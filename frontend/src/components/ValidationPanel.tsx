import { CheckStatus, ValidationCheck, ValidationResult } from "../types";

const STATUS_ICON: Record<CheckStatus, { icon: string; color: string }> = {
  ok: { icon: "✓", color: "var(--green)" },
  warn: { icon: "⚠", color: "var(--amber)" },
  error: { icon: "✗", color: "var(--red)" },
  info: { icon: "ℹ", color: "var(--text3)" },
};

const SUMMARY_TEXT: Record<Exclude<CheckStatus, "info">, string> = {
  ok: "poate rula",
  warn: "poate rula, cu avertismente",
  error: "va eșua — vezi motivele marcate cu ✗",
};

const GROUPS: ValidationCheck["group"][] = ["Conexiune", "Privilegii", "Configurare server"];

function StatusIcon({ status }: { status: CheckStatus }) {
  const s = STATUS_ICON[status];
  return <span style={{ color: s.color, fontWeight: 600, width: 14, flexShrink: 0 }}>{s.icon}</span>;
}

function CheckRow({ check }: { check: ValidationCheck }) {
  const problem = check.status === "error" || check.status === "warn";
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, lineHeight: 1.5 }}>
      <StatusIcon status={check.status} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>
          <strong style={{ fontWeight: problem ? 600 : 500 }}>{check.label}</strong>
          {check.detail && (
            <span style={{ color: problem ? STATUS_ICON[check.status].color : "var(--text3)" }}> — {check.detail}</span>
          )}
        </div>
        {check.fix && (
          <pre
            className="mono"
            style={{
              margin: "4px 0 2px",
              padding: "6px 8px",
              background: "var(--bg3)",
              borderRadius: 6,
              fontSize: 11,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {check.fix}
          </pre>
        )}
      </div>
    </div>
  );
}

// Rezultatul „Testează drepturile și configurațiile”: rezumat pentru backup full / incremental,
// apoi fiecare verificare cu motivul și, unde e cazul, comanda de reparare.
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
        Drepturi și configurație
        {validating && <span className="spinner" style={{ marginLeft: 8 }} />}
      </div>
      {validation && (
        <div className="validation-checks" style={{ gap: 10 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {(["full", "incremental"] as const).map(kind => {
              const status = kind === "full" ? validation.fullBackup : validation.incrementalBackup;
              return (
                <div key={kind} style={{ display: "flex", gap: 8, fontSize: 13, fontWeight: 600 }}>
                  <StatusIcon status={status} />
                  <span>
                    Backup {kind === "full" ? "full" : "incremental"}:{" "}
                    <span style={{ color: STATUS_ICON[status].color }}>{SUMMARY_TEXT[status]}</span>
                  </span>
                </div>
              );
            })}
          </div>

          {GROUPS.map(group => {
            const checks = validation.checks.filter(c => c.group === group);
            if (checks.length === 0) return null;
            return (
              <div key={group} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div className="stat-label" style={{ marginBottom: 0, marginTop: 4 }}>{group}</div>
                {checks.map((c, i) => <CheckRow key={i} check={c} />)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
