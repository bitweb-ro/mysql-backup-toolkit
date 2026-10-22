import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, onConnectionsChanged } from '../api';
import { DashboardStat, Connection, DiskInfo, RecentError } from '../types';
import { formatBytes, formatRelative, formatTime } from '../utils';
import ConnectionModal from '../components/ConnectionModal';
import ServerOptionsMenu from '../components/ServerOptionsMenu';

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStat[]>([]);
  const [disk, setDisk] = useState<DiskInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [search, setSearch] = useState('');
  const navigate = useNavigate();

  const load = useCallback(async () => {
    api.getDiskInfo().then(setDisk).catch(() => setDisk(null));
    try { setStats(await api.getDashboard()); } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    const off = onConnectionsChanged(load);
    return () => { clearInterval(t); off(); };
  }, [load]);

  const handleSaved = (conn: Connection) => {
    setShowModal(false);
    navigate(`/server/${conn.id}/dashboard`);
  };

  if (loading) {
    return (
      <div className="page-content" style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text3)' }}>
        <span className="spinner" /> Se încarcă...
      </div>
    );
  }

  const q = search.trim().toLowerCase();
  const filtered = q
    ? stats.filter(s => {
        const c = s.connection;
        return [c.name, c.host, c.database_name, c.user].some(v => v.toLowerCase().includes(q));
      })
    : stats;

  return (
    <>
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h2>Dashboard</h2>
            <p>Vizualizare generală a tuturor serverelor MySQL</p>
          </div>
          <div className="page-actions">
            {stats.length > 0 && (
              <input
                type="search"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="🔍 Caută server…"
                style={{ minWidth: 220 }}
              />
            )}
            <button className="btn btn-primary" onClick={() => setShowModal(true)}>
              + Adaugă server
            </button>
          </div>
        </div>
      </div>

      <div className="page-content">
        {disk && <DiskPanel disk={disk} />}
        {stats.length > 0 && <ErrorsPanel stats={stats} />}
        {stats.length === 0 ? (
          <div className="empty">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0018 0V5"/><path d="M3 12a9 3 0 0018 0"/>
            </svg>
            <p>Niciun server configurat. Adaugă prima conexiune MySQL.</p>
            <button className="btn btn-primary" style={{ margin: '16px auto 0', display: 'flex' }} onClick={() => setShowModal(true)}>
              + Adaugă server
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty">
            <p>Niciun server nu corespunde căutării „{search.trim()}".</p>
          </div>
        ) : (
          <div className="conn-grid">
            {filtered.map(s => (
              <DashboardCard key={s.connection.id} stat={s} onChanged={load} />
            ))}
          </div>
        )}
      </div>

      {showModal && <ConnectionModal onClose={() => setShowModal(false)} onSaved={handleSaved} />}
    </>
  );
}

function DiskPanel({ disk }: { disk: DiskInfo }) {
  const color = disk.low ? 'var(--red)' : disk.usedPercent >= 85 ? 'var(--amber)' : 'var(--green)';

  return (
    <div className="conn-card" style={{ marginBottom: 20, cursor: 'default', borderColor: disk.low ? 'var(--red)' : undefined }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div className="conn-name">💾 Spațiu disc backup-uri</div>
        <div style={{ fontSize: 13, color: 'var(--text2)' }}>
          <strong style={{ color }}>{formatBytes(disk.freeBytes)} liberi</strong>
          {' '}din {formatBytes(disk.totalBytes)} ({disk.usedPercent}% folosit)
        </div>
      </div>
      <div style={{ height: 8, background: 'var(--bg4)', borderRadius: 4, marginTop: 10, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(disk.usedPercent, 100)}%`, height: '100%', background: color }} />
      </div>
      <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 8 }}>
        {disk.alertMinFreeGb
          ? `Alertă Slack când spațiul liber scade sub ${disk.alertMinFreeGb} GB (verificat după fiecare backup).`
          : 'Alertă de spațiu dezactivată — se poate seta din Opțiuni.'}
      </div>
      {disk.low && (
        <div className="alert error" style={{ marginTop: 10, marginBottom: 0 }}>
          Spațiul liber este sub limita de {disk.alertMinFreeGb} GB. Backup-urile noi pot eșua — eliberează spațiu
          sau redu retenția din programări.
        </div>
      )}
    </div>
  );
}

const errorText = (e: RecentError) => e.error_message || e.storage_error || 'Eroare necunoscută';

// O eroare pe un rând: tip, mesaj trunchiat (complet la hover), când. Click → jurnalul backup-ului.
function ErrorRow({ connId, error, serverName }: { connId: string; error: RecentError; serverName?: string }) {
  const navigate = useNavigate();
  const isUpload = error.status !== 'failed';

  return (
    <div
      onClick={e => { e.stopPropagation(); navigate(`/server/${connId}/logs?backup=${error.id}`); }}
      title={errorText(error)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 'var(--radius)',
        background: 'var(--bg3)', cursor: 'pointer', fontSize: 12, opacity: error.resolved ? 0.6 : 1,
      }}
    >
      {serverName && <strong style={{ whiteSpace: 'nowrap' }}>{serverName}</strong>}
      <span className={`badge ${error.type}`}>{error.type}</span>
      <span style={{ color: isUpload ? 'var(--amber)' : 'var(--red)', whiteSpace: 'nowrap' }}>
        {isUpload ? 'upload eșuat' : 'eșuat'}
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text2)' }}>
        {errorText(error)}
      </span>
      {error.resolved && <span className="badge success">rezolvat</span>}
      <span style={{ color: 'var(--text3)', whiteSpace: 'nowrap' }}>{formatRelative(error.started_at)}</span>
    </div>
  );
}

// Toate erorile din ultimele 7 zile, de la toate serverele, cele mai noi primele.
function ErrorsPanel({ stats }: { stats: DashboardStat[] }) {
  const all = stats
    .flatMap(s => s.recentErrors.map(error => ({ conn: s.connection, error })))
    .sort((a, b) => b.error.started_at.localeCompare(a.error.started_at))
    .slice(0, 10);
  const open = all.filter(x => !x.error.resolved).length;

  return (
    <div className="conn-card" style={{ marginBottom: 20, cursor: 'default', borderColor: open > 0 ? 'var(--red)' : undefined }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div className="conn-name">⚠️ Ultimele erori</div>
        <div style={{ fontSize: 13, color: 'var(--text2)' }}>
          {all.length === 0
            ? <strong style={{ color: 'var(--green)' }}>Nicio eroare în ultimele 7 zile</strong>
            : open > 0
              ? <strong style={{ color: 'var(--red)' }}>{open} nerezolvate</strong>
              : <strong style={{ color: 'var(--green)' }}>Toate rezolvate</strong>}
        </div>
      </div>
      {all.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
          {all.map(({ conn, error }) => (
            <ErrorRow key={error.id} connId={conn.id} error={error} serverName={conn.name} />
          ))}
        </div>
      )}
      <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 8 }}>
        Backup-uri eșuate și upload-uri eșuate, max. 2 per server. „Rezolvat” = a urmat un backup reușit de același tip.
        Click pe o eroare deschide jurnalul cu cauza.
      </div>
    </div>
  );
}

function DashboardCard({ stat, onChanged }: { stat: DashboardStat; onChanged: () => void }) {
  const navigate = useNavigate();
  const { connection: conn, lastFull, todayIncrementals, runningBackup, totalBackups } = stat;
  const openErrors = stat.recentErrors.filter(e => !e.resolved);

  return (
    <div className="conn-card" onClick={() => navigate(`/server/${conn.id}/dashboard`)}>
      <div className="conn-card-top">
        <div>
          <div className="conn-name">{conn.name}</div>
          <div className="conn-host">{conn.user}@{conn.host}:{conn.port}/{conn.database_name}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {runningBackup && (
            <span className="badge running">
              <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
              {runningBackup.type}
            </span>
          )}
          <div onClick={e => e.stopPropagation()}>
            <ServerOptionsMenu conn={conn} onDeleted={onChanged} />
          </div>
        </div>
      </div>

      <div className="conn-stats">
        <div className="stat-box">
          <div className="stat-label">Ultimul full backup</div>
          <div className={`stat-value ${lastFull ? 'green' : 'amber'}`}>
            {lastFull ? formatRelative(lastFull.completed_at || lastFull.started_at) : 'Niciodată'}
          </div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Incrementale azi</div>
          <div className="stat-value muted">
            {todayIncrementals.length > 0
              ? `${todayIncrementals.length} × (ultimul ${formatTime(todayIncrementals[0].started_at)})`
              : '—'}
          </div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Total backup-uri</div>
          <div className="stat-value muted">{totalBackups}</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Server</div>
          <div className="stat-value muted mono">{conn.host}</div>
        </div>
      </div>

      {openErrors.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
          {openErrors.map(e => <ErrorRow key={e.id} connId={conn.id} error={e} />)}
        </div>
      )}

      <div className="conn-footer">
        <button className="btn btn-secondary btn-sm" onClick={e => { e.stopPropagation(); navigate(`/server/${conn.id}/backup`); }}>
          📦 Backup
        </button>
        <button className="btn btn-secondary btn-sm" onClick={e => { e.stopPropagation(); navigate(`/server/${conn.id}/restore`); }}>
          ↩ Restore
        </button>
        <button className="btn btn-secondary btn-sm" onClick={e => { e.stopPropagation(); navigate(`/server/${conn.id}/schedule`); }}>
          🕐 Program
        </button>
      </div>
    </div>
  );
}
