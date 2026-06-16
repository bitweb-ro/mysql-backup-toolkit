import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { Backup, Connection, BackupListResponse } from '../types';
import { formatBytes, formatDate, formatRelative } from '../utils';
import LogViewer from '../components/LogViewer';

export default function RestorePage() {
  const { id } = useParams<{ id: string }>();
  const [conn, setConn] = useState<Connection | null>(null);
  const [data, setData] = useState<BackupListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [alert, setAlert] = useState<{ type: 'success' | 'error' | 'info'; msg: string } | null>(null);
  const [activeTab, setActiveTab] = useState<'full' | 'incremental'>('full');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [runningJobId, setRunningJobId] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [c, b] = await Promise.all([api.getConnection(id), api.getBackups(id)]);
      setConn(c);
      setData(b);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Poll restore job
  useEffect(() => {
    if (!runningJobId || !id) return;
    const interval = setInterval(async () => {
      try {
        const job = await api.getRestoreJob(id, runningJobId);
        if (job.logs) setLogLines(job.logs);
        if (job.status !== 'running') {
          setRunningJobId(null);
          clearInterval(interval);
          if (job.status === 'success') {
            setAlert({ type: 'success', msg: 'Restaurare completă! Baza de date a fost restaurată cu succes.' });
          } else {
            setAlert({ type: 'error', msg: `Restaurare eșuată: ${job.error}` });
          }
        }
      } catch { setRunningJobId(null); }
    }, 1500);
    return () => clearInterval(interval);
  }, [runningJobId, id]);

  const handleRestore = async (backup: Backup) => {
    if (!id) return;
    if (confirming !== backup.id) { setConfirming(backup.id); return; }
    setConfirming(null);
    setLogLines([]);
    setAlert({ type: 'info', msg: 'Restaurare pornită...' });

    try {
      const r = backup.type === 'full'
        ? await api.restoreFullBackup(id, backup.id)
        : await api.restoreIncrementalBackup(id, backup.id);
      setRunningJobId(r.jobId);
    } catch (e: unknown) {
      setAlert({ type: 'error', msg: e instanceof Error ? e.message : 'Eroare la pornire restore' });
    }
  };

  if (loading) {
    return <div className="page-content" style={{ color: 'var(--text3)', display: 'flex', gap: 10 }}><span className="spinner" /> Se încarcă...</div>;
  }

  if (!conn) {
    return <div className="page-content"><div className="alert error">Conexiunea nu a fost găsită.</div></div>;
  }

  const isRunning = !!runningJobId;
  const successBackups = (data?.backups || []).filter(b => b.status === 'success' && b.type === activeTab);

  return (
    <>
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h2>Restore — {conn.name}</h2>
            <p className="mono">{conn.user}@{conn.host}:{conn.port}/{conn.database_name}</p>
          </div>
        </div>
      </div>

      <div className="page-content">
        <div className="alert error" style={{ marginBottom: 20 }}>
          <span style={{ fontSize: 16 }}>⚠</span>
          <span>
            <strong>Atenție:</strong> Restaurarea suprascrie datele din <strong>{conn.database_name}</strong>. Acțiunea este ireversibilă.
          </span>
        </div>

        {alert && (
          <div className={`alert ${alert.type}`} style={{ marginBottom: 16 }}>
            {alert.type === 'info' && isRunning && <span className="spinner" style={{ width: 14, height: 14 }} />}
            {alert.msg}
          </div>
        )}

        {/* Live log viewer */}
        {(isRunning || logLines.length > 0) && (
          <div style={{ marginBottom: 20 }}>
            <LogViewer
              lines={logLines}
              running={isRunning}
              title={isRunning ? 'Jurnal restaurare în curs' : 'Jurnal restaurare finalizată'}
            />
          </div>
        )}

        <div className="card" style={{ marginBottom: 20, background: 'rgba(59,130,246,0.05)' }}>
          <div className="card-header" style={{ marginBottom: 8 }}>
            <span className="card-title">Procedura recomandată</span>
          </div>
          <ol style={{ paddingLeft: 18, color: 'var(--text2)', fontSize: 13, lineHeight: 2 }}>
            <li>Restaurează cel mai recent <strong>full backup</strong></li>
            <li>Aplică <strong>backup-urile incrementale</strong> în ordine cronologică (cel mai vechi → cel mai nou)</li>
            <li>Verifică datele după fiecare pas</li>
          </ol>
        </div>

        <div className="tabs">
          <button className={`tab ${activeTab === 'full' ? 'active' : ''}`} onClick={() => { setActiveTab('full'); setConfirming(null); }}>
            Full ({(data?.backups || []).filter(b => b.type === 'full' && b.status === 'success').length})
          </button>
          <button className={`tab ${activeTab === 'incremental' ? 'active' : ''}`} onClick={() => { setActiveTab('incremental'); setConfirming(null); }}>
            Incrementale ({(data?.backups || []).filter(b => b.type === 'incremental' && b.status === 'success').length})
          </button>
        </div>

        {successBackups.length === 0 ? (
          <div className="empty">
            <p>Niciun backup {activeTab} disponibil pentru restaurare.</p>
          </div>
        ) : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Tip</th>
                    <th>Data backup</th>
                    <th>Dimensiune</th>
                    <th>Binlog</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {successBackups.map((b, i) => (
                    <RestoreRow
                      key={b.id}
                      backup={b}
                      index={i}
                      isFirst={i === 0}
                      confirming={confirming === b.id}
                      restoring={isRunning}
                      onRestore={() => handleRestore(b)}
                      onCancel={() => setConfirming(null)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function RestoreRow({ backup: b, index, isFirst, confirming, restoring, onRestore, onCancel }: {
  backup: Backup; index: number; isFirst: boolean;
  confirming: boolean; restoring: boolean;
  onRestore: () => void; onCancel: () => void;
}) {
  return (
    <tr style={{ background: isFirst ? 'rgba(34,197,94,0.04)' : undefined }}>
      <td>
        <span className={`badge ${b.type}`}>{b.type}</span>
        {isFirst && <span className="meta" style={{ marginLeft: 6, color: 'var(--green)' }}>← cel mai recent</span>}
        {index > 0 && <span className="meta" style={{ marginLeft: 6 }}>#{index + 1}</span>}
      </td>
      <td>
        <div>{formatDate(b.started_at)}</div>
        <div className="meta">{formatRelative(b.started_at)}</div>
      </td>
      <td className="mono">{b.file_size ? formatBytes(b.file_size) : '—'}</td>
      <td className="mono">{b.binlog_file ? `${b.binlog_file} pos ${b.binlog_pos}` : '—'}</td>
      <td style={{ textAlign: 'right', minWidth: 200 }}>
        {confirming ? (
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--amber)' }}>Ești sigur?</span>
            <button className="btn btn-danger btn-sm" onClick={onRestore} disabled={restoring}>
              {restoring ? <span className="spinner" style={{ width: 12, height: 12 }} /> : '↩ Confirmă'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={onCancel}>Nu</button>
          </div>
        ) : (
          <button className="btn btn-secondary btn-sm" onClick={onRestore} disabled={restoring}>
            ↩ Restaurează
          </button>
        )}
      </td>
    </tr>
  );
}
