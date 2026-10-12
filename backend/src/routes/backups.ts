import { Router, Request, Response } from 'express';
import { randomUUID as uuidv4 } from 'crypto';
import { getDb } from '../db/database';
import {
  performFullBackup,
  performIncrementalBackup,
  restoreFullBackup,
  restoreIncrementalBackup,
  getBackupFiles,
  appendLog,
  getLogs,
  flushLogs,
  cleanupBackups
} from '../services/backupService';
import { notifyBackupFailure, notifyRestoreFailure } from '../services/notificationService';
import { checkDiskSpace } from '../services/diskService';
import { storeBackup, getLocalCopy, deleteStoredBackup } from '../services/storageService';
import { Connection, Backup, BackupResult, Schedule } from '../types';

const router = Router({ mergeParams: true });

// In-memory store for async restore jobs
interface RestoreJob {
  status: 'running' | 'success' | 'failed';
  logs: string[];
  error?: string;
  startedAt: string;
  completedAt?: string;
}
const restoreJobs = new Map<string, RestoreJob>();

// Restaurează din fișierul local sau, dacă backup-ul există doar remote,
// dintr-o copie descărcată temporar (ștearsă după restaurare).
async function restoreFromStorage(
  connectionId: string,
  backup: Backup,
  jobId: string,
  restore: (filePath: string) => Promise<BackupResult>
): Promise<BackupResult> {
  try {
    const copy = await getLocalCopy(connectionId, backup, jobId);
    try {
      return await restore(copy.path);
    } finally {
      copy.cleanup();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendLog(jobId, `EROARE: ${message}`);
    return { success: false, error: message };
  }
}

// List backups
router.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const { connectionId } = req.params;
  const { type, date } = req.query;

  const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(connectionId) as Connection | undefined;
  if (!conn) return res.status(404).json({ error: 'Connection not found' });

  let query = 'SELECT * FROM backups WHERE connection_id = ?';
  const params: unknown[] = [connectionId];

  if (type) { query += ' AND type = ?'; params.push(type); }
  if (date) { query += ' AND date(started_at) = ?'; params.push(date); }
  query += ' ORDER BY started_at DESC';

  const backups = db.prepare(query).all(...params) as Backup[];
  const files = getBackupFiles(conn.name);

  res.json({ backups, files });
});

// Get backup status + live logs
router.get('/:backupId/status', (req: Request, res: Response) => {
  const db = getDb();
  const backup = db.prepare('SELECT * FROM backups WHERE id = ?').get(req.params.backupId) as Backup | undefined;
  if (!backup) return res.status(404).json({ error: 'Backup not found' });

  // If still running, return live in-memory logs; otherwise return DB logs
  const liveLogs = getLogs(req.params.backupId);
  const logs = backup.status === 'running'
    ? liveLogs
    : (backup.logs ? backup.logs.split('\n') : []);

  res.json({ ...backup, liveLines: logs });
});

// Get restore job status
router.get('/restore-job/:jobId', (req: Request, res: Response) => {
  const job = restoreJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Restore job not found' });
  res.json(job);
});

// Trigger full backup
router.post('/full', async (req: Request, res: Response) => {
  const db = getDb();
  const { connectionId } = req.params;

  const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(connectionId) as Connection | undefined;
  if (!conn) return res.status(404).json({ error: 'Connection not found' });

  const running = db.prepare("SELECT id FROM backups WHERE connection_id = ? AND status = 'running'").get(connectionId);
  if (running) return res.status(409).json({ error: 'Un backup rulează deja pentru această conexiune.' });

  const backupId = uuidv4();
  db.prepare("INSERT INTO backups (id, connection_id, type, status) VALUES (?, ?, 'full', 'running')").run(backupId, connectionId);

  res.json({ backupId, status: 'running' });

  (async () => {
    let result = await performFullBackup(conn, conn.name, backupId);
    if (result.success) result = await storeBackup(conn, 'full', result, backupId);
    const logStr = flushLogs(backupId);

    if (result.success) {
      db.prepare(`
        UPDATE backups SET status='success', file_path=?, file_size=?, binlog_file=?, binlog_pos=?, logs=?,
          storage_type=?, remote_path=?, storage_error=?, completed_at=datetime('now')
        WHERE id=?
      `).run(result.filePath ?? null, result.fileSize ?? null, result.binlogFile ?? null, result.binlogPos ?? null, logStr,
        result.storageType ?? null, result.remotePath ?? null, result.storageError ?? null, backupId);

      // Run cleanup after successful full backup
      const schedule = db.prepare('SELECT * FROM schedules WHERE connection_id = ?').get(connectionId) as Schedule | undefined;
      if (schedule) {
        await cleanupBackups(connectionId, conn.name, schedule.retention_days, !!schedule.cleanup_incrementals);
      }
    } else {
      db.prepare(`
        UPDATE backups SET status='failed', error_message=?, logs=?, completed_at=datetime('now') WHERE id=?
      `).run(result.error ?? 'Eroare necunoscută', logStr, backupId);
      notifyBackupFailure({ connectionId: conn.id, serverName: conn.name, type: 'full', error: result.error ?? 'Eroare necunoscută' });
    }
    checkDiskSpace(conn.name);
  })();
});

// Trigger incremental backup
router.post('/incremental', async (req: Request, res: Response) => {
  const db = getDb();
  const { connectionId } = req.params;

  const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(connectionId) as Connection | undefined;
  if (!conn) return res.status(404).json({ error: 'Connection not found' });

  const running = db.prepare("SELECT id FROM backups WHERE connection_id = ? AND status = 'running'").get(connectionId);
  if (running) return res.status(409).json({ error: 'Un backup rulează deja.' });

  const lastBackup = db.prepare(`
    SELECT * FROM backups WHERE connection_id = ? AND status = 'success' AND binlog_file IS NOT NULL
    ORDER BY completed_at DESC LIMIT 1
  `).get(connectionId) as Backup | undefined;

  if (!lastBackup) {
    return res.status(400).json({ error: 'Nu există backup full anterior. Rulează mai întâi un backup full.' });
  }

  const backupId = uuidv4();
  db.prepare("INSERT INTO backups (id, connection_id, type, status) VALUES (?, ?, 'incremental', 'running')").run(backupId, connectionId);

  res.json({ backupId, status: 'running' });

  (async () => {
    let result = await performIncrementalBackup(conn, conn.name, backupId, lastBackup.binlog_file, lastBackup.binlog_pos);
    if (result.success) result = await storeBackup(conn, 'incremental', result, backupId);
    const logStr = flushLogs(backupId);

    if (result.success) {
      db.prepare(`
        UPDATE backups SET status='success', file_path=?, file_size=?, binlog_file=?, binlog_pos=?, logs=?,
          storage_type=?, remote_path=?, storage_error=?, completed_at=datetime('now')
        WHERE id=?
      `).run(result.filePath ?? null, result.fileSize ?? null, result.binlogFile ?? null, result.binlogPos ?? null, logStr,
        result.storageType ?? null, result.remotePath ?? null, result.storageError ?? null, backupId);
    } else {
      db.prepare(`
        UPDATE backups SET status='failed', error_message=?, logs=?, completed_at=datetime('now') WHERE id=?
      `).run(result.error ?? 'Eroare necunoscută', logStr, backupId);
      notifyBackupFailure({ connectionId: conn.id, serverName: conn.name, type: 'incremental', error: result.error ?? 'Eroare necunoscută' });
    }
    checkDiskSpace(conn.name);
  })();
});

// Restore full backup (async)
router.post('/:backupId/restore/full', async (req: Request, res: Response) => {
  const db = getDb();
  const { connectionId } = req.params;

  const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(connectionId) as Connection | undefined;
  if (!conn) return res.status(404).json({ error: 'Connection not found' });

  const backup = db.prepare("SELECT * FROM backups WHERE id = ? AND connection_id = ? AND type = 'full' AND status = 'success'")
    .get(req.params.backupId, connectionId) as Backup | undefined;
  if (!backup) return res.status(404).json({ error: 'Full backup not found' });
  if (!backup.file_path && !backup.remote_path) return res.status(400).json({ error: 'Backup file path missing' });

  const jobId = uuidv4();
  const job: RestoreJob = { status: 'running', logs: [], startedAt: new Date().toISOString() };
  restoreJobs.set(jobId, job);

  res.json({ jobId, status: 'running' });

  (async () => {
    appendLog(jobId, `Pornire restaurare full pentru '${conn.database_name}'...`);
    job.logs = getLogs(jobId);

    const result = await restoreFromStorage(connectionId, backup, jobId, fp => restoreFullBackup(conn, fp, jobId));
    const finalLogs = getLogs(jobId);
    flushLogs(jobId);

    job.status = result.success ? 'success' : 'failed';
    job.logs = finalLogs;
    job.error = result.error;
    job.completedAt = new Date().toISOString();
    restoreJobs.set(jobId, job);

    if (!result.success) {
      notifyRestoreFailure({ connectionId: conn.id, serverName: conn.name, type: 'full', error: result.error ?? 'Eroare necunoscută' });
    }
  })();
});

// Restore incremental backup (async)
router.post('/:backupId/restore/incremental', async (req: Request, res: Response) => {
  const db = getDb();
  const { connectionId } = req.params;

  const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(connectionId) as Connection | undefined;
  if (!conn) return res.status(404).json({ error: 'Connection not found' });

  const backup = db.prepare("SELECT * FROM backups WHERE id = ? AND connection_id = ? AND type = 'incremental' AND status = 'success'")
    .get(req.params.backupId, connectionId) as Backup | undefined;
  if (!backup) return res.status(404).json({ error: 'Incremental backup not found' });
  if (!backup.file_path && !backup.remote_path) return res.status(400).json({ error: 'Backup file path missing' });

  const jobId = uuidv4();
  const job: RestoreJob = { status: 'running', logs: [], startedAt: new Date().toISOString() };
  restoreJobs.set(jobId, job);

  res.json({ jobId, status: 'running' });

  (async () => {
    appendLog(jobId, `Pornire restaurare incrementală...`);
    job.logs = getLogs(jobId);

    const result = await restoreFromStorage(connectionId, backup, jobId, fp => restoreIncrementalBackup(conn, fp, jobId));
    const finalLogs = getLogs(jobId);
    flushLogs(jobId);

    job.status = result.success ? 'success' : 'failed';
    job.logs = finalLogs;
    job.error = result.error;
    job.completedAt = new Date().toISOString();
    restoreJobs.set(jobId, job);

    if (!result.success) {
      notifyRestoreFailure({ connectionId: conn.id, serverName: conn.name, type: 'incremental', error: result.error ?? 'Eroare necunoscută' });
    }
  })();
});

// Delete backup
router.delete('/:backupId', async (req: Request, res: Response) => {
  const db = getDb();
  const { connectionId } = req.params;

  const backup = db.prepare('SELECT * FROM backups WHERE id = ? AND connection_id = ?')
    .get(req.params.backupId, connectionId) as Backup | undefined;
  if (!backup) return res.status(404).json({ error: 'Backup not found' });

  // Șterge local și remote; dacă fișierul remote nu poate fi șters, înregistrarea se șterge oricum.
  const warning = await deleteStoredBackup(connectionId, backup);
  db.prepare('DELETE FROM backups WHERE id = ?').run(req.params.backupId);

  res.json({ success: true, warning });
});

export default router;
