import { useState } from "react";
import { Connection, ValidationResult } from "../types";
import { api } from "../api";

interface Props {
  existing?: Connection;
  onClose: () => void;
  onSaved: (conn: Connection) => void;
}

const defaultForm = {
  name: "",
  host: "",
  port: 3306,
  user: "",
  password: "",
  database_name: "",
};

function ValidationBadge({ ok }: { ok: boolean }) {
  return ok ? (
    <span style={{ color: "var(--green)", fontWeight: 600 }}>✓</span>
  ) : (
    <span style={{ color: "var(--red)", fontWeight: 600 }}>✗</span>
  );
}

export default function ConnectionModal({ existing, onClose, onSaved }: Props) {
  const [form, setForm] = useState(
    existing
      ? {
          name: existing.name,
          host: existing.host,
          port: existing.port,
          user: existing.user,
          password: existing.password,
          database_name: existing.database_name,
        }
      : { ...defaultForm },
  );
  const [error, setError] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    msg: string;
  } | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [savedConn, setSavedConn] = useState<Connection | null>(
    existing || null,
  );

  const set = (k: string, v: string | number) => {
    setForm((f) => ({ ...f, [k]: v }));
    setTestResult(null);
    setValidation(null);
  };

  const handleTest = async () => {
    if (!savedConn) {
      setTestResult({ ok: false, msg: "Salvează conexiunea înainte de test." });
      return;
    }
    setTesting(true);
    try {
      const r = await api.testConnection(savedConn.id);
      setTestResult({ ok: r.success, msg: r.message });
    } catch (e: unknown) {
      setTestResult({
        ok: false,
        msg: e instanceof Error ? e.message : "Eroare necunoscută",
      });
    } finally {
      setTesting(false);
    }
  };

  const runValidation = async (conn: Connection) => {
    setValidating(true);
    try {
      const r = await api.validateConnection(conn.id);
      setValidation(r);
    } catch {
      // non-critical, ignore
    } finally {
      setValidating(false);
    }
  };

  const handleSave = async () => {
    if (
      !form.name ||
      !form.host ||
      !form.user ||
      !form.password ||
      !form.database_name
    ) {
      setError("Completează toate câmpurile obligatorii.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const conn = savedConn
        ? await api.updateConnection(savedConn.id, form)
        : await api.createConnection(form);
      setSavedConn(conn);
      onSaved(conn);
      // Auto-validate after save
      await runValidation(conn);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Eroare la salvare");
    } finally {
      setSaving(false);
    }
  };

  const handleRevalidate = async () => {
    if (savedConn) await runValidation(savedConn);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: 520 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span className="modal-title">
            {existing ? "Editează conexiunea" : "Adaugă conexiune MySQL"}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className="alert error">{error}</div>}
        {testResult && (
          <div className={`alert ${testResult.ok ? "success" : "error"}`}>
            {testResult.ok ? "✓" : "✗"} {testResult.msg}
          </div>
        )}

        <div className="form-group">
          <label className="form-label">Nume server *</label>
          <input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="ex: Baza de date X"
          />
        </div>

        <div className="form-row-3">
          <div className="form-group">
            <label className="form-label">Host *</label>
            <input
              value={form.host}
              onChange={(e) => set("host", e.target.value)}
              placeholder="localhost"
            />
          </div>
          <div className="form-group">
            <label className="form-label">Port</label>
            <input
              type="number"
              value={form.port}
              onChange={(e) => set("port", parseInt(e.target.value) || 3306)}
            />
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label className="form-label">User *</label>
            <input
              value={form.user}
              onChange={(e) => set("user", e.target.value)}
              placeholder="root"
            />
          </div>
          <div className="form-group">
            <label className="form-label">Parolă *</label>
            <input
              type="password"
              value={form.password}
              onChange={(e) => set("password", e.target.value)}
              placeholder="••••••••"
            />
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Baza de date *</label>
          <input
            value={form.database_name}
            onChange={(e) => set("database_name", e.target.value)}
            placeholder="mydb"
          />
        </div>

        {/* Validation results */}
        {(validation || validating) && (
          <div className="validation-panel">
            <div className="validation-title">
              Verificare compatibilitate
              {validating && (
                <span className="spinner" style={{ marginLeft: 8 }} />
              )}
            </div>
            {validation && (
              <div className="validation-checks">
                <div className="validation-row">
                  <ValidationBadge ok={validation.canConnect} />
                  <span>Conexiune MySQL</span>
                  {validation.mysqlVersion && (
                    <span
                      className="mono"
                      style={{ marginLeft: "auto", color: "var(--text3)" }}
                    >
                      v{validation.mysqlVersion}
                    </span>
                  )}
                </div>
                <div className="validation-row">
                  <ValidationBadge ok={validation.versionOk} />
                  <span>Versiune ≥ 8.0</span>
                </div>
                <div className="validation-row">
                  <ValidationBadge ok={validation.databaseExists} />
                  <span>Baza de date există</span>
                </div>
                <div className="validation-row">
                  <ValidationBadge ok={validation.binlogEnabled} />
                  <span>Binary logging activ</span>
                  {validation.binlogFormat && (
                    <span
                      className="mono"
                      style={{ marginLeft: "auto", color: "var(--text3)" }}
                    >
                      {validation.binlogFormat}
                    </span>
                  )}
                </div>
                <div className="validation-row">
                  <ValidationBadge ok={validation.incrementalSupported} />
                  <span>Backup incremental suportat</span>
                </div>
                {validation.errors.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    {validation.errors.map((err, i) => (
                      <div
                        key={i}
                        className="alert error"
                        style={{
                          marginBottom: 4,
                          padding: "6px 10px",
                          fontSize: 12,
                        }}
                      >
                        {err}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="form-actions">
          {savedConn && (
            <>
              <button
                className="btn btn-secondary"
                onClick={handleTest}
                disabled={testing}
              >
                {testing ? <span className="spinner" /> : "⚡"} Test
              </button>
              <button
                className="btn btn-secondary"
                onClick={handleRevalidate}
                disabled={validating}
              >
                {validating ? <span className="spinner" /> : "🔍"} Verifică
              </button>
            </>
          )}
          <button className="btn btn-ghost" onClick={onClose}>
            Închide
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving || validating}
          >
            {saving ? <span className="spinner" /> : null}
            {existing ? "Salvează" : "Adaugă"}
          </button>
        </div>
      </div>
    </div>
  );
}
