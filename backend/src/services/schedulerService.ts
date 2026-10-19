import cron, { ScheduledTask } from 'node-cron';
import { randomUUID as uuidv4 } from 'crypto';
import { getDb } from '../db/database';
import { performFullBackup, performIncrementalBackup, flushLogs, cleanupBackups } from './backupService';
import { notifyBackupFailure } from './notificationService';
import { checkDiskSpace } from './diskService';
import { storeBackup } from './storageService';
import { Connection, Backup, Schedule } from '../types';

const activeTasks = new Map<string, ScheduledTask[]>();

export function initScheduler() {
  const db = getDb();
  const schedules = db.prepare(`
    SELECT s.*, c.id as conn_id FROM schedules s
    JOIN connections c ON s.connection_id = c.id
    WHERE s.enabled = 1
  `).all() as (Schedule & { conn_id: string })[];

  for (const schedule of schedules) {
    registerSchedule(schedule);
  }

  console.log(`Scheduler inițializat cu ${schedules.length} programe active.`);
}

export function registerSchedule(schedule: Schedule) {
  // Clear existing tasks for this connection
  unregisterSchedule(schedule.connection_id);

  const tasks: ScheduledTask[] = [];

  if (schedule.full_cron && cron.validate(schedule.full_cron) && schedule.enabled) {
    const task = cron.schedule(schedule.full_cron, () => runScheduledBackup(schedule.connection_id, 'full'));
    tasks.push(task);
    console.log(`Scheduled FULL backup for connection ${schedule.connection_id}: ${schedule.full_cron}`);
  }

  if (schedule.incremental_cron && cron.validate(schedule.incremental_cron) && schedule.enabled) {
    const task = cron.schedule(schedule.incremental_cron, () => runScheduledBackup(schedule.connection_id, 'incremental'));
    tasks.push(task);
    console.log(`Scheduled INCREMENTAL backup for connection ${schedule.connection_id}: ${schedule.incremental_cron}`);
  }

  if (tasks.length > 0) {
    activeTasks.set(schedule.connection_id, tasks);
  }
}

export function unregisterSchedule(connectionId: string) {
  const tasks = activeTasks.get(connectionId);
  if (tasks) {
    // destroy (nu doar stop): în node-cron v4 task-urile oprite rămân în registrul global.
    tasks.forEach(t => t.destroy());
    activeTasks.delete(connectionId);
  }
}

async function runScheduledBackup(connectionId: string, type: 'full' | 'incremental') {
  const db = getDb();

  const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(connectionId) as Connection | undefined;
  if (!conn) return;

  const running = db.prepare("SELECT id FROM backups WHERE connection_id = ? AND status = 'running'").get(connectionId);
  if (running) {
    console.log(`Scheduled ${type} backup skipped for ${conn.name} — already running.`);
    return;
  }

  const backupId = uuidv4();
  db.prepare(`INSERT INTO backups (id, connection_id, type, status) VALUES (?, ?, ?, 'running')`)
    .run(backupId, connectionId, type);

  console.log(`Scheduled ${type} backup started for ${conn.name} (${backupId})`);

  try {
    let result;
    if (type === 'full') {
      result = await performFullBackup(conn, conn.name, backupId);
    } else {
      const lastBackup = db.prepare(`
        SELECT * FROM backups WHERE connection_id = ? AND status = 'success' AND binlog_file IS NOT NULL
        ORDER BY completed_at DESC LIMIT 1
      `).get(connectionId) as Backup | undefined;

      if (!lastBackup) {
        const msg = 'Nu există backup full anterior.';
        db.prepare("UPDATE backups SET status='failed', error_message=?, completed_at=datetime('now') WHERE id=?")
          .run(msg, backupId);
        notifyBackupFailure({ connectionId: conn.id, serverName: conn.name, type, error: msg, scheduled: true });
        return;
      }
      result = await performIncrementalBackup(conn, conn.name, backupId, lastBackup.binlog_file, lastBackup.binlog_pos);
    }

    if (result.success) result = await storeBackup(conn, type, result, backupId);
    const logStr = flushLogs(backupId);

    if (result.success) {
      db.prepare(`
        UPDATE backups SET status='success', file_path=?, file_size=?, binlog_file=?, binlog_pos=?, logs=?,
          storage_type=?, remote_path=?, storage_error=?, completed_at=datetime('now')
        WHERE id=?
      `).run(result.filePath ?? null, result.fileSize ?? null, result.binlogFile ?? null, result.binlogPos ?? null, logStr,
        result.storageType ?? null, result.remotePath ?? null, result.storageError ?? null, backupId);

      // După orice backup reușit: retenția e pe lanțuri, deci nu poate șterge ce e necesar restaurării
      const schedule = db.prepare('SELECT * FROM schedules WHERE connection_id = ?').get(connectionId) as Schedule | undefined;
      if (schedule) {
        await cleanupBackups(connectionId, conn.name, schedule.retention_days, !!schedule.cleanup_incrementals, backupId);
      }
    } else {
      db.prepare("UPDATE backups SET status='failed', error_message=?, logs=?, completed_at=datetime('now') WHERE id=?")
        .run(result.error ?? 'Eroare', logStr, backupId);
      notifyBackupFailure({ connectionId: conn.id, serverName: conn.name, type, error: result.error ?? 'Eroare', scheduled: true });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare("UPDATE backups SET status='failed', error_message=?, completed_at=datetime('now') WHERE id=?")
      .run(message, backupId);
    notifyBackupFailure({ connectionId: conn.id, serverName: conn.name, type, error: message, scheduled: true });
  } finally {
    checkDiskSpace(conn.name);
  }
}
