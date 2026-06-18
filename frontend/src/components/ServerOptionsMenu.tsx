import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Connection, ValidationResult } from '../types';
import ValidationPanel from './ValidationPanel';

export default function ServerOptionsMenu({ conn, onDeleted }: { conn: Connection; onDeleted?: () => void }) {
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

      {showModal && <ServerOptionsModal conn={conn} onClose={() => setShowModal(false)} onDeleted={onDeleted} />}
    </>
  );
}

function ServerOptionsModal({ conn, onClose, onDeleted }: { conn: Connection; onClose: () => void; onDeleted?: () => void }) {
  const [view, setView] = useState<'menu' | 'delete' | 'privileges'>('menu');
  const navigate = useNavigate();

  const titles: Record<typeof view, string> = {
    menu: 'Opțiuni server',
    delete: 'Șterge server',
    privileges: 'Testează drepturile',
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{titles[view]}</span>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>

        {view === 'menu' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button className="btn btn-secondary" style={{ justifyContent: 'flex-start' }} onClick={() => setView('privileges')}>
              🔍 Testează drepturile
            </button>
            <button className="btn btn-danger" style={{ justifyContent: 'flex-start' }} onClick={() => setView('delete')}>
              Șterge acest server
            </button>
          </div>
        )}
        {view === 'delete' && (
          <DeleteServerForm conn={conn} onBack={() => setView('menu')} onDeleted={() => { onClose(); if (onDeleted) onDeleted(); else navigate('/'); }} />
        )}
        {view === 'privileges' && (
          <TestPrivilegesForm conn={conn} onBack={() => setView('menu')} />
        )}
      </div>
    </div>
  );
}

function TestPrivilegesForm({ conn, onBack }: { conn: Connection; onBack: () => void }) {
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState('');

  const runTest = async () => {
    setValidating(true);
    setError('');
    try {
      const r = await api.validateConnection(conn.id);
      setValidation(r);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Eroare la testare');
    } finally {
      setValidating(false);
    }
  };

  useEffect(() => {
    runTest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {error && <div className="alert error" style={{ marginBottom: 12 }}>{error}</div>}
      <ValidationPanel validation={validation} validating={validating} />
      <div className="form-actions">
        <button className="btn btn-ghost" onClick={onBack}>Înapoi</button>
        <button className="btn btn-secondary" onClick={runTest} disabled={validating}>
          {validating ? <span className="spinner" /> : '🔄'} Retestează
        </button>
      </div>
    </>
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
