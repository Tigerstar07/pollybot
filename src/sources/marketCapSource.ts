import type { AppConfig } from "../config";
import type { Db } from "../db";
import { getCachedSource, saveSourceObservation } from "../db";
import type { NormalizedMarket, SourceObservation } from "../types";
import { nowIso } from "../utils";
import { resilientFetchJson } from "../utils/fetch";

/**
 * Single-company market-capitalization evidence via Financial Modeling Prep's free
 * "stable" API. Unlocks the family of Polymarket "largest company / most valuable
 * company / $X trillion market cap" markets that the share-price feed cannot model:
 * Yahoo blocks the market-cap endpoint, and a $4T market cap is not a $4 share price.
 *
 * The free FMP tier only permits single-symbol quotes (batch/multi-symbol are premium),
 * so each ticker is fetched and cached independently. Market caps move slowly enough that
 * a multi-hour cache keeps even a full ranking basket well under the 250 requests/day free
 * quota. This source only gathers the authoritative caps plus a per-name volatility prior;
 * the probability math lives in probability/heuristics.ts, like the other price sources.
 */

export type MarketCapKind = "threshold" | "pairwise" | "ranking";

interface MegaCap {
  pattern: RegExp;
  ticker: string;
  name: string;
  annualVol: number; // annualized volatility prior for the lognormal model
}

// US-listed mega caps FMP's free quote endpoint returns. Vols are conservative annualized
// priors (a lower assumed correlation later widens the relative spread, biasing toward 50/50).
const MEGA_CAPS: MegaCap[] = [
  { pattern: /\b(nvidia|nvda)\b/i, ticker: "NVDA", name: "Nvidia", annualVol: 0.5 },
  { pattern: /\b(apple|aapl)\b/i, ticker: "AAPL", name: "Apple", annualVol: 0.3 },
  { pattern: /\b(microsoft|msft)\b/i, ticker: "MSFT", name: "Microsoft", annualVol: 0.28 },
  { pattern: /\b(alphabet|google|googl|goog)\b/i, ticker: "GOOGL", name: "Alphabet", annualVol: 0.3 },
  { pattern: /\b(amazon|amzn)\b/i, ticker: "AMZN", name: "Amazon", annualVol: 0.35 },
  { pattern: /\b(meta|facebook)\b/i, ticker: "META", name: "Meta", annualVol: 0.4 },
  { pattern: /\b(broadcom|avgo)\b/i, ticker: "AVGO", name: "Broadcom", annualVol: 0.45 },
  { pattern: /\b(tesla|tsla)\b/i, ticker: "TSLA", name: "Tesla", annualVol: 0.6 },
  { pattern: /\b(berkshire|brk)\b/i, ticker: "BRK-B", name: "Berkshire Hathaway", annualVol: 0.18 },
  { pattern: /\b(taiwan semiconductor|tsmc|tsm)\b/i, ticker: "TSM", name: "TSMC", annualVol: 0.4 },
  { pattern: /\b(eli lilly|lilly|lly)\b/i, ticker: "LLY", name: "Eli Lilly", annualVol: 0.3 },
];

// Cues that a market is about company valuation rather than share price.
const VALUATION_CUE =
  /\b(market cap(italization)?|valuation|valued at|most valuable|worth (more|less) than|biggest compan|largest compan)\b|\$?\s?\d+(\.\d+)?\s*(trillion|tn)\b/i;
const RANKING_CUE = /\b(largest|biggest|most valuable|number one|#\s?1|top)\b[^.]*\bcompan/i;
const COMPARISON_CUE =
  /\b(worth (more|less) than|bigger than|larger than|smaller than|overtake|overtakes|surpass|surpasses|exceed)\b/i;

export interface MarketCapQuery {
  kind: MarketCapKind;
  target: MegaCap;
  competitor?: MegaCap;
}

/** Detects whether a market is a single-company market-cap question this source can model. */
export function detectMarketCapMarket(market: NormalizedMarket): MarketCapQuery | undefined {
  const text = `${market.title} ${market.rules ?? ""}`;
  if (!VALUATION_CUE.test(text) && !RANKING_CUE.test(text)) return undefined;
  const matched = MEGA_CAPS.filter((company) => company.pattern.test(text));
  const target = matched[0];
  if (!target) return undefined;

  // Pairwise comparison between two recognized companies takes priority (most specific).
  const competitor = matched.find((company) => company.ticker !== target.ticker);
  if (competitor && COMPARISON_CUE.test(text)) {
    return { kind: "pairwise", target, competitor };
  }
  // A market-cap dollar amount means a threshold question against a single company.
  if (hasMarketCapThreshold(text)) {
    return { kind: "threshold", target };
  }
  // "largest / most valuable company" with a single named company is a ranking question.
  if (RANKING_CUE.test(text) || /\bmost valuable\b/i.test(text)) {
    return { kind: "ranking", target };
  }
  return undefined;
}

function hasMarketCapThreshold(text: string): boolean {
  return /\$?\s?\d+(\.\d+)?\s*(trillion|tn|billion|bn)\b/i.test(text) || /\$\s?\d{10,}/.test(text);
}

export async function getMarketCapObservation(
  config: AppConfig,
  db: Db,
  market: NormalizedMarket,
): Promise<SourceObservation> {
  const query = detectMarketCapMarket(market);
  if (!query) {
    return unavailable(market, "Market text does not reference a supported single-company market-cap question");
  }
  if (!config.fmpApiKey) {
    return unavailable(market, "FMP_API_KEY is not configured for market-cap evidence");
  }

  try {
    if (query.kind === "ranking") {
      const quotes = await fetchBasket(config, db);
      const targetQuote = quotes.find((quote) => quote.ticker === query.target.ticker);
      if (!targetQuote) return unavailable(market, `FMP returned no market cap for ${query.target.name}`);
      const others = quotes
        .filter((quote) => quote.ticker !== query.target.ticker)
        .sort((a, b) => b.marketCap - a.marketCap);
      const competitor = others[0];
      if (!competitor) return unavailable(market, "No competing company market caps were available for the ranking");
      const ranked = [...quotes].sort((a, b) => b.marketCap - a.marketCap);
      return ok(market, {
        kind: "ranking",
        target: describe(query.target.ticker, query.target.name, targetQuote.marketCap),
        competitor: describe(competitor.ticker, competitor.name, competitor.marketCap),
        ranked: ranked.map((quote) => ({ name: quote.name, ticker: quote.ticker, marketCap: quote.marketCap })),
      });
    }

    const targetQuote = await fetchQuote(config, db, query.target.ticker);
    if (!targetQuote) return unavailable(market, `FMP returned no market cap for ${query.target.name}`);

    if (query.kind === "pairwise" && query.competitor) {
      const competitorQuote = await fetchQuote(config, db, query.competitor.ticker);
      if (!competitorQuote) return unavailable(market, `FMP returned no market cap for ${query.competitor.name}`);
      return ok(market, {
        kind: "pairwise",
        target: describe(query.target.ticker, query.target.name, targetQuote.marketCap),
        competitor: describe(query.competitor.ticker, query.competitor.name, competitorQuote.marketCap),
      });
    }

    return ok(market, {
      kind: "threshold",
      target: describe(query.target.ticker, query.target.name, targetQuote.marketCap),
    });
  } catch (error) {
    return unavailable(market, error instanceof Error ? error.message : String(error));
  }
}

interface Quote {
  ticker: string;
  name: string;
  marketCap: number;
}

interface FmpQuote {
  symbol?: string;
  name?: string;
  marketCap?: number;
  price?: number;
}

async function fetchQuote(config: AppConfig, db: Db, ticker: string): Promise<Quote | undefined> {
  const cacheKey = `fmp:quote:${ticker}`;
  const cached = getCachedSource(db, "market-cap-quote", cacheKey);
  if (cached?.available && typeof cached.payload.marketCap === "number") {
    return { ticker, name: String(cached.payload.name ?? ticker), marketCap: Number(cached.payload.marketCap) };
  }

  const url = new URL("/stable/quote", config.fmpApiUrl);
  url.searchParams.set("symbol", ticker);
  url.searchParams.set("apikey", config.fmpApiKey ?? "");
  const { data } = await resilientFetchJson<FmpQuote[]>(url, {
    timeoutMs: 12_000,
    headers: { "user-agent": "pollybot/1.1 research and paper-trading bot" },
  });
  const row = Array.isArray(data) ? data[0] : undefined;
  const marketCap = row && typeof row.marketCap === "number" ? row.marketCap : undefined;
  if (!marketCap || marketCap <= 0) return undefined;
  const name = typeof row?.name === "string" && row.name.length > 0 ? row.name : ticker;

  saveSourceObservation(db, null, {
    sourceType: "market-cap-quote",
    sourceKey: cacheKey,
    collectedAt: nowIso(),
    // Market caps move slowly; a 6h cache protects the 250 requests/day free quota.
    expiresAt: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
    available: true,
    independent: true,
    quality: 0.6,
    payload: { provider: "fmp", ticker, name, marketCap },
  });
  return { ticker, name, marketCap };
}

async function fetchBasket(config: AppConfig, db: Db): Promise<Quote[]> {
  const quotes: Quote[] = [];
  for (const company of MEGA_CAPS) {
    const quote = await fetchQuote(config, db, company.ticker).catch(() => undefined);
    if (quote) quotes.push(quote);
  }
  return quotes;
}

function describe(ticker: string, name: string, marketCap: number): Record<string, unknown> {
  const annualVol = MEGA_CAPS.find((company) => company.ticker === ticker)?.annualVol ?? 0.4;
  return { ticker, name, marketCap, annualVol };
}

function ok(market: NormalizedMarket, payload: Record<string, unknown>): SourceObservation {
  return {
    sourceType: "market-cap",
    sourceKey: `marketcap:${market.marketId}`,
    collectedAt: nowIso(),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    available: true,
    independent: true,
    quality: 0.62,
    payload: { provider: "fmp", asOf: nowIso(), ...payload },
  };
}

function unavailable(market: NormalizedMarket, reason: string): SourceObservation {
  return {
    sourceType: "market-cap",
    sourceKey: `marketcap:${market.marketId}`,
    collectedAt: nowIso(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    payload: {},
    available: false,
    independent: true,
    quality: 0,
    reason,
  };
}
