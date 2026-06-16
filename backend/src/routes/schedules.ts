import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import cron from 'node-cron';
import { getDb } from '../db/database';
import { registerSchedule, unregisterSchedule } from '../services/schedulerService';
import { Schedule, Connection } from '../types';

const router = Router();

router.get('/:connectionId', (req: Request, res: Response) => {
  const db = getDb();
  const schedule = db.prepare('SELECT * FROM schedules WHERE connection_id = ?')
    .get(req.params.connectionId) as Schedule | undefined;
  res.json(schedule || null);
});

router.put('/:connectionId', (req: Request, res: Response) => {
  const db = getDb();
  const { connectionId } = req.params;

  const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(connectionId) as Connection | undefined;
  if (!conn) return res.status(404).json({ error: 'Connection not found' });

  const { full_cron, incremental_cron, enabled, retention_days, cleanup_incrementals } = req.body;

  // Validate cron expressions
  if (full_cron && !cron.validate(full_cron)) {
    return res.status(400).json({ error: `Expresia cron pentru full backup este invalidă: "${full_cron}"` });
  }
  if (incremental_cron && !cron.validate(incremental_cron)) {
    return res.status(400).json({ error: `Expresia cron pentru incremental este invalidă: "${incremental_cron}"` });
  }

  const existing = db.prepare('SELECT * FROM schedules WHERE connection_id = ?').get(connectionId) as Schedule | undefined;

  if (existing) {
    db.prepare(`
      UPDATE schedules
      SET full_cron=?, incremental_cron=?, enabled=?, retention_days=?, cleanup_incrementals=?
      WHERE connection_id=?
    `).run(
      full_cron || null,
      incremental_cron || null,
      enabled ? 1 : 0,
      retention_days ?? 30,
      cleanup_incrementals ? 1 : 0,
      connectionId
    );
  } else {
    db.prepare(`
      INSERT INTO schedules (id, connection_id, full_cron, incremental_cron, enabled, retention_days, cleanup_incrementals)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      connectionId,
      full_cron || null,
      incremental_cron || null,
      enabled ? 1 : 0,
      retention_days ?? 30,
      cleanup_incrementals ? 1 : 0
    );
  }

  const schedule = db.prepare('SELECT * FROM schedules WHERE connection_id = ?').get(connectionId) as Schedule;

  // Re-register cron jobs
  if (schedule.enabled) {
    registerSchedule(schedule);
  } else {
    unregisterSchedule(connectionId);
  }

  res.json(schedule);
});

router.delete('/:connectionId', (req: Request, res: Response) => {
  const db = getDb();
  unregisterSchedule(req.params.connectionId);
  db.prepare('DELETE FROM schedules WHERE connection_id = ?').run(req.params.connectionId);
  res.json({ success: true });
});

export default router;
