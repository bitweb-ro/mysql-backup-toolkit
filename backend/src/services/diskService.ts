import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getSetting, setSetting } from '../db/database';
import { getBackupRoot, formatBytes } from './backupService';
import { notifySlack } from './notificationService';

const DISK_ALERT_KEY = 'disk_alert_min_free_gb';
// Ține minte dacă alerta a fost deja trimisă, ca să nu trimitem același mesaj
// după fiecare backup cât timp spațiul rămâne sub limită.
const DISK_ALERT_STATE_KEY = 'disk_alert_low';

const GB = 1024 ** 3;

const execFileAsync = promisify(execFile);

export interface DiskUsage {
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

// Spațiul discului pe care se află folderul de backup (BACKUP_PATH montat în container).
// Folosim `df -kP` și nu fs.statfs: Node expune doar f_bsize, dar numărul de blocuri e în
// unități de f_frsize. Pe bind mount-uri virtiofs/FUSE (Docker Desktop) f_bsize = 1 MiB și
// f_frsize = 4 KiB, deci statfs raporta valori de 256× mai mari. df folosește f_frsize corect.
// freeBytes = spațiul disponibil pentru utilizatori obișnuiți (fără blocurile rezervate pentru root).
export async function getDiskUsage(): Promise<DiskUsage> {
  const root = getBackupRoot();
  fs.mkdirSync(root, { recursive: true });
  const { stdout } = await execFileAsync('df', ['-kP', root]);
  const line = stdout.trim().split('\n').pop() || '';
  // Format POSIX: Filesystem 1024-blocks Used Available Capacity Mounted-on
  const m = line.match(/\s(\d+)\s+(\d+)\s+(\d+)\s+\d+%/);
  if (!m) throw new Error(`Output df neașteptat: ${line}`);
  const totalBytes = Number(m[1]) * 1024;
  const usedBytes = Number(m[2]) * 1024;
  const freeBytes = Number(m[3]) * 1024;
  return {
    path: root,
    totalBytes,
    freeBytes,
    usedBytes,
    usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
  };
}

// Limita minimă de spațiu liber (GB) sub care se trimite alertă. null = dezactivat.
export function getDiskAlertMinFreeGb(): number | null {
  const raw = getSetting(DISK_ALERT_KEY);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function setDiskAlertMinFreeGb(value: number | null): void {
  setSetting(DISK_ALERT_KEY, value && value > 0 ? String(value) : '');
  // La schimbarea limitei, resetează starea ca următoarea verificare să reevalueze de la zero.
  setSetting(DISK_ALERT_STATE_KEY, '0');
}

export function isDiskLow(usage: DiskUsage, minFreeGb: number | null): boolean {
  return minFreeGb !== null && usage.freeBytes < minFreeGb * GB;
}

let checkChain: Promise<void> = Promise.resolve();

// Verifică spațiul după terminarea unui backup (reușit sau eșuat) și trimite pe Slack:
// - o alertă când spațiul liber scade sub limită;
// - un mesaj de revenire când spațiul liber trece din nou peste limită.
// Verificările sunt serializate: backup-uri terminate simultan nu trimit alerte duplicate.
// Nu aruncă niciodată — nu trebuie să afecteze fluxul de backup.
export function checkDiskSpace(serverName?: string): Promise<void> {
  checkChain = checkChain.then(() => runDiskCheck(serverName)).catch(err => {
    console.error('[disk] Verificare spațiu eșuată:', err instanceof Error ? err.message : String(err));
  });
  return checkChain;
}

async function runDiskCheck(serverName?: string): Promise<void> {
  const minFreeGb = getDiskAlertMinFreeGb();
  if (minFreeGb === null) return;

  const usage = await getDiskUsage();
  const low = isDiskLow(usage, minFreeGb);
  const alreadyNotified = getSetting(DISK_ALERT_STATE_KEY) === '1';

  if (low && !alreadyNotified) {
    setSetting(DISK_ALERT_STATE_KEY, '1');
    await notifySlack(
      `🟠 *Spațiu pe disc insuficient pentru backup-uri*\n` +
      `• Liber: *${formatBytes(usage.freeBytes)}* din ${formatBytes(usage.totalBytes)} (${usage.usedPercent}% folosit)\n` +
      `• Limită setată: ${minFreeGb} GB liberi\n` +
      (serverName ? `• Detectat după backup-ul serverului: *${serverName}*\n` : '') +
      `• Moment: ${new Date().toISOString()}`
    );
  } else if (!low && alreadyNotified) {
    setSetting(DISK_ALERT_STATE_KEY, '0');
    await notifySlack(
      `🟢 *Spațiul pe disc a revenit peste limită*\n` +
      `• Liber: *${formatBytes(usage.freeBytes)}* din ${formatBytes(usage.totalBytes)}\n` +
      `• Limită setată: ${minFreeGb} GB liberi\n` +
      `• Moment: ${new Date().toISOString()}`
    );
  }
}
