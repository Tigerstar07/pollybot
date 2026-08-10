import type { AppConfig } from "../config";
import type { Db } from "../db";
import { getCachedSource, saveSourceObservation } from "../db";
import type { NormalizedMarket, SourceObservation } from "../types";
import { nowIso } from "../utils";
import { resilientFetchJson } from "../utils/fetch";
import { buildQuery } from "./newsSource";

interface TmdbSearchResponse {
  results?: Array<{ title?: string; name?: string; release_date?: string; first_air_date?: string; popularity?: number }>;
}

export async function getCultureObservation(config: AppConfig, db: Db, market: NormalizedMarket): Promise<SourceObservation> {
  if (!config.tmdbApiKey) {
    return unavailable(market, "TMDB_API_KEY is not configured for movie/TV release-date evidence");
  }
  const query = buildCultureQuery(market.title);
  if (!query) return unavailable(market, "Culture market title produced no usable movie/TV query");
  const cacheKey = `tmdb:${query}`;
  const cached = getCachedSource(db, "culture-tmdb", cacheKey);
  if (cached) return withMarketMatch(cached, market, query);

  try {
    const url = new URL("/3/search/multi", "https://api.themoviedb.org");
    url.searchParams.set("api_key", config.tmdbApiKey);
    url.searchParams.set("query", query);
    const { data } = await resilientFetchJson<TmdbSearchResponse>(url, {
      timeoutMs: 12_000,
      headers: { "user-agent": "pollybot/1.1 research and paper-trading bot" },
    });
    const results = (data.results ?? []).slice(0, 8).map((result) => ({
      title: result.title ?? result.name,
      releaseDate: result.release_date ?? result.first_air_date,
      popularity: result.popularity,
    }));
    const observation: SourceObservation = {
      sourceType: "culture-tmdb",
      sourceKey: cacheKey,
      collectedAt: nowIso(),
      expiresAt: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
      available: results.length > 0,
      independent: true,
      quality: results.length > 0 ? 0.58 : 0,
      payload: { provider: "tmdb", query, results },
      reason: results.length > 0 ? undefined : "TMDB returned no matching movie/TV results",
    };
    saveSourceObservation(db, null, observation);
    return withMarketMatch(observation, market, query);
  } catch (error) {
    return unavailable(market, error instanceof Error ? error.message : String(error));
  }
}

function withMarketMatch(observation: SourceObservation, market: NormalizedMarket, query: string): SourceObservation {
  if (!observation.available) return { ...observation, sourceKey: `culture:${market.marketId}` };
  const results = Array.isArray(observation.payload.results) ? observation.payload.results as Array<Record<string, unknown>> : [];
  const marketText = normalize(market.title);
  const ranked = results
    .map((result) => ({ result, score: titleScore(marketText, String(result.title ?? "")) }))
    .sort((a, b) => b.score - a.score);
  return {
    ...observation,
    sourceKey: `culture:${market.marketId}`,
    payload: {
      ...observation.payload,
      query,
      matchedResult: ranked[0]?.result,
      matchScore: ranked[0]?.score ?? 0,
    },
  };
}

function buildCultureQuery(title: string): string {
  return buildQuery(title)
    .replace(/\b(movie|film|season|episode|release|released|premiere|premiered|box|office)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleScore(marketText: string, title: string): number {
  const tokens = normalize(title).split(" ").filter((token) => token.length > 2);
  if (tokens.length === 0) return 0;
  return tokens.filter((token) => marketText.includes(token)).length / tokens.length;
}

function normalize(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
}

function unavailable(market: NormalizedMarket, reason: string): SourceObservation {
  return {
    sourceType: "culture-tmdb",
    sourceKey: `culture:${market.marketId}`,
    collectedAt: nowIso(),
    payload: {},
    available: false,
    independent: true,
    quality: 0,
    reason,
  };
}
