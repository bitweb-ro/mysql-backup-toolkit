// Intervalul maxim (în ore) dintre două rulări ale unei expresii cron, pentru formele generate de pagina
// Program (la N ore, zilnic, luni–vineri, săptămânal, lunar). null = formă necunoscută (nu se poate estima).
export function maxCronIntervalHours(expr: string): number | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts;
  if (!/^\d+$/.test(minute) || month !== '*') return null;

  if (dom === '*' && dow === '*') {
    if (hour === '*') return 1;
    const every = hour.match(/^\*\/(\d+)$/);
    if (every) return Number(every[1]);
    if (/^\d+$/.test(hour)) return 24;
    return null;
  }
  if (!/^\d+$/.test(hour)) return null;
  if (dom === '*' && dow === '1-5') return 72; // vineri → luni
  if (dom === '*' && /^\d$/.test(dow)) return 7 * 24;
  if (/^\d+$/.test(dom) && dow === '*') return 31 * 24;
  return null;
}
