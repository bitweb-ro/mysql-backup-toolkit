const BASE = '/api';

function getToken() {
  return localStorage.getItem('appToken') || '';
}

async function req<T>(url: string, opts?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(BASE + url, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...opts
  });
  if (res.status === 401) {
    localStorage.removeItem('appToken');
    window.location.reload();
    throw new Error('Sesiunea a expirat.');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

// Anunță Sidebar-ul și Dashboard-ul că lista de servere s-a schimbat (adăugare, editare,
// ștergere, import), ca să se reîncarce imediat, fără refresh și fără să aștepte polling-ul.
const CONNECTIONS_CHANGED = 'connections-changed';

function connectionsChanged<T>(result: T): T {
  window.dispatchEvent(new Event(CONNECTIONS_CHANGED));
  return result;
}

export function onConnectionsChanged(cb: () => void): () => void {
  window.addEventListener(CONNECTIONS_CHANGED, cb);
  return () => window.removeEventListener(CONNECTIONS_CHANGED, cb);
}

export const api = {
  getDashboard: () => req<import('./types').DashboardStat[]>('/dashboard'),
  getDiskInfo: () => req<import('./types').DiskInfo>('/dashboard/disk'),

  getConnections: () => req<import('./types').Connection[]>('/connections'),
  getConnection: (id: string) => req<import('./types').Connection>(`/connections/${id}`),
  createConnection: (data: Omit<import('./types').Connection, 'id' | 'created_at' | 'updated_at'>) =>
    req<import('./types').Connection>('/connections', { method: 'POST', body: JSON.stringify(data) }).then(connectionsChanged),
  updateConnection: (id: string, data: Partial<import('./types').Connection>) =>
    req<import('./types').Connection>(`/connections/${id}`, { method: 'PUT', body: JSON.stringify(data) }).then(connectionsChanged),
  renameConnection: (id: string, name: string) =>
    req<import('./types').Connection>(`/connections/${id}/name`, { method: 'PUT', body: JSON.stringify({ name }) }).then(connectionsChanged),
  getDumpOptions: (id: string) => req<import('./types').DumpOptions>(`/connections/${id}/dump-options`),
  saveDumpOptions: (id: string, data: Partial<import('./types').DumpOptions>) =>
    req<import('./types').DumpOptions>(`/connections/${id}/dump-options`, { method: 'PUT', body: JSON.stringify(data) }),
  getConnectionBackupCount: (id: string) =>
    req<{ count: number }>(`/connections/${id}/backup-count`),
  deleteConnection: (id: string, confirmPassword?: string) =>
    req<{ success: boolean; requiresPassword?: boolean; backupCount?: number }>(
      `/connections/${id}`,
      { method: 'DELETE', body: JSON.stringify({ confirmPassword }) }
    ).then(connectionsChanged),
  exportConfig: async () => {
    const token = getToken();
    const res = await fetch('/api/connections/export/config', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('Export eșuat');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mysql-backup-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  },
  importConfig: (data: unknown) =>
    req<{ imported: number; skipped: number }>('/connections/import/config', { method: 'POST', body: JSON.stringify(data) }).then(connectionsChanged),
  downloadBackup: async (connectionId: string, backupId: string, fileName: string) => {
    const token = getToken();
    const res = await fetch(`/api/connections/${connectionId}/backups/${backupId}/download`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('Download eșuat');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  },
  testConnection: (id: string) =>
    req<{ success: boolean; message: string }>(`/connections/${id}/test`, { method: 'POST' }),
  validateConnection: (id: string) =>
    req<import('./types').ValidationResult>(`/connections/${id}/validate`, { method: 'POST' }),
  testCredentials: (data: { host: string; port: number; user: string; password: string; database_name: string }) =>
    req<import('./types').ValidationResult>('/connections/test-credentials', { method: 'POST', body: JSON.stringify(data) }),

  getBackups: (connectionId: string) =>
    req<import('./types').BackupListResponse>(`/connections/${connectionId}/backups`),
  getBackupStatus: (connectionId: string, backupId: string) =>
    req<import('./types').Backup>(`/connections/${connectionId}/backups/${backupId}/status`),
  runFullBackup: (connectionId: string) =>
    req<{ backupId: string; status: string }>(`/connections/${connectionId}/backups/full`, { method: 'POST' }),
  runIncrementalBackup: (connectionId: string) =>
    req<{ backupId: string; status: string }>(`/connections/${connectionId}/backups/incremental`, { method: 'POST' }),
  // target: restaurare de verificare într-o altă bază; overwrite = permite o bază existentă cu tabele
  restoreFullBackup: (connectionId: string, backupId: string, target?: { targetDatabase: string; overwrite: boolean }) =>
    req<{ jobId: string; status: string }>(`/connections/${connectionId}/backups/${backupId}/restore/full`, {
      method: 'POST',
      body: JSON.stringify(target || {}),
    }),
  restoreIncrementalBackup: (connectionId: string, backupId: string) =>
    req<{ jobId: string; status: string }>(`/connections/${connectionId}/backups/${backupId}/restore/incremental`, { method: 'POST' }),
  getRestoreJob: (connectionId: string, jobId: string) =>
    req<import('./types').RestoreJob>(`/connections/${connectionId}/backups/restore-job/${jobId}`),
  deleteBackup: (connectionId: string, backupId: string) =>
    req<{ success: boolean; warning?: string | null }>(`/connections/${connectionId}/backups/${backupId}`, { method: 'DELETE' }),

  getSettings: () =>
    req<import('./types').PlatformSettings>('/settings'),
  updateSettings: (data: { slackWebhookUrl?: string; diskAlertMinFreeGb?: number | null; storageDefault?: import('./types').StorageConfig }) =>
    req<{ success: boolean; slackWebhookConfigured: boolean; diskAlertMinFreeGb: number | null; storageDefault: import('./types').StorageConfig }>('/settings', { method: 'PUT', body: JSON.stringify(data) }),
  testSlack: () =>
    req<{ success: boolean }>('/settings/slack/test', { method: 'POST' }),
  testDefaultStorage: (config: import('./types').StorageConfig) =>
    req<{ success: boolean; message: string }>('/settings/storage/test', { method: 'POST', body: JSON.stringify({ config }) }),

  getServerStorage: (connectionId: string) =>
    req<import('./types').ServerStorage>(`/connections/${connectionId}/storage`),
  saveServerStorage: (connectionId: string, config: import('./types').StorageConfig | null) =>
    req<{ success: boolean; config: import('./types').StorageConfig | null }>(`/connections/${connectionId}/storage`, { method: 'PUT', body: JSON.stringify({ config }) }),
  testServerStorage: (connectionId: string, config: import('./types').StorageConfig) =>
    req<{ success: boolean; message: string }>(`/connections/${connectionId}/storage/test`, { method: 'POST', body: JSON.stringify({ config }) }),
  getServerSlack: (connectionId: string) =>
    req<import('./types').ServerSlack>(`/connections/${connectionId}/slack`),
  saveServerSlack: (connectionId: string, slackWebhookUrl: string) =>
    req<{ success: boolean; slackWebhookUrl: string }>(`/connections/${connectionId}/slack`, { method: 'PUT', body: JSON.stringify({ slackWebhookUrl }) }),
  testServerSlack: (connectionId: string) =>
    req<{ success: boolean }>(`/connections/${connectionId}/slack/test`, { method: 'POST' }),

  getSchedule: (connectionId: string) =>
    req<import('./types').Schedule | null>(`/schedules/${connectionId}`),
  saveSchedule: (connectionId: string, data: Partial<import('./types').Schedule>) =>
    req<import('./types').Schedule>(`/schedules/${connectionId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteSchedule: (connectionId: string) =>
    req<{ success: boolean }>(`/schedules/${connectionId}`, { method: 'DELETE' }),
};
