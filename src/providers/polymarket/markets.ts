import type { AppConfig } from "../../config";
import type { NormalizedMarket } from "../../types";
import { safeJsonParse, toNumber, uniq } from "../../utils";
import { HttpRequestError, fetchJson, gammaUrl } from "./client";
import type { GammaEvent, GammaMarket } from "./types";

export async function fetchOpenMarkets(
  config: AppConfig,
  options: {
    onPage?: (page: {
      offset: number;
      events: number;
      markets: number;
      totalEvents: number;
      totalMarkets: number;
    }) => void;
  } = {},
): Promise<NormalizedMarket[]> {
  const markets: NormalizedMarket[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let fetchedEvents = 0;
  const addEvents = (events: GammaEvent[]): number => {
    const marketsBefore = markets.length;
    for (const event of events) {
      for (const market of event.markets ?? []) {
        const normalized = normalizeGammaMarket(event, market);
        if (!normalized || seen.has(normalized.marketId)) continue;
        seen.add(normalized.marketId);
        markets.push(normalized);
      }
    }
    return markets.length - marketsBefore;
  };

  while (config.scanAllMarkets || fetchedEvents < config.scanMaxEvents) {
    const remaining = config.scanAllMarkets ? config.scanPageLimit : config.scanMaxEvents - fetchedEvents;
    const limit = Math.min(config.scanPageLimit, remaining);
    const url = gammaUrl(config, "/events", {
      active: true,
      closed: false,
      // Gamma now validates against JSON response-field names. The formerly
      // documented snake_case value started returning HTTP 422 in July 2026.
      order: "volume24hr",
      ascending: false,
      limit,
      offset,
    });
    let response;
    try {
      response = await fetchJson<GammaEvent[]>(url, 25_000);
    } catch (error) {
      if (
        config.scanAllMarkets &&
        markets.length > 0 &&
        error instanceof HttpRequestError &&
        error.status === 422
      ) {
        break;
      }
      throw error;
    }
    if (!Array.isArray(response.data) || response.data.length === 0) break;

    const marketsAdded = addEvents(response.data);

    fetchedEvents += response.data.length;
    options.onPage?.({
      offset,
      events: response.data.length,
      markets: marketsAdded,
      totalEvents: fetchedEvents,
      totalMarkets: markets.length,
    });
    offset += response.data.length;
    if (response.data.length < limit) break;
  }

  await fetchSupplementalTaggedEvents(config, "daily-temperature", (events, pageOffset) => {
    const marketsAdded = addEvents(events);
    fetchedEvents += events.length;
    options.onPage?.({
      offset: pageOffset,
      events: events.length,
      markets: marketsAdded,
      totalEvents: fetchedEvents,
      totalMarkets: markets.length,
    });
  });

  return markets;
}

async function fetchSupplementalTaggedEvents(
  config: AppConfig,
  tagSlug: string,
  onEvents: (events: GammaEvent[], offset: number) => void,
): Promise<void> {
  const limit = Math.min(100, Math.max(20, config.scanPageLimit));
  const maxTaggedEvents = 400;
  for (let offset = 0; offset < maxTaggedEvents; offset += limit) {
    const url = gammaUrl(config, "/events", {
      active: true,
      closed: false,
      tag_slug: tagSlug,
      limit,
      offset,
    });
    let response;
    try {
      response = await fetchJson<GammaEvent[]>(url, 25_000);
    } catch (error) {
      if (error instanceof HttpRequestError && error.status === 422) return;
      throw error;
    }
    if (!Array.isArray(response.data) || response.data.length === 0) return;
    onEvents(response.data, offset);
    if (response.data.length < limit) return;
  }
}

export interface MarketResolution {
  marketId: string;
  closed: boolean;
  resolved: boolean;
  winningOutcome?: string;
  winningIndex?: number;
  outcomes: string[];
  outcomePrices: number[];
  umaResolutionStatus?: string;
}

/**
 * Fetches a single market's resolution state from Gamma. A market is treated as
 * resolved only when it is closed and exactly one outcome price has converged to ~1.
 * This deliberately fails closed: ambiguous, disputed, or partially-priced markets
 * return resolved=false so paper positions are never settled on a guess.
 */
export async function fetchMarketResolution(config: AppConfig, marketId: string): Promise<MarketResolution> {
  const url = gammaUrl(config, `/markets/${encodeURIComponent(marketId)}`);
  const response = await fetchJson<GammaMarket>(url, 15_000);
  const market = response.data;
  const outcomes = safeJsonParse<string[]>(market.outcomes, []);
  const outcomePrices = safeJsonParse<string[]>(market.outcomePrices, []).map((price) => toNumber(price) ?? 0);
  const closed = Boolean(market.closed);
  const pricesValid =
    outcomePrices.length === outcomes.length &&
    outcomePrices.length >= 2 &&
    outcomePrices.every((price) => Number.isFinite(price) && price >= 0 && price <= 1);
  const winners = outcomePrices.filter((price) => price >= 0.99).length;
  const winningIndex = outcomePrices.findIndex((price) => price >= 0.99);
  const resolved = closed && pricesValid && winners === 1 && winningIndex >= 0;
  return {
    marketId,
    closed,
    resolved,
    winningIndex: resolved ? winningIndex : undefined,
    winningOutcome: resolved ? outcomes[winningIndex] : undefined,
    outcomes,
    outcomePrices,
    umaResolutionStatus: market.umaResolutionStatus,
  };
}

function normalizeGammaMarket(event: GammaEvent, market: GammaMarket): NormalizedMarket | undefined {
  if (!market.id || !market.question) return undefined;
  const outcomes = safeJsonParse<string[]>(market.outcomes, []);
  const outcomePrices = safeJsonParse<string[]>(market.outcomePrices, []);
  const clobTokenIds = safeJsonParse<string[]>(market.clobTokenIds, []);
  const yesIndex = outcomes.findIndex((outcome) => outcome.toLowerCase() === "yes");
  const noIndex = outcomes.findIndex((outcome) => outcome.toLowerCase() === "no");
  const yesPrice = yesIndex >= 0 ? toNumber(outcomePrices[yesIndex]) : undefined;
  const noPrice = noIndex >= 0 ? toNumber(outcomePrices[noIndex]) : undefined;
  const tags = extractTags(event.tags);
  const category = inferCategory(`${event.title ?? ""} ${market.question}`, tags);
  const status = market.closed
    ? "closed"
    : market.umaResolutionStatus && market.umaResolutionStatus !== "proposed"
      ? market.umaResolutionStatus
      : market.active
        ? "open"
        : "inactive";
  const url = event.slug ? `https://polymarket.com/event/${event.slug}` : market.slug ? `https://polymarket.com/event/${market.slug}` : undefined;

  return {
    provider: "polymarket",
    marketId: market.id,
    eventId: event.id,
    conditionId: market.conditionId,
    slug: market.slug,
    eventSlug: event.slug,
    title: market.question,
    category,
    outcomes,
    yesTokenId: yesIndex >= 0 ? clobTokenIds[yesIndex] : undefined,
    noTokenId: noIndex >= 0 ? clobTokenIds[noIndex] : undefined,
    yesPrice,
    noPrice,
    feesEnabled: market.feesEnabled,
    takerFeeRate: toNumber(market.feeSchedule?.rate),
    bestAsk: toNumber(market.bestAsk),
    spread: toNumber(market.spread),
    volume: toNumber(market.volumeNum) ?? toNumber(market.volume) ?? toNumber(event.volume),
    liquidity: toNumber(market.liquidityClob) ?? toNumber(market.liquidity) ?? toNumber(event.liquidityClob) ?? toNumber(event.liquidity),
    endDate: market.endDate ?? event.endDate,
    startDate: market.startDate ?? event.startDate,
    status,
    resolutionSource: market.resolutionSource || event.resolutionSource || undefined,
    rules: market.description || event.description || undefined,
    tags,
    url,
    raw: {
      event: {
        id: event.id,
        slug: event.slug,
        title: event.title,
        liquidity: event.liquidity,
        volume: event.volume,
        volume24hr: event.volume24hr,
      },
      market,
    },
    updatedAt: new Date().toISOString(),
  };
}

function extractTags(tags: unknown[] | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  return uniq(
    tags
      .map((tag) => {
        if (typeof tag === "string") return tag;
        if (tag && typeof tag === "object") {
          const record = tag as Record<string, unknown>;
          return String(record.label ?? record.name ?? record.slug ?? record.title ?? "");
        }
        return "";
      })
      .filter(Boolean),
  );
}

export function inferCategory(text: string, tags: string[] = []): string {
  // Gamma tags are editorial metadata and should win over entity words in a title.
  // Otherwise a Mentions contract about NVIDIA becomes "tech", or a Politics market
  // mentioning China becomes "geopolitics" before its actual market family is checked.
  const tagValue = tags.join(" ").toLowerCase();
  const tagRules: Array<[RegExp, string]> = [
    [/\bmentions?\b/, "mentions"],
    [/\bweather\b/, "weather"],
    [/\besports?\b/, "esports"],
    [/\b(sports?|soccer|football|basketball|baseball|hockey|tennis|cricket|golf|rugby)\b/, "sports"],
    [/\bcrypto\b/, "crypto"],
    [/\b(finance|financial|commodities|stocks?)\b/, "finance"],
    [/\b(macro|economics?|economy)\b/, "macro"],
    [/\b(politics?|elections?)\b/, "politics"],
    [/\b(geopolitics|world affairs)\b/, "geopolitics"],
    [/\b(tech|technology)\b/, "tech"],
    [/\b(culture|entertainment)\b/, "culture"],
  ];
  const tagged = tagRules.find(([pattern]) => pattern.test(tagValue));
  if (tagged) return tagged[1];

  const value = text.toLowerCase();
  if (/\b(mentions?|say the word|what will .* say|speech|podcast)\b/.test(value)) return "mentions";
  if (/\b(weather|daily temperature|temperature|hurricane|rain|snow|tornado|storm|wind gust)\b/.test(value)) return "weather";
  if (/\b(esports?|league of legends|counter[- ]strike|cs2|cs:go|dota\s?2|valorant|overwatch|rainbow six|r6 siege|honor of kings|mobile legends|rocket league|starcraft|pubg)\b/.test(value)) return "esports";
  if (/\b(sports?|nba|wnba|nfl|mlb|nhl|soccer|football|tennis|ufc|fifa|world cup|premier league|champions league|cricket|formula 1|f1|baseball|basketball|hockey|golf|rugby|volleyball|table tennis|wimbledon)\b/.test(value)) return "sports";
  if (/\b(btc|bitcoin|eth|ethereum|solana|sol|crypto|xrp|doge|trump coin|token launch|airdrop)\b/.test(value)) return "crypto";
  if (/\b(cpi|pce|inflation|fed|fomc|interest rate|rate (cut|hike)|jobs report|payrolls?|unemployment|gdp|treasury|yield|recession|economy|economic|macro)\b/.test(value)) return "macro";
  if (/\b(finance|stocks?|equities|commodit|forex|currency|gold|silver|crude oil|market cap|valuation)\b/.test(value)) return "finance";
  if (/\b(geopolitics|world affairs|war|ukraine|russia|israel|iran|china|ceasefire|missile|territory capture|foreign policy)\b/.test(value)) return "geopolitics";
  if (/\b(openai|chatgpt|gpt-?\d|anthropic|claude|ai model|large language model|llm|spacex|tesla|app store|ios|android|nvidia|nvda|apple|microsoft|alphabet|google)\b/.test(value)) return "tech";
  if (/\b(election|president|presidential|congress|senate|politic|minister|party|nomination)\b/.test(value)) return "politics";
  if (/\b(culture|celebrity|album|movie|film|television|oscar|grammy|box office|stream|music|award)\b/.test(value)) return "culture";
  return "objective-event";
}
