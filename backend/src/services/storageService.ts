import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import SftpClient from 'ssh2-sftp-client';
import * as ftp from 'basic-ftp';
import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getDb, getSetting, setSetting } from '../db/database';
import { appendLog, getBackupRoot, getServerSlug, formatBytes } from './backupService';
import { notifyUploadFailure } from './notificationService';
import {
  Backup, BackupResult, Connection, StorageConfig, StorageType,
  SftpStorage, FtpStorage, S3Storage,
} from '../types';

const DEFAULT_STORAGE_KEY = 'storage_default';

// Valoarea trimisă către UI în locul secretelor salvate. Dacă UI-ul o trimite
// înapoi neschimbată, secretul existent se păstrează.
export const SECRET_MASK = '••••••••';

const LOCAL_STORAGE: StorageConfig = { type: 'local', keepLocal: true };
const STORAGE_TYPES: StorageType[] = ['local', 'sftp', 'ftp', 's3'];

// ─── Configurație ─────────────────────────────────────────────────

function parseStored(raw: string | null | undefined): StorageConfig | null {
  if (!raw) return null;
  try {
    const cfg = JSON.parse(raw) as StorageConfig;
    return STORAGE_TYPES.includes(cfg.type) ? cfg : null;
  } catch {
    return null;
  }
}

// Destinația implicită din Opțiuni. Fără configurare = local.
export function getDefaultStorageConfig(): StorageConfig {
  return parseStored(getSetting(DEFAULT_STORAGE_KEY)) ?? LOCAL_STORAGE;
}

export function setDefaultStorageConfig(cfg: StorageConfig): void {
  setSetting(DEFAULT_STORAGE_KEY, JSON.stringify(cfg));
}

// Destinația proprie a serverului; null = folosește destinația implicită.
export function getServerStorageConfig(conn: Connection): StorageConfig | null {
  return parseStored(conn.storage_config);
}

export function resolveStorageConfig(conn: Connection): StorageConfig {
  return getServerStorageConfig(conn) ?? getDefaultStorageConfig();
}

// Copie a configurației cu secretele înlocuite de SECRET_MASK, pentru UI.
export function maskStorageConfig(cfg: StorageConfig): StorageConfig {
  const mask = (v: string) => (v ? SECRET_MASK : '');
  return {
    ...cfg,
    sftp: cfg.sftp && { ...cfg.sftp, password: mask(cfg.sftp.password), privateKey: mask(cfg.sftp.privateKey), passphrase: mask(cfg.sftp.passphrase) },
    ftp: cfg.ftp && { ...cfg.ftp, password: mask(cfg.ftp.password) },
    s3: cfg.s3 && { ...cfg.s3, secretAccessKey: mask(cfg.s3.secretAccessKey) },
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function parsePort(v: unknown, def: number): number | null {
  const n = v === undefined || v === null || v === '' ? def : Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

// Gol, „/” sau „.”: backup-urile ar ajunge direct în rădăcină (pe Synology/NAS nu se poate scrie acolo).
function isRootDir(dir: string): boolean {
  return /^[\s/.]*$/.test(dir);
}

const ROOT_DIR_ERROR =
  'completează „Director remote” cu un folder, nu „/”. Pe Synology/NAS: un shared folder existent ' +
  '(ex: /backup-databases-mysql); subfolderele se creează automat.';

// SECRET_MASK = păstrează secretul salvat anterior.
function secret(incoming: unknown, previous: string | undefined): string {
  if (incoming === SECRET_MASK) return previous ?? '';
  return typeof incoming === 'string' ? incoming : '';
}

// Validează configurația primită din UI și o completează cu secretele existente.
// Se validează doar tipul activ; setările celorlalte tipuri se păstrează așa cum sunt.
export function parseStorageConfigInput(
  input: unknown,
  existing: StorageConfig | null
): { config: StorageConfig } | { error: string } {
  if (!input || typeof input !== 'object') return { error: 'Configurație de stocare invalidă.' };
  const i = input as Record<string, unknown>;
  const type = i.type as StorageType;
  if (!STORAGE_TYPES.includes(type)) {
    return { error: 'Tip de stocare invalid. Valori permise: local, sftp, ftp, s3.' };
  }

  const cfg: StorageConfig = { type, keepLocal: type === 'local' ? true : i.keepLocal !== false };

  if (i.sftp && typeof i.sftp === 'object') {
    const s = i.sftp as Record<string, unknown>;
    const prev = existing?.sftp;
    const port = parsePort(s.port, 22);
    if (port === null && type === 'sftp') return { error: 'Port SFTP invalid (1-65535).' };
    cfg.sftp = {
      host: str(s.host),
      port: port ?? 22,
      username: str(s.username),
      password: secret(s.password, prev?.password),
      privateKey: secret(s.privateKey, prev?.privateKey),
      passphrase: secret(s.passphrase, prev?.passphrase),
      remoteDir: str(s.remoteDir),
    };
  }

  if (i.ftp && typeof i.ftp === 'object') {
    const f = i.ftp as Record<string, unknown>;
    const port = parsePort(f.port, 21);
    if (port === null && type === 'ftp') return { error: 'Port FTP invalid (1-65535).' };
    cfg.ftp = {
      host: str(f.host),
      port: port ?? 21,
      username: str(f.username),
      password: secret(f.password, existing?.ftp?.password),
      secure: f.secure === true,
      allowSelfSigned: f.secure === true && f.allowSelfSigned === true,
      remoteDir: str(f.remoteDir),
    };
  }

  if (i.s3 && typeof i.s3 === 'object') {
    const s = i.s3 as Record<string, unknown>;
    cfg.s3 = {
      endpoint: str(s.endpoint),
      region: str(s.region),
      bucket: str(s.bucket),
      accessKeyId: str(s.accessKeyId),
      secretAccessKey: secret(s.secretAccessKey, existing?.s3?.secretAccessKey),
      prefix: str(s.prefix),
      forcePathStyle: s.forcePathStyle === true,
    };
  }

  if (type === 'sftp') {
    const s = cfg.sftp;
    if (!s || !s.host || !s.username) return { error: 'SFTP: completează host și utilizator.' };
    if (!s.password && !s.privateKey.trim()) return { error: 'SFTP: completează parola sau cheia privată.' };
    if (isRootDir(s.remoteDir)) return { error: `SFTP: ${ROOT_DIR_ERROR}` };
  }
  if (type === 'ftp') {
    const f = cfg.ftp;
    if (!f || !f.host || !f.username) return { error: 'FTP: completează host și utilizator.' };
    if (isRootDir(f.remoteDir)) return { error: `FTP: ${ROOT_DIR_ERROR}` };
  }
  if (type === 's3') {
    const s = cfg.s3;
    if (!s || !s.bucket || !s.accessKeyId || !s.secretAccessKey) {
      return { error: 'S3: completează bucket, Access Key ID și Secret Access Key.' };
    }
    if (s.endpoint && !/^https?:\/\//.test(s.endpoint)) {
      return { error: 'S3: endpoint-ul trebuie să înceapă cu http:// sau https://.' };
    }
  }

  return { config: cfg };
}

// Descriere scurtă pentru log-uri, Slack și UI. Nu conține secrete.
export function describeStorage(cfg: StorageConfig): string {
  switch (cfg.type) {
    case 'sftp': return `SFTP ${cfg.sftp?.username}@${cfg.sftp?.host}:${cfg.sftp?.port}`;
    case 'ftp': return `${cfg.ftp?.secure ? 'FTPS' : 'FTP'} ${cfg.ftp?.username}@${cfg.ftp?.host}:${cfg.ftp?.port}`;
    case 's3': return `S3 ${cfg.s3?.bucket}${cfg.s3?.endpoint ? ` (${cfg.s3.endpoint})` : ''}`;
    default: return 'local';
  }
}

// Cale sub directorul remote (SFTP/FTP) sau prefixul S3. Cheile S3 nu încep cu „/”.
function remoteJoin(cfg: StorageConfig, ...parts: string[]): string {
  const base = cfg.type === 's3' ? cfg.s3?.prefix : cfg.type === 'sftp' ? cfg.sftp?.remoteDir : cfg.ftp?.remoteDir;
  const p = path.posix.join(base || '', ...parts);
  return cfg.type === 's3' ? p.replace(/^\/+/, '') : p;
}

// <director remote | prefix S3>/<server>/<full|incremental>/<fișier>, ca local.
function remotePathFor(cfg: StorageConfig, serverName: string, kind: 'full' | 'incremental', fileName: string): string {
  return remoteJoin(cfg, getServerSlug(serverName), kind, fileName);
}

// ─── Drivere remote ───────────────────────────────────────────────

interface RemoteDriver {
  upload(localPath: string, remotePath: string): Promise<void>;
  download(remotePath: string, localPath: string): Promise<void>;
  remove(remotePath: string): Promise<void>;
}

// Deschide o conexiune la destinație, rulează fn și închide conexiunea.
function withDriver<T>(cfg: StorageConfig, fn: (d: RemoteDriver) => Promise<T>): Promise<T> {
  switch (cfg.type) {
    case 'sftp': return withSftp(cfg.sftp!, fn);
    case 'ftp': return withFtp(cfg.ftp!, fn);
    case 's3': return withS3(cfg.s3!, fn);
    default: throw new Error('Destinația locală nu are operații remote.');
  }
}

async function withSftp<T>(c: SftpStorage, fn: (d: RemoteDriver) => Promise<T>): Promise<T> {
  const client = new SftpClient();
  try {
    await client.connect({
      host: c.host,
      port: c.port,
      username: c.username,
      password: c.password || undefined,
      privateKey: c.privateKey.trim() ? c.privateKey : undefined,
      passphrase: c.passphrase || undefined,
      readyTimeout: 20000,
    });
    return await fn({
      upload: async (local, remote) => {
        const dir = path.posix.dirname(remote);
        if (!(await client.exists(dir))) {
          try {
            await client.mkdir(dir, true);
          } catch (err) {
            throw mkdirError(dir, err, await sftpRootDirs(client));
          }
        }
        await client.put(local, remote);
      },
      download: async (remote, local) => { await client.get(remote, local); },
      remove: async remote => { await client.delete(remote, true); },
    });
  } finally {
    await client.end().catch(() => { /* conexiunea poate fi deja închisă */ });
  }
}

// Eroare pentru un folder remote care nu a putut fi creat. Pe Synology/NAS, în „/” sunt doar
// shared folder-ele, care nu se pot crea prin SFTP/FTP. rootDirs = folderele vizibile în „/”.
function mkdirError(dir: string, err: unknown, rootDirs: string[] | null): Error {
  return new Error(
    `Folderul ${dir} nu există și nu a putut fi creat (${err instanceof Error ? err.message : String(err)}). ` +
    'Verifică dreptul de scriere al userului. Pe Synology/NAS, primul nivel din cale trebuie să fie ' +
    'un shared folder existent; subfolderele se creează automat. ' +
    (rootDirs?.length
      ? `Foldere disponibile în „/” pentru acest user: ${rootDirs.join(', ')}.`
      : 'Niciun folder vizibil în „/” pentru acest user: verifică permisiunile pe shared folder.')
  );
}

// Folderele din rădăcina SFTP / FTP, pentru mkdirError; null dacă nu se pot lista.
async function sftpRootDirs(client: SftpClient): Promise<string[] | null> {
  try {
    return (await client.list('/')).filter(f => f.type === 'd').map(f => `/${f.name}`);
  } catch {
    return null;
  }
}

async function ftpRootDirs(client: ftp.Client): Promise<string[] | null> {
  try {
    return (await client.list('/')).filter(f => f.isDirectory).map(f => `/${f.name}`);
  } catch {
    return null;
  }
}

async function withFtp<T>(c: FtpStorage, fn: (d: RemoteDriver) => Promise<T>): Promise<T> {
  const client = new ftp.Client(30000);
  try {
    await client.access({
      host: c.host, port: c.port, user: c.username, password: c.password, secure: c.secure,
      secureOptions: c.secure && c.allowSelfSigned ? { rejectUnauthorized: false } : undefined,
    });
    // ensureDir schimbă directorul curent, deci căile relative se rezolvă față de directorul de login.
    const home = await client.pwd();
    const abs = (p: string) => (p.startsWith('/') ? p : path.posix.join(home, p));
    return await fn({
      upload: async (local, remote) => {
        const dir = path.posix.dirname(abs(remote));
        try {
          await client.ensureDir(dir);
        } catch (err) {
          throw mkdirError(dir, err, await ftpRootDirs(client));
        }
        await client.uploadFrom(local, abs(remote));
      },
      download: async (remote, local) => { await client.downloadTo(local, abs(remote)); },
      remove: async remote => { await client.remove(abs(remote), true); },
    });
  } finally {
    client.close();
  }
}

async function withS3<T>(c: S3Storage, fn: (d: RemoteDriver) => Promise<T>): Promise<T> {
  const client = new S3Client({
    region: c.region || 'us-east-1',
    endpoint: c.endpoint || undefined,
    forcePathStyle: c.forcePathStyle,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
    // Checksum-urile implicite ale SDK-ului nu sunt acceptate de toți furnizorii S3-compatibili.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  try {
    return await fn({
      upload: async (local, key) => {
        await new Upload({
          client,
          params: { Bucket: c.bucket, Key: key, Body: fs.createReadStream(local), ContentType: 'application/gzip' },
        }).done();
      },
      download: async (key, local) => {
        const r = await client.send(new GetObjectCommand({ Bucket: c.bucket, Key: key }));
        if (!r.Body) throw new Error(`Obiectul S3 ${key} este gol.`);
        await pipeline(r.Body as Readable, fs.createWriteStream(local));
      },
      remove: async key => { await client.send(new DeleteObjectCommand({ Bucket: c.bucket, Key: key })); },
    });
  } finally {
    client.destroy();
  }
}

// Explicații pentru erorile SFTP frecvente (cauza e de obicei pe serverul destinație, nu în aplicație)
const STORAGE_HINTS: [RegExp, string][] = [
  [/Unable to start subsystem: sftp/i,
    'Login-ul SSH reușește, dar serverul nu pornește SFTP pentru acest user. Pe server, în /etc/ssh/sshd_config: ' +
    '„Subsystem sftp internal-sftp” (sau instalează pachetul openssh-sftp-server); dacă user-ul are un bloc „Match User”, ' +
    'acolo trebuie „ForceCommand internal-sftp” sau niciun ForceCommand. Apoi: sudo sshd -t && sudo systemctl reload ssh.'],
  [/All configured authentication methods failed/i,
    'User, parolă sau cheie greșite, ori serverul SSH nu permite metoda folosită (ex: PasswordAuthentication no). ' +
    'Dacă parola apare ca „••••••••”, se folosește parola salvată anterior: dacă ai schimbat-o pe server, rescrie-o.'],
  [/^530 /,
    'User sau parolă greșite. Dacă parola apare ca „••••••••”, se folosește parola salvată anterior: ' +
    'dacă ai schimbat-o pe server, rescrie-o.'],
  [/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|Timed out while waiting for handshake/i,
    'Serverul nu răspunde pe acest port: verifică host-ul, portul și firewall-ul pentru IP-ul aplicației.'],
  [/unable to verify the first certificate|self[- ]signed certificate|unable to get local issuer certificate/i,
    'Certificatul TLS al serverului FTPS nu este de încredere (ex: certificatul implicit Synology). ' +
    'Bifează „Acceptă certificat self-signed” sau instalează pe server un certificat valid.'],
  [/^553 .*Permission denied/i,
    'Userul nu are drept de scriere în acest folder. Pe Synology/NAS, la „Director remote” pune un shared folder (ex: /backup-databases-mysql), nu „/”.'],
  [/TLS\/SSL protection required/i,
    'Serverul cere conexiune criptată: bifează „FTPS (TLS explicit)”.'],
];

function errMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const hint = STORAGE_HINTS.find(([re]) => re.test(message));
  return hint ? `${message} — ${hint[1]}` : message;
}

function tmpDir(): string {
  const dir = path.join(getBackupRoot(), '.tmp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Operații folosite de backup / restore / ștergere ─────────────

// Trimite fișierul unui backup reușit pe destinația serverului.
// Upload eșuat = backup-ul rămâne reușit, fișierul local se păstrează, alertă pe Slack.
// Nu aruncă niciodată.
export async function storeBackup(
  conn: Connection,
  kind: 'full' | 'incremental',
  result: BackupResult,
  opId: string
): Promise<BackupResult> {
  const cfg = resolveStorageConfig(conn);
  if (cfg.type === 'local' || !result.filePath) return { ...result, storageType: 'local' };

  const label = describeStorage(cfg);
  const remotePath = remotePathFor(cfg, conn.name, kind, path.basename(result.filePath));
  appendLog(opId, `Upload către ${label}: ${remotePath}...`);

  try {
    const started = Date.now();
    await withDriver(cfg, d => d.upload(result.filePath!, remotePath));
    appendLog(opId, `Upload finalizat în ${Math.round((Date.now() - started) / 1000)}s.`);

    if (!cfg.keepLocal) {
      fs.rmSync(result.filePath, { force: true });
      appendLog(opId, 'Copia locală a fost ștearsă („Păstrează și copia locală” este dezactivat).');
      return { ...result, filePath: undefined, storageType: cfg.type, remotePath };
    }
    return { ...result, storageType: cfg.type, remotePath };
  } catch (err) {
    const message = errMessage(err);
    appendLog(opId, `EROARE upload către ${label}: ${message}. Fișierul local este păstrat.`);
    notifyUploadFailure({ connectionId: conn.id, serverName: conn.name, type: kind, destination: label, error: message });
    return { ...result, storageType: 'local', storageError: `Upload către ${label} eșuat: ${message}` };
  }
}

// Credențialele pentru un backup remote existent: configurația serverului sau cea implicită,
// prima care are același tip ca destinația pe care a fost salvat backup-ul.
function configForBackup(connectionId: string, backup: Backup): StorageConfig {
  const conn = getDb().prepare('SELECT * FROM connections WHERE id = ?').get(connectionId) as Connection | undefined;
  const candidates = [conn ? getServerStorageConfig(conn) : null, getDefaultStorageConfig()];
  const match = candidates.find(c => c && c.type === backup.storage_type);
  if (!match) {
    throw new Error(
      `Backup-ul este salvat pe ${String(backup.storage_type).toUpperCase()}, ` +
      'dar această destinație nu mai este configurată (nici pe server, nici ca implicită).'
    );
  }
  return match;
}

function isRemote(backup: Backup): boolean {
  return !!backup.remote_path && !!backup.storage_type && backup.storage_type !== 'local';
}

// Calea unui fișier local cu backup-ul: fișierul local dacă există, altfel îl descarcă
// temporar de pe destinația remote. cleanup() șterge fișierul temporar.
export async function getLocalCopy(
  connectionId: string,
  backup: Backup,
  opId?: string
): Promise<{ path: string; cleanup: () => void }> {
  if (backup.file_path && fs.existsSync(backup.file_path)) {
    return { path: backup.file_path, cleanup: () => { /* fișier permanent */ } };
  }
  if (!isRemote(backup)) {
    throw new Error(`Fișierul de backup nu mai există pe disc${backup.file_path ? `: ${backup.file_path}` : ''}.`);
  }

  const cfg = configForBackup(connectionId, backup);
  const label = describeStorage(cfg);
  const tmp = path.join(tmpDir(), `${randomUUID()}_${path.posix.basename(backup.remote_path!)}`);
  if (opId) appendLog(opId, `Descărcare de pe ${label}: ${backup.remote_path}...`);
  try {
    await withDriver(cfg, d => d.download(backup.remote_path!, tmp));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`Descărcarea de pe ${label} a eșuat: ${errMessage(err)}`);
  }
  if (opId) appendLog(opId, `Descărcat: ${formatBytes(fs.statSync(tmp).size)}.`);
  return { path: tmp, cleanup: () => fs.rmSync(tmp, { force: true }) };
}

// Șterge fișierele unui backup: local și de pe destinația remote.
// Eroarea remote nu oprește ștergerea; se întoarce ca avertizare (null = totul ok).
export async function deleteStoredBackup(connectionId: string, backup: Backup): Promise<string | null> {
  if (backup.file_path) fs.rmSync(backup.file_path, { force: true });
  if (!isRemote(backup)) return null;
  try {
    const cfg = configForBackup(connectionId, backup);
    await withDriver(cfg, d => d.remove(backup.remote_path!));
    return null;
  } catch (err) {
    const message = `Fișierul remote ${backup.remote_path} nu a putut fi șters: ${errMessage(err)}`;
    console.error(`[storage] ${message}`);
    return message;
  }
}

// Verifică o destinație: urcă un fișier mic de test și îl șterge.
export async function testStorage(cfg: StorageConfig): Promise<string> {
  if (cfg.type === 'local') {
    fs.accessSync(getBackupRoot(), fs.constants.W_OK);
    return 'Folderul local de backup are drept de scriere.';
  }
  const local = path.join(tmpDir(), `test_${randomUUID()}.txt`);
  fs.writeFileSync(local, `Test MySQL Backup Manager ${new Date().toISOString()}\n`);
  const remote = remoteJoin(cfg, `.mysql-backup-test_${path.basename(local)}`);
  try {
    await withDriver(cfg, async d => {
      await d.upload(local, remote);
      await d.remove(remote);
    });
    return `Conexiune reușită la ${describeStorage(cfg)}: fișierul de test a fost urcat și șters.`;
  } catch (err) {
    throw new Error(`Test eșuat pentru ${describeStorage(cfg)}: ${errMessage(err)}`);
  } finally {
    fs.rmSync(local, { force: true });
  }
}
