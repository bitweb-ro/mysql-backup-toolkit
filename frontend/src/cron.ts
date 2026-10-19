// Expresii cron pentru pagina Program: construire din frecvență + oră, descriere în română și
// intervalul maxim dintre rulări (aceleași forme ca backend/src/services/cronInterval.ts).

export type CronFreq = "off" | "hours" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";

export interface CronParts {
  freq: CronFreq;
  hours: number;    // freq = hours: la fiecare N ore
  time: string;     // HH:MM, pentru daily / weekdays / weekly / monthly
  weekday: number;  // 0 = duminică
  monthDay: number; // 1–28, ca să ruleze în fiecare lună
  custom: string;
}

export const HOUR_STEPS = [1, 2, 4, 6, 12];
export const WEEKDAYS = ["duminică", "luni", "marți", "miercuri", "joi", "vineri", "sâmbătă"];

const pad = (n: number) => String(n).padStart(2, "0");

export function buildCron(p: CronParts): string {
  const [hh, mm] = p.time.split(":").map(Number);
  switch (p.freq) {
    case "off": return "";
    case "hours": return p.hours === 1 ? "0 * * * *" : `0 */${p.hours} * * *`;
    case "daily": return `${mm} ${hh} * * *`;
    case "weekdays": return `${mm} ${hh} * * 1-5`;
    case "weekly": return `${mm} ${hh} * * ${p.weekday}`;
    case "monthly": return `${mm} ${hh} ${p.monthDay} * *`;
    case "custom": return p.custom.trim();
  }
}

export function parseCron(expr: string, fallback: Omit<CronParts, "freq" | "custom">): CronParts {
  const base: CronParts = { ...fallback, freq: "custom", custom: expr };
  if (!expr.trim()) return { ...base, freq: "off" };
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5 || f[3] !== "*" || !/^\d+$/.test(f[0])) return base;
  const [minute, hour, dom, , dow] = f;

  if (dom === "*" && dow === "*" && minute === "0") {
    if (hour === "*") return { ...base, freq: "hours", hours: 1 };
    const every = hour.match(/^\*\/(\d+)$/);
    if (every && HOUR_STEPS.includes(Number(every[1]))) return { ...base, freq: "hours", hours: Number(every[1]) };
  }
  if (!/^\d+$/.test(hour) || Number(hour) > 23 || Number(minute) > 59) return base;
  const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
  if (dom === "*" && dow === "*") return { ...base, freq: "daily", time };
  if (dom === "*" && dow === "1-5") return { ...base, freq: "weekdays", time };
  if (dom === "*" && /^[0-6]$/.test(dow)) return { ...base, freq: "weekly", time, weekday: Number(dow) };
  if (/^\d+$/.test(dom) && Number(dom) >= 1 && Number(dom) <= 28 && dow === "*") {
    return { ...base, freq: "monthly", time, monthDay: Number(dom) };
  }
  return base;
}

const DEFAULTS = { hours: 6, time: "02:00", weekday: 0, monthDay: 1 };

export function describeCron(expr: string | null | undefined): string {
  if (!expr) return "dezactivat";
  const p = parseCron(expr, DEFAULTS);
  switch (p.freq) {
    case "hours": return p.hours === 1 ? "la fiecare oră" : `la fiecare ${p.hours} ore`;
    case "daily": return `zilnic la ${p.time}`;
    case "weekdays": return `luni–vineri la ${p.time}`;
    case "weekly": return `săptămânal, ${WEEKDAYS[p.weekday]} la ${p.time}`;
    case "monthly": return `lunar, pe ${p.monthDay} la ${p.time}`;
    default: return expr;
  }
}

// Cel mai lung interval posibil între două rulări (ore); null = expresie personalizată, nu se estimează.
export function maxIntervalHours(expr: string | null | undefined): number | null {
  if (!expr) return null;
  const p = parseCron(expr, DEFAULTS);
  switch (p.freq) {
    case "hours": return p.hours;
    case "daily": return 24;
    case "weekdays": return 72;
    case "weekly": return 7 * 24;
    case "monthly": return 31 * 24;
    default: return null;
  }
}

export function formatHours(h: number): string {
  return h < 24 ? `${h} ore` : `${+(h / 24).toFixed(1)} zile`;
}
