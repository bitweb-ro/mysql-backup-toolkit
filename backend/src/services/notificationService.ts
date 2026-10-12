import { getSetting, setSetting } from '../db/database';

const SLACK_WEBHOOK_KEY = 'slack_webhook_url';

export function isSlackWebhookUrl(url: string): boolean {
  return /^https:\/\/hooks\.slack\.com\//.test(url);
}

// Webhook propriu al unui server (tab-ul Setări al serverului). Gol = folosește webhook-ul global.
function serverWebhookKey(connectionId: string): string {
  return `${SLACK_WEBHOOK_KEY}:${connectionId}`;
}

export function getServerSlackWebhookUrl(connectionId: string): string {
  return (getSetting(serverWebhookKey(connectionId)) || '').trim();
}

export function setServerSlackWebhookUrl(connectionId: string, url: string): void {
  setSetting(serverWebhookKey(connectionId), url.trim());
}

// Pentru mesajele unui server: webhook-ul propriu al serverului, dacă există, înlocuiește
// webhook-ul global. Altfel: webhook-ul din UI (Opțiuni platformă) are prioritate; ca fallback
// se folosește variabila de mediu SLACK_WEBHOOK_URL dacă există.
export function getSlackWebhookUrl(connectionId?: string): string | null {
  if (connectionId) {
    const own = getServerSlackWebhookUrl(connectionId);
    if (own) return own;
  }
  const fromDb = getSetting(SLACK_WEBHOOK_KEY);
  if (fromDb && fromDb.trim()) return fromDb.trim();
  const fromEnv = process.env.SLACK_WEBHOOK_URL;
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : null;
}

export function setSlackWebhookUrl(url: string): void {
  setSetting(SLACK_WEBHOOK_KEY, url.trim());
}

// Trimite un mesaj către Slack DOAR dacă un webhook este configurat.
// Nu aruncă niciodată — notificarea nu trebuie să blocheze sau să crape fluxul de backup.
// connectionId: mesajul ține de un server → se trimite pe webhook-ul lui, dacă are unul.
export async function notifySlack(text: string, connectionId?: string): Promise<void> {
  const url = getSlackWebhookUrl(connectionId);
  if (!url) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      console.error(`[slack] Notificare eșuată: HTTP ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.error('[slack] Notificare eșuată:', err instanceof Error ? err.message : String(err));
  }
}

// Trimite un mesaj de test și SURSEALĂ rezultatul (spre deosebire de notifySlack,
// aici aruncă dacă webhook-ul nu răspunde, ca utilizatorul să vadă problema în UI).
export async function testSlackWebhook(connectionId?: string): Promise<void> {
  const url = getSlackWebhookUrl(connectionId);
  if (!url) throw new Error('Niciun webhook Slack configurat.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '✅ Test notificare din MySQL Backup Manager — webhook-ul funcționează.' }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`Nu s-a putut contacta Slack: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    throw new Error(`Slack a răspuns cu HTTP ${res.status} ${res.statusText}.`);
  }
}

// Notificare standard pentru un backup eșuat.
export function notifyBackupFailure(opts: {
  connectionId: string;
  serverName: string;
  type: 'full' | 'incremental';
  error: string;
  scheduled?: boolean;
}): Promise<void> {
  const trigger = opts.scheduled ? 'programat' : 'manual';
  const text =
    `🔴 *Backup ${opts.type} eșuat* (${trigger})\n` +
    `• Server: *${opts.serverName}*\n` +
    `• Eroare: ${opts.error}\n` +
    `• Moment: ${new Date().toISOString()}`;
  return notifySlack(text, opts.connectionId);
}

// Backup reușit local, dar upload-ul pe destinația remote a eșuat (fișierul local e păstrat).
export function notifyUploadFailure(opts: {
  connectionId: string;
  serverName: string;
  type: 'full' | 'incremental';
  destination: string;
  error: string;
}): Promise<void> {
  const text =
    `🟠 *Upload backup ${opts.type} eșuat*\n` +
    `• Server: *${opts.serverName}*\n` +
    `• Destinație: ${opts.destination}\n` +
    `• Eroare: ${opts.error}\n` +
    `• Backup-ul a reușit și este păstrat local.\n` +
    `• Moment: ${new Date().toISOString()}`;
  return notifySlack(text, opts.connectionId);
}

// Notificare pentru o restaurare eșuată.
export function notifyRestoreFailure(opts: {
  connectionId: string;
  serverName: string;
  type: 'full' | 'incremental';
  error: string;
}): Promise<void> {
  const text =
    `🔴 *Restaurare ${opts.type} eșuată*\n` +
    `• Server: *${opts.serverName}*\n` +
    `• Eroare: ${opts.error}\n` +
    `• Moment: ${new Date().toISOString()}`;
  return notifySlack(text, opts.connectionId);
}

// Notificare pentru o eroare fatală a aplicației (crash).
export function notifyAppCrash(kind: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? (err.stack || err.message) : String(err);
  const text =
    `💥 *Aplicația de backup a întâmpinat o eroare fatală* (${kind})\n` +
    '```' + message.slice(0, 2500) + '```\n' +
    `• Moment: ${new Date().toISOString()}`;
  return notifySlack(text);
}
