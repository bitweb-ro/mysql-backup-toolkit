import { useState, useRef, useEffect } from 'react';
import { api } from '../api';
import type { PlatformSettings } from '../types';

export default function PlatformOptionsMenu() {
  const [showModal, setShowModal] = useState(false);

  return (
    <>
      <button className="sidebar-add-btn" onClick={() => setShowModal(true)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h0a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h0a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v0a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
        </svg>
        Opțiuni
      </button>

      {showModal && <PlatformOptionsModal onClose={() => setShowModal(false)} />}
    </>
  );
}

function PlatformOptionsModal({ onClose }: { onClose: () => void }) {
  const [alert, setAlert] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [savingWebhook, setSavingWebhook] = useState(false);
  const [testingWebhook, setTestingWebhook] = useState(false);

  useEffect(() => {
    api.getSettings()
      .then(s => { setSettings(s); setWebhookUrl(s.slackWebhookUrl); })
      .catch(() => { /* setările sunt opționale; ignoră eroarea de încărcare */ });
  }, []);

  const handleSaveWebhook = async () => {
    setSavingWebhook(true);
    setAlert(null);
    try {
      const r = await api.updateSettings({ slackWebhookUrl: webhookUrl });
      setSettings(s => s ? { ...s, slackWebhookUrl: webhookUrl, slackWebhookConfigured: r.slackWebhookConfigured, slackWebhookSource: webhookUrl.trim() ? 'db' : (r.slackWebhookConfigured ? 'env' : 'none') } : s);
      setAlert({ type: 'success', msg: webhookUrl.trim() ? 'Webhook Slack salvat. Notificările pentru erori sunt active.' : 'Webhook Slack șters. Notificările din DB sunt dezactivate.' });
    } catch (e) {
      setAlert({ type: 'error', msg: e instanceof Error ? e.message : 'Eroare la salvarea webhook-ului' });
    } finally {
      setSavingWebhook(false);
    }
  };

  const handleTestWebhook = async () => {
    setTestingWebhook(true);
    setAlert(null);
    try {
      await api.testSlack();
      setAlert({ type: 'success', msg: 'Mesaj de test trimis. Verifică canalul Slack.' });
    } catch (e) {
      setAlert({ type: 'error', msg: e instanceof Error ? e.message : 'Test eșuat' });
    } finally {
      setTestingWebhook(false);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      await api.exportConfig();
    } catch (e) {
      setAlert({ type: 'error', msg: e instanceof Error ? e.message : 'Eroare la export' });
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const r = await api.importConfig(data);
      setAlert({ type: 'success', msg: `Import reușit: ${r.imported} servere importate, ${r.skipped} omise (deja existente).` });
    } catch (err: unknown) {
      setAlert({ type: 'error', msg: err instanceof Error ? err.message : 'Eroare la import' });
    }
    if (importRef.current) importRef.current.value = '';
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Opțiuni platformă</span>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>

        {alert && (
          <div className={`alert ${alert.type}`} style={{ marginBottom: 16 }}>
            {alert.msg}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button className="btn btn-secondary" style={{ justifyContent: 'flex-start' }} onClick={handleExport} disabled={exporting}>
            {exporting ? '… Se exportă' : '↑ Exportă configurațiile serverelor'}
          </button>
          <label className="btn btn-secondary" style={{ justifyContent: 'flex-start', cursor: 'pointer' }}>
            ↓ Importă configurații servere din JSON
            <input ref={importRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleImport} />
          </label>
        </div>

        <div style={{ borderTop: '1px solid var(--border, #2a2a2a)', marginTop: 20, paddingTop: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Notificări Slack</div>
          <p style={{ fontSize: 13, opacity: 0.75, marginTop: 0, marginBottom: 10 }}>
            Adaugă un Slack Incoming Webhook. Dacă este configurat, orice problemă de backup
            (backup eșuat, restaurare eșuată, eroare fatală a aplicației) este trimisă prin POST
            în canalul Slack. Lasă gol pentru a dezactiva.
          </p>
          <input
            type="url"
            style={{ width: '100%', boxSizing: 'border-box' }}
            placeholder="https://hooks.slack.com/services/T000/B000/XXXX"
            value={webhookUrl}
            onChange={e => setWebhookUrl(e.target.value)}
          />
          {settings?.slackWebhookSource === 'env' && !webhookUrl.trim() && (
            <p style={{ fontSize: 12, opacity: 0.7, margin: '6px 0 0' }}>
              Un webhook este preluat din variabila de mediu <code>SLACK_WEBHOOK_URL</code>.
              Completarea câmpului de mai sus îl suprascrie.
            </p>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn btn-primary btn-sm" onClick={handleSaveWebhook} disabled={savingWebhook}>
              {savingWebhook ? '… Se salvează' : 'Salvează'}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={handleTestWebhook} disabled={testingWebhook || !settings?.slackWebhookConfigured}>
              {testingWebhook ? '… Se trimite' : 'Trimite test'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
