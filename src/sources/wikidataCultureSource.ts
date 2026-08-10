import type { Db } from "../db";
import { getCachedSource, saveSourceObservation } from "../db";
import type { NormalizedMarket, SourceObservation } from "../types";
import { nowIso } from "../utils";
import { resilientFetchJson } from "../utils/fetch";
import { buildQuery } from "./newsSource";

/**
 * Keyless, non-geoblocked movie/TV release-date evidence via the public Wikidata API.
 * Used in place of TMDB when no TMDB_API_KEY is configured (TMDB signup is CloudFront
 * region-blocked for some users). It emits the same matched-result shape the culture
 * consumer in probability/heuristics.ts expects (matchedResult.releaseDate + matchScore),
 * so no consumer change is needed beyond accepting the "culture-wikidata" source type.
 */

interface WikidataSearchResponse {
  search?: Array<{ id?: string; label?: string; description?: string }>;
}

interface WikidataTimeValue {
  time?: string;
  precision?: number;
}

interface WikidataEntitiesResponse {
  entities?: Record<
    string,
    {
      labels?: { en?: { value?: string } };
      claims?: { P577?: Array<{ mainsnak?: { datavalue?: { value?: WikidataTimeValue } } }> };
    }
  >;
}

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const HEADERS = { "user-agent": "pollybot/1.1 research and paper-trading bot" };

export async function getWikidataCultureObservation(db: Db, market: NormalizedMarket): Promise<SourceObservation> {
  const query = buildCultureQuery(market.title);
  if (!query) return unavailable(market, "Culture market title produced no usable movie/TV query");

  const cacheKey = `wikidata:${query}`;
  const cached = getCachedSource(db, "culture-wikidata", cacheKey);
  if (cached) return withMarketMatch(cached, market, query);

  try {
    const results = await searchEntities(query);
    if (results.length === 0) {
      return saveAndMatch(db, market, query, [], "Wikidata returned no matching entities");
    }

    // Rank candidates by how well their label matches the market title, then resolve release
    // dates for the strongest few in a single entities call.
    const marketText = normalize(market.title);
    const ranked = results
      .map((result) => ({ result, score: titleScore(marketText, result.label ?? "") }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    const ids = ranked.map((entry) => entry.result.id).filter((id): id is string => Boolean(id));
    const releaseDates = await fetchReleaseDates(ids);

    const enriched = ranked
      .map((entry) => ({
        title: entry.result.label,
        description: entry.result.description,
        releaseDate: entry.result.id ? releaseDates[entry.result.id] : undefined,
        score: entry.score,
      }))
      .filter((entry) => entry.title);

    return saveAndMatch(db, market, query, enriched, enriched.some((entry) => entry.releaseDate)
      ? undefined
      : "Wikidata matched titles but none had a usable publication date");
  } catch (error) {
    return unavailable(market, error instanceof Error ? error.message : String(error));
  }
}

async function searchEntities(query: string): Promise<NonNullable<WikidataSearchResponse["search"]>> {
  const url = new URL(WIKIDATA_API);
  url.searchParams.set("action", "wbsearchentities");
  url.searchParams.set("search", query);
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  url.searchParams.set("type", "item");
  url.searchParams.set("limit", "5");
  const { data } = await resilientFetchJson<WikidataSearchResponse>(url, { timeoutMs: 12_000, headers: HEADERS });
  return data.search ?? [];
}

async function fetchReleaseDates(ids: string[]): Promise<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  if (ids.length === 0) return out;
  const url = new URL(WIKIDATA_API);
  url.searchParams.set("action", "wbgetentities");
  url.searchParams.set("ids", ids.join("|"));
  url.searchParams.set("props", "claims|labels");
  url.searchParams.set("languages", "en");
  url.searchParams.set("format", "json");
  const { data } = await resilientFetchJson<WikidataEntitiesResponse>(url, { timeoutMs: 12_000, headers: HEADERS });
  for (const id of ids) {
    const claims = data.entities?.[id]?.claims?.P577 ?? [];
    const dates = claims
      .map((claim) => parseWikidataTime(claim.mainsnak?.datavalue?.value))
      .filter((date): date is string => Boolean(date))
      .sort((a, b) => a.localeCompare(b));
    out[id] = dates[0]; // earliest publication/premiere date
  }
  return out;
}

/** Parses a Wikidata P577 time value (day or month precision) into a YYYY-MM-DD string. */
function parseWikidataTime(value: WikidataTimeValue | undefined): string | undefined {
  if (!value?.time || (value.precision ?? 0) < 10) return undefined; // require at least month precision
  const match = value.time.match(/^[+-](\d{4})-(\d{2})-(\d{2})/);
  if (!match) return undefined;
  const [, year, monthRaw, dayRaw] = match;
  const month = monthRaw === "00" ? "01" : monthRaw;
  const day = dayRaw === "00" ? "01" : dayRaw;
  return `${year}-${month}-${day}`;
}

function saveAndMatch(
  db: Db,
  market: NormalizedMarket,
  query: string,
  results: Array<{ title?: string; releaseDate?: string; description?: string; score: number }>,
  reason?: string,
): SourceObservation {
  const observation: SourceObservation = {
    sourceType: "culture-wikidata",
    sourceKey: `wikidata:${query}`,
    collectedAt: nowIso(),
    expiresAt: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
    available: results.length > 0,
    independent: true,
    quality: results.some((entry) => entry.releaseDate) ? 0.56 : 0,
    payload: { provider: "wikidata", query, results },
    reason,
  };
  saveSourceObservation(db, null, observation);
  return withMarketMatch(observation, market, query);
}

function withMarketMatch(observation: SourceObservation, market: NormalizedMarket, query: string): SourceObservation {
  if (!observation.available) return { ...observation, sourceKey: `culture:${market.marketId}` };
  const results = Array.isArray(observation.payload.results)
    ? (observation.payload.results as Array<Record<string, unknown>>)
    : [];
  const marketText = normalize(market.title);
  const ranked = results
    .map((result) => ({ result, score: titleScore(marketText, String(result.title ?? "")) }))
    .sort((a, b) => b.score - a.score);
  // Prefer the best-scoring candidate that actually has a release date.
  const withDate = ranked.find((entry) => entry.result.releaseDate) ?? ranked[0];
  return {
    ...observation,
    sourceKey: `culture:${market.marketId}`,
    payload: {
      ...observation.payload,
      query,
      matchedResult: withDate?.result,
      matchScore: withDate?.score ?? 0,
    },
  };
}

function buildCultureQuery(title: string): string {
  // Wikidata entity search is sensitive to extra tokens, so strip release/temporal noise
  // (month names, years, "will/before/by") and leave the proper-noun title behind.
  return buildQuery(title)
    .replace(/\b(movie|film|season|episode|release|released|releasing|premiere|premiered|debut|launch|box|office)\b/g, "")
    .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/g, "")
    .replace(/\b(will|before|after|by|until|through|next|year|end|come|out)\b/g, "")
    .replace(/\b\d{4}\b/g, "")
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
    sourceType: "culture-wikidata",
    sourceKey: `culture:${market.marketId}`,
    collectedAt: nowIso(),
    payload: {},
    available: false,
    independent: true,
    quality: 0,
    reason,
  };
}
