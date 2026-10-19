import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Backup, Schedule } from '../types';
import { formatBytes, formatDate, formatRelative, formatTime } from '../utils';
import { storageTypeLabel } from '../components/StorageConfigForm';
import { describeCron } from '../cron';

// Tab-ul „Dashboard” al unui server: starea backup-urilor, programul, destinația, ultimele rulări.
export default function ServerDashboard() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [backups, setBackups] = useState<Backup[] | null>(null);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [storage, setStorage] = useState('');

  const load = useCallback(async () => {
    if (!id) return;
    api.getSchedule(id).then(setSchedule).catch(() => setSchedule(null));
    api.getServerStorage(id).then(r => setStorage(r.activeDescription)).catch(() => setStorage(''));
    try { setBackups((await api.getBackups(id)).backups); } catch { setBackups([]); }
  }, [id]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  if (!backups) {
    return <div className="page-content" style={{ color: 'var(--text3)', display: 'flex', gap: 10 }}><span className="spinner" /> Se încarcă...</div>;
  }

  const ok = backups.filter(b => b.status === 'success');
  const lastFull = ok.find(b => b.type === 'full');
  const todayIncrementals = ok.filter(b => b.type === 'incremental' && new Date(b.started_at).toDateString() === new Date().toDateString());
  const running = backups.find(b => b.status === 'running');
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const failedWeek = backups.filter(b => b.status === 'failed' && new Date(b.started_at.replace(' ', 'T') + 'Z').getTime() >= weekAgo).length;
  const uploadErrors = ok.filter(b => b.storage_error).length;
  const totalSize = ok.reduce((s, b) => s + (b.file_size || 0), 0);

  return (
    <>
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h2>Dashboard</h2>
            <p>Starea backup-urilor acestui server.</p>
          </div>
          <div className="page-actions">
            {running && (
              <span className="badge running">
                <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
                {running.type} în curs
              </span>
            )}
            <button className="btn btn-primary" onClick={() => navigate(`/server/${id}/backup`)}>📦 Backup acum</button>
          </div>
        </div>
      </div>

      <div className="page-content">
        <div className="conn-stats" style={{ marginBottom: 20 }}>
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
            <div className="stat-label">Backup-uri reușite</div>
            <div className="stat-value muted">{ok.length} ({formatBytes(totalSize)})</div>
          </div>
          <div className="stat-box">
            <div className="stat-label">Eșuate (7 zile)</div>
            <div className={`stat-value ${failedWeek > 0 ? 'amber' : 'muted'}`}>{failedWeek}</div>
          </div>
        </div>

        {uploadErrors > 0 && (
          <div className="alert error" style={{ marginBottom: 20 }}>
            {uploadErrors} backup-uri nu au ajuns pe destinația remote (sunt păstrate local). Vezi tab-ul Backup.
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, marginBottom: 20 }}>
          <div className="card" style={{ cursor: 'pointer' }} onClick={() => navigate(`/server/${id}/schedule`)}>
            <div className="card-header"><span className="card-title">🕐 Program</span></div>
            {schedule ? (
              <div style={{ fontSize: 13, lineHeight: 1.8 }}>
                <div>Status: <span className={`badge ${schedule.enabled ? 'success' : 'failed'}`}>{schedule.enabled ? 'activ' : 'oprit'}</span></div>
                <div>Full: {describeCron(schedule.full_cron)}</div>
                <div>Incremental: {describeCron(schedule.incremental_cron)}</div>
                <div>Retenție: {schedule.retention_days} zile</div>
              </div>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--amber)' }}>Niciun program setat — backup-urile rulează doar manual.</div>
            )}
          </div>
          <div className="card" style={{ cursor: 'pointer' }} onClick={() => navigate(`/server/${id}/settings`)}>
            <div className="card-header"><span className="card-title">💾 Destinație backup</span></div>
            <div style={{ fontSize: 13 }} className="mono">{storage || '—'}</div>
            <div className="meta" style={{ marginTop: 8 }}>Se schimbă din tab-ul Setări.</div>
          </div>
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="card-header" style={{ padding: '14px 16px 0' }}><span className="card-title">Ultimele backup-uri</span></div>
          {backups.length === 0 ? (
            <div className="empty"><p>Niciun backup încă.</p></div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Tip</th><th>Status</th><th>Data</th><th>Dimensiune</th><th>Locație</th></tr>
                </thead>
                <tbody>
                  {backups.slice(0, 10).map(b => (
                    <tr key={b.id}>
                      <td><span className={`badge ${b.type}`}>{b.type}</span></td>
                      <td>
                        <span className={`badge ${b.status}`}>{b.status}</span>
                        {(b.error_message || b.storage_error) && (
                          <div className="meta" style={{ color: b.error_message ? 'var(--red)' : 'var(--amber)', marginTop: 2, whiteSpace: 'normal', maxWidth: 320 }}>
                            {b.error_message || `⚠ ${b.storage_error}`}
                          </div>
                        )}
                        {b.status === 'failed' && (
                          <button
                            className="btn btn-ghost btn-sm"
                            style={{ marginTop: 4, padding: '2px 6px' }}
                            onClick={() => navigate(`/server/${id}/logs?backup=${b.id}`)}
                          >
                            📜 Vezi jurnalul și cauza →
                          </button>
                        )}
                      </td>
                      <td>
                        <div>{formatDate(b.started_at)}</div>
                        <div className="meta">{formatRelative(b.started_at)}</div>
                      </td>
                      <td className="mono">{b.file_size ? formatBytes(b.file_size) : '—'}</td>
                      <td className="mono">
                        {b.status !== 'success' ? '—'
                          : b.remote_path && b.storage_type && b.storage_type !== 'local'
                            ? `${storageTypeLabel(b.storage_type)}${b.file_path ? ' + local' : ''}`
                            : 'Local'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
