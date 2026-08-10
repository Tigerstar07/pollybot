import type { Db } from "../db";
import { getCachedSource, saveSourceObservation } from "../db";
import type { NormalizedMarket, SourceObservation } from "../types";
import { nowIso, referencesNonUsEconomy } from "../utils";
import { resilientFetchJson } from "../utils/fetch";

interface BlsResponse {
  status?: string;
  Results?: {
    series?: Array<{
      seriesID?: string;
      data?: Array<{ year?: string; period?: string; periodName?: string; value?: string; latest?: string }>;
    }>;
  };
}

interface MacroSeries {
  id: string;
  metric: "cpi_yoy" | "unemployment_rate" | "payroll_change";
  label: string;
  unit: "percent" | "thousand_jobs";
}

export async function getMacroCalendarObservation(db: Db, market: NormalizedMarket): Promise<SourceObservation> {
  const series = detectMacroSeries(market);
  if (!series) {
    return unavailable(market, "No supported public macro series was recognized");
  }

  const cacheKey = `bls:${series.id}:v1`;
  const cached = getCachedSource(db, "macro-economic", cacheKey);
  if (cached) return withMarketKey(cached, market);

  try {
    const url = `https://api.bls.gov/publicAPI/v2/timeseries/data/${series.id}`;
    const { data } = await resilientFetchJson<BlsResponse>(url, {
      timeoutMs: 12_000,
      headers: { "user-agent": "pollybot/1.1 research and paper-trading bot" },
    });
    const points = parseBlsPoints(data);
    if (points.length < 2) throw new Error("BLS returned too few usable observations");
    const transformed = transformSeries(series, points);
    if (!transformed) throw new Error("BLS series could not be transformed for this market");

    const observation: SourceObservation = {
      sourceType: "macro-economic",
      sourceKey: cacheKey,
      collectedAt: nowIso(),
      // BLS values update monthly; cache for 6 hours to avoid hammering the public API.
      expiresAt: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
      available: true,
      independent: true,
      quality: transformed.history.length >= 12 ? 0.72 : 0.56,
      payload: {
        provider: "bls-public-api",
        seriesId: series.id,
        metric: series.metric,
        label: series.label,
        unit: series.unit,
        latestPeriod: transformed.latestPeriod,
        latestValue: transformed.latestValue,
        history: transformed.history,
        sampleCount: transformed.history.length,
        standardDeviation: standardDeviation(transformed.history.slice(-12)) ?? transformed.defaultStd,
        defaultStd: transformed.defaultStd,
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
      payload: { provider: "bls-public-api", seriesId: series.id, metric: series.metric, label: series.label },
      available: false,
      independent: true,
      quality: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
    saveSourceObservation(db, null, observation);
    return withMarketKey(observation, market);
  }
}

function detectMacroSeries(market: NormalizedMarket): MacroSeries | undefined {
  const text = `${market.title} ${market.rules ?? ""}`.toLowerCase();
  // BLS only carries US series; never match a foreign-economy market.
  if (referencesNonUsEconomy(text)) return undefined;
  if (/\b(cpi|consumer price index|inflation)\b/.test(text)) {
    return { id: "CUSR0000SA0", metric: "cpi_yoy", label: "US CPI year-over-year inflation", unit: "percent" };
  }
  if (/\b(unemployment|jobless rate)\b/.test(text)) {
    return { id: "LNS14000000", metric: "unemployment_rate", label: "US unemployment rate", unit: "percent" };
  }
  if (/\b(nonfarm payroll|payrolls?|jobs report|jobs added|employment change)\b/.test(text)) {
    return { id: "CES0000000001", metric: "payroll_change", label: "US nonfarm payroll monthly change", unit: "thousand_jobs" };
  }
  return undefined;
}

function parseBlsPoints(payload: BlsResponse): Array<{ period: string; value: number }> {
  const raw = payload.Results?.series?.[0]?.data ?? [];
  return raw
    .map((point) => ({
      period: `${point.year ?? ""}-${String(point.period ?? "").replace(/^M/, "").padStart(2, "0")}`,
      value: Number(point.value),
    }))
    .filter((point) => /^\d{4}-\d{2}$/.test(point.period) && Number.isFinite(point.value))
    .sort((a, b) => a.period.localeCompare(b.period));
}

function transformSeries(
  series: MacroSeries,
  points: Array<{ period: string; value: number }>,
): { latestPeriod: string; latestValue: number; history: number[]; defaultStd: number } | undefined {
  if (series.metric === "cpi_yoy") {
    if (points.length < 13) return undefined;
    const values: Array<{ period: string; value: number }> = [];
    for (let i = 12; i < points.length; i += 1) {
      const current = points[i]!;
      const lastYear = points[i - 12]!;
      if (lastYear.value > 0) values.push({ period: current.period, value: ((current.value / lastYear.value) - 1) * 100 });
    }
    const latest = values[values.length - 1];
    return latest ? { latestPeriod: latest.period, latestValue: latest.value, history: values.map((v) => v.value), defaultStd: 0.25 } : undefined;
  }
  if (series.metric === "payroll_change") {
    const values: Array<{ period: string; value: number }> = [];
    for (let i = 1; i < points.length; i += 1) {
      values.push({ period: points[i]!.period, value: points[i]!.value - points[i - 1]!.value });
    }
    const latest = values[values.length - 1];
    return latest ? { latestPeriod: latest.period, latestValue: latest.value, history: values.map((v) => v.value), defaultStd: 125 } : undefined;
  }
  const latest = points[points.length - 1];
  return latest ? { latestPeriod: latest.period, latestValue: latest.value, history: points.map((v) => v.value), defaultStd: 0.25 } : undefined;
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
