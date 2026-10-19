import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { DumpOptions, StorageConfig } from '../types';
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
        <NameSection connectionId={id} />
        <DumpOptionsSection connectionId={id} />
        <StorageSection connectionId={id} />
        <SlackSection connectionId={id} />
      </div>
    </>
  );
}

// Numele serverului. Redenumirea mută și folderul local de backup (derivat din nume).
function NameSection({ connectionId }: { connectionId: string }) {
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [savedName, setSavedName] = useState('');
  const [saving, setSaving] = useState(false);
  const [alert, setAlert] = useState<Alert>(null);

  useEffect(() => {
    api.getConnection(connectionId).then(c => {
      setName(c.name);
      setSavedName(c.name);
    }).catch(e => {
      setAlert({ type: 'error', msg: e instanceof Error ? e.message : 'Eroare la încărcare' });
    }).finally(() => setLoading(false));
  }, [connectionId]);

  const handleSave = async () => {
    setSaving(true);
    setAlert(null);
    try {
      const c = await api.renameConnection(connectionId, name);
      setName(c.name);
      setSavedName(c.name);
      setAlert({ type: 'success', msg: `Server redenumit în „${c.name}”.` });
    } catch (e) {
      setAlert({ type: 'error', msg: e instanceof Error ? e.message : 'Eroare la salvare' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card">
      <div className="card-header"><span className="card-title">✏️ Nume server</span></div>
      {loading ? (
        <div style={{ textAlign: 'center', padding: 20 }}><span className="spinner" /></div>
      ) : (
        <>
          {alert && <div className={`alert ${alert.type}`} style={{ marginBottom: 12 }}>{alert.msg}</div>}
          <p style={{ fontSize: 13, color: 'var(--text2)', marginTop: 0, marginBottom: 10 }}>
            Folderul local de backup se redenumește automat. Pe destinațiile remote, backup-urile vechi
            rămân în folderul vechi; cele noi merg în folderul cu numele nou.
          </p>
          <input
            type="text"
            className={!name.trim() ? 'input-error' : undefined}
            value={name}
            onChange={e => setName(e.target.value)}
          />
          <div className="form-actions">
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={saving || !name.trim() || name.trim() === savedName}
            >
              {saving ? <span className="spinner" /> : null} Salvează
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// Opțiuni mysqldump care rezolvă probleme întâlnite pe anumite servere. Fiecare schimbare
// cere confirmare, cu motivul, ce face opțiunea și efectele ei.
const DUMP_OPTIONS: {
  key: keyof DumpOptions;
  title: string;
  flag: string;
  when: string;
  what: string;
  effects: string;
}[] = [
  {
    key: 'gtidPurgedOff',
    title: 'Fără GTID în backup',
    flag: '--set-gtid-purged=OFF',
    when: 'Serverul are GTID activ (gtid_mode=ON), iar user-ul de backup nu are RELOAD / FLUSH_TABLES, cum se întâmplă pe MySQL '
      + 'administrat (DigitalOcean, AWS RDS, Azure). Simptom: în jurnal apare „Couldn\'t execute \'FLUSH TABLES\': Access denied … '
      + 'RELOAD or FLUSH_TABLES (1227)”, iar backup-ul are doar câteva sute de bytes.',
    what: 'mysqldump nu mai citește și nu mai scrie setul de GTID-uri, deci nu mai are nevoie de FLUSH TABLES WITH READ LOCK. '
      + 'Backup-ul rămâne consistent prin --single-transaction.',
    effects: 'Dump-ul nu mai conține SET @@GLOBAL.GTID_PURGED, deci restaurarea pe un server cu GTID nu mai dă eroarea 3546. '
      + 'Dacă folosești backup-ul ca să construiești o replică bazată pe GTID, setul GTID trebuie setat manual. '
      + 'Se aplică backup-urilor full noi; cele existente rămân neschimbate.',
  },
  {
    key: 'maxAllowedPacket',
    title: 'Rânduri mari',
    flag: '--max-allowed-packet=1G',
    when: 'Doar dacă jurnalul arată „Error 2020: Got packet bigger than max_allowed_packet” (limita clientului). '
      + 'Nu rezolvă „Error 2013: Lost connection … at row: N”: în teste (MySQL 8.0 și 8.4), mysqldump citește rânduri '
      + 'de zeci de MB și fără această opțiune.',
    what: 'Crește limita clientului mysqldump (implicit 24 MB) și a clientului mysql la restaurare (implicit 16 MB) la 1 GB. '
      + 'Memoria se alocă doar cât e nevoie pentru cel mai mare rând.',
    effects: 'Nu schimbă nimic pe serverul MySQL și nici conținutul backup-ului. La restaurare, limita serverului destinație '
      + '(max_allowed_packet) rămâne plafonul: un rând mai mare dă ERROR 1153 și limita trebuie mărită pe server. '
      + 'Se aplică backup-urilor și restaurărilor noi.',
  },
];

function DumpOptionsSection({ connectionId }: { connectionId: string }) {
  const [options, setOptions] = useState<DumpOptions | null>(null);
  const [pending, setPending] = useState<{ key: keyof DumpOptions; enable: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [alert, setAlert] = useState<Alert>(null);

  useEffect(() => {
    api.getDumpOptions(connectionId).then(setOptions).catch(e => {
      setAlert({ type: 'error', msg: e instanceof Error ? e.message : 'Eroare la încărcare' });
    });
  }, [connectionId]);

  const confirmChange = async () => {
    if (!pending) return;
    setSaving(true);
    setAlert(null);
    try {
      const r = await api.saveDumpOptions(connectionId, { [pending.key]: pending.enable });
      setOptions(r);
      const opt = DUMP_OPTIONS.find(o => o.key === pending.key)!;
      setAlert({
        type: 'success',
        msg: `„${opt.title}” ${pending.enable ? 'activată' : 'dezactivată'}. Se aplică de la următorul backup.`,
      });
      setPending(null);
    } catch (e) {
      setAlert({ type: 'error', msg: e instanceof Error ? e.message : 'Eroare la salvare' });
    } finally {
      setSaving(false);
    }
  };

  const pendingOption = pending ? DUMP_OPTIONS.find(o => o.key === pending.key)! : null;

  return (
    <div className="card">
      <div className="card-header"><span className="card-title">🛠 Opțiuni mysqldump</span></div>
      {!options ? (
        alert ? <div className={`alert ${alert.type}`}>{alert.msg}</div>
          : <div style={{ textAlign: 'center', padding: 20 }}><span className="spinner" /></div>
      ) : (
        <>
          {alert && <div className={`alert ${alert.type}`} style={{ marginBottom: 12 }}>{alert.msg}</div>}
          <p style={{ fontSize: 13, color: 'var(--text2)', marginTop: 0, marginBottom: 10 }}>
            Implicit dezactivate. Activează-le doar dacă „Testează drepturile și configurațiile” sau tab-ul Log-uri
            indică problema pe care o rezolvă.
          </p>
          {DUMP_OPTIONS.map(o => (
            <label key={o.key} className="schedule-toggle" style={{ marginBottom: 10, alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                checked={options[o.key]}
                onChange={() => setPending({ key: o.key, enable: !options[o.key] })}
              />
              <span style={{ fontSize: 13 }}>
                {o.title} <span className="mono" style={{ color: 'var(--text3)' }}>{o.flag}</span>
                <div className="meta" style={{ marginTop: 2, whiteSpace: 'normal', lineHeight: 1.5 }}>{o.when}</div>
              </span>
            </label>
          ))}
        </>
      )}

      {pending && pendingOption && (
        <div className="modal-backdrop" onClick={() => !saving && setPending(null)}>
          <div className="modal" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">
                {pending.enable ? 'Activezi' : 'Dezactivezi'} „{pendingOption.title}”?
              </span>
              <button className="btn btn-ghost btn-sm" onClick={() => setPending(null)} disabled={saving}>✕</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, lineHeight: 1.55 }}>
              <div className="mono" style={{ color: 'var(--text3)' }}>{pendingOption.flag}</div>
              <div><strong>Motiv — când e nevoie:</strong> {pendingOption.when}</div>
              <div><strong>Ce face:</strong> {pendingOption.what}</div>
              <div><strong>Efecte:</strong> {pendingOption.effects}</div>
              {!pending.enable && (
                <div className="alert error" style={{ margin: 0 }}>
                  După dezactivare, backup-urile revin la comportamentul implicit și problema descrisă mai sus poate reapărea.
                </div>
              )}
            </div>
            <div className="form-actions">
              <button className="btn btn-ghost" onClick={() => setPending(null)} disabled={saving}>Anulează</button>
              <button className={`btn ${pending.enable ? 'btn-primary' : 'btn-danger'}`} onClick={confirmChange} disabled={saving}>
                {saving ? <span className="spinner" /> : null} Confirmă {pending.enable ? 'activarea' : 'dezactivarea'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
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
