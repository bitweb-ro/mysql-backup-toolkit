import { useState, useEffect } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { api } from '../api';
import { DashboardStat, Connection } from '../types';
import ConnectionModal from './ConnectionModal';
import PlatformOptionsMenu from './PlatformOptionsMenu';

export default function Sidebar({ onLogout }: { onLogout: () => void }) {
  const [stats, setStats] = useState<DashboardStat[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  const load = async () => {
    try { setStats(await api.getDashboard()); } catch { /* silent */ }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  // Keep the server containing the currently viewed page expanded
  useEffect(() => {
    if (id) setExpandedId(id);
  }, [id]);

  const handleSaved = (conn: Connection) => {
    setShowModal(false);
    load();
    navigate(`/server/${conn.id}/backup`);
  };

  const isActive = (serverId: string, page: string) =>
    id === serverId && location.pathname.includes(page);

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
          <div className="sidebar-section" style={{ flex: 1 }}>
            <div className="sidebar-section-label">Servere ({stats.length})</div>
            {stats.map(s => {
              const expanded = expandedId === s.connection.id;
              return (
                <div key={s.connection.id}>
                  <button
                    onClick={() => setExpandedId(expanded ? null : s.connection.id)}
                    style={{
                      width: '100%', padding: '6px 12px', fontSize: 12, color: 'var(--text2)', fontWeight: 600,
                      display: 'flex', alignItems: 'center', gap: 6, marginTop: 4,
                      background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left'
                    }}
                  >
                    <svg
                      width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
                      style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0 }}
                    >
                      <path d="M9 18l6-6-6-6" />
                    </svg>
                    <span
                      className="dot"
                      style={{ background: s.runningBackup ? 'var(--amber)' : 'var(--green)' }}
                      title={s.runningBackup ? 'Backup în curs' : 'Activ'}
                    />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.connection.name}</span>
                  </button>
                  {expanded && (
                    <>
                      <button className={`sidebar-item ${isActive(s.connection.id, 'backup') ? 'active' : ''}`} style={{ paddingLeft: 28, fontSize: 12 }} onClick={() => navigate(`/server/${s.connection.id}/backup`)}>
                        📦 Backup
                      </button>
                      <button className={`sidebar-item ${isActive(s.connection.id, 'restore') ? 'active' : ''}`} style={{ paddingLeft: 28, fontSize: 12 }} onClick={() => navigate(`/server/${s.connection.id}/restore`)}>
                        ↩ Restore
                      </button>
                      <button className={`sidebar-item ${isActive(s.connection.id, 'schedule') ? 'active' : ''}`} style={{ paddingLeft: 28, fontSize: 12 }} onClick={() => navigate(`/server/${s.connection.id}/schedule`)}>
                        🕐 Program
                      </button>
                    </>
                  )}
                </div>
              );
            })}
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
