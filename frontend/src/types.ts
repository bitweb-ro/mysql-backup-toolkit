export interface Connection {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database_name: string;
  created_at: string;
  updated_at: string;
}

export interface Backup {
  id: string;
  connection_id: string;
  type: 'full' | 'incremental';
  status: 'running' | 'success' | 'failed';
  file_path?: string;
  file_size?: number;
  binlog_file?: string;
  binlog_pos?: number;
  error_message?: string;
  logs?: string;
  liveLines?: string[];
  started_at: string;
  completed_at?: string;
}

export interface Schedule {
  id: string;
  connection_id: string;
  full_cron: string | null;
  incremental_cron: string | null;
  enabled: boolean;
  retention_days: number;
  cleanup_incrementals: boolean;
}

export interface RestoreJob {
  status: 'running' | 'success' | 'failed';
  logs: string[];
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface DashboardStat {
  connection: Connection;
  lastFull: Backup | null;
  todayIncrementals: Backup[];
  runningBackup: { id: string; type: string } | null;
  totalBackups: number;
}

export interface BackupFile {
  name: string;
  path: string;
  size: number;
  mtime: string;
}

export interface BackupListResponse {
  backups: Backup[];
  files: {
    full: BackupFile[];
    incremental: BackupFile[];
  };
}

export interface ValidationResult {
  canConnect: boolean;
  mysqlVersion: string | null;
  versionOk: boolean;
  binlogEnabled: boolean;
  binlogFormat: string | null;
  incrementalSupported: boolean;
  databaseExists: boolean;
  errors: string[];
}
