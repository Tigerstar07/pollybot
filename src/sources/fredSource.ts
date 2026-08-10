import type { AppConfig } from "../config";
import type { Db } from "../db";
import { getCachedSource, saveSourceObservation } from "../db";
import type { NormalizedMarket, SourceObservation } from "../types";
import { nowIso, referencesNonUsEconomy } from "../utils";
import { resilientFetchJson } from "../utils/fetch";

/**
 * Macro evidence via the free FRED (St. Louis Fed) API for the series the BLS source does
 * not cover: the federal funds rate, Treasury yields, real GDP growth and PCE inflation.
 *
 * It emits the same "macro-economic" observation shape as the BLS source, so the existing
 * threshold consumer in probability/heuristics.ts models it without changes. The macro
 * router only calls this when a market clearly references a FRED-specific metric, so it
 * never competes with BLS for CPI/unemployment/payroll markets.
 */

interface FredResponse {
  observations?: Array<{ date?: string; value?: string }>;
}

interface FredSeries {
  id: string;
  metric: "level" | "index_yoy";
  label: string;
  unit: "percent";
  defaultStd: number;
}

const SERIES: Array<{ pattern: RegExp; series: FredSeries }> = [
  {
    pattern: /\bcore pce\b/i,
    series: { id: "PCEPILFE", metric: "index_yoy", label: "US core PCE inflation (YoY)", unit: "percent", defaultStd: 0.25 },
  },
  {
    pattern: /\bpce\b/i,
    series: { id: "PCEPI", metric: "index_yoy", label: "US PCE inflation (YoY)", unit: "percent", defaultStd: 0.25 },
  },
  {
    pattern: /\b(10[\s-]?year|10y)\b.*\b(treasury|yield|note)\b|\b(treasury|bond)\s+yield\b/i,
    series: { id: "DGS10", metric: "level", label: "US 10-year Treasury yield", unit: "percent", defaultStd: 0.35 },
  },
  {
    pattern: /\b(2[\s-]?year|2y)\b.*\b(treasury|yield|note)\b/i,
    series: { id: "DGS2", metric: "level", label: "US 2-year Treasury yield", unit: "percent", defaultStd: 0.35 },
  },
  {
    pattern: /\b(gdp|gross domestic product)\b/i,
    series: { id: "A191RL1Q225SBEA", metric: "level", label: "US real GDP growth (annualized)", unit: "percent", defaultStd: 1.5 },
  },
  {
    pattern:
      /\bfed(eral)? funds\b|\bfomc\b|\bpolicy rate\b|\brate (cut|hike|decision|cuts|hikes)\b|(?=.*\bfed\b)\binterest rate\b/i,
    series: { id: "FEDFUNDS", metric: "level", label: "US federal funds rate", unit: "percent", defaultStd: 0.25 },
  },
];

export function detectFredSeries(market: NormalizedMarket): FredSeries | undefined {
  const text = `${market.title} ${market.rules ?? ""}`;
  // FRED only carries US series; never match a foreign-economy market (e.g. China GDP).
  if (referencesNonUsEconomy(text)) return undefined;
  // A historical rate level cannot price categorical meeting outcomes such as
  // "no change", "+25 bps", or "how many cuts". Those need a meeting-specific
  // futures/economist-consensus model, not FEDFUNDS with a number parsed from the date.
  if (/\b(meeting|basis points?|bps|no change|rate cuts?|rate hikes?|cut rates?|hike rates?)\b/i.test(text)) {
    return undefined;
  }
  return SERIES.find(({ pattern }) => pattern.test(text))?.series;
}

export async function getFredObservation(config: AppConfig, db: Db, market: NormalizedMarket): Promise<SourceObservation> {
  const series = detectFredSeries(market);
  if (!series) return unavailable(market, "No supported FRED macro series was recognized");
  if (!config.fredApiKey) return unavailable(market, "FRED_API_KEY is not configured for rate/yield/GDP/PCE evidence");

  const cacheKey = `fred:${series.id}:v1`;
  const cached = getCachedSource(db, "macro-economic", cacheKey);
  if (cached) return withMarketKey(cached, market);

  try {
    const limit = series.metric === "index_yoy" ? 40 : 24;
    const url = new URL("/fred/series/observations", config.fredApiUrl);
    url.searchParams.set("series_id", series.id);
    url.searchParams.set("api_key", config.fredApiKey);
    url.searchParams.set("file_type", "json");
    url.searchParams.set("sort_order", "desc");
    url.searchParams.set("limit", String(limit));
    const { data } = await resilientFetchJson<FredResponse>(url, {
      timeoutMs: 12_000,
      headers: { "user-agent": "pollybot/1.1 research and paper-trading bot" },
    });
    const points = parseFredPoints(data);
    if (points.length < 2) throw new Error("FRED returned too few usable observations");
    const transformed = transformSeries(series, points);
    if (!transformed) throw new Error("FRED series could not be transformed for this market");

    const observation: SourceObservation = {
      sourceType: "macro-economic",
      sourceKey: cacheKey,
      collectedAt: nowIso(),
      // Rates/yields update daily but the threshold model is robust; cache 6h to be polite.
      expiresAt: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
      available: true,
      independent: true,
      quality: transformed.history.length >= 12 ? 0.72 : 0.56,
      payload: {
        provider: "fred",
        seriesId: series.id,
        metric: series.metric,
        label: series.label,
        unit: series.unit,
        latestPeriod: transformed.latestPeriod,
        latestValue: transformed.latestValue,
        history: transformed.history,
        sampleCount: transformed.history.length,
        standardDeviation: standardDeviation(transformed.history.slice(-12)) ?? series.defaultStd,
        defaultStd: series.defaultStd,
      },
    };
    saveSourceObservation(db, null, observation);
    return withMarketKey(observation, market);
  } catch (error) {
    const observation: SourceObservation = {
      sourceType: "macro-economic",
      sourceKey: cacheKey,
      collectedAt: nowIso(),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      payload: { provider: "fred", seriesId: series.id, metric: series.metric, label: series.label },
      available: false,
      independent: true,
      quality: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
    saveSourceObservation(db, null, observation);
    return withMarketKey(observation, market);
  }
}

function parseFredPoints(payload: FredResponse): Array<{ period: string; value: number }> {
  const raw = payload.observations ?? [];
  return raw
    .map((point) => ({ period: String(point.date ?? ""), value: Number(point.value) }))
    .filter((point) => /^\d{4}-\d{2}-\d{2}$/.test(point.period) && Number.isFinite(point.value))
    .sort((a, b) => a.period.localeCompare(b.period)); // chronological ascending
}

function transformSeries(
  series: FredSeries,
  points: Array<{ period: string; value: number }>,
): { latestPeriod: string; latestValue: number; history: number[]; defaultStd: number } | undefined {
  if (series.metric === "index_yoy") {
    if (points.length < 13) return undefined;
    const values: Array<{ period: string; value: number }> = [];
    for (let i = 12; i < points.length; i += 1) {
      const current = points[i]!;
      const lastYear = points[i - 12]!;
      if (lastYear.value > 0) values.push({ period: current.period, value: (current.value / lastYear.value - 1) * 100 });
    }
    const latest = values[values.length - 1];
    return latest
      ? { latestPeriod: latest.period, latestValue: latest.value, history: values.map((v) => v.value), defaultStd: series.defaultStd }
      : undefined;
  }
  const latest = points[points.length - 1];
  return latest
    ? { latestPeriod: latest.period, latestValue: latest.value, history: points.map((v) => v.value), defaultStd: series.defaultStd }
    : undefined;
}

function standardDeviation(values: number[]): number | undefined {
  if (values.length < 3) return undefined;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const std = Math.sqrt(variance);
  return Number.isFinite(std) && std > 0 ? std : undefined;
}

function withMarketKey(observation: SourceObservation, market: NormalizedMarket): SourceObservation {
  return { ...observation, sourceKey: `macro:${market.marketId}` };
}

function unavailable(market: NormalizedMarket, reason: string): SourceObservation {
  return {
    sourceType: "macro-economic",
    sourceKey: `macro:${market.marketId}`,
    collectedAt: nowIso(),
    payload: {},
    available: false,
    independent: true,
    quality: 0,
    reason: market.category === "macro" ? reason : "Not a macro market",
  };
}
