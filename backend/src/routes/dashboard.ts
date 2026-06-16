import { Router, Request, Response } from 'express';
import { getDb } from '../db/database';
import { Connection, Backup } from '../types';

const router = Router();

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

    return {
      connection: conn,
      lastFull: lastFull || null,
      todayIncrementals,
      runningBackup: runningBackup || null,
      totalBackups: totalBackups.count
    };
  });

  res.json(stats);
});

export default router;
