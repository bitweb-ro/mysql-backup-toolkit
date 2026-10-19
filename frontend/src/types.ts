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
  storage_type?: StorageType | null;
  remote_path?: string | null;
  storage_error?: string | null;
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
  lastBackupAt: string | null;
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

export interface PlatformSettings {
  slackWebhookUrl: string;
  slackWebhookConfigured: boolean;
  slackWebhookSource: 'db' | 'env' | 'none';
  diskAlertMinFreeGb: number | null;
  storageDefault: StorageConfig;
}

export type StorageType = 'local' | 'sftp' | 'ftp' | 's3';

export interface StorageConfig {
  type: StorageType;
  keepLocal: boolean;
  sftp?: {
    host: string;
    port: number;
    username: string;
    password: string;
    privateKey: string;
    passphrase: string;
    remoteDir: string;
  };
  ftp?: {
    host: string;
    port: number;
    username: string;
    password: string;
    secure: boolean;
    remoteDir: string;
  };
  s3?: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    prefix: string;
    forcePathStyle: boolean;
  };
}

export interface ServerStorage {
  config: StorageConfig | null;
  defaultDescription: string;
  activeDescription: string;
}

export interface ServerSlack {
  slackWebhookUrl: string;
  globalConfigured: boolean;
}

export interface DiskInfo {
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
  alertMinFreeGb: number | null;
  low: boolean;
}

export type CheckStatus = 'ok' | 'warn' | 'error' | 'info';

export interface ValidationCheck {
  group: 'Conexiune' | 'Privilegii' | 'Configurare server';
  label: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
  affects: ('full' | 'incremental')[];
}

export interface ValidationResult {
  canConnect: boolean;
  mysqlVersion: string | null;
  versionOk: boolean;
  binlogEnabled: boolean;
  binlogFormat: string | null;
  incrementalSupported: boolean;
  databaseExists: boolean;
  fullBackup: Exclude<CheckStatus, 'info'>;
  incrementalBackup: Exclude<CheckStatus, 'info'>;
  checks: ValidationCheck[];
  errors: string[];
}

// Opțiuni mysqldump per server (tab-ul Setări)
export interface DumpOptions {
  gtidPurgedOff: boolean;
  maxAllowedPacket: boolean;
}
