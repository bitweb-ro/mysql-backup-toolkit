export function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

// SQLite stores datetime('now') as 'YYYY-MM-DD HH:MM:SS' (UTC, no Z suffix).
// Without the Z, browsers parse it as local time, causing timezone offsets.
function parseUtc(iso: string): Date {
  const s = iso.replace(' ', 'T');
  return new Date(s.endsWith('Z') || s.includes('+') ? s : s + 'Z');
}

export function formatDate(iso: string): string {
  if (!iso) return '—';
  return parseUtc(iso).toLocaleString('ro-RO', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}

export function formatRelative(iso: string): string {
  if (!iso) return '—';
  const diff = Date.now() - parseUtc(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'acum câteva secunde';
  if (mins < 60) return `acum ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `acum ${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `acum ${days}z`;
}

// Starea unui server după ultimul backup reușit (full sau incremental), pentru bulina din sidebar.
// Ordinea din listă e și ordinea din legendă.
export const SERVER_STATUSES = [
  { key: 'running', color: 'var(--yellow)', label: 'Backup în curs' },
  { key: 'fresh', color: 'var(--green)', label: 'Backup în ultimele 48h' },
  { key: 'stale', color: 'var(--purple)', label: 'Fără backup de peste 48h' },
  { key: 'old', color: 'var(--red)', label: 'Fără backup de peste 7 zile / niciodată' },
] as const;

export function serverStatus(running: boolean, lastBackupAt: string | null) {
  const byKey = (k: typeof SERVER_STATUSES[number]['key']) => SERVER_STATUSES.find(s => s.key === k)!;
  if (running) return byKey('running');
  if (!lastBackupAt) return byKey('old');
  const hours = (Date.now() - parseUtc(lastBackupAt).getTime()) / 3600000;
  if (hours <= 48) return byKey('fresh');
  if (hours <= 24 * 7) return byKey('stale');
  return byKey('old');
}

export function formatTime(iso: string): string {
  if (!iso) return '—';
  return parseUtc(iso).toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
}
