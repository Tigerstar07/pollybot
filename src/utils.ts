export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (Array.isArray(value) || (value && typeof value === "object")) return value as T;
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean).map((value) => value.trim()).filter(Boolean))];
}

export function formatMoney(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return "-";
  return value.toFixed(2);
}

export function formatPct(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

export function formatSigned(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return "-";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(3)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

const NON_US_ECONOMY =
  /\b(china|chinese|pboc|eurozone|euro area|euro-area|ecb|european central bank|\buk\b|u\.k\.|britain|british|bank of england|\bboe\b|japan|japanese|bank of japan|\bboj\b|india|indian|reserve bank|canada|canadian|bank of canada|germany|german|france|french|brazil|brazilian|russia|russian|mexico|mexican|australia|australian|\brba\b|turkey|turkish|israel|south korea|korean|switzerland|swiss|\bsnb\b)\b/i;

/**
 * True when a market clearly references a non-US economy/central bank. The BLS and FRED
 * sources only carry US series, so they must not be matched against e.g. "China GDP" or
 * "Bank of Israel rate" markets (doing so produced wrong-side forecasts).
 */
export function referencesNonUsEconomy(text: string): boolean {
  if (NON_US_ECONOMY.test(text)) return true;
  // A generic/foreign "central bank" must never silently fall through to US data.
  // Require an explicit US/Federal Reserve reference before treating such wording as US.
  return /\bcentral bank\b/i.test(text) &&
    !/\b(u\.?s\.?|united states|america(?:n)?|federal reserve|fomc|fed)\b/i.test(text);
}

export function daysUntil(iso?: string): number | undefined {
  if (!iso) return undefined;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return undefined;
  return (time - Date.now()) / 86_400_000;
}
