import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { Connection, Backup, BackupResult, BinlogInfo, Schedule } from '../types';
import { getDb, getSetting, setSetting } from '../db/database';
import { maxCronIntervalHours } from './cronInterval';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// process.cwd() is always backend/ (set by WORKDIR/working_dir in the
// Dockerfile and docker-compose files), while the BACKUP_PATH volume is
// mounted one level up, at <project-root>/backup_servers.
const BACKUP_ROOT = path.join(process.cwd(), '..', 'backup_servers');

export function getBackupRoot(): string {
  return BACKUP_ROOT;
}

// In-memory log buffer for running operations
const opLogs = new Map<string, string[]>();

export function appendLog(opId: string, line: string) {
  const lines = opLogs.get(opId) || [];
  lines.push(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
  opLogs.set(opId, lines);
}

export function getLogs(opId: string): string[] {
  return opLogs.get(opId) || [];
}

export function flushLogs(opId: string): string {
  const lines = opLogs.get(opId) || [];
  opLogs.delete(opId);
  return lines.join('\n');
}

const DIACRITICS_MAP: Record<string, string> = {
  ă: 'a', â: 'a', î: 'i', ș: 's', ş: 's', ț: 't', ţ: 't',
  Ă: 'a', Â: 'a', Î: 'i', Ș: 's', Ş: 's', Ț: 't', Ţ: 't',
};

// Numele de folder al serverului, folosit și local și pe destinațiile remote.
export function getServerSlug(serverName: string): string {
  const transliterated = serverName.replace(/[ăâîșşțţĂÂÎȘŞȚŢ]/g, c => DIACRITICS_MAP[c] || c);
  return transliterated
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_');
}

export function getServerDir(serverName: string): string {
  return path.join(BACKUP_ROOT, getServerSlug(serverName));
}

export function getFullBackupDir(serverName: string): string {
  return path.join(getServerDir(serverName), 'full');
}

export function getIncrementalBackupDir(serverName: string): string {
  return path.join(getServerDir(serverName), 'incremental');
}

function ensureDirs(serverName: string) {
  fs.mkdirSync(getFullBackupDir(serverName), { recursive: true });
  fs.mkdirSync(getIncrementalBackupDir(serverName), { recursive: true });
}

function mysqlEnv(conn: Connection): NodeJS.ProcessEnv {
  return { ...process.env, MYSQL_PWD: conn.password };
}

function mysqlArgs(conn: Connection): string {
  return `-h ${conn.host} -P ${conn.port} -u ${conn.user}`;
}

// Opțiuni mysqldump activate per server din tab-ul Setări (cheia `dump_options:<connectionId>`).
// Implicit dezactivate: schimbă conținutul backup-ului, deci se activează doar cu acordul utilizatorului.
export interface DumpOptions {
  gtidPurgedOff: boolean;    // --set-gtid-purged=OFF (servere cu GTID fără RELOAD / FLUSH_TABLES)
  maxAllowedPacket: boolean; // --max-allowed-packet=1G la mysqldump și la mysql (restore), pentru rânduri mari
}

export const DEFAULT_DUMP_OPTIONS: DumpOptions = { gtidPurgedOff: false, maxAllowedPacket: false };

const dumpOptionsKey = (connectionId: string) => `dump_options:${connectionId}`;

export function getDumpOptions(connectionId: string): DumpOptions {
  try {
    const saved = JSON.parse(getSetting(dumpOptionsKey(connectionId)) || '{}');
    return {
      gtidPurgedOff: saved.gtidPurgedOff === true,
      maxAllowedPacket: saved.maxAllowedPacket === true,
    };
  } catch {
    return { ...DEFAULT_DUMP_OPTIONS };
  }
}

export function setDumpOptions(connectionId: string, options: DumpOptions | null): void {
  setSetting(dumpOptionsKey(connectionId), options ? JSON.stringify(options) : '');
}

const MAX_PACKET_FLAG = '--max-allowed-packet=1G';

// Run a pipe command capturing stderr as logs; pipefail ensures mysqldump errors propagate
async function execPipe(
  cmd: string,
  env: NodeJS.ProcessEnv,
  opId: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-c', `set -o pipefail; ${cmd}`], {
      env,
      stdio: ['ignore', 'inherit', 'pipe']
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      chunk.toString().split('\n').filter(Boolean).forEach(line => {
        appendLog(opId, line);
      });
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else if (code === 2) {
        // Cod 2 = eroare MySQL (ex: privilegiu lipsă), nu avertisment: mysqldump se oprește
        // și fișierul rămâne incomplet, deci backup-ul trebuie marcat eșuat.
        reject(new Error('Proces încheiat cu codul 2 (eroare MySQL) — rezultatul este incomplet.'));
      } else if (code === 127) {
        reject(new Error('Comandă negăsită (cod 127): mysql-client nu este instalat sau nu este în PATH. Asigură-te că aplicația rulează din containerul Docker (docker-compose up).'));
      } else {
        reject(new Error(`Proces încheiat cu codul ${code}.`));
      }
    });

    proc.on('error', reject);
  });
}

export async function testConnection(conn: Connection): Promise<boolean> {
  try {
    await execAsync(
      `mysql ${mysqlArgs(conn)} -e "SELECT 1" ${conn.database_name}`,
      { env: mysqlEnv(conn) }
    );
    return true;
  } catch {
    return false;
  }
}

export type CheckStatus = 'ok' | 'warn' | 'error' | 'info';
export type BackupKind = 'full' | 'incremental';

// O verificare din „Testează drepturile și configurațiile”: ce s-a verificat, rezultatul,
// motivul (detail), comanda de reparare (fix) și ce tip de backup e afectat.
export interface ValidationCheck {
  group: 'Conexiune' | 'Privilegii' | 'Configurare server';
  label: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
  affects: BackupKind[];
}

export interface ValidationResult {
  canConnect: boolean;
  mysqlVersion: string | null;
  versionOk: boolean;
  binlogEnabled: boolean;
  binlogFormat: string | null;
  incrementalSupported: boolean;
  databaseExists: boolean;
  fullBackup: Exclude<CheckStatus, 'info'>;
  incrementalBackup: Exclude<CheckStatus, 'info'>;
  checks: ValidationCheck[];
  errors: string[];
}

// Interogare fără shell (numele bazei, parola și ghilimelele nu trec prin bash).
// Rândurile vin ca liste de coloane (separate prin tab, fără escaping: -r).
async function mysqlQuery(conn: Connection, sql: string): Promise<string[][]> {
  const { stdout } = await execFileAsync(
    'mysql',
    ['-h', conn.host, '-P', String(conn.port), '-u', conn.user, '--connect-timeout=10', '-N', '-B', '-r', '-e', sql],
    { env: mysqlEnv(conn), timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
  );
  return stdout.split('\n').filter(Boolean).map(l => l.split('\t'));
}

type Probe = { ok: true; rows: string[][] } | { ok: false; error: string };

// Rulează interogarea și păstrează mesajul de eroare MySQL (fără avertismentele clientului).
async function probe(conn: Connection, sql: string): Promise<Probe> {
  try {
    return { ok: true, rows: await mysqlQuery(conn, sql) };
  } catch (err) {
    const e = err as { stderr?: string; message?: string; killed?: boolean };
    if (e.killed) return { ok: false, error: 'serverul nu a răspuns în 30 de secunde (timeout)' };
    const lines = (e.stderr || e.message || String(err)).split('\n').map(l => l.trim()).filter(Boolean);
    const error = lines.find(l => l.startsWith('ERROR')) || lines.find(l => !l.includes('[Warning]')) || 'eroare necunoscută';
    return { ok: false, error };
  }
}

const sqlStr = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
const sqlId = (s: string) => '`' + s.replace(/`/g, '``') + '`';

function connectionErrorHint(error: string, conn: Connection): string {
  if (/ERROR 1045/.test(error)) {
    return "User sau parolă greșite, ori user-ul nu are voie să se conecteze de pe IP-ul aplicației (verifică partea de host din 'user'@'host').";
  }
  if (/ERROR 1130/.test(error)) {
    return "IP-ul aplicației nu are voie să se conecteze la acest MySQL. Creează user-ul pentru IP-ul aplicației sau pentru '%'.";
  }
  if (/ERROR 200[2-5]|Can't connect|Unknown MySQL server host|timeout/i.test(error)) {
    return `Serverul ${conn.host}:${conn.port} nu răspunde. Verifică host-ul, portul, că MySQL ascultă pe rețea (bind-address) și firewall-ul pentru IP-ul aplicației.`;
  }
  return 'Verifică host, port, user și parolă.';
}

// Privilegiile din SHOW GRANTS: globale (ON *.*) și pe baza de date (inclusiv pattern-uri
// cu % și _). Granturile pe tabele individuale sunt ignorate.
interface Grants { global: Set<string>; db: Set<string>; viaRoles: boolean }

function grantDbMatches(pattern: string, database: string): boolean {
  const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) re += esc(pattern[++i]);
    else if (c === '%') re += '.*';
    else if (c === '_') re += '.';
    else re += esc(c);
  }
  return new RegExp(`^${re}$`).test(database);
}

function parseGrants(lines: string[], database: string): Grants {
  const grants: Grants = { global: new Set(), db: new Set(), viaRoles: false };
  for (const line of lines) {
    const m = line.match(/^GRANT\s+(.+?)\s+ON\s+(?:(?:TABLE|FUNCTION|PROCEDURE)\s+)?(\*|`(?:[^`]|``)*`)\.(\*|`(?:[^`]|``)*`)\s+TO\s/i);
    if (!m) {
      if (/^GRANT\s+[`'"]/.test(line)) grants.viaRoles = true; // GRANT `rol`@`%` TO ...
      continue;
    }
    if (m[3] !== '*') continue;
    const target = m[2] === '*'
      ? grants.global
      : grantDbMatches(m[2].slice(1, -1).replace(/``/g, '`'), database) ? grants.db : null;
    if (!target) continue;
    for (const raw of m[1].split(',')) {
      const priv = raw.trim().toUpperCase().replace(/\s*\(.*\)$/, '');
      target.add(priv.startsWith('ALL') ? 'ALL' : priv);
    }
  }
  return grants;
}

const hasGlobal = (g: Grants, ...privs: string[]) => g.global.has('ALL') || privs.some(p => g.global.has(p));
const hasOnDb = (g: Grants, priv: string) => hasGlobal(g, priv) || g.db.has('ALL') || g.db.has(priv);

function worstStatus(checks: ValidationCheck[], kind: BackupKind): Exclude<CheckStatus, 'info'> {
  const statuses = checks.filter(c => c.affects.includes(kind)).map(c => c.status);
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('warn')) return 'warn';
  return 'ok';
}

// Verifică tot ce are nevoie backup-ul (full și incremental): conexiunea, privilegiile
// (prin interogări inofensive unde se poate, altfel din SHOW GRANTS) și configurația serverului.
// Fiecare problemă vine cu motivul și comanda de reparare.
export async function validateMySQLCapabilities(
  conn: Connection,
  options: DumpOptions = DEFAULT_DUMP_OPTIONS
): Promise<ValidationResult> {
  const checks: ValidationCheck[] = [];
  const result: ValidationResult = {
    canConnect: false,
    mysqlVersion: null,
    versionOk: false,
    binlogEnabled: false,
    binlogFormat: null,
    incrementalSupported: false,
    databaseExists: false,
    fullBackup: 'ok',
    incrementalBackup: 'ok',
    checks,
    errors: []
  };
  const BOTH: BackupKind[] = ['full', 'incremental'];
  const db = conn.database_name;

  const finish = () => {
    result.fullBackup = worstStatus(checks, 'full');
    result.incrementalBackup = worstStatus(checks, 'incremental');
    result.incrementalSupported = result.incrementalBackup !== 'error';
    result.errors = checks.filter(c => c.status === 'error').map(c => `${c.label}: ${c.detail ?? ''}`);
    return result;
  };

  // ── Conexiune ──
  const hello = await probe(conn, 'SELECT VERSION(), CURRENT_USER()');
  if (!hello.ok) {
    checks.push({
      group: 'Conexiune', label: `Conectare la ${conn.host}:${conn.port}`, status: 'error',
      detail: `${hello.error} — ${connectionErrorHint(hello.error, conn)}`, affects: BOTH,
    });
    return finish();
  }
  result.canConnect = true;
  const [version = '', currentUser = ''] = hello.rows[0] || [];
  result.mysqlVersion = version;
  const account = currentUser.includes('@') ? currentUser.replace(/^(.*)@([^@]*)$/, "'$1'@'$2'") : `'${conn.user}'@'%'`;
  checks.push({ group: 'Conexiune', label: `Conectare la ${conn.host}:${conn.port}`, status: 'ok', detail: `conectat ca ${account}`, affects: BOTH });

  const isMariaDb = /mariadb/i.test(version);
  result.versionOk = isMariaDb || parseInt(version.split('.')[0]) >= 8;
  checks.push({
    group: 'Conexiune', label: 'Versiune server', status: result.versionOk ? 'ok' : 'error',
    detail: result.versionOk ? `${isMariaDb ? 'MariaDB' : 'MySQL'} ${version}` : `MySQL ${version} — versiunea minimă suportată este 8.0`,
    affects: BOTH,
  });

  const schema = await probe(conn, `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ${sqlStr(db)}`);
  result.databaseExists = schema.ok && schema.rows.length > 0;
  checks.push({
    group: 'Conexiune', label: `Baza de date „${db}”`, status: result.databaseExists ? 'ok' : 'error',
    detail: result.databaseExists
      ? 'există și e accesibilă'
      : 'nu există sau user-ul nu are niciun drept pe ea (information_schema arată doar bazele la care user-ul are acces)',
    affects: BOTH,
  });

  // Tabelele bazei: număr, mărime, view-uri, motoare non-InnoDB (ordonate descrescător după mărime)
  const inv = { tables: 0, views: 0, sizeBytes: 0, largest: '', largestBytes: 0, firstView: '', nonInnodb: [] as string[] };
  if (result.databaseExists) {
    const t = await probe(conn,
      `SELECT TABLE_NAME, TABLE_TYPE, IFNULL(ENGINE, ''), IFNULL(DATA_LENGTH, 0) + IFNULL(INDEX_LENGTH, 0) ` +
      `FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${sqlStr(db)} ORDER BY 4 DESC`);
    if (t.ok) {
      for (const [name, type, engine, size] of t.rows) {
        if (type === 'VIEW') { inv.views++; inv.firstView ||= name; continue; }
        const bytes = Number(size) || 0;
        inv.tables++;
        inv.sizeBytes += bytes;
        if (!inv.largest) { inv.largest = name; inv.largestBytes = bytes; }
        if (engine && engine.toUpperCase() !== 'INNODB') inv.nonInnodb.push(`${name} (${engine})`);
      }
    }
  }

  const vars = new Map<string, string>();
  const varsProbe = await probe(conn,
    "SHOW GLOBAL VARIABLES WHERE Variable_name IN ('log_bin', 'binlog_format', 'gtid_mode', 'max_allowed_packet', " +
    "'net_write_timeout', 'max_execution_time', 'max_statement_time', 'binlog_expire_logs_seconds', 'expire_logs_days')");
  if (varsProbe.ok) varsProbe.rows.forEach(([k, v]) => vars.set(k.toLowerCase(), v ?? ''));
  const gtidMode = (vars.get('gtid_mode') || '').toUpperCase();
  const gtidOn = gtidMode.startsWith('ON');

  // ── Privilegii ──
  const grantsProbe = await probe(conn, 'SHOW GRANTS');
  const grants = grantsProbe.ok ? parseGrants(grantsProbe.rows.map(r => r[0]), db) : null;
  const rolesNote = grants?.viaRoles ? ' (user-ul are și roluri; privilegiile primite prin roluri nu pot fi verificate aici)' : '';
  const grantDb = (privs: string) => `GRANT ${privs} ON ${sqlId(db)}.* TO ${account};`;
  const grantGlobal = (privs: string) => `GRANT ${privs} ON *.* TO ${account};`;

  // Verificare din SHOW GRANTS: lipsa e sigură doar dacă user-ul nu are roluri.
  const grantCheck = (
    label: string, has: boolean | null, missing: 'error' | 'warn',
    okDetail: string, missingDetail: string, fix: string, affects: BackupKind[]
  ) => checks.push({
    group: 'Privilegii', label, affects,
    status: has === null ? 'warn' : has ? 'ok' : grants?.viaRoles ? 'warn' : missing,
    detail: has === null
      ? `nu s-a putut verifica (SHOW GRANTS: ${grantsProbe.ok ? '' : grantsProbe.error}) — ${missingDetail}`
      : has ? okDetail : missingDetail + rolesNote,
    fix: has ? undefined : fix,
  });

  if (result.databaseExists) {
    if (inv.tables > 0) {
      const sel = await probe(conn, `SELECT 1 FROM ${sqlId(db)}.${sqlId(inv.largest)} LIMIT 0`);
      checks.push({
        group: 'Privilegii', label: 'SELECT', status: sel.ok ? 'ok' : 'error',
        detail: sel.ok ? `citire date (${inv.tables} tabele)` : `${sel.error} — fără SELECT, mysqldump nu poate citi datele.`,
        fix: sel.ok ? undefined : grantDb('SELECT'), affects: ['full'],
      });
    } else {
      checks.push({
        group: 'Privilegii', label: 'SELECT', status: 'warn',
        detail: 'user-ul nu vede niciun tabel în această bază: fie baza e goală, fie lipsește SELECT. Backup-ul ar fi gol.',
        fix: grantDb('SELECT'), affects: ['full'],
      });
    }

    if (inv.views > 0) {
      const sv = await probe(conn, `SHOW CREATE VIEW ${sqlId(db)}.${sqlId(inv.firstView)}`);
      checks.push({
        group: 'Privilegii', label: 'SHOW VIEW', status: sv.ok ? 'ok' : 'error',
        detail: sv.ok
          ? `${inv.views} view-uri incluse în backup`
          : `${sv.error} — baza are ${inv.views} view-uri, iar mysqldump se oprește la primul.`,
        fix: sv.ok ? undefined : grantDb('SHOW VIEW'), affects: ['full'],
      });
    } else {
      checks.push({ group: 'Privilegii', label: 'SHOW VIEW', status: 'ok', detail: 'baza nu are view-uri, deci nu e necesar acum', affects: ['full'] });
    }

    grantCheck('TRIGGER', grants ? hasOnDb(grants, 'TRIGGER') : null, 'warn',
      'triggerele sunt incluse în backup',
      'fără TRIGGER, triggerele lipsesc din backup fără nicio eroare: backup-ul pare reușit, dar e incomplet.',
      grantDb('TRIGGER'), ['full']);

    const ev = await probe(conn, `SHOW EVENTS FROM ${sqlId(db)}`);
    checks.push({
      group: 'Privilegii', label: 'EVENT', status: ev.ok ? 'ok' : 'error',
      detail: ev.ok
        ? 'event-urile programate sunt incluse în backup'
        : `${ev.error} — backup-ul rulează cu --events și se oprește cu „Access denied” fără EVENT.`,
      fix: ev.ok ? undefined : grantDb('EVENT'), affects: ['full'],
    });
  }

  if (gtidOn && !options.gtidPurgedOff) {
    grantCheck('RELOAD sau FLUSH_TABLES (GTID activ)', grants ? hasGlobal(grants, 'RELOAD', 'FLUSH_TABLES') : null, 'error',
      'serverul are GTID activ, iar mysqldump poate executa FLUSH TABLES',
      `serverul are GTID activ (gtid_mode=${gtidMode}), deci mysqldump execută FLUSH TABLES WITH READ LOCK și se oprește cu ` +
      '„Access denied … RELOAD or FLUSH_TABLES”, iar fișierul rămâne aproape gol. Pe MySQL administrat (DigitalOcean, AWS RDS, Azure) ' +
      'privilegiul nu se poate acorda: activează opțiunea „Fără GTID în backup” din tab-ul Setări.',
      `${grantGlobal('RELOAD')}\n-- sau: tab-ul Setări → Opțiuni mysqldump → „Fără GTID în backup (--set-gtid-purged=OFF)”`,
      ['full']);
  }

  grantCheck('RELOAD', grants ? hasGlobal(grants, 'RELOAD') : null, 'error',
    'FLUSH LOGS înainte de backup (rotire binlog)',
    'fără RELOAD, FLUSH LOGS eșuează: backup-ul full merge (cu avertisment), dar backup-ul incremental se oprește.',
    grantGlobal('RELOAD'), ['incremental']);

  // SHOW BINARY LOG STATUS (MySQL 8.2+) / SHOW MASTER STATUS (8.0, MariaDB): ce folosește și backup-ul
  const binlogStatus = await probe(conn, 'SHOW BINARY LOG STATUS');
  const replClient = binlogStatus.ok || /denied/i.test(binlogStatus.error) ? binlogStatus : await probe(conn, 'SHOW MASTER STATUS');
  checks.push({
    group: 'Privilegii', label: isMariaDb ? 'REPLICATION CLIENT / BINLOG MONITOR' : 'REPLICATION CLIENT',
    status: replClient.ok ? 'ok' : 'error',
    detail: replClient.ok
      ? 'citire poziție binlog (SHOW BINARY LOG STATUS / MASTER STATUS)'
      : `${replClient.error} — fără el nu se poate citi poziția binlog: backup-ul full merge, dar incrementalul nu are punct de pornire.`,
    fix: replClient.ok ? undefined : grantGlobal(isMariaDb ? 'BINLOG MONITOR' : 'REPLICATION CLIENT'),
    affects: ['incremental'],
  });

  grantCheck('REPLICATION SLAVE', grants ? hasGlobal(grants, 'REPLICATION SLAVE', 'REPLICATION REPLICA') : null, 'error',
    'citire binlog prin rețea (mysqlbinlog --read-from-remote-server)',
    'incrementalul citește binlog-ul prin rețea (mysqlbinlog --read-from-remote-server), ceea ce cere REPLICATION SLAVE.',
    grantGlobal('REPLICATION SLAVE'), ['incremental']);

  // ── Configurare server ──
  result.binlogEnabled = ['ON', '1'].includes((vars.get('log_bin') || '').toUpperCase());
  checks.push({
    group: 'Configurare server', label: 'Binary logging (log_bin)', status: result.binlogEnabled ? 'ok' : 'error',
    detail: result.binlogEnabled ? 'activ' : 'dezactivat — backup-ul incremental citește modificările din binlog, deci nu poate funcționa.',
    fix: result.binlogEnabled ? undefined : 'în my.cnf, secțiunea [mysqld]: log_bin = mysql-bin și server_id = 1, apoi restart MySQL',
    affects: ['incremental'],
  });

  result.binlogFormat = vars.get('binlog_format') || null;
  if (result.binlogEnabled && result.binlogFormat) {
    const isRow = result.binlogFormat.toUpperCase() === 'ROW';
    checks.push({
      group: 'Configurare server', label: 'Format binlog', status: isRow ? 'ok' : 'warn',
      detail: isRow
        ? 'ROW'
        : `${result.binlogFormat} — incrementalul filtrează după baza de date; cu STATEMENT/MIXED se pierd modificările ` +
          `făcute cu altă bază selectată (ex: USE alta_baza; UPDATE ${db}.tabel …). Recomandat: ROW.`,
      fix: isRow ? undefined : "SET GLOBAL binlog_format = 'ROW';  -- și binlog_format = ROW în my.cnf",
      affects: ['incremental'],
    });
  }

  if (result.binlogEnabled) {
    const expireSec = Number(vars.get('binlog_expire_logs_seconds') || 0) || Number(vars.get('expire_logs_days') || 0) * 86400;
    const retention = expireSec >= 86400 ? `${+(expireSec / 86400).toFixed(1)} zile` : `${+(expireSec / 3600).toFixed(1)} ore`;
    // Incrementalul citește binlog-urile de la backup-ul anterior: ele trebuie să existe încă la rularea următoare
    const schedule = conn.id
      ? getDb().prepare('SELECT * FROM schedules WHERE connection_id = ? AND enabled = 1').get(conn.id) as Schedule | undefined
      : undefined;
    const incrHours = schedule?.incremental_cron ? maxCronIntervalHours(schedule.incremental_cron) : null;
    if (expireSec > 0 && incrHours && incrHours * 3600 > expireSec) {
      const suggested = Math.max(incrHours * 3600 * 2, 7 * 86400);
      checks.push({
        group: 'Configurare server', label: 'Retenție binlog față de program', status: 'error',
        detail: `programul rulează incrementalul la până la ${incrHours >= 24 ? `${+(incrHours / 24).toFixed(1)} zile` : `${incrHours} ore`} ` +
          'distanță, dar serverul șterge binlog-urile după ' +
          `${retention}. Până la rularea următoare, binlog-urile de care are nevoie incrementalul nu mai există, deci va eșua.`,
        fix: `SET GLOBAL binlog_expire_logs_seconds = ${suggested};  -- și în my.cnf (pe MySQL 8: SET PERSIST)`,
        affects: ['incremental'],
      });
    }
    checks.push({
      group: 'Configurare server', label: 'Retenție binlog', status: expireSec > 0 && expireSec < 86400 ? 'warn' : 'info',
      detail: expireSec > 0
        ? `binlog-urile se șterg după ${retention}. Incrementalul are nevoie de binlog-urile de la ultimul backup; ` +
          'dacă dispar mai devreme, incrementalul eșuează până la următorul full.'
        : 'binlog-urile nu se șterg automat (atenție la spațiul pe serverul MySQL).',
      affects: ['incremental'],
    });
  }

  if (vars.has('gtid_mode')) {
    checks.push({
      group: 'Configurare server', label: 'GTID (gtid_mode)', status: 'info',
      detail: !gtidOn
        ? gtidMode
        : options.gtidPurgedOff
          ? `${gtidMode} — backup-ul rulează cu --set-gtid-purged=OFF, deci nu cere RELOAD / FLUSH_TABLES.`
          : `${gtidMode} — mysqldump cere RELOAD sau FLUSH_TABLES, iar restaurarea pe un server cu GTID poate da eroarea 3546. ` +
            'Ambele se rezolvă cu opțiunea „Fără GTID în backup” din tab-ul Setări.',
      affects: ['full'],
    });
  }

  const packet = Number(vars.get('max_allowed_packet') || 0);
  if (packet) {
    checks.push({
      group: 'Configurare server', label: 'max_allowed_packet', status: 'info',
      detail: `server: ${formatBytes(packet)}. Nu limitează backup-ul; la restaurare, un rând mai mare decât această ` +
        'limită a serverului destinație dă ERROR 1153 („Got a packet bigger than max_allowed_packet”).',
      affects: ['full'],
    });
  }

  const writeTimeout = Number(vars.get('net_write_timeout') || 0);
  if (writeTimeout) {
    checks.push({
      group: 'Configurare server', label: 'net_write_timeout', status: 'info',
      detail: `${writeTimeout}s — dacă scrierea backup-ului se blochează mai mult de atât (disc lent), serverul închide conexiunea (Error 2013).` +
        (writeTimeout < 300 ? ' Pentru baze mari se recomandă 600.' : ''),
      fix: writeTimeout < 300 ? 'SET GLOBAL net_write_timeout = 600;  -- și în my.cnf' : undefined,
      affects: ['full'],
    });
  }

  const execTimeMs = Number(vars.get('max_execution_time') || 0);    // MySQL, milisecunde
  const statementTimeS = Number(vars.get('max_statement_time') || 0); // MariaDB, secunde
  if (execTimeMs > 0 || statementTimeS > 0) {
    checks.push({
      group: 'Configurare server', label: 'Limită durată interogări', status: 'warn',
      detail: (execTimeMs > 0 ? `max_execution_time = ${execTimeMs} ms` : `max_statement_time = ${statementTimeS}s`) +
        ' — citirea tabelelor mari de către mysqldump poate fi oprită de server înainte să se termine.',
      fix: execTimeMs > 0 ? 'SET GLOBAL max_execution_time = 0;' : 'SET GLOBAL max_statement_time = 0;',
      affects: ['full'],
    });
  }

  if (inv.nonInnodb.length > 0) {
    const more = inv.nonInnodb.length > 5 ? ` și încă ${inv.nonInnodb.length - 5}` : '';
    checks.push({
      group: 'Configurare server', label: 'Tabele non-InnoDB', status: 'warn',
      detail: `${inv.nonInnodb.slice(0, 5).join(', ')}${more} — --single-transaction garantează un backup consistent doar ` +
        'pentru InnoDB; aceste tabele pot fi copiate inconsistent dacă se scrie în ele în timpul backup-ului.',
      affects: ['full'],
    });
  }

  if (inv.tables > 0) {
    let status: CheckStatus = 'info';
    let disk = '';
    try {
      const { getDiskUsage } = await import('./diskService');
      const usage = await getDiskUsage();
      disk = ` Spațiu liber pentru backup-uri: ${formatBytes(usage.freeBytes)}.`;
      if (usage.freeBytes < inv.sizeBytes / 2) {
        status = 'warn';
        disk += ' Backup-ul comprimat e de obicei de câteva ori mai mic decât baza, dar spațiul liber e sub jumătate din mărimea ei.';
      }
    } catch { /* non-critic */ }
    checks.push({
      group: 'Configurare server', label: 'Mărime bază de date', status,
      detail: `${formatBytes(inv.sizeBytes)} (date + indecși, estimare), ${inv.tables} tabele; ` +
        `cel mai mare: ${inv.largest} (${formatBytes(inv.largestBytes)}).${disk}`,
      affects: ['full'],
    });
  }

  return finish();
}

export async function getBinlogInfo(conn: Connection): Promise<BinlogInfo | null> {
  const env = mysqlEnv(conn);
  const args = mysqlArgs(conn);

  for (const query of ['SHOW BINARY LOG STATUS\\G', 'SHOW MASTER STATUS\\G']) {
    try {
      const { stdout } = await execAsync(`mysql ${args} -e "${query}"`, { env });
      const fileMatch = stdout.match(/File:\s+(\S+)/);
      const posMatch = stdout.match(/Position:\s+(\d+)/);
      if (fileMatch && posMatch) {
        return { file: fileMatch[1], position: parseInt(posMatch[1]) };
      }
    } catch { /* try next */ }
  }
  return null;
}

// După „Error 2013 … when dumping table X at row: N”: verifică dacă serverul a repornit și cât de
// mare e rândul la care s-a oprit dump-ul, comparat cu max_allowed_packet al serverului.
// Scrie liniile „DIAGNOSTIC:” în jurnal și întoarce cauza pe scurt (pentru mesajul de eroare).
async function diagnoseLostConnection(conn: Connection, opId: string, startedAt: number): Promise<string | null> {
  const m = getLogs(opId).join('\n').match(/Error 2013: .* when dumping table `([^`]+)` at row: (\d+)/);
  if (!m) return null;
  const table = m[1];
  const row = Number(m[2]); // rânduri citite cu succes; rândul care a eșuat e următorul (offset `row`)
  const log = (line: string) => appendLog(opId, `DIAGNOSTIC: ${line}`);
  log(`caut cauza conexiunii pierdute la tabelul ${table}, rândul ${row + 1}...`);

  const status = await probe(conn, "SHOW GLOBAL STATUS LIKE 'Uptime'");
  if (!status.ok) {
    log(`serverul MySQL nu mai răspunde (${status.error}) — a fost oprit sau a căzut în timpul backup-ului.`);
    return 'serverul MySQL nu mai răspunde după eroare';
  }
  const uptime = Number(status.rows[0]?.[1] || 0);
  if (uptime > 0 && uptime * 1000 < Date.now() - startedAt) {
    log(`serverul MySQL a repornit în timpul backup-ului (pornit de ${uptime}s) — crash sau oprit de sistem (ex: lipsă memorie). ` +
      'Cauza e în jurnalul de erori MySQL al serverului (ex: /var/log/mysql/error.log).');
    return 'serverul MySQL a repornit în timpul backup-ului';
  }

  const packetRes = await probe(conn, 'SELECT @@global.max_allowed_packet');
  const packet = packetRes.ok ? Number(packetRes.rows[0]?.[0] || 0) : 0;
  const where = `TABLE_SCHEMA = ${sqlStr(conn.database_name)} AND TABLE_NAME = ${sqlStr(table)}`;
  const cols = await probe(conn, `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE ${where} ORDER BY ORDINAL_POSITION`);
  if (!cols.ok || cols.rows.length === 0) {
    log(`nu pot citi coloanele tabelului ${table} (${cols.ok ? 'tabel negăsit' : cols.error}).`);
    return null;
  }
  // mysqldump citește în ordinea cheii primare (ordinea fizică InnoDB)
  const pk = await probe(conn, `SELECT COLUMN_NAME FROM information_schema.STATISTICS WHERE ${where} AND INDEX_NAME = 'PRIMARY' ORDER BY SEQ_IN_INDEX`);
  const pkCols = pk.ok ? pk.rows.map(([c]) => sqlId(c)) : [];
  const lenExpr = cols.rows.map(([c]) => `COALESCE(LENGTH(${sqlId(c)}), 0)`).join(' + ');
  const from = `${sqlId(conn.database_name)}.${sqlId(table)}`;
  const order = pkCols.length > 0 ? ` ORDER BY ${pkCols.join(', ')}` : '';
  const key = pkCols.length > 0 ? `CONCAT_WS(',', ${pkCols.join(', ')})` : "''";

  const rowRes = await probe(conn, `SELECT ${key}, ${lenExpr} FROM ${from}${order} LIMIT ${row}, 1`);
  if (!rowRes.ok) {
    log(`citirea rândului ${row + 1} eșuează și separat (${rowRes.error}) — posibil tabel corupt. ` +
      `Verifică jurnalul de erori MySQL și rulează CHECK TABLE ${from};`);
    return `citirea rândului ${row + 1} din ${table} eșuează pe server (posibil tabel corupt)`;
  }
  if (rowRes.rows.length === 0) {
    log(`rândul ${row + 1} nu mai există (tabelul s-a modificat între timp).`);
    return null;
  }
  const [keyValue, lenStr] = rowRes.rows[0];
  const rowBytes = Number(lenStr || 0);
  const maxRes = await probe(conn, `SELECT MAX(${lenExpr}) FROM ${from}`);
  const maxBytes = maxRes.ok ? Number(maxRes.rows[0]?.[0] || 0) : 0;
  log(`rândul ${row + 1}${keyValue ? ` (cheie primară ${keyValue})` : ''} are ${formatBytes(rowBytes)} și se citește ` +
    `normal separat; cel mai mare rând din tabel: ${maxRes.ok ? formatBytes(maxBytes) : `necalculat (${maxRes.error})`}.`);
  // Testat pe MySQL 8.0.46 și 8.4: mysqldump citește rânduri de 30 MB indiferent de max_allowed_packet
  // (client sau server), deci mărimea rândului nu e cauza. Limita serverului contează doar la restaurare.
  log('serverul nu a repornit, iar rândul se poate citi, deci conexiunea a fost închisă din afara dump-ului. ' +
    'Cauze posibile: un firewall / IPS / antivirus de rețea care taie conexiunea când vede conținutul acelui rând ' +
    '(ex: atașament detectat ca suspect), net_write_timeout prea mic, o întrerupere de rețea sau un KILL. ' +
    'Caută ora erorii în jurnalul MySQL al serverului (ex: /var/log/mysql/error.log, „Aborted connection”).' +
    (packet && maxBytes > packet ? ` Atenție: rânduri mai mari decât max_allowed_packet al serverului (${formatBytes(packet)}) ` +
      'nu vor putea fi restaurate (ERROR 1153) până nu se mărește limita.' : ''));
  return null;
}

export async function performFullBackup(
  conn: Connection,
  serverName: string,
  opId: string
): Promise<BackupResult> {
  ensureDirs(serverName);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `full_${timestamp}.sql.gz`;
  const filePath = path.join(getFullBackupDir(serverName), fileName);

  const env = mysqlEnv(conn);
  const args = mysqlArgs(conn);
  const startedAt = Date.now();

  try {
    // Verify mysqldump is available before attempting backup
    try {
      const { stdout: mpPath } = await execAsync('which mysqldump');
      appendLog(opId, `mysqldump: ${mpPath.trim()}`);
    } catch {
      return { success: false, error: 'mysqldump nu este instalat sau nu este în PATH. Asigură-te că aplicația rulează din containerul Docker (docker-compose up).' };
    }

    appendLog(opId, `Conectare la ${conn.host}:${conn.port} ca ${conn.user}...`);

    try {
      await execAsync(`mysql ${args} -e "FLUSH LOGS;"`, { env });
      appendLog(opId, 'FLUSH LOGS executat — binlog rotit.');
    } catch (err: unknown) {
      const flushErr = err instanceof Error ? err.message : String(err);
      if (flushErr.includes('2002') || flushErr.includes("Can't connect")) {
        appendLog(opId, `EROARE CONEXIUNE: Nu se poate conecta la ${conn.host}:${conn.port} — ${flushErr.split('\n')[0]}`);
        return { success: false, error: `Nu se poate conecta la serverul MySQL ${conn.host}:${conn.port}. Verifică că serverul rulează și că portul este accesibil din container.` };
      }
      appendLog(opId, 'WARN: FLUSH LOGS eșuat (lipsă privilegiu RELOAD) — continuă fără rotire binlog.');
    }

    const binlogInfo = await getBinlogInfo(conn);
    if (binlogInfo) {
      appendLog(opId, `Poziție binlog la start: ${binlogInfo.file}:${binlogInfo.position}`);
    }

    const options = getDumpOptions(conn.id);
    const extraFlags = [
      options.gtidPurgedOff ? '--set-gtid-purged=OFF' : '',
      options.maxAllowedPacket ? MAX_PACKET_FLAG : '',
    ].filter(Boolean).join(' ');
    if (extraFlags) appendLog(opId, `Opțiuni mysqldump active (din Setări): ${extraFlags}`);

    appendLog(opId, `Rulare mysqldump pentru baza '${conn.database_name}'...`);
    // --no-tablespaces avoids "Access denied" on PROCESS privilege for tablespace dump (MySQL 8.0.21+)
    // --column-statistics=0: pe MariaDB, mysqldump 8.0 se oprește după primul tabel (cod 2,
    // „Unknown table 'COLUMN_STATISTICS'”); pe MySQL omite doar histogramele (ANALYZE TABLE).
    const cmd = `mysqldump ${args} --single-transaction --no-tablespaces --column-statistics=0 --routines --triggers --events ${extraFlags} ${conn.database_name} | gzip > "${filePath}"`;
    await execPipe(cmd, env, opId);

    const stat = fs.statSync(filePath);

    // < 30 bytes = gzip empty (mysqldump ran but produced no output = connection/auth failure)
    if (stat.size < 30) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      const logLines = getLogs(opId).slice(-5).join(' | ');
      appendLog(opId, `EROARE: Fișierul generat este gol (${stat.size} bytes). Ultima ieșire mysqldump: ${logLines}`);
      return { success: false, error: `mysqldump nu a produs output. ${logLines ? `Eroare: ${logLines}` : 'Verifică host/port/user/parolă și privilegiile MySQL.'}` };
    }

    appendLog(opId, `Backup finalizat. Dimensiune: ${formatBytes(stat.size)}`);
    appendLog(opId, `Fișier: ${fileName}`);

    return {
      success: true,
      filePath,
      fileSize: stat.size,
      binlogFile: binlogInfo?.file,
      binlogPos: binlogInfo?.position
    };
  } catch (err: unknown) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    const message = err instanceof Error ? err.message : String(err);
    appendLog(opId, `EROARE: ${message}`);
    // Ultimele linii de eroare din mysqldump, ca motivul real să apară și în notificare
    const stderrLines = getLogs(opId)
      .filter(l => /mysqldump: (Error|Couldn't|Got error)|denied/i.test(l))
      .slice(-2)
      .map(l => l.replace(/^\[\d{2}:\d{2}:\d{2}\] /, ''));
    const detail = stderrLines.length > 0 ? ` — ${stderrLines.join(' | ')}` : '';
    const cause = await diagnoseLostConnection(conn, opId, startedAt).catch(() => null);
    return { success: false, error: `${message}${detail}${cause ? ` Cauza: ${cause}.` : ''} Jurnal complet și cauza: tab-ul 📜 Log-uri.` };
  }
}

export async function performIncrementalBackup(
  conn: Connection,
  serverName: string,
  opId: string,
  lastBinlogFile?: string,
  lastBinlogPos?: number
): Promise<BackupResult> {
  ensureDirs(serverName);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `incremental_${timestamp}.sql.gz`;
  const filePath = path.join(getIncrementalBackupDir(serverName), fileName);

  const env = mysqlEnv(conn);
  const args = mysqlArgs(conn);

  try {
    if (!lastBinlogFile) {
      return { success: false, error: 'Nu există un backup full anterior. Rulează mai întâi un backup full.' };
    }

    // Find mysqlbinlog — on Debian Bookworm, MariaDB renamed it to mariadb-binlog
    let mysqlbinlogBin: string | null = null;
    for (const name of ['mysqlbinlog', 'mariadb-binlog']) {
      try {
        const { stdout } = await execAsync(`which ${name}`);
        if (stdout.trim()) { mysqlbinlogBin = name; break; }
      } catch { /* try next */ }
    }
    if (!mysqlbinlogBin) {
      // Last resort: check known absolute paths
      const knownPaths = [
        '/usr/bin/mysqlbinlog', '/usr/bin/mariadb-binlog',
        '/usr/local/bin/mysqlbinlog', '/usr/local/mysql/bin/mysqlbinlog',
        '/opt/homebrew/bin/mysqlbinlog',
      ];
      mysqlbinlogBin = knownPaths.find(p => fs.existsSync(p)) ?? null;
    }
    if (!mysqlbinlogBin) {
      return {
        success: false,
        error: 'mysqlbinlog (sau mariadb-binlog) nu a fost găsit. ' +
          'Asigură-te că aplicația rulează din containerul Docker (docker-compose up --build).'
      };
    }
    appendLog(opId, `mysqlbinlog bin: ${mysqlbinlogBin}`);

    appendLog(opId, `Conectare la ${conn.host}:${conn.port}...`);
    appendLog(opId, `Binlog de referință: ${lastBinlogFile}:${lastBinlogPos}`);

    await execAsync(`mysql ${args} -e "FLUSH LOGS;"`, { env });
    appendLog(opId, 'FLUSH LOGS executat — binlog curent rotit pentru a delimita intervalul.');

    const currentBinlog = await getBinlogInfo(conn);
    if (currentBinlog) appendLog(opId, `Binlog curent (nou): ${currentBinlog.file}:${currentBinlog.position}`);

    const { stdout: binlogList } = await execAsync(`mysql ${args} -e "SHOW BINARY LOGS" -s -N`, { env });

    const allLogs = binlogList.trim().split('\n').map(l => l.split('\t')[0].trim()).filter(Boolean);
    appendLog(opId, `Fișiere binlog disponibile: ${allLogs.join(', ')}`);

    const startIdx = allLogs.indexOf(lastBinlogFile);
    if (startIdx === -1) {
      return {
        success: false,
        error: `Fișierul binlog ${lastBinlogFile} nu mai există pe server (probabil expirat/purged). ` +
          'Rulează un backup full pentru a reseta punctul de referință.'
      };
    }

    const logsToBackup = allLogs.slice(startIdx, -1);
    if (logsToBackup.length === 0) {
      return {
        success: false,
        error: 'Nu există modificări noi față de ultimul backup. ' +
          'Nu au apărut scrieri în baza de date de la ultimul backup incremental. ' +
          'Încearcă după ce există activitate pe baza de date.'
      };
    }

    appendLog(opId, `Procesez ${logsToBackup.length} fișier(e) binlog: ${logsToBackup.join(', ')}`);

    const { stdout: dataDir } = await execAsync(`mysql ${args} -e "SELECT @@datadir" -s -N`, { env });
    const binlogDir = dataDir.trim();

    const startPosArg = lastBinlogPos ? `--start-position=${lastBinlogPos}` : '';
    const binlogFileList = logsToBackup.join(' ');

    // Prefer direct file access (faster, no extra privileges needed).
    // Falls back to --read-from-remote-server when binlog files are not accessible
    // locally (e.g. MySQL runs in a separate container or on a remote host).
    const firstFilePath = path.join(binlogDir, logsToBackup[0]);
    const useDirectAccess = fs.existsSync(firstFilePath);

    let cmd: string;
    if (useDirectAccess) {
      appendLog(opId, 'Citire binlog din fișiere locale...');
      const logPaths = logsToBackup.map(l => `"${path.join(binlogDir, l)}"`).join(' ');
      cmd = `"${mysqlbinlogBin}" ${startPosArg} --database=${conn.database_name} ${logPaths} | gzip > "${filePath}"`;
    } else {
      appendLog(opId, 'Fișierele binlog nu sunt accesibile local → citire via protocol MySQL remote (necesită REPLICATION SLAVE)...');
      cmd = `"${mysqlbinlogBin}" --read-from-remote-server ${args} ${startPosArg} --database=${conn.database_name} ${binlogFileList} | gzip > "${filePath}"`;
    }
    await execPipe(cmd, env, opId);

    const stat = fs.statSync(filePath);
    appendLog(opId, `Backup incremental finalizat. Dimensiune: ${formatBytes(stat.size)}`);

    return {
      success: true,
      filePath,
      fileSize: stat.size,
      binlogFile: currentBinlog?.file,
      binlogPos: currentBinlog?.position
    };
  } catch (err: unknown) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    const message = err instanceof Error ? err.message : String(err);
    appendLog(opId, `EROARE: ${message}`);
    // Include the last stderr lines so the user sees the real reason without opening logs
    const stderrLines = getLogs(opId)
      .filter(l => /error|ERROR|denied|unknown|failed|invalid/i.test(l))
      .slice(-3)
      .map(l => l.replace(/^\[\d{2}:\d{2}:\d{2}\] /, ''));
    const detail = stderrLines.length > 0 ? ` — ${stderrLines.join(' | ')}` : '';
    return { success: false, error: `${message}${detail} Jurnal complet și cauza: tab-ul 📜 Log-uri.` };
  }
}

// Ultima linie „ERROR …” a clientului mysql din jurnalul unei restaurări, pentru mesajul de eroare.
function lastMysqlError(opId: string): string {
  const line = getLogs(opId).filter(l => /ERROR \d+/.test(l)).pop();
  return line ? ` — ${line.replace(/^\[\d{2}:\d{2}:\d{2}\] /, '')}` : '';
}

// Nume permis pentru o bază de restaurare de verificare (folosit și în comanda shell, deci strict).
export const TARGET_DB_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const SYSTEM_DATABASES = ['mysql', 'sys', 'information_schema', 'performance_schema'];

export function isSystemDatabase(name: string): boolean {
  return SYSTEM_DATABASES.includes(name.toLowerCase());
}

// Câte tabele / view-uri are baza; null = baza nu există (sau user-ul nu o vede).
export async function countDatabaseTables(conn: Connection, database: string): Promise<number | null> {
  const rows = await mysqlQuery(conn,
    `SELECT COUNT(t.TABLE_NAME) FROM information_schema.SCHEMATA s LEFT JOIN information_schema.TABLES t ` +
    `ON t.TABLE_SCHEMA = s.SCHEMA_NAME WHERE s.SCHEMA_NAME = ${sqlStr(database)} GROUP BY s.SCHEMA_NAME`);
  return rows.length > 0 ? Number(rows[0][0]) : null;
}

// targetDatabase: altă bază decât cea a conexiunii (restaurare de verificare); se creează dacă nu există.
// Dump-ul full nu conține numele bazei (fără --databases), deci se poate aplica sub alt nume.
export async function restoreFullBackup(
  conn: Connection,
  filePath: string,
  opId: string,
  targetDatabase?: string
): Promise<BackupResult> {
  if (!fs.existsSync(filePath)) {
    return { success: false, error: `Fișierul de backup nu a fost găsit: ${filePath}` };
  }

  const env = mysqlEnv(conn);
  const args = mysqlArgs(conn);
  const fileName = path.basename(filePath);
  const database = targetDatabase || conn.database_name;

  try {
    appendLog(opId, `Conectare la ${conn.host}:${conn.port} ca ${conn.user}...`);
    appendLog(opId, `Restaurare fișier: ${fileName}`);
    if (database !== conn.database_name) {
      appendLog(opId, `Baza de date destinație: ${database} (restaurare de verificare; baza originală '${conn.database_name}' nu se modifică)`);
      try {
        await mysqlQuery(conn, `CREATE DATABASE IF NOT EXISTS ${sqlId(database)}`);
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        const line = (e.stderr || e.message || String(err)).split('\n').find(l => l.startsWith('ERROR')) || String(err);
        appendLog(opId, line);
        return {
          success: false,
          error: `Nu pot crea baza '${database}': ${line}. User-ul are nevoie de drepturi pe ea — ` +
            `ca root/admin: GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${conn.user}'@'%';`,
        };
      }
    } else {
      appendLog(opId, `Baza de date destinație: ${database}`);
    }
    appendLog(opId, 'Decompresat și aplicat SQL... (poate dura câteva minute)');

    const packet = getDumpOptions(conn.id).maxAllowedPacket ? MAX_PACKET_FLAG : '';
    const cmd = `gunzip -c "${filePath}" | mysql ${args} ${packet} ${database}`;
    await execPipe(cmd, env, opId);

    appendLog(opId, `Restaurare full completă cu succes în '${database}'.`);
    if (database !== conn.database_name) {
      // Event-urile vin active din dump: în copia de verificare ar rula singure pe serverul de producție
      try {
        const events = await mysqlQuery(conn, `SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ${sqlStr(database)} AND STATUS = 'ENABLED'`);
        for (const [name] of events) {
          await mysqlQuery(conn, `ALTER EVENT ${sqlId(database)}.${sqlId(name)} DISABLE`);
        }
        if (events.length > 0) {
          appendLog(opId, `Event-uri dezactivate în copie (ca să nu ruleze programat): ${events.map(([n]) => n).join(', ')}`);
        }
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        const line = (e.stderr || e.message || String(err)).split('\n').find(l => l.startsWith('ERROR')) || String(err);
        appendLog(opId, `ATENȚIE: nu am putut dezactiva event-urile din '${database}' (${line}) — vor rula programat; ` +
          `dezactivează-le manual: ALTER EVENT \`${database}\`.nume DISABLE;`);
      }
      appendLog(opId, `După verificare, baza se poate șterge (ca root/admin): DROP DATABASE \`${database}\`;`);
    }
    return { success: true, filePath };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const detail = lastMysqlError(opId);
    appendLog(opId, `EROARE la restaurare: ${message}`);
    return { success: false, error: message + detail };
  }
}

export async function restoreIncrementalBackup(
  conn: Connection,
  filePath: string,
  opId: string
): Promise<BackupResult> {
  if (!fs.existsSync(filePath)) {
    return { success: false, error: `Fișierul de backup nu a fost găsit: ${filePath}` };
  }

  const env = mysqlEnv(conn);
  const args = mysqlArgs(conn);
  const fileName = path.basename(filePath);

  try {
    appendLog(opId, `Conectare la ${conn.host}:${conn.port}...`);
    appendLog(opId, `Aplicare binlog incremental: ${fileName}`);
    appendLog(opId, 'Aplicare SQL din binlog...');

    const packet = getDumpOptions(conn.id).maxAllowedPacket ? MAX_PACKET_FLAG : '';
    const cmd = `gunzip -c "${filePath}" | mysql ${args} ${packet} ${conn.database_name}`;
    await execPipe(cmd, env, opId);

    appendLog(opId, 'Restaurare incrementală completă.');
    return { success: true, filePath };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const detail = lastMysqlError(opId);
    appendLog(opId, `EROARE la restaurare: ${message}`);
    return { success: false, error: message + detail };
  }
}

// Retenția lucrează pe lanțuri: un incremental se restaurează doar peste full-ul de dinaintea lui și peste
// toate incrementalele dintre ele (fiecare pornește de la poziția binlog a backup-ului anterior).
// - retenție N zile: se șterge doar ce a început înaintea „full-ului de bază” = cel mai nou full reușit
//   început cu cel puțin N zile în urmă. Orice moment din ultimele N zile rămâne restaurabil, iar cel mai
//   nou full nu se șterge niciodată (nici dacă full-urile eșuează de mult timp).
// - cleanupIncrementals: se șterg incrementalele începute înaintea celui mai nou full reușit (acoperite de el).
// logBackupId: backup-ul după care rulează curățarea; ce s-a șters se adaugă în jurnalul lui.
export async function cleanupBackups(
  connectionId: string,
  serverName: string,
  retentionDays: number,
  cleanupIncrementals: boolean,
  logBackupId?: string
) {
  const { deleteStoredBackup } = await import('./storageService');
  const db = getDb();
  const lines: string[] = [];
  const time = () => new Date().toTimeString().slice(0, 8);

  const remove = async (backups: Backup[], reason: string) => {
    for (const b of backups) {
      const warning = await deleteStoredBackup(connectionId, b);
      db.prepare('DELETE FROM backups WHERE id = ?').run(b.id);
      lines.push(`[${time()}] Curățare: șters ${b.type} din ${b.started_at} — ${reason}.${warning ? ` ${warning}` : ''}`);
    }
  };
  const newestFull = (beforeCutoffDays?: number) => db.prepare(`
    SELECT * FROM backups WHERE connection_id = ? AND type = 'full' AND status = 'success'
      ${beforeCutoffDays !== undefined ? "AND datetime(started_at) <= datetime('now', '-' || ? || ' days')" : ''}
    ORDER BY datetime(started_at) DESC LIMIT 1
  `).get(...(beforeCutoffDays !== undefined ? [connectionId, beforeCutoffDays] : [connectionId])) as Backup | undefined;

  if (retentionDays > 0) {
    const base = newestFull(retentionDays);
    if (base) {
      const old = db.prepare(`
        SELECT * FROM backups WHERE connection_id = ? AND status = 'success'
          AND datetime(started_at) < datetime(?)
      `).all(connectionId, base.started_at) as Backup[];
      await remove(old, `mai vechi de ${retentionDays} zile și înaintea full-ului din ${base.started_at}, de care depind backup-urile păstrate`);
    }
  }

  if (cleanupIncrementals) {
    const latest = newestFull();
    if (latest) {
      const covered = db.prepare(`
        SELECT * FROM backups WHERE connection_id = ? AND type = 'incremental' AND status = 'success'
          AND datetime(started_at) < datetime(?)
      `).all(connectionId, latest.started_at) as Backup[];
      await remove(covered, `incremental dinaintea ultimului full (${latest.started_at})`);
    }
  }

  if (lines.length > 0) {
    console.log(`[cleanup] ${serverName}: ${lines.length} backup-uri șterse`);
    if (logBackupId) {
      db.prepare("UPDATE backups SET logs = COALESCE(logs, '') || ? WHERE id = ?").run('\n' + lines.join('\n'), logBackupId);
    }
  }
}

export function getBackupFiles(serverName: string): {
  full: { name: string; path: string; size: number; mtime: string }[];
  incremental: { name: string; path: string; size: number; mtime: string }[];
} {
  const fullDir = getFullBackupDir(serverName);
  const incrDir = getIncrementalBackupDir(serverName);

  const readDir = (dir: string) => {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.sql.gz'))
      .map(f => {
        const fp = path.join(dir, f);
        const stat = fs.statSync(fp);
        return { name: f, path: fp, size: stat.size, mtime: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  };

  return { full: readDir(fullDir), incremental: readDir(incrDir) };
}

export function deleteBackupFile(filePath: string): boolean {
  try {
    if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); return true; }
    return false;
  } catch { return false; }
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
