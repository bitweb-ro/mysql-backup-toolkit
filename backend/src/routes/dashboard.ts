import { Router, Request, Response } from 'express';
import { getDb } from '../db/database';
import { Connection, Backup } from '../types';
import { getDiskUsage, getDiskAlertMinFreeGb, isDiskLow } from '../services/diskService';
import { publicConnection } from './connections';

const router = Router();

// Spațiul pe discul unde se salvează backup-urile + limita de alertă din Opțiuni.
router.get('/disk', async (_req: Request, res: Response) => {
  try {
    const usage = await getDiskUsage();
    const minFreeGb = getDiskAlertMinFreeGb();
    res.json({ ...usage, alertMinFreeGb: minFreeGb, low: isDiskLow(usage, minFreeGb) });
  } catch (err) {
    res.status(500).json({ error: `Nu s-a putut citi spațiul pe disc: ${err instanceof Error ? err.message : String(err)}` });
  }
});

router.get('/', (_req: Request, res: Response) => {
  const db = getDb();

  const connections = db.prepare('SELECT * FROM connections ORDER BY name ASC').all() as Connection[];

  const stats = connections.map(conn => {
    const lastFull = db.prepare(`
      SELECT * FROM backups
      WHERE connection_id = ? AND type = 'full' AND status = 'success'
      ORDER BY completed_at DESC LIMIT 1
    `).get(conn.id) as Backup | undefined;

    const todayIncrementals = db.prepare(`
      SELECT * FROM backups
      WHERE connection_id = ? AND type = 'incremental' AND status = 'success'
        AND date(started_at) = date('now')
      ORDER BY started_at DESC
    `).all(conn.id) as Backup[];

    const runningBackup = db.prepare(`
      SELECT id, type FROM backups WHERE connection_id = ? AND status = 'running' LIMIT 1
    `).get(conn.id) as Pick<Backup, 'id' | 'type'> | undefined;

    const totalBackups = db.prepare(`
      SELECT COUNT(*) as count FROM backups WHERE connection_id = ? AND status = 'success'
    `).get(conn.id) as { count: number };

    // Ultimul backup reușit, full sau incremental: folosit pentru culoarea de stare din sidebar.
    const lastBackup = db.prepare(`
      SELECT MAX(completed_at) as at FROM backups WHERE connection_id = ? AND status = 'success'
    `).get(conn.id) as { at: string | null };

    // Ultimele 2 erori din ultimele 7 zile: backup eșuat sau upload eșuat pe destinația remote.
    // „resolved” = după eroare a urmat un backup reușit de același tip, cu upload reușit.
    const recentErrors = db.prepare(`
      SELECT b.id, b.type, b.status, b.error_message, b.storage_error, b.started_at,
        EXISTS (
          SELECT 1 FROM backups s
          WHERE s.connection_id = b.connection_id AND s.type = b.type AND s.status = 'success'
            AND s.storage_error IS NULL AND s.started_at > b.started_at
        ) AS resolved
      FROM backups b
      WHERE b.connection_id = ? AND (b.status = 'failed' OR b.storage_error IS NOT NULL)
        AND b.started_at >= datetime('now', '-7 days')
      ORDER BY b.started_at DESC LIMIT 2
    `).all(conn.id) as (Pick<Backup, 'id' | 'type' | 'status' | 'error_message' | 'storage_error' | 'started_at'> & { resolved: number })[];

    return {
      connection: publicConnection(conn),
      lastFull: lastFull || null,
      todayIncrementals,
      runningBackup: runningBackup || null,
      totalBackups: totalBackups.count,
      lastBackupAt: lastBackup.at,
      recentErrors: recentErrors.map(e => ({ ...e, resolved: e.resolved === 1 }))
    };
  });

  res.json(stats);
});

export default router;
