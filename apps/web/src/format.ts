// Small display helpers shared by pages.

/** "sqld sqld 0.24.32 (40c272de 2025-02-14)" → "0.24.32" (null if no x.y.z). */
export function shortSqldVersion(raw: string | null | undefined): string | null {
  const m = raw ? /(\d+\.\d+\.\d+)/.exec(raw) : null;
  return m ? m[1]! : null;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "in 12 months", "yesterday", "5 minutes ago", "just now". */
export function relTime(epochMs: number, now = Date.now()): string {
  const diff = epochMs - now;
  for (let i = 0; i < UNITS.length; i++) {
    const [unit, ms] = UNITS[i]!;
    if (Math.abs(diff) < ms && unit !== "minute") continue;
    const v = Math.round(diff / ms);
    // Rounding can reach the next unit up (350 days → "12 months"): use it.
    const up = UNITS[i - 1];
    if (up && Math.abs(v * ms) >= up[1]) return rtf.format(Math.round(diff / up[1]), up[0]);
    return v === 0 ? "just now" : rtf.format(v, unit);
  }
  return "just now";
}

/** Full local timestamp, for title= tooltips next to relative times. */
export const fullTime = (epochMs: number) => new Date(epochMs).toLocaleString();
