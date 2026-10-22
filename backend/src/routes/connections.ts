import { Router, Request, Response } from 'express';
import { randomUUID as uuidv4 } from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDb } from '../db/database';
import {
  testConnection, validateMySQLCapabilities, getServerDir, getDumpOptions, setDumpOptions, TABLE_NAME_PATTERN,
} from '../services/backupService';
import {
  getServerStorageConfig, getDefaultStorageConfig, maskStorageConfig, describeStorage,
  parseStorageConfigInput, testStorage, deleteStoredBackup, getLocalCopy,
} from '../services/storageService';
import {
  getSlackWebhookUrl, getServerSlackWebhookUrl, setServerSlackWebhookUrl, isSlackWebhookUrl, testSlackWebhook,
} from '../services/notificationService';
import { Connection, Backup } from '../types';

const router = Router();

// storage_config conține secrete (parole SFTP/FTP, chei S3): se expune doar mascat, prin /:id/storage.
export function publicConnection(conn: Connection): Omit<Connection, 'storage_config'> {
  const { storage_config: _omit, ...rest } = conn;
  return rest;
}

router.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const connections = db.prepare('SELECT * FROM connections ORDER BY name ASC').all() as Connection[];
  res.json(connections.map(publicConnection));
});

router.get('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(req.params.id) as Connection | undefined;
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  res.json(publicConnection(conn));
});

// Destinația backup-urilor pentru acest server. config = null → folosește destinația implicită.
router.get('/:id/storage', (req: Request, res: Response) => {
  const db = getDb();
  const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(req.params.id) as Connection | undefined;
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  const own = getServerStorageConfig(conn);
  const def = getDefaultStorageConfig();
  res.json({
    config: own ? maskStorageConfig(own) : null,
    defaultDescription: describeStorage(def),
    activeDescription: describeStorage(own ?? def),
  });
});

// Webhook Slack propriu serverului. Gol = alertele serverului merg pe webhook-ul global.
router.get('/:id/slack', (req: Request, res: Response) => {
  const db = getDb();
  const conn = db.prepare('SELECT id FROM connections WHERE id = ?').get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  res.json({
    slackWebhookUrl: getServerSlackWebhookUrl(req.params.id),
    globalConfigured: !!getSlackWebhookUrl(),
  });
});

router.put('/:id/slack', (req: Request, res: Response) => {
  const db = getDb();
  const conn = db.prepare('SELECT id FROM connections WHERE id = ?').get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  const { slackWebhookUrl } = req.body || {};
  if (typeof slackWebhookUrl !== 'string') {
    return res.status(400).json({ error: 'slackWebhookUrl trebuie să fie un string.' });
  }
  const url = slackWebhookUrl.trim();
  if (url && !isSlackWebhookUrl(url)) {
    return res.status(400).json({ error: 'URL invalid. Trebuie să fie un Slack Incoming Webhook (https://hooks.slack.com/...).' });
  }
  setServerSlackWebhookUrl(req.params.id, url);
  res.json({ success: true, slackWebhookUrl: url });
});

// Trimite un mesaj de test pe webhook-ul folosit de acest server (propriu sau global).
router.post('/:id/slack/test', async (req: Request, res: Response) => {
  try {
    await testSlackWebhook(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Test eșuat.' });
  }
});

// Opțiunile mysqldump ale serverului (activate din tab-ul Setări, cu confirmare în UI).
router.get('/:id/dump-options', (req: Request, res: Response) => {
  const db = getDb();
  const conn = db.prepare('SELECT id FROM connections WHERE id = ?').get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  res.json(getDumpOptions(req.params.id));
});

// Body parțial: { gtidPurgedOff?: boolean, maxAllowedPacket?: boolean, ignoreTables?: string[] };
// câmpurile lipsă rămân neschimbate.
router.put('/:id/dump-options', (req: Request, res: Response) => {
  const db = getDb();
  const conn = db.prepare('SELECT id FROM connections WHERE id = ?').get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  const body = req.body || {};
  const current = getDumpOptions(req.params.id);
  for (const key of ['gtidPurgedOff', 'maxAllowedPacket'] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') return res.status(400).json({ error: `${key} trebuie să fie true sau false.` });
    current[key] = body[key];
  }
  if (body.ignoreTables !== undefined) {
    const tables: unknown = body.ignoreTables;
    if (!Array.isArray(tables) || tables.length > 50) {
      return res.status(400).json({ error: 'ignoreTables trebuie să fie o listă de cel mult 50 de tabele.' });
    }
    const invalid = tables.filter(t => typeof t !== 'string' || !TABLE_NAME_PATTERN.test(t));
    if (invalid.length > 0) {
      return res.status(400).json({ error: `Nume de tabel invalid: ${invalid.map(String).join(', ')} (doar litere, cifre, _ și $).` });
    }
    current.ignoreTables = [...new Set(tables as string[])];
  }
  setDumpOptions(req.params.id, current);
  res.json(current);
});

// Salvează destinația serverului. Body: { config: StorageConfig | null }; null = revine la implicită.
router.put('/:id/storage', (req: Request, res: Response) => {
  const db = getDb();
  const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(req.params.id) as Connection | undefined;
  if (!conn) return res.status(404).json({ error: 'Connection not found' });

  const { config } = req.body || {};
  if (config === null) {
    db.prepare("UPDATE connections SET storage_config = NULL, updated_at = datetime('now') WHERE id = ?").run(conn.id);
    return res.json({ success: true, config: null });
  }
  const parsed = parseStorageConfigInput(config, getServerStorageConfig(conn));
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  db.prepare("UPDATE connections SET storage_config = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(parsed.config), conn.id);
  res.json({ success: true, config: maskStorageConfig(parsed.config) });
});

// Testează configurația din formular (nesalvată); secretele mascate se iau din configurația salvată.
router.post('/:id/storage/test', async (req: Request, res: Response) => {
  const db = getDb();
  const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(req.params.id) as Connection | undefined;
  if (!conn) return res.status(404).json({ error: 'Connection not found' });

  const parsed = parseStorageConfigInput(req.body?.config, getServerStorageConfig(conn));
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  try {
    res.json({ success: true, message: await testStorage(parsed.config) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Test eșuat.' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  const { name, host, port, user, password, database_name } = req.body;
  if (!name || !host || !user || !password || !database_name) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const db = getDb();
  const id = uuidv4();
  db.prepare(`
    INSERT INTO connections (id, name, host, port, user, password, database_name)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, host, port || 3306, user, password, database_name);
  const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as Connection;
  res.status(201).json(publicConnection(conn));
});

router.put('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM connections WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Connection not found' });
  const { name, host, port, user, password, database_name } = req.body;
  db.prepare(`
    UPDATE connections SET name=?, host=?, port=?, user=?, password=?, database_name=?, updated_at=datetime('now')
    WHERE id=?
  `).run(name, host, port || 3306, user, password, database_name, req.params.id);
  const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(req.params.id) as Connection;
  res.json(publicConnection(conn));
});

// Redenumește serverul. Folderul local de backup e derivat din nume, deci se mută și el,
// împreună cu căile fișierelor din istoric. Pe destinațiile remote backup-urile vechi rămân
// unde sunt (calea e salvată per backup); cele noi merg în folderul cu numele nou.
router.put('/:id/name', (req: Request, res: Response) => {
  const db = getDb();
  const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(req.params.id) as Connection | undefined;
  if (!conn) return res.status(404).json({ error: 'Connection not found' });

  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'Numele serverului nu poate fi gol.' });
  if (name === conn.name) return res.json(publicConnection(conn));

  const running = db.prepare("SELECT 1 FROM backups WHERE connection_id = ? AND status = 'running'").get(conn.id);
  if (running) {
    return res.status(409).json({ error: 'Un backup rulează acum pentru acest server. Redenumește după ce se termină.' });
  }

  const oldDir = getServerDir(conn.name);
  const newDir = getServerDir(name);
  if (newDir !== oldDir) {
    const others = db.prepare('SELECT name FROM connections WHERE id != ?').all(conn.id) as { name: string }[];
    const clash = others.find(o => getServerDir(o.name) === newDir);
    if (clash) {
      return res.status(409).json({ error: `Numele „${name}” ar folosi același folder de backup ca serverul „${clash.name}”. Alege alt nume.` });
    }
    if (fs.existsSync(newDir)) {
      return res.status(409).json({ error: `Folderul backup_servers/${path.basename(newDir)} există deja. Alege alt nume sau mută folderul manual.` });
    }
  }

  const moveDir = newDir !== oldDir && fs.existsSync(oldDir);
  if (moveDir) fs.renameSync(oldDir, newDir);
  try {
    db.transaction(() => {
      db.prepare("UPDATE connections SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name, conn.id);
      if (moveDir) {
        const prefix = oldDir + path.sep;
        db.prepare(`
          UPDATE backups SET file_path = ? || substr(file_path, ?)
          WHERE connection_id = ? AND substr(file_path, 1, ?) = ?
        `).run(newDir, oldDir.length + 1, conn.id, prefix.length, prefix);
      }
    })();
  } catch (err) {
    if (moveDir) fs.renameSync(newDir, oldDir);
    throw err;
  }

  const updated = db.prepare('SELECT * FROM connections WHERE id = ?').get(conn.id) as Connection;
  res.json(publicConnection(updated));
});

// Check if connection has backups before delete
router.get('/:id/backup-count', (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM backups WHERE connection_id = ?')
    .get(req.params.id) as { count: number };
  res.json({ count: row.count });
});

// Delete server — requires app password confirmation if backups exist
router.delete('/:id', async (req: Request, res: Response) => {
  const db = getDb();
  const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(req.params.id) as Connection | undefined;
  if (!conn) return res.status(404).json({ error: 'Connection not found' });

  const { confirmPassword } = req.body || {};
  const backupCount = (db.prepare("SELECT COUNT(*) as c FROM backups WHERE connection_id = ?").get(req.params.id) as { c: number }).c;

  if (backupCount > 0) {
    if (!confirmPassword) {
      return res.status(400).json({
        error: 'Serverul are backup-uri. Introdu parola aplicației pentru confirmare.',
        requiresPassword: true,
        backupCount
      });
    }
    // Verify against app password (APP_PASSWORD env var)
    const appPassword = process.env.APP_PASSWORD;
    if (!appPassword || confirmPassword !== appPassword) {
      return res.status(401).json({ error: 'Parolă incorectă. Ștergerea a fost anulată.' });
    }
    // 1. Delete all backup files, local and remote (remote errors are only logged)
    const backups = db.prepare('SELECT * FROM backups WHERE connection_id = ?').all(req.params.id) as Backup[];
    for (const b of backups) {
      await deleteStoredBackup(req.params.id, b);
    }
    // 2. Delete entire server backup folder (catches any orphaned files)
    const serverDir = getServerDir(conn.name);
    if (fs.existsSync(serverDir)) {
      fs.rmSync(serverDir, { recursive: true, force: true });
    }
    // 3. Delete backup records from SQLite
    db.prepare('DELETE FROM backups WHERE connection_id = ?').run(req.params.id);
    // 4. Delete schedule from SQLite
    db.prepare('DELETE FROM schedules WHERE connection_id = ?').run(req.params.id);
  }

  // 5. Delete the connection (CASCADE would handle backups/schedules but we do it explicitly above)
  db.prepare('DELETE FROM connections WHERE id = ?').run(req.params.id);
  // 6. Clear the server's own Slack webhook and mysqldump options (stored in settings, not covered by CASCADE)
  setServerSlackWebhookUrl(req.params.id, '');
  setDumpOptions(req.params.id, null);
  res.json({ success: true });
});

router.post('/:id/test', async (req: Request, res: Response) => {
  const db = getDb();
  const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(req.params.id) as Connection | undefined;
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  const ok = await testConnection(conn);
  res.json({ success: ok, message: ok ? 'Connection successful' : 'Cannot connect to MySQL server' });
});

router.post('/:id/validate', async (req: Request, res: Response) => {
  const db = getDb();
  const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(req.params.id) as Connection | undefined;
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  const result = await validateMySQLCapabilities(conn, getDumpOptions(conn.id));
  res.json(result);
});

// Validate raw credentials before saving (no connection record needed yet)
router.post('/test-credentials', async (req: Request, res: Response) => {
  const { host, port, user, password, database_name } = req.body;
  if (!host || !user || !password || !database_name) {
    return res.status(400).json({ error: 'Completează host, user, parolă și baza de date.' });
  }
  const conn = { host, port: port || 3306, user, password, database_name } as Connection;
  const result = await validateMySQLCapabilities(conn);
  res.json(result);
});

// Export all connections config (with passwords) as JSON
router.get('/export/config', (_req: Request, res: Response) => {
  const db = getDb();
  const connections = db.prepare('SELECT * FROM connections ORDER BY name ASC').all();
  const schedules = db.prepare('SELECT * FROM schedules').all();
  const exported = {
    exportedAt: new Date().toISOString(),
    version: 1,
    connections,
    schedules
  };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="mysql-backup-config-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(exported);
});

// Import connections config
router.post('/import/config', (req: Request, res: Response) => {
  const db = getDb();
  const { connections, schedules } = req.body;
  if (!Array.isArray(connections)) {
    return res.status(400).json({ error: 'Format invalid. Fișierul trebuie să conțină "connections".' });
  }

  let imported = 0;
  let skipped = 0;

  for (const c of connections) {
    if (!c.name || !c.host || !c.user || !c.database_name) { skipped++; continue; }
    const existing = db.prepare('SELECT id FROM connections WHERE name = ? AND host = ?').get(c.name, c.host);
    if (existing) { skipped++; continue; }
    // storage_config vine din export ca JSON string; se păstrează doar dacă e o configurație validă.
    const storage = typeof c.storage_config === 'string' ? getServerStorageConfig(c as Connection) : null;
    db.prepare(`
      INSERT INTO connections (id, name, host, port, user, password, database_name, storage_config)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(c.id || uuidv4(), c.name, c.host, c.port || 3306, c.user, c.password || '', c.database_name,
      storage ? JSON.stringify(storage) : null);
    imported++;
  }

  res.json({ imported, skipped });
});

// Download a backup file
// Fișierul local dacă există, altfel descărcat temporar de pe destinația remote.
router.get('/:id/backups/:backupId/download', async (req: Request, res: Response) => {
  const db = getDb();
  const backup = db.prepare('SELECT * FROM backups WHERE id = ? AND connection_id = ?')
    .get(req.params.backupId, req.params.id) as Backup | undefined;

  if (!backup) return res.status(404).json({ error: 'Backup not found' });
  if (!backup.file_path && !backup.remote_path) return res.status(404).json({ error: 'Fișierul backup nu există' });

  let copy: { path: string; cleanup: () => void };
  try {
    copy = await getLocalCopy(req.params.id, backup);
  } catch (err) {
    return res.status(404).json({ error: err instanceof Error ? err.message : 'Fișierul nu a putut fi citit.' });
  }

  const fileName = (backup.file_path || backup.remote_path || '').split('/').pop() || 'backup.sql.gz';
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Type', 'application/gzip');
  res.on('close', copy.cleanup);
  fs.createReadStream(copy.path).pipe(res);
});

export default router;
