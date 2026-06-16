import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import { getDb } from '../db/database';
import { testConnection, validateMySQLCapabilities, deleteBackupFile, getServerDir } from '../services/backupService';
import { Connection, Backup } from '../types';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const connections = db.prepare('SELECT * FROM connections ORDER BY name ASC').all() as Connection[];
  res.json(connections);
});

router.get('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(req.params.id) as Connection | undefined;
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  res.json(conn);
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
  res.status(201).json(conn);
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
  res.json(conn);
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
    // 1. Delete all backup files from disk
    const backups = db.prepare('SELECT file_path FROM backups WHERE connection_id = ?').all(req.params.id) as { file_path: string | null }[];
    for (const b of backups) {
      if (b.file_path) deleteBackupFile(b.file_path);
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
  const result = await validateMySQLCapabilities(conn);
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
    db.prepare(`
      INSERT INTO connections (id, name, host, port, user, password, database_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(c.id || uuidv4(), c.name, c.host, c.port || 3306, c.user, c.password || '', c.database_name);
    imported++;
  }

  res.json({ imported, skipped });
});

// Download a backup file
router.get('/:id/backups/:backupId/download', (req: Request, res: Response) => {
  const db = getDb();
  const backup = db.prepare('SELECT * FROM backups WHERE id = ? AND connection_id = ?')
    .get(req.params.backupId, req.params.id) as Backup | undefined;

  if (!backup) return res.status(404).json({ error: 'Backup not found' });
  if (!backup.file_path) return res.status(404).json({ error: 'Fișierul backup nu există' });
  if (!fs.existsSync(backup.file_path)) return res.status(404).json({ error: 'Fișierul nu mai există pe disc' });

  const fileName = backup.file_path.split('/').pop() || 'backup.sql.gz';
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Type', 'application/gzip');
  fs.createReadStream(backup.file_path).pipe(res);
});

export default router;
