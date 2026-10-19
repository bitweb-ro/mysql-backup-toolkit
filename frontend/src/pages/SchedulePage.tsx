import { useState, useEffect, useCallback } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import { Connection, Schedule } from "../types";
import {
  CronFreq, CronParts, HOUR_STEPS, WEEKDAYS,
  buildCron, parseCron, describeCron, maxIntervalHours, formatHours,
} from "../cron";

const FREQ_LABELS: Record<CronFreq, string> = {
  off: "Dezactivat",
  hours: "La fiecare câteva ore",
  daily: "Zilnic (la 24 de ore)",
  weekdays: "Luni–vineri",
  weekly: "Săptămânal",
  monthly: "Lunar",
  custom: "Personalizat (expresie cron)",
};

// Frecvență + oră / zi → expresie cron. Starea internă se reinițializează prin `key` (după încărcare / ștergere).
function CronPicker({ value, onChange, freqs, defaults }: {
  value: string;
  onChange: (cron: string) => void;
  freqs: CronFreq[];
  defaults: Omit<CronParts, "freq" | "custom">;
}) {
  const [parts, setParts] = useState<CronParts>(() => parseCron(value, defaults));
  const update = (patch: Partial<CronParts>) => {
    const next = { ...parts, ...patch };
    if (patch.freq === "custom" && !next.custom) next.custom = buildCron(parts);
    setParts(next);
    onChange(buildCron(next));
  };
  const options = freqs.includes(parts.freq) ? freqs : [...freqs, parts.freq];
  const timed = ["daily", "weekdays", "weekly", "monthly"].includes(parts.freq);

  return (
    <div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="form-group" style={{ marginBottom: 0, minWidth: 200 }}>
          <label className="form-label">Frecvență</label>
          <select value={parts.freq} onChange={(e) => update({ freq: e.target.value as CronFreq })}>
            {options.map((f) => <option key={f} value={f}>{FREQ_LABELS[f]}</option>)}
          </select>
        </div>
        {parts.freq === "hours" && (
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Interval</label>
            <select value={parts.hours} onChange={(e) => update({ hours: Number(e.target.value) })}>
              {HOUR_STEPS.map((h) => <option key={h} value={h}>{h === 1 ? "la fiecare oră" : `la ${h} ore`}</option>)}
            </select>
          </div>
        )}
        {parts.freq === "weekly" && (
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Ziua</label>
            <select value={parts.weekday} onChange={(e) => update({ weekday: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 6, 0].map((d) => <option key={d} value={d}>{WEEKDAYS[d]}</option>)}
            </select>
          </div>
        )}
        {parts.freq === "monthly" && (
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Ziua din lună</label>
            <select value={parts.monthDay} onChange={(e) => update({ monthDay: Number(e.target.value) })}>
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        )}
        {timed && (
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Ora</label>
            <input type="time" value={parts.time} onChange={(e) => e.target.value && update({ time: e.target.value })} />
          </div>
        )}
      </div>

      {parts.freq === "custom" && (
        <div className="form-group" style={{ marginTop: 10, marginBottom: 0 }}>
          <input
            value={parts.custom}
            onChange={(e) => update({ custom: e.target.value })}
            placeholder="ex: 30 1 * * 6  (sâmbătă la 01:30)"
            className="mono"
          />
          <div className="meta" style={{ marginTop: 4 }}>
            Format: minute oră zi-lună lună zi-săptămână ·{" "}
            <a href="https://crontab.guru" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
              crontab.guru
            </a>
          </div>
        </div>
      )}
      {parts.freq === "monthly" && (
        <div className="meta" style={{ marginTop: 6 }}>Zilele 29–31 nu există în fiecare lună, de aceea lista se oprește la 28.</div>
      )}
      {parts.freq !== "off" && parts.freq !== "custom" && (
        <div className="meta" style={{ marginTop: 6 }}>
          cron: <span className="mono">{buildCron(parts)}</span>
        </div>
      )}
    </div>
  );
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
  const [pickerKey, setPickerKey] = useState(0); // reinițializează selectoarele după încărcare / ștergere

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
      setPickerKey((k) => k + 1);
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
      setPickerKey((k) => k + 1);
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

  // Combinații care nu au sens sau care fac restaurarea nesigură
  const fullHours = maxIntervalHours(fullCron);
  const incrHours = maxIntervalHours(incrCron);
  const warnings: string[] = [];
  if (incrCron && !fullCron) {
    warnings.push(
      "Incremental fără full programat: fiecare incremental depinde de ultimul full și de toate incrementalele de după el. " +
      "Lanțul crește la nesfârșit, iar retenția nu poate șterge nimic din el. Programează și un full (ex: săptămânal sau lunar)."
    );
  }
  if (fullHours && incrHours && incrHours >= fullHours) {
    warnings.push(
      `Incrementalul (${describeCron(incrCron)}) nu rulează mai des decât full-ul (${describeCron(fullCron)}), deci nu aduce ` +
      "puncte de restaurare în plus. Alege un interval mai scurt pentru incremental sau dezactivează-l."
    );
  }
  if (incrHours && incrHours >= 7 * 24) {
    warnings.push(
      `Incrementalul rulează la până la ${formatHours(incrHours)}: serverul MySQL trebuie să păstreze binlog-urile cel puțin ` +
      "atât (binlog_expire_logs_seconds), altfel incrementalul eșuează. Verifică cu „Testează drepturile și configurațiile”."
    );
  }
  // Retenția păstrează și full-ul de bază (cu incrementalele lui) de care depind backup-urile din ultimele N zile
  const maxKeptDays = fullHours ? retentionDays + Math.ceil(fullHours / 24) : null;

  return (
    <>
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h2>Program backup</h2>
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
          <CronPicker
            key={`full-${pickerKey}`}
            value={fullCron}
            onChange={setFullCron}
            freqs={["off", "daily", "weekdays", "weekly", "monthly", "custom"]}
            defaults={{ hours: 24, time: "02:00", weekday: 0, monthDay: 1 }}
          />
        </div>

        {/* Incremental schedule */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <span className="card-title">Backup Incremental</span>
            {incrCron && <span className="meta">{describeCron(incrCron)}</span>}
          </div>
          <CronPicker
            key={`incr-${pickerKey}`}
            value={incrCron}
            onChange={setIncrCron}
            freqs={["off", "hours", "daily", "weekly", "monthly", "custom"]}
            defaults={{ hours: 6, time: "14:00", weekday: 3, monthDay: 15 }}
          />
        </div>

        {warnings.length > 0 && (
          <div className="alert error" style={{ marginBottom: 16, flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
            {warnings.map((w) => <div key={w}>⚠ {w}</div>)}
          </div>
        )}

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
                max={3650}
                value={retentionDays}
                onChange={(e) =>
                  setRetentionDays(parseInt(e.target.value) || 30)
                }
                style={{ width: 100 }}
              />
              <span className="meta">
                Orice moment din ultimele {retentionDays} zile rămâne restaurabil.
              </span>
            </div>
            <div className="meta" style={{ marginTop: 8, lineHeight: 1.6 }}>
              Curățarea rulează după fiecare backup reușit și șterge pe lanțuri: un incremental se restaurează doar peste
              full-ul de dinaintea lui și peste toate incrementalele dintre ele. De aceea se păstrează și full-ul de bază
              (cel mai nou full mai vechi de {retentionDays} zile) împreună cu incrementalele lui, iar cel mai nou full nu
              se șterge niciodată, nici dacă full-urile eșuează o perioadă.
              {maxKeptDays && maxKeptDays > retentionDays && (
                <> Cu full {describeCron(fullCron)}, pe disc pot rămâne backup-uri de până la ~{maxKeptDays} zile.</>
              )}
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
                Păstrează doar incrementalele de după ultimul full
              </div>
              <div className="meta" style={{ marginTop: 2 }}>
                După fiecare full reușit, incrementalele dinaintea lui se șterg (datele lor sunt deja în full).
                Economisești spațiu, dar momentele dintre full-urile mai vechi nu se mai pot restaura exact, doar
                full-urile. Incrementalele de după ultimul full, necesare pentru starea actuală, nu se șterg.
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
                  Doar incrementalele de după ultimul full:
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
