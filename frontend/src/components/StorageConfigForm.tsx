import type { StorageConfig, StorageType } from '../types';

// Secretele salvate vin de la backend înlocuite cu această valoare;
// trimisă înapoi neschimbată, backend-ul păstrează secretul existent.
const SECRET_MASK = '••••••••';

const EMPTY_SFTP: NonNullable<StorageConfig['sftp']> = {
  host: '', port: 22, username: '', password: '', privateKey: '', passphrase: '', remoteDir: '/backups',
};
const EMPTY_FTP: NonNullable<StorageConfig['ftp']> = {
  host: '', port: 21, username: '', password: '', secure: false, allowSelfSigned: false, remoteDir: '/backups',
};
const EMPTY_S3: NonNullable<StorageConfig['s3']> = {
  endpoint: '', region: '', bucket: '', accessKeyId: '', secretAccessKey: '', prefix: 'mysql-backups', forcePathStyle: false,
};

// Completează sub-configurațiile lipsă, ca formularul să aibă mereu toate câmpurile.
export function withStorageDefaults(cfg: StorageConfig | null | undefined): StorageConfig {
  const c = cfg ?? { type: 'local', keepLocal: true };
  return {
    ...c,
    sftp: { ...EMPTY_SFTP, ...c.sftp },
    ftp: { ...EMPTY_FTP, ...c.ftp },
    s3: { ...EMPTY_S3, ...c.s3 },
  };
}

export function storageTypeLabel(type: StorageType | null | undefined): string {
  switch (type) {
    case 'sftp': return 'SFTP';
    case 'ftp': return 'FTP';
    case 's3': return 'S3';
    default: return 'Local';
  }
}

// Gol, „/” sau „.”: backup-urile ar ajunge direct în rădăcină (pe Synology/NAS nu se poate scrie acolo).
function isRootDir(dir: string | undefined): boolean {
  return /^[\s/.]*$/.test(dir ?? '');
}

const ROOT_DIR_HINT = 'Pune un folder, nu „/”. Pe Synology/NAS: un shared folder existent (ex: /backup-databases-mysql); subfolderele se creează automat.';

// Câmpurile obligatorii necompletate pentru tipul activ (aceleași reguli ca validarea din backend).
export function missingStorageFields(c: StorageConfig): string[] {
  const out: string[] = [];
  if (c.type === 'sftp') {
    if (!c.sftp?.host.trim()) out.push('sftp.host');
    if (!c.sftp?.username.trim()) out.push('sftp.username');
    if (!c.sftp?.password && !c.sftp?.privateKey.trim()) out.push('sftp.password', 'sftp.privateKey');
    if (isRootDir(c.sftp?.remoteDir)) out.push('sftp.remoteDir');
  }
  if (c.type === 'ftp') {
    if (!c.ftp?.host.trim()) out.push('ftp.host');
    if (!c.ftp?.username.trim()) out.push('ftp.username');
    if (isRootDir(c.ftp?.remoteDir)) out.push('ftp.remoteDir');
  }
  if (c.type === 's3') {
    if (!c.s3?.bucket.trim()) out.push('s3.bucket');
    if (!c.s3?.accessKeyId.trim()) out.push('s3.accessKeyId');
    if (!c.s3?.secretAccessKey) out.push('s3.secretAccessKey');
  }
  return out;
}

function SecretInput({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <>
      <input
        className={className}
        type="password"
        autoComplete="new-password"
        value={value}
        placeholder={placeholder}
        onFocus={e => e.target.select()}
        onChange={e => onChange(e.target.value)}
      />
      {value === SECRET_MASK && <div className="meta" style={{ marginTop: 4 }}>Salvat. Lasă neschimbat pentru a-l păstra.</div>}
    </>
  );
}

// showRequired: după o încercare de salvare / testare, câmpurile obligatorii goale primesc border roșu.
export default function StorageConfigForm({ value, onChange, showRequired = false }: {
  value: StorageConfig;
  onChange: (c: StorageConfig) => void;
  showRequired?: boolean;
}) {
  const missing = showRequired ? missingStorageFields(value) : [];
  const err = (field: string) => (missing.includes(field) ? 'input-error' : undefined);
  const sftp = value.sftp!;
  const ftp = value.ftp!;
  const s3 = value.s3!;
  const setSftp = (patch: Partial<typeof sftp>) => onChange({ ...value, sftp: { ...sftp, ...patch } });
  const setFtp = (patch: Partial<typeof ftp>) => onChange({ ...value, ftp: { ...ftp, ...patch } });
  const setS3 = (patch: Partial<typeof s3>) => onChange({ ...value, s3: { ...s3, ...patch } });

  return (
    <>
      <div className="form-group">
        <label className="form-label">Destinație</label>
        <select value={value.type} onChange={e => onChange({ ...value, type: e.target.value as StorageType })}>
          <option value="local">Local (folderul backup_servers)</option>
          <option value="sftp">SFTP / SSH</option>
          <option value="ftp">FTP / FTPS</option>
          <option value="s3">S3 (AWS, MinIO, Backblaze, Hetzner etc.)</option>
        </select>
      </div>

      {value.type === 'sftp' && (
        <>
          <div className="form-row-3">
            <div className="form-group">
              <label className="form-label">Host *</label>
              <input className={err('sftp.host')} value={sftp.host} placeholder="backup.exemplu.ro" onChange={e => setSftp({ host: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Port</label>
              <input type="number" value={sftp.port} onChange={e => setSftp({ port: Number(e.target.value) })} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Utilizator *</label>
              <input className={err('sftp.username')} value={sftp.username} autoComplete="off" onChange={e => setSftp({ username: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Parolă * (sau cheie privată)</label>
              <SecretInput className={err('sftp.password')} value={sftp.password} onChange={v => setSftp({ password: v })} />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Cheie privată SSH (opțional, format OpenSSH/PEM)</label>
            <textarea
              className={err('sftp.privateKey')}
              rows={4}
              value={sftp.privateKey}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              onFocus={e => e.target.select()}
              onChange={e => setSftp({ privateKey: e.target.value })}
            />
            {sftp.privateKey === SECRET_MASK && <div className="meta" style={{ marginTop: 4 }}>Salvată. Lasă neschimbat pentru a o păstra.</div>}
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Passphrase cheie (opțional)</label>
              <SecretInput value={sftp.passphrase} onChange={v => setSftp({ passphrase: v })} />
            </div>
            <div className="form-group">
              <label className="form-label">Director remote *</label>
              <input className={err('sftp.remoteDir')} value={sftp.remoteDir} placeholder="/backups" onChange={e => setSftp({ remoteDir: e.target.value })} />
              {isRootDir(sftp.remoteDir) && <div className="meta" style={{ marginTop: 4 }}>{ROOT_DIR_HINT}</div>}
            </div>
          </div>
        </>
      )}

      {value.type === 'ftp' && (
        <>
          <div className="form-row-3">
            <div className="form-group">
              <label className="form-label">Host *</label>
              <input className={err('ftp.host')} value={ftp.host} placeholder="ftp.exemplu.ro" onChange={e => setFtp({ host: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Port</label>
              <input type="number" value={ftp.port} onChange={e => setFtp({ port: Number(e.target.value) })} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Utilizator *</label>
              <input className={err('ftp.username')} value={ftp.username} autoComplete="off" onChange={e => setFtp({ username: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Parolă</label>
              <SecretInput value={ftp.password} onChange={v => setFtp({ password: v })} />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Director remote *</label>
            <input className={err('ftp.remoteDir')} value={ftp.remoteDir} placeholder="/backups" onChange={e => setFtp({ remoteDir: e.target.value })} />
            {isRootDir(ftp.remoteDir) && <div className="meta" style={{ marginTop: 4 }}>{ROOT_DIR_HINT}</div>}
          </div>
          <label className="schedule-toggle" style={{ marginBottom: 14 }}>
            <input type="checkbox" checked={ftp.secure} onChange={e => setFtp({ secure: e.target.checked })} />
            <span style={{ fontSize: 13 }}>FTPS (TLS explicit). Recomandat: FTP simplu trimite parola necriptat.</span>
          </label>
          {ftp.secure && (
            <label className="schedule-toggle" style={{ marginBottom: 14 }}>
              <input type="checkbox" checked={ftp.allowSelfSigned} onChange={e => setFtp({ allowSelfSigned: e.target.checked })} />
              <span style={{ fontSize: 13 }}>
                Acceptă certificat self-signed (ex: certificatul implicit Synology). Conexiunea rămâne criptată,
                dar identitatea serverului nu mai e verificată: folosește doar în rețea internă.
              </span>
            </label>
          )}
        </>
      )}

      {value.type === 's3' && (
        <>
          <div className="form-group">
            <label className="form-label">Endpoint (gol pentru AWS S3)</label>
            <input value={s3.endpoint} placeholder="https://s3.eu-central-003.backblazeb2.com" onChange={e => setS3({ endpoint: e.target.value })} />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Bucket *</label>
              <input className={err('s3.bucket')} value={s3.bucket} onChange={e => setS3({ bucket: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Regiune</label>
              <input value={s3.region} placeholder="eu-central-1" onChange={e => setS3({ region: e.target.value })} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Access Key ID *</label>
              <input className={err('s3.accessKeyId')} value={s3.accessKeyId} autoComplete="off" onChange={e => setS3({ accessKeyId: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Secret Access Key *</label>
              <SecretInput className={err('s3.secretAccessKey')} value={s3.secretAccessKey} onChange={v => setS3({ secretAccessKey: v })} />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Prefix (folder în bucket)</label>
            <input value={s3.prefix} placeholder="mysql-backups" onChange={e => setS3({ prefix: e.target.value })} />
          </div>
          <label className="schedule-toggle" style={{ marginBottom: 14 }}>
            <input type="checkbox" checked={s3.forcePathStyle} onChange={e => setS3({ forcePathStyle: e.target.checked })} />
            <span style={{ fontSize: 13 }}>Path-style URL (necesar pentru MinIO și unii furnizori S3-compatibili)</span>
          </label>
        </>
      )}

      {value.type !== 'local' && (
        <label className="schedule-toggle">
          <input type="checkbox" checked={value.keepLocal} onChange={e => onChange({ ...value, keepLocal: e.target.checked })} />
          <span style={{ fontSize: 13 }}>
            Păstrează și copia locală
            <div className="meta" style={{ marginTop: 2 }}>
              Backup-ul se face întâi local, apoi se urcă pe destinație. Debifat: fișierul local se șterge după
              upload reușit. Dacă upload-ul eșuează, fișierul local rămâne oricum.
            </div>
          </span>
        </label>
      )}
    </>
  );
}
