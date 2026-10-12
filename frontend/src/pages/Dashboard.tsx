import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, onConnectionsChanged } from '../api';
import { DashboardStat, Connection, DiskInfo } from '../types';
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

function DashboardCard({ stat, onChanged }: { stat: DashboardStat; onChanged: () => void }) {
  const navigate = useNavigate();
  const { connection: conn, lastFull, todayIncrementals, runningBackup, totalBackups } = stat;

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
