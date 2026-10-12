import { useState, useEffect, useCallback } from 'react';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { api, onConnectionsChanged } from '../api';
import { Connection } from '../types';
import ServerOptionsMenu from './ServerOptionsMenu';

const TABS = [
  { path: 'dashboard', label: '📊 Dashboard' },
  { path: 'backup', label: '📦 Backup' },
  { path: 'restore', label: '↩ Restore' },
  { path: 'schedule', label: '🕐 Program' },
  { path: 'settings', label: '⚙️ Setări' },
];

// Pagina unui server: antet cu numele serverului și tab-uri; conținutul tab-ului vine din rută.
// Click pe server (sidebar / dashboard) deschide tab-ul Dashboard.
export default function ServerLayout() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [conn, setConn] = useState<Connection | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    api.getConnection(id)
      .then(c => { setConn(c); setNotFound(false); })
      .catch(() => setNotFound(true));
  }, [id]);

  useEffect(() => {
    load();
    return onConnectionsChanged(load);
  }, [load]);

  if (notFound) {
    return <div className="page-content"><div className="alert error">Serverul nu a fost găsit.</div></div>;
  }

  return (
    <>
      <div className="server-header">
        <div className="page-header-row">
          <div>
            <h2>{conn?.name ?? '…'}</h2>
            {conn && <p className="mono">{conn.user}@{conn.host}:{conn.port}/{conn.database_name}</p>}
          </div>
          {conn && <ServerOptionsMenu conn={conn} onDeleted={() => navigate('/')} />}
        </div>
        <nav className="server-tabs">
          {TABS.map(t => (
            <NavLink key={t.path} to={`/server/${id}/${t.path}`} className={({ isActive }) => `server-tab ${isActive ? 'active' : ''}`}>
              {t.label}
            </NavLink>
          ))}
        </nav>
      </div>
      <Outlet />
    </>
  );
}
