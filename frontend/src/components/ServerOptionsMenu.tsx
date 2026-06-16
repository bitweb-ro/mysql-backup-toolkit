import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Connection } from '../types';

export default function ServerOptionsMenu({ conn }: { conn: Connection }) {
  const [showModal, setShowModal] = useState(false);

  return (
    <>
      <button
        className="btn btn-ghost btn-sm"
        title="Opțiuni server"
        onClick={() => setShowModal(true)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="12" cy="19" r="1.6" />
        </svg>
      </button>

      {showModal && <ServerOptionsModal conn={conn} onClose={() => setShowModal(false)} />}
    </>
  );
}

function ServerOptionsModal({ conn, onClose }: { conn: Connection; onClose: () => void }) {
  const [view, setView] = useState<'menu' | 'delete'>('menu');
  const navigate = useNavigate();

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{view === 'menu' ? 'Opțiuni server' : 'Șterge server'}</span>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>

        {view === 'menu' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button className="btn btn-danger" style={{ justifyContent: 'flex-start' }} onClick={() => setView('delete')}>
              Șterge acest server
            </button>
          </div>
        ) : (
          <DeleteServerForm conn={conn} onBack={() => setView('menu')} onDeleted={() => { onClose(); navigate('/'); }} />
        )}
      </div>
    </div>
  );
}

function DeleteServerForm({ conn, onBack, onDeleted }: { conn: Connection; onBack: () => void; onDeleted: () => void }) {
  const [password, setPassword] = useState('');
  const [backupCount, setBackupCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getConnectionBackupCount(conn.id).then(r => {
      setBackupCount(r.count);
      setLoading(false);
    }).catch(() => {
      setBackupCount(0);
      setLoading(false);
    });
  }, [conn.id]);

  const handleDelete = async () => {
    setDeleting(true);
    setError('');
    try {
      await api.deleteConnection(conn.id, backupCount! > 0 ? password : undefined);
      onDeleted();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Eroare la ștergere');
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 20 }}><span className="spinner" /></div>;
  }

  return (
    <>
      <div className="alert error" style={{ marginBottom: 16 }}>
        <span>Ești sigur că vrei să ștergi serverul <strong>{conn.name}</strong>?</span>
      </div>

      {backupCount! > 0 ? (
        <>
          <div className="alert info" style={{ marginBottom: 16 }}>
            Acest server are <strong>{backupCount} backup-uri</strong>. Toate fișierele de backup vor fi șterse definitiv.
            Introdu parola aplicației pentru confirmare.
          </div>
          <div className="form-group">
            <label className="form-label">Parola aplicației (APP_PASSWORD din .env)</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              autoFocus
            />
          </div>
        </>
      ) : (
        <p style={{ color: 'var(--text2)', fontSize: 13, marginBottom: 16 }}>
          Serverul nu are backup-uri. Va fi șters fără a fi necesară confirmare prin parolă.
        </p>
      )}

      {error && <div className="alert error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="form-actions">
        <button className="btn btn-ghost" onClick={onBack}>Înapoi</button>
        <button
          className="btn btn-danger"
          onClick={handleDelete}
          disabled={deleting || (backupCount! > 0 && !password)}
        >
          {deleting ? <span className="spinner" /> : null}
          Șterge definitiv
        </button>
      </div>
    </>
  );
}
