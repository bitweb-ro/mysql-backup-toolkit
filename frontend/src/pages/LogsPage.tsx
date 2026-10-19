import { useState, useEffect, useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Backup, ValidationResult } from '../types';
import { formatBytes, formatDate, formatRelative } from '../utils';
import { diagnoseBackup } from '../diagnostics';
import LogViewer from '../components/LogViewer';
import ValidationPanel from '../components/ValidationPanel';

type Filter = 'all' | 'failed' | 'full' | 'incremental';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Toate' },
  { key: 'failed', label: 'Eșuate' },
  { key: 'full', label: 'Full' },
  { key: 'incremental', label: 'Incrementale' },
];

function duration(b: Backup): string {
  if (!b.completed_at) return '';
  const s = Math.round((new Date(b.completed_at).getTime() - new Date(b.started_at).getTime()) / 1000);
  if (!Number.isFinite(s) || s < 0) return '';
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

// Tab-ul „Log-uri”: jurnalul fiecărei rulări de backup (manual sau programat), cu explicația
// erorilor cunoscute. ?backup=<id> deschide direct jurnalul acelui backup.
export default function LogsPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const openId = searchParams.get('backup');
  const [backups, setBackups] = useState<Backup[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState('');
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [validating, setValidating] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.getBackups(id);
      setBackups(r.backups);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Eroare la încărcare');
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Reîncarcă cât timp rulează un backup, ca jurnalul și statusul să se actualizeze.
  const anyRunning = !!backups?.some(b => b.status === 'running');
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [anyRunning, load]);

  const toggle = (backupId: string) => {
    setSearchParams(openId === backupId ? {} : { backup: backupId }, { replace: true });
  };

  const runValidation = async () => {
    if (!id) return;
    setValidating(true);
    try {
      setValidation(await api.validateConnection(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Eroare la testare');
    } finally {
      setValidating(false);
    }
  };

  const visible = (backups || []).filter(b =>
    filter === 'all' ? true : filter === 'failed' ? b.status === 'failed' : b.type === filter);

  return (
    <>
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h2>Log-uri</h2>
            <p>Jurnalul fiecărei rulări de backup (manual sau programat). Click pe o rulare pentru detalii.</p>
          </div>
          <div className="page-actions">
            <button className="btn btn-secondary" onClick={runValidation} disabled={validating}>
              {validating ? <span className="spinner" /> : '🔍'} Testează drepturile și configurațiile
            </button>
          </div>
        </div>
      </div>

      <div className="page-content">
        {error && <div className="alert error" style={{ marginBottom: 16 }}>{error}</div>}

        {(validation || validating) && (
          <div style={{ marginBottom: 20 }}>
            <ValidationPanel validation={validation} validating={validating} />
            {validation && (
              <button className="btn btn-ghost btn-sm" style={{ marginTop: 6 }} onClick={() => setValidation(null)}>
                Închide rezultatul testului
              </button>
            )}
          </div>
        )}

        <div className="tabs">
          {FILTERS.map(f => (
            <button key={f.key} className={`tab ${filter === f.key ? 'active' : ''}`} onClick={() => setFilter(f.key)}>
              {f.label}
              {f.key === 'failed' && backups ? ` (${backups.filter(b => b.status === 'failed').length})` : ''}
            </button>
          ))}
        </div>

        {!backups ? (
          !error && <div style={{ textAlign: 'center', padding: 20 }}><span className="spinner" /></div>
        ) : visible.length === 0 ? (
          <div className="empty"><p>Nicio rulare pentru acest filtru.</p></div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {visible.map(b => (
              <LogEntry key={b.id} backup={b} open={openId === b.id} onToggle={() => toggle(b.id)} />
            ))}
          </div>
        )}

        <p className="meta" style={{ marginTop: 16, whiteSpace: 'normal' }}>
          Jurnalele restaurărilor nu se păstrează încă; ele apar doar în timpul restaurării, în tab-ul Restore.
        </p>
      </div>
    </>
  );
}

function LogEntry({ backup: b, open, onToggle }: { backup: Backup; open: boolean; onToggle: () => void }) {
  const lines = (b.logs || '').split('\n').filter(Boolean);
  const diagnosis = b.status === 'failed' || b.storage_error
    ? diagnoseBackup(`${b.error_message || ''}\n${b.storage_error || ''}\n${b.logs || ''}`)
    : null;

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div
        onClick={onToggle}
        style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 16px', cursor: 'pointer' }}
      >
        <span className={`badge ${b.type}`}>{b.type}</span>
        <span className={`badge ${b.status}`}>{b.status}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13 }}>
            {formatDate(b.started_at)} <span className="meta">· {formatRelative(b.started_at)}</span>
            {duration(b) && <span className="meta"> · durată {duration(b)}</span>}
            {b.file_size ? <span className="meta"> · {formatBytes(b.file_size)}</span> : null}
          </div>
          {diagnosis ? (
            <div style={{ fontSize: 13, color: 'var(--red)', marginTop: 2, fontWeight: 600 }}>{diagnosis.title}</div>
          ) : b.error_message ? (
            <div className="meta" style={{ color: 'var(--red)', marginTop: 2, whiteSpace: 'normal' }}>{b.error_message}</div>
          ) : null}
          {b.storage_error && !diagnosis && (
            <div className="meta" style={{ color: 'var(--amber)', marginTop: 2, whiteSpace: 'normal' }}>⚠ {b.storage_error}</div>
          )}
        </div>
        <span className="meta">{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {diagnosis && (
            <div className="alert error" style={{ margin: 0, display: 'block', lineHeight: 1.55 }}>
              <div><strong>Ce s-a întâmplat:</strong> {diagnosis.detail}</div>
              {diagnosis.fix && <div style={{ marginTop: 4 }}><strong>Cum se repară:</strong> {diagnosis.fix}</div>}
            </div>
          )}
          {b.error_message && (
            <div className="meta" style={{ color: 'var(--red)', whiteSpace: 'normal' }}>Eroare: {b.error_message}</div>
          )}
          {lines.length > 0 || b.status === 'running' ? (
            <LogViewer lines={lines} running={b.status === 'running'} title="Jurnal execuție" />
          ) : (
            <div className="meta">Rularea nu are jurnal salvat.</div>
          )}
        </div>
      )}
    </div>
  );
}
