import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { Backup, Connection, BackupListResponse } from '../types';
import { formatBytes, formatDate, formatRelative } from '../utils';
import LogViewer from '../components/LogViewer';

export default function BackupPage() {
  const { id } = useParams<{ id: string }>();
  const [conn, setConn] = useState<Connection | null>(null);
  const [data, setData] = useState<BackupListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [alert, setAlert] = useState<{ type: 'success' | 'error' | 'info'; msg: string } | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'full' | 'incremental'>('full');
  const [logLines, setLogLines] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [selectedBackupLogs, setSelectedBackupLogs] = useState<string[] | null>(null);

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

  // Poll while backup is running — capture live logs
  useEffect(() => {
    if (!runningId || !id) return;
    const interval = setInterval(async () => {
      try {
        const backup = await api.getBackupStatus(id, runningId);
        if (backup.liveLines) setLogLines(backup.liveLines);
        if (backup.status !== 'running') {
          setRunningId(null);
          if (backup.status === 'success') {
            setAlert({ type: 'success', msg: `Backup ${backup.type} finalizat cu succes!` });
          } else {
            setAlert({ type: 'error', msg: `Backup eșuat: ${backup.error_message}` });
          }
          if (backup.logs) setLogLines(backup.logs.split('\n'));
          load();
        }
      } catch { setRunningId(null); }
    }, 1500);
    return () => clearInterval(interval);
  }, [runningId, id, load]);

  const runBackup = async (type: 'full' | 'incremental') => {
    if (!id) return;
    setAlert(null);
    setLogLines([]);
    setSelectedBackupLogs(null);
    setShowLogs(true);
    try {
      const r = type === 'full'
        ? await api.runFullBackup(id)
        : await api.runIncrementalBackup(id);
      setRunningId(r.backupId);
      setAlert({ type: 'info', msg: `Backup ${type} în curs de execuție...` });
      setActiveTab(type);
    } catch (e: unknown) {
      setAlert({ type: 'error', msg: e instanceof Error ? e.message : 'Eroare la pornire backup' });
      setShowLogs(false);
    }
  };

  const showBackupLogs = (b: Backup) => {
    const lines = b.logs ? b.logs.split('\n').filter(Boolean) : [];
    setSelectedBackupLogs(lines);
    setShowLogs(true);
    setLogLines([]);
  };

  const deleteBackup = async (backupId: string) => {
    if (!id || !confirm('Ștergi definitiv acest backup?')) return;
    try {
      await api.deleteBackup(id, backupId);
      load();
    } catch (e: unknown) {
      setAlert({ type: 'error', msg: e instanceof Error ? e.message : 'Eroare la ștergere' });
    }
  };

  if (loading) {
    return <div className="page-content" style={{ color: 'var(--text3)', display: 'flex', gap: 10 }}><span className="spinner" /> Se încarcă...</div>;
  }

  if (!conn) {
    return <div className="page-content"><div className="alert error">Conexiunea nu a fost găsită.</div></div>;
  }

  const isRunning = !!runningId;
  const backupsByType = (data?.backups || []).filter(b => b.type === activeTab);
  const lastFull = (data?.backups || []).find(b => b.type === 'full' && b.status === 'success');
  const todayIncrementals = (data?.backups || []).filter(b => {
    if (b.type !== 'incremental' || b.status !== 'success') return false;
    return new Date(b.started_at).toDateString() === new Date().toDateString();
  });

  const displayLogs = isRunning ? logLines : (selectedBackupLogs || []);

  return (
    <>
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h2>Backup — {conn.name}</h2>
            <p className="mono">{conn.user}@{conn.host}:{conn.port}/{conn.database_name}</p>
          </div>
          <div className="page-actions">
            <button className="btn btn-secondary" onClick={() => runBackup('incremental')} disabled={isRunning}>
              {isRunning && activeTab === 'incremental' ? <span className="spinner" /> : '⚡'}
              Incremental
            </button>
            <button className="btn btn-primary" onClick={() => runBackup('full')} disabled={isRunning}>
              {isRunning && activeTab === 'full' ? <span className="spinner" /> : '💾'}
              Full backup
            </button>
          </div>
        </div>
      </div>

      <div className="page-content">
        {alert && (
          <div className={`alert ${alert.type}`} style={{ marginBottom: 16 }}>
            {alert.type === 'info' && isRunning && <span className="spinner" style={{ width: 14, height: 14 }} />}
            {alert.msg}
          </div>
        )}

        {/* Log viewer */}
        {showLogs && (
          <div style={{ marginBottom: 20 }}>
            <LogViewer
              lines={displayLogs}
              running={isRunning}
              title={isRunning ? 'Jurnal backup în curs' : 'Jurnal backup selectat'}
            />
            {!isRunning && selectedBackupLogs !== null && (
              <button className="btn btn-ghost btn-sm" style={{ marginTop: 6 }} onClick={() => { setSelectedBackupLogs(null); setShowLogs(false); }}>
                Închide jurnal
              </button>
            )}
          </div>
        )}

        {/* Summary */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
          <div className="card" style={{ padding: 14 }}>
            <div className="stat-label">Ultimul full backup</div>
            <div className="stat-value green" style={{ marginTop: 4, fontSize: 14 }}>
              {lastFull ? formatRelative(lastFull.completed_at || lastFull.started_at) : <span style={{ color: 'var(--amber)' }}>Niciodată</span>}
            </div>
            {lastFull && <div className="meta" style={{ marginTop: 2 }}>{formatDate(lastFull.completed_at || lastFull.started_at)} · {formatBytes(lastFull.file_size || 0)}</div>}
          </div>
          <div className="card" style={{ padding: 14 }}>
            <div className="stat-label">Incrementale azi</div>
            <div className="stat-value muted" style={{ marginTop: 4, fontSize: 14 }}>
              {todayIncrementals.length > 0 ? `${todayIncrementals.length} backup-uri` : <span style={{ color: 'var(--text3)' }}>Niciun incremental azi</span>}
            </div>
            {todayIncrementals.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                {todayIncrementals.map(b => (
                  <span key={b.id} className="meta" style={{ background: 'var(--bg3)', padding: '2px 6px', borderRadius: 4 }}>
                    {new Date(b.started_at).toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="tabs">
          <button className={`tab ${activeTab === 'full' ? 'active' : ''}`} onClick={() => setActiveTab('full')}>
            Full ({(data?.backups || []).filter(b => b.type === 'full').length})
          </button>
          <button className={`tab ${activeTab === 'incremental' ? 'active' : ''}`} onClick={() => setActiveTab('incremental')}>
            Incrementale ({(data?.backups || []).filter(b => b.type === 'incremental').length})
          </button>
        </div>

        {backupsByType.length === 0 ? (
          <div className="empty">
            <p>Niciun backup de tip {activeTab}.</p>
          </div>
        ) : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Data</th>
                    <th>Dimensiune</th>
                    <th>Binlog</th>
                    <th>Fișier</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {backupsByType.map(b => (
                    <BackupRow
                      key={b.id}
                      backup={b}
                      connectionId={id!}
                      onDelete={() => deleteBackup(b.id)}
                      onShowLogs={() => showBackupLogs(b)}
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

function BackupRow({ backup: b, connectionId, onDelete, onShowLogs }: {
  backup: Backup; connectionId: string; onDelete: () => void; onShowLogs: () => void;
}) {
  const fileName = b.file_path ? b.file_path.split('/').pop() || '' : '';
  const hasLogs = !!(b.logs && b.logs.trim());
  const [downloading, setDownloading] = useState(false);

  return (
    <tr>
      <td><StatusBadge status={b.status} /></td>
      <td>
        <div>{formatDate(b.started_at)}</div>
        {b.error_message && (
          <div className="meta" style={{ color: 'var(--red)', marginTop: 2, whiteSpace: 'normal', wordBreak: 'break-word', lineHeight: 1.4 }}>
            {b.error_message}
          </div>
        )}
      </td>
      <td className="mono">{b.file_size ? formatBytes(b.file_size) : '—'}</td>
      <td className="mono">{b.binlog_file ? `${b.binlog_file}:${b.binlog_pos}` : '—'}</td>
      <td className="mono" style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={fileName}>
        {fileName || '—'}
      </td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap', display: 'flex', gap: 4, justifyContent: 'flex-end', alignItems: 'center' }}>
        {hasLogs && (
          <button className="btn btn-ghost btn-sm" onClick={onShowLogs}>Jurnal</button>
        )}
        {b.status === 'success' && b.file_path && (
          <button
            className="btn btn-secondary btn-sm"
            title="Descarcă fișier backup"
            disabled={downloading}
            onClick={async () => {
              const fileName = b.file_path!.split('/').pop() || 'backup.sql.gz';
              setDownloading(true);
              try {
                await api.downloadBackup(connectionId, b.id, fileName);
              } catch (e) {
                console.error(e);
              } finally {
                setDownloading(false);
              }
            }}
          >
            {downloading ? '…' : '↓'}
          </button>
        )}
        {b.status !== 'running' && (
          <button className="btn btn-danger btn-sm" onClick={onDelete}>Șterge</button>
        )}
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { status: Backup['status'] }) {
  const map = { success: '✓ success', failed: '✗ failed', running: '⟳ running' };
  return <span className={`badge ${status}`}>{map[status]}</span>;
}
