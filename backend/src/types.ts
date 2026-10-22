export interface Connection {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database_name: string;
  // JSON StorageConfig propriu serverului; NULL = folosește destinația implicită din Opțiuni.
  storage_config?: string | null;
  created_at: string;
  updated_at: string;
}

export type StorageType = 'local' | 'sftp' | 'ftp' | 's3';

export interface SftpStorage {
  host: string;
  port: number;
  username: string;
  password: string;
  privateKey: string;
  passphrase: string;
  remoteDir: string;
}

export interface FtpStorage {
  host: string;
  port: number;
  username: string;
  password: string;
  secure: boolean;
  // FTPS: acceptă certificat self-signed / neverificabil (ex: certificatul implicit Synology)
  allowSelfSigned?: boolean;
  remoteDir: string;
}

export interface S3Storage {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  forcePathStyle: boolean;
}

// Unde se trimit backup-urile. Se păstrează setările tuturor tipurilor,
// ca schimbarea tipului din UI să nu piardă ce era completat.
export interface StorageConfig {
  type: StorageType;
  // Pentru destinații remote: păstrează și fișierul local după upload reușit.
  keepLocal: boolean;
  sftp?: SftpStorage;
  ftp?: FtpStorage;
  s3?: S3Storage;
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
  storageType?: StorageType;
  remotePath?: string;
  storageError?: string;
}

export interface BinlogInfo {
  file: string;
  position: number;
}
