import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.join(process.cwd(), 'data', 'app.db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
    runMigrations();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 3306,
      user TEXT NOT NULL,
      password TEXT NOT NULL,
      database_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('full', 'incremental')),
      status TEXT NOT NULL CHECK(status IN ('running', 'success', 'failed')),
      file_path TEXT,
      file_size INTEGER,
      binlog_file TEXT,
      binlog_pos INTEGER,
      error_message TEXT,
      logs TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL UNIQUE,
      full_cron TEXT,
      incremental_cron TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      retention_days INTEGER NOT NULL DEFAULT 30,
      cleanup_incrementals INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
    );
  `);
}

function runMigrations() {
  const backupCols = (db.prepare('PRAGMA table_info(backups)').all() as { name: string }[]).map(c => c.name);
  if (!backupCols.includes('logs')) {
    db.exec('ALTER TABLE backups ADD COLUMN logs TEXT');
  }

  const scheduleCols = (db.prepare('PRAGMA table_info(schedules)').all() as { name: string }[]).map(c => c.name);
  if (!scheduleCols.includes('retention_days')) {
    db.exec('ALTER TABLE schedules ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 30');
  }
  if (!scheduleCols.includes('cleanup_incrementals')) {
    db.exec('ALTER TABLE schedules ADD COLUMN cleanup_incrementals INTEGER NOT NULL DEFAULT 0');
  }
}
