import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { StorageConfig } from '../types';
import StorageConfigForm, { withStorageDefaults, storageTypeLabel, missingStorageFields } from '../components/StorageConfigForm';

type Alert = { type: 'success' | 'error'; msg: string } | null;

// Tab-ul „Setări” al unui server: configurări care suprascriu setările globale din Opțiuni.
export default function ServerSettingsPage() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;

  return (
    <>
      <div className="page-header">
        <h2>Setări server</h2>
        <p>Configurări proprii acestui server. Ce nu e setat aici se ia din Opțiuni (setările globale).</p>
      </div>
      <div className="page-content" style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 640 }}>
        <StorageSection connectionId={id} />
        <SlackSection connectionId={id} />
      </div>
    </>
  );
}

// Destinația backup-urilor acestui server: implicită (din Opțiuni) sau proprie.
function StorageSection({ connectionId }: { connectionId: string }) {
  const [loading, setLoading] = useState(true);
  const [useDefault, setUseDefault] = useState(true);
  const [defaultDescription, setDefaultDescription] = useState('');
  const [config, setConfig] = useState<StorageConfig>(() => withStorageDefaults(null));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [alert, setAlert] = useState<Alert>(null);
  const [showRequired, setShowRequired] = useState(false);

  // Marchează câmpurile obligatorii goale; true = se poate continua.
  const checkRequired = () => {
    setShowRequired(true);
    if (missingStorageFields(config).length === 0) return true;
    setAlert({ type: 'error', msg: 'Completează câmpurile obligatorii marcate cu roșu.' });
    return false;
  };

  useEffect(() => {
    api.getServerStorage(connectionId).then(r => {
      setUseDefault(!r.config);
      setDefaultDescription(r.defaultDescription);
      setConfig(withStorageDefaults(r.config));
    }).catch(e => {
      setAlert({ type: 'error', msg: e instanceof Error ? e.message : 'Eroare la încărcare' });
    }).finally(() => setLoading(false));
  }, [connectionId]);

  const handleSave = async () => {
    if (!useDefault && !checkRequired()) return;
    setSaving(true);
    setAlert(null);
    try {
      const r = await api.saveServerStorage(connectionId, useDefault ? null : config);
      if (r.config) setConfig(withStorageDefaults(r.config));
      setAlert({
        type: 'success',
        msg: useDefault
          ? `Serverul folosește destinația implicită (${defaultDescription}).`
          : `Destinație proprie salvată: ${storageTypeLabel(config.type)}. Se aplică de la următorul backup.`,
      });
    } catch (e) {
      setAlert({ type: 'error', msg: e instanceof Error ? e.message : 'Eroare la salvare' });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!checkRequired()) return;
    setTesting(true);
    setAlert(null);
    try {
      const r = await api.testServerStorage(connectionId, config);
      setAlert({ type: 'success', msg: r.message });
    } catch (e) {
      setAlert({ type: 'error', msg: e instanceof Error ? e.message : 'Test eșuat' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="card">
      <div className="card-header"><span className="card-title">💾 Stocare backup</span></div>
      {loading ? (
        <div style={{ textAlign: 'center', padding: 20 }}><span className="spinner" /></div>
      ) : (
        <>
          {alert && <div className={`alert ${alert.type}`} style={{ marginBottom: 12 }}>{alert.msg}</div>}

          <label className="schedule-toggle" style={{ marginBottom: 6 }}>
            <input type="radio" name="storage-mode" checked={useDefault} onChange={() => setUseDefault(true)} />
            <span style={{ fontSize: 13 }}>
              Folosește destinația implicită
              <div className="meta" style={{ marginTop: 2 }}>Acum: {defaultDescription} (se schimbă din Opțiuni → Stocare backup)</div>
            </span>
          </label>
          <label className="schedule-toggle" style={{ marginBottom: 14 }}>
            <input type="radio" name="storage-mode" checked={!useDefault} onChange={() => setUseDefault(false)} />
            <span style={{ fontSize: 13 }}>Destinație proprie pentru acest server</span>
          </label>

          {!useDefault && <StorageConfigForm value={config} onChange={setConfig} showRequired={showRequired} />}

          <div className="form-actions">
            {!useDefault && (
              <button className="btn btn-secondary" onClick={handleTest} disabled={testing}>
                {testing ? <span className="spinner" /> : null} Testează conexiunea
              </button>
            )}
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? <span className="spinner" /> : null} Salvează
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// Webhook Slack propriu: dacă e setat, alertele acestui server merg aici în loc de webhook-ul global.
function SlackSection({ connectionId }: { connectionId: string }) {
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState('');
  const [globalConfigured, setGlobalConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [alert, setAlert] = useState<Alert>(null);

  useEffect(() => {
    api.getServerSlack(connectionId).then(r => {
      setUrl(r.slackWebhookUrl);
      setGlobalConfigured(r.globalConfigured);
    }).catch(e => {
      setAlert({ type: 'error', msg: e instanceof Error ? e.message : 'Eroare la încărcare' });
    }).finally(() => setLoading(false));
  }, [connectionId]);

  const handleSave = async () => {
    setSaving(true);
    setAlert(null);
    try {
      await api.saveServerSlack(connectionId, url);
      setAlert({
        type: 'success',
        msg: url.trim()
          ? 'Webhook salvat. Alertele acestui server merg pe acest webhook.'
          : 'Webhook propriu șters. Alertele acestui server merg pe webhook-ul global.',
      });
    } catch (e) {
      setAlert({ type: 'error', msg: e instanceof Error ? e.message : 'Eroare la salvare' });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setAlert(null);
    try {
      await api.testServerSlack(connectionId);
      setAlert({ type: 'success', msg: 'Mesaj de test trimis. Verifică canalul Slack.' });
    } catch (e) {
      setAlert({ type: 'error', msg: e instanceof Error ? e.message : 'Test eșuat' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="card">
      <div className="card-header"><span className="card-title">🔔 Notificări Slack</span></div>
      {loading ? (
        <div style={{ textAlign: 'center', padding: 20 }}><span className="spinner" /></div>
      ) : (
        <>
          {alert && <div className={`alert ${alert.type}`} style={{ marginBottom: 12 }}>{alert.msg}</div>}
          <p style={{ fontSize: 13, color: 'var(--text2)', marginTop: 0, marginBottom: 10 }}>
            Webhook propriu pentru alertele acestui server (backup / upload / restaurare eșuate).
            Dacă e completat, înlocuiește webhook-ul global pentru acest server. Lasă gol pentru a folosi
            webhook-ul global{globalConfigured ? '' : ' (momentan neconfigurat în Opțiuni)'}.
          </p>
          <input
            type="url"
            placeholder="https://hooks.slack.com/services/T000/B000/XXXX"
            value={url}
            onChange={e => setUrl(e.target.value)}
          />
          <div className="form-actions">
            <button className="btn btn-secondary" onClick={handleTest} disabled={testing || (!url.trim() && !globalConfigured)}>
              {testing ? <span className="spinner" /> : null} Trimite test
            </button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? <span className="spinner" /> : null} Salvează
            </button>
          </div>
        </>
      )}
    </div>
  );
}
