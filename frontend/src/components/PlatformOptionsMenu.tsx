import { useState, useRef } from 'react';
import { api } from '../api';

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
      </div>
    </div>
  );
}
