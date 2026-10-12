import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { api, onConnectionsChanged } from '../api';
import { DashboardStat, Connection } from '../types';
import ConnectionModal from './ConnectionModal';
import { SERVER_STATUSES, serverStatus, formatRelative } from '../utils';
import PlatformOptionsMenu from './PlatformOptionsMenu';

export default function Sidebar({ onLogout }: { onLogout: () => void }) {
  const [stats, setStats] = useState<DashboardStat[]>([]);
  const [showModal, setShowModal] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const load = async () => {
    try { setStats(await api.getDashboard()); } catch { /* silent */ }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    const off = onConnectionsChanged(load);
    return () => { clearInterval(t); off(); };
  }, []);

  const handleSaved = (conn: Connection) => {
    setShowModal(false);
    navigate(`/server/${conn.id}/dashboard`);
  };

  // Sidebar-ul e în afara <Routes>, deci id-ul serverului se citește din URL.
  const isActive = (serverId: string) => location.pathname.startsWith(`/server/${serverId}/`);

  return (
    <>
      <div className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <ellipse cx="12" cy="5" rx="9" ry="3"/>
              <path d="M3 5v14a9 3 0 0018 0V5"/>
              <path d="M3 12a9 3 0 0018 0"/>
            </svg>
            <h1>MySQL Backup</h1>
          </div>
          <div className="sidebar-sub">Manager v1.0</div>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-label">General</div>
          <button
            className={`sidebar-item ${location.pathname === '/' ? 'active' : ''}`}
            onClick={() => navigate('/')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
              <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
            </svg>
            Dashboard
          </button>
        </div>

        {stats.length > 0 && (
          <div className="sidebar-section" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            <div className="sidebar-section-label">Servere ({stats.length})</div>
            {stats.map(s => {
              const status = serverStatus(!!s.runningBackup, s.lastBackupAt);
              return (
                <button
                  key={s.connection.id}
                  className={`sidebar-item ${isActive(s.connection.id) ? 'active' : ''}`}
                  onClick={() => navigate(`/server/${s.connection.id}/dashboard`)}
                >
                  <span
                    className="dot"
                    style={{ background: status.color }}
                    title={s.lastBackupAt ? `${status.label} (ultimul: ${formatRelative(s.lastBackupAt)})` : status.label}
                  />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.connection.name}</span>
                </button>
              );
            })}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 12px 4px', fontSize: 11, color: 'var(--text3)' }}>
              {SERVER_STATUSES.map(st => (
                <span key={st.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: st.color, flexShrink: 0 }} /> {st.label}
                </span>
              ))}
            </div>
          </div>
        )}

        <div style={{ padding: '8px', borderTop: '1px solid var(--border)', marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button className="sidebar-add-btn" onClick={() => setShowModal(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 5v14M5 12h14"/>
            </svg>
            Adaugă server
          </button>
          <PlatformOptionsMenu />
          <button className="sidebar-add-btn" onClick={onLogout} style={{ borderStyle: 'solid', borderColor: 'var(--border)' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>
            </svg>
            Deconectare
          </button>
        </div>
      </div>

      {showModal && (
        <ConnectionModal onClose={() => setShowModal(false)} onSaved={handleSaved} />
      )}
    </>
  );
}
