import { useState, useEffect, useCallback } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import { Connection, Schedule } from "../types";

const CRON_PRESETS = [
  { label: "În fiecare zi la 02:00", value: "0 2 * * *" },
  { label: "În fiecare zi la 00:00", value: "0 0 * * *" },
  { label: "Duminică la 01:00", value: "0 1 * * 0" },
  { label: "Luni–Vineri la 23:00", value: "0 23 * * 1-5" },
];

const INCR_PRESETS = [
  { label: "La fiecare 6 ore", value: "0 */6 * * *" },
  { label: "La fiecare 4 ore", value: "0 */4 * * *" },
  { label: "La fiecare 2 ore", value: "0 */2 * * *" },
  { label: "La fiecare oră", value: "0 * * * *" },
];

function describeCron(expr: string): string {
  if (!expr) return "";
  const presets = [...CRON_PRESETS, ...INCR_PRESETS];
  const found = presets.find((p) => p.value === expr);
  return found ? found.label : expr;
}

export default function SchedulePage() {
  const { id } = useParams<{ id: string }>();
  const [conn, setConn] = useState<Connection | null>(null);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [alert, setAlert] = useState<{
    type: "success" | "error";
    msg: string;
  } | null>(null);

  const [fullCron, setFullCron] = useState("");
  const [incrCron, setIncrCron] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [retentionDays, setRetentionDays] = useState(30);
  const [cleanupIncrementals, setCleanupIncrementals] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [c, s] = await Promise.all([
        api.getConnection(id),
        api.getSchedule(id),
      ]);
      setConn(c);
      setSchedule(s);
      if (s) {
        setFullCron(s.full_cron || "");
        setIncrCron(s.incremental_cron || "");
        setEnabled(s.enabled);
        setRetentionDays(s.retention_days);
        setCleanupIncrementals(s.cleanup_incrementals);
      }
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async () => {
    if (!id) return;
    setSaving(true);
    setAlert(null);
    try {
      await api.saveSchedule(id, {
        full_cron: fullCron || null,
        incremental_cron: incrCron || null,
        enabled,
        retention_days: retentionDays,
        cleanup_incrementals: cleanupIncrementals,
      });
      setAlert({ type: "success", msg: "Programul a fost salvat." });
      load();
    } catch (e: unknown) {
      setAlert({
        type: "error",
        msg: e instanceof Error ? e.message : "Eroare la salvare",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!id || !confirm("Ștergi programul de backup pentru acest server?"))
      return;
    try {
      await api.deleteSchedule(id);
      setSchedule(null);
      setFullCron("");
      setIncrCron("");
      setAlert({ type: "success", msg: "Programul a fost șters." });
    } catch (e: unknown) {
      setAlert({
        type: "error",
        msg: e instanceof Error ? e.message : "Eroare",
      });
    }
  };

  if (loading) {
    return (
      <div
        className="page-content"
        style={{ color: "var(--text3)", display: "flex", gap: 10 }}
      >
        <span className="spinner" /> Se încarcă...
      </div>
    );
  }

  if (!conn) {
    return (
      <div className="page-content">
        <div className="alert error">Conexiunea nu a fost găsită.</div>
      </div>
    );
  }

  return (
    <>
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h2>Program backup — {conn.name}</h2>
            <p className="mono">
              {conn.user}@{conn.host}:{conn.port}/{conn.database_name}
            </p>
          </div>
          <div className="page-actions">
            {schedule && (
              <button className="btn btn-danger btn-sm" onClick={handleDelete}>
                Șterge programul
              </button>
            )}
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? <span className="spinner" /> : null} Salvează programul
            </button>
          </div>
        </div>
      </div>

      <div className="page-content" style={{ maxWidth: 680 }}>
        {alert && (
          <div className={`alert ${alert.type}`} style={{ marginBottom: 20 }}>
            {alert.msg}
          </div>
        )}

        {/* Enable toggle */}
        <div className="card" style={{ marginBottom: 16 }}>
          <label className="schedule-toggle">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <span>Program activ</span>
            <span
              className={`badge ${enabled ? "success" : "failed"}`}
              style={{ marginLeft: "auto" }}
            >
              {enabled ? "Activat" : "Dezactivat"}
            </span>
          </label>
        </div>

        {/* Full backup schedule */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <span className="card-title">Full Backup</span>
            {fullCron && <span className="meta">{describeCron(fullCron)}</span>}
          </div>
          <div className="form-group" style={{ marginBottom: 10 }}>
            <label className="form-label">Expresie cron</label>
            <input
              value={fullCron}
              onChange={(e) => setFullCron(e.target.value)}
              placeholder="ex: 0 2 * * *  (în fiecare zi la 02:00)"
              className="mono"
            />
            <div className="meta" style={{ marginTop: 4 }}>
              Format: minute oră zi-lună lună zi-săptămână ·{" "}
              <a
                href="https://crontab.guru"
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--accent)" }}
              >
                crontab.guru
              </a>
            </div>
          </div>
          <div className="cron-presets">
            {CRON_PRESETS.map((p) => (
              <button
                key={p.value}
                className={`preset-btn ${fullCron === p.value ? "active" : ""}`}
                onClick={() => setFullCron(p.value)}
              >
                {p.label}
              </button>
            ))}
            <button className="preset-btn" onClick={() => setFullCron("")}>
              Dezactivat
            </button>
          </div>
        </div>

        {/* Incremental schedule */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <span className="card-title">Backup Incremental</span>
            {incrCron && <span className="meta">{describeCron(incrCron)}</span>}
          </div>
          <div className="form-group" style={{ marginBottom: 10 }}>
            <label className="form-label">Expresie cron</label>
            <input
              value={incrCron}
              onChange={(e) => setIncrCron(e.target.value)}
              placeholder="ex: 0 */6 * * *  (la fiecare 6 ore)"
              className="mono"
            />
          </div>
          <div className="cron-presets">
            {INCR_PRESETS.map((p) => (
              <button
                key={p.value}
                className={`preset-btn ${incrCron === p.value ? "active" : ""}`}
                onClick={() => setIncrCron(p.value)}
              >
                {p.label}
              </button>
            ))}
            <button className="preset-btn" onClick={() => setIncrCron("")}>
              Dezactivat
            </button>
          </div>
        </div>

        {/* Retention & Cleanup */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <span className="card-title">Retenție și curățare</span>
          </div>

          <div className="form-group" style={{ marginBottom: 14 }}>
            <label className="form-label">
              Păstrează backup-urile timp de (zile)
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input
                type="number"
                min={1}
                max={365}
                value={retentionDays}
                onChange={(e) =>
                  setRetentionDays(parseInt(e.target.value) || 30)
                }
                style={{ width: 100 }}
              />
              <span className="meta">
                Backup-urile mai vechi de {retentionDays} zile vor fi șterse
                automat după fiecare backup full.
              </span>
            </div>
          </div>

          <label
            className="schedule-toggle"
            style={{ padding: "10px 0", borderTop: "1px solid var(--border)" }}
          >
            <input
              type="checkbox"
              checked={cleanupIncrementals}
              onChange={(e) => setCleanupIncrementals(e.target.checked)}
            />
            <div>
              <div style={{ fontWeight: 500, fontSize: 13 }}>
                Șterge incrementalele din ziua precedentă după backup full
              </div>
              <div className="meta" style={{ marginTop: 2 }}>
                Dacă există un backup full pentru ziua X, toate incrementalele
                din ziua X vor fi șterse automat după backup-ul full următor.
                Economisești spațiu păstrând doar full-ul + incrementalele din
                ziua curentă.
              </div>
            </div>
          </label>
        </div>

        {/* Preview */}
        {(fullCron || incrCron) && (
          <div
            className="card"
            style={{ background: "var(--bg3)", marginBottom: 16 }}
          >
            <div className="card-header" style={{ marginBottom: 8 }}>
              <span className="card-title">Rezumat program</span>
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                fontSize: 13,
                color: "var(--text2)",
              }}
            >
              {fullCron && (
                <div>
                  <span style={{ color: "var(--accent)" }}>Full backup:</span>{" "}
                  {describeCron(fullCron)}{" "}
                  <span className="mono" style={{ color: "var(--text3)" }}>
                    ({fullCron})
                  </span>
                </div>
              )}
              {incrCron && (
                <div>
                  <span style={{ color: "#a78bfa" }}>Incremental:</span>{" "}
                  {describeCron(incrCron)}{" "}
                  <span className="mono" style={{ color: "var(--text3)" }}>
                    ({incrCron})
                  </span>
                </div>
              )}
              <div>
                <span style={{ color: "var(--amber)" }}>Retenție:</span>{" "}
                {retentionDays} zile
              </div>
              <div>
                <span style={{ color: "var(--amber)" }}>
                  Curățare incrementale vechi:
                </span>{" "}
                {cleanupIncrementals ? "Da" : "Nu"}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
