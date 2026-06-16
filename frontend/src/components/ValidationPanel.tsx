import { ValidationResult } from "../types";

export function ValidationBadge({ ok }: { ok: boolean }) {
  return ok ? (
    <span style={{ color: "var(--green)", fontWeight: 600 }}>✓</span>
  ) : (
    <span style={{ color: "var(--red)", fontWeight: 600 }}>✗</span>
  );
}

export default function ValidationPanel({
  validation,
  validating,
}: {
  validation: ValidationResult | null;
  validating: boolean;
}) {
  if (!validation && !validating) return null;

  return (
    <div className="validation-panel">
      <div className="validation-title">
        Verificare compatibilitate
        {validating && <span className="spinner" style={{ marginLeft: 8 }} />}
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
                  style={{ marginBottom: 4, padding: "6px 10px", fontSize: 12 }}
                >
                  {err}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
