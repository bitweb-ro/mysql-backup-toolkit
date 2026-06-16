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
  started_at: string;
  completed_at?: string;
}

export interface Schedule {
  id: string;
  connection_id: string;
  full_cron?: string;
  incremental_cron?: string;
  enabled: boolean;
  retention_days: number;
  cleanup_incrementals: boolean;
}

export interface BackupResult {
  success: boolean;
  filePath?: string;
  fileSize?: number;
  binlogFile?: string;
  binlogPos?: number;
  error?: string;
}

export interface BinlogInfo {
  file: string;
  position: number;
}
