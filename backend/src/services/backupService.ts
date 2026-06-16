import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { Connection, BackupResult, BinlogInfo } from '../types';

const execAsync = promisify(exec);

// process.cwd() is always backend/ (set by WORKDIR/working_dir in the
// Dockerfile and docker-compose files), while the BACKUP_PATH volume is
// mounted one level up, at <project-root>/backup_servers.
const BACKUP_ROOT = path.join(process.cwd(), '..', 'backup_servers');

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

export function getServerDir(serverName: string): string {
  const transliterated = serverName.replace(/[ăâîșşțţĂÂÎȘŞȚŢ]/g, c => DIACRITICS_MAP[c] || c);
  const safe = transliterated
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_');
  return path.join(BACKUP_ROOT, safe);
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
      if (code === 0 || code === 2) {
        // mysqldump exits with 2 for warnings (e.g. missing PROCESS privilege) — treat as success
        if (code === 2) appendLog(opId, 'WARN: mysqldump a finalizat cu avertismente (cod 2) — verifică log-ul pentru detalii.');
        resolve();
      } else if (code === 127) {
        reject(new Error('Comandă negăsită (cod 127): mysql-client nu este instalat sau nu este în PATH. Asigură-te că aplicația rulează din containerul Docker (docker-compose up).'));
      } else {
        reject(new Error(`Proces încheiat cu codul ${code} — verifică log-ul de mai sus pentru detalii.`));
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

export interface ValidationResult {
  canConnect: boolean;
  mysqlVersion: string | null;
  versionOk: boolean;
  binlogEnabled: boolean;
  binlogFormat: string | null;
  incrementalSupported: boolean;
  databaseExists: boolean;
  errors: string[];
}

export async function validateMySQLCapabilities(conn: Connection): Promise<ValidationResult> {
  const result: ValidationResult = {
    canConnect: false,
    mysqlVersion: null,
    versionOk: false,
    binlogEnabled: false,
    binlogFormat: null,
    incrementalSupported: false,
    databaseExists: false,
    errors: []
  };

  const env = mysqlEnv(conn);
  const args = mysqlArgs(conn);

  try {
    const { stdout } = await execAsync(`mysql ${args} -e "SELECT VERSION()" -s -N`, { env });
    result.canConnect = true;
    result.mysqlVersion = stdout.trim();
    const major = parseInt(result.mysqlVersion.split('.')[0]);
    result.versionOk = major >= 8;
    if (!result.versionOk) {
      result.errors.push(`MySQL ${result.mysqlVersion} detectat — versiunea minimă suportată este 8.0`);
    }
  } catch {
    result.errors.push('Nu se poate conecta la serverul MySQL. Verifică host, port, user și parolă.');
    return result;
  }

  try {
    const { stdout } = await execAsync(`mysql ${args} -e "SHOW VARIABLES LIKE 'log_bin'" -s -N`, { env });
    result.binlogEnabled = stdout.includes('ON');
    if (!result.binlogEnabled) {
      result.errors.push("log_bin dezactivat — backup incremental indisponibil. Activează log_bin în my.cnf.");
    }
  } catch {
    result.errors.push('Nu s-au putut verifica variabilele binlog.');
  }

  try {
    const { stdout } = await execAsync(`mysql ${args} -e "SHOW VARIABLES LIKE 'binlog_format'" -s -N`, { env });
    result.binlogFormat = stdout.trim().split(/\s+/)[1] || null;
  } catch { /* non-critical */ }

  try {
    const { stdout } = await execAsync(
      `mysql ${args} -e "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='${conn.database_name}'" -s -N`,
      { env }
    );
    result.databaseExists = stdout.trim() === conn.database_name;
    if (!result.databaseExists) {
      result.errors.push(`Baza de date '${conn.database_name}' nu există pe acest server.`);
    }
  } catch {
    result.errors.push('Nu s-a putut verifica existența bazei de date.');
  }

  // Check required backup privileges
  try {
    const { stdout } = await execAsync(
      `mysql ${args} -e "SHOW GRANTS FOR CURRENT_USER()" -s -N`,
      { env }
    );
    const grants = stdout.toUpperCase();
    const hasAll = grants.includes('ALL PRIVILEGES') || grants.includes('ALL ON *.*');
    const requiredPrivs = ['SELECT', 'PROCESS', 'LOCK TABLES', 'SHOW VIEW', 'TRIGGER', 'RELOAD'];
    const missingPrivs: string[] = [];
    if (!hasAll) {
      for (const priv of requiredPrivs) {
        if (!grants.includes(priv)) missingPrivs.push(priv);
      }
    }
    if (missingPrivs.length > 0) {
      result.errors.push(
        `Privilegii lipsă pentru backup: ${missingPrivs.join(', ')}. ` +
        `Rulează: GRANT ${missingPrivs.join(', ')} ON *.* TO '${conn.user}'@'%';`
      );
    }
    // REPLICATION SLAVE is required for incremental backup (mysqlbinlog --read-from-remote-server)
    const hasReplication = hasAll ||
      grants.includes('REPLICATION SLAVE') ||
      grants.includes('REPLICATION REPLICA') ||
      grants.includes('BINLOG_ADMIN');
    if (!hasReplication) {
      result.errors.push(
        `Lipsă privilegiu pentru backup incremental: REPLICATION SLAVE. ` +
        `Rulează: GRANT REPLICATION SLAVE ON *.* TO '${conn.user}'@'%'; FLUSH PRIVILEGES;`
      );
    }
  } catch { /* non-critical */ }

  result.incrementalSupported = result.binlogEnabled && result.versionOk;
  return result;
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

    appendLog(opId, `Rulare mysqldump pentru baza '${conn.database_name}'...`);
    // --no-tablespaces avoids "Access denied" on PROCESS privilege for tablespace dump (MySQL 8.0.21+)
    const cmd = `mysqldump ${args} --single-transaction --no-tablespaces --routines --triggers --events ${conn.database_name} | gzip > "${filePath}"`;
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
    return { success: false, error: message };
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
    return { success: false, error: message + detail };
  }
}

export async function restoreFullBackup(
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
    appendLog(opId, `Conectare la ${conn.host}:${conn.port} ca ${conn.user}...`);
    appendLog(opId, `Restaurare fișier: ${fileName}`);
    appendLog(opId, `Baza de date destinație: ${conn.database_name}`);
    appendLog(opId, 'Decompresat și aplicat SQL... (poate dura câteva minute)');

    const cmd = `gunzip -c "${filePath}" | mysql ${args} ${conn.database_name}`;
    await execPipe(cmd, env, opId);

    appendLog(opId, 'Restaurare full completă cu succes.');
    return { success: true, filePath };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    appendLog(opId, `EROARE la restaurare: ${message}`);
    return { success: false, error: message };
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

    const cmd = `gunzip -c "${filePath}" | mysql ${args} ${conn.database_name}`;
    await execPipe(cmd, env, opId);

    appendLog(opId, 'Restaurare incrementală completă.');
    return { success: true, filePath };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    appendLog(opId, `EROARE la restaurare: ${message}`);
    return { success: false, error: message };
  }
}

export async function cleanupBackups(
  connectionId: string,
  serverName: string,
  retentionDays: number,
  cleanupIncrementals: boolean
) {
  const { getDb } = await import('../db/database');
  const db = getDb();

  // Delete backups older than retention_days
  if (retentionDays > 0) {
    const old = db.prepare(`
      SELECT id, file_path FROM backups
      WHERE connection_id = ? AND status = 'success'
        AND datetime(completed_at) < datetime('now', '-' || ? || ' days')
    `).all(connectionId, retentionDays) as { id: string; file_path: string | null }[];

    for (const b of old) {
      if (b.file_path && fs.existsSync(b.file_path)) fs.unlinkSync(b.file_path);
      db.prepare('DELETE FROM backups WHERE id = ?').run(b.id);
    }
  }

  // Delete previous day's incrementals if a full backup exists for that day
  if (cleanupIncrementals) {
    const prevDayIncrementals = db.prepare(`
      SELECT b.id, b.file_path, date(b.started_at) as day FROM backups b
      WHERE b.connection_id = ? AND b.type = 'incremental' AND b.status = 'success'
        AND date(b.started_at) < date('now')
        AND EXISTS (
          SELECT 1 FROM backups f
          WHERE f.connection_id = ? AND f.type = 'full' AND f.status = 'success'
            AND date(f.started_at) = date(b.started_at)
        )
    `).all(connectionId, connectionId) as { id: string; file_path: string | null; day: string }[];

    for (const b of prevDayIncrementals) {
      if (b.file_path && fs.existsSync(b.file_path)) fs.unlinkSync(b.file_path);
      db.prepare('DELETE FROM backups WHERE id = ?').run(b.id);
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
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
