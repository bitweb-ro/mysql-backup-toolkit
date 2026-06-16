export function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
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

export function formatTime(iso: string): string {
  if (!iso) return '—';
  return parseUtc(iso).toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
}
