import type { Db } from "../db";
import { getCachedSource, saveSourceObservation } from "../db";
import type { NormalizedMarket, SourceObservation } from "../types";
import { nowIso } from "../utils";
import { resilientFetchJson } from "../utils/fetch";
import { calculateAnnualizedVolatility } from "./cryptoPriceSource";

/**
 * Free, key-less financial market data via the Yahoo Finance chart API. This unlocks the
 * large family of Polymarket "will <asset> hit $X" markets for commodities, equity
 * indices, single stocks and FX, using the same lognormal price model the crypto source
 * feeds. Yahoo returns spot (regularMarketPrice) plus daily closes for realized volatility.
 */

export type InstrumentKind = "metal" | "energy" | "index" | "equity" | "forex";

export interface Instrument {
  ticker: string; // Yahoo Finance symbol
  symbol: string; // display
  kind: InstrumentKind;
  fallbackVol: number;
}

// Order matters: more specific phrases first. Matched case-insensitively on title+rules.
const INSTRUMENTS: Array<{ pattern: RegExp; instrument: Instrument }> = [
  // Precious / industrial metals (USD futures)
  { pattern: /\bgold\b/, instrument: { ticker: "GC=F", symbol: "Gold", kind: "metal", fallbackVol: 0.16 } },
  { pattern: /\bsilver\b|\(si\)/, instrument: { ticker: "SI=F", symbol: "Silver", kind: "metal", fallbackVol: 0.28 } },
  { pattern: /\bplatinum\b/, instrument: { ticker: "PL=F", symbol: "Platinum", kind: "metal", fallbackVol: 0.25 } },
  { pattern: /\bpalladium\b/, instrument: { ticker: "PA=F", symbol: "Palladium", kind: "metal", fallbackVol: 0.35 } },
  { pattern: /\bcopper\b/, instrument: { ticker: "HG=F", symbol: "Copper", kind: "metal", fallbackVol: 0.25 } },
  // Energy
  { pattern: /\b(crude oil|wti|crude|oil)\b|\(cl\)/, instrument: { ticker: "CL=F", symbol: "WTI Crude", kind: "energy", fallbackVol: 0.4 } },
  { pattern: /\bbrent\b/, instrument: { ticker: "BZ=F", symbol: "Brent Crude", kind: "energy", fallbackVol: 0.38 } },
  { pattern: /\bnatural gas|natgas\b/, instrument: { ticker: "NG=F", symbol: "Natural Gas", kind: "energy", fallbackVol: 0.6 } },
  // Equity indices
  { pattern: /\bs&p\s?500|s&p|sp500|spx\b/, instrument: { ticker: "^GSPC", symbol: "S&P 500", kind: "index", fallbackVol: 0.16 } },
  { pattern: /\bnasdaq\b|\bndx\b/, instrument: { ticker: "^IXIC", symbol: "Nasdaq", kind: "index", fallbackVol: 0.2 } },
  { pattern: /\bdow jones|dow\b|djia/, instrument: { ticker: "^DJI", symbol: "Dow Jones", kind: "index", fallbackVol: 0.15 } },
  { pattern: /\brussell 2000|russell\b/, instrument: { ticker: "^RUT", symbol: "Russell 2000", kind: "index", fallbackVol: 0.22 } },
  { pattern: /\bvix\b/, instrument: { ticker: "^VIX", symbol: "VIX", kind: "index", fallbackVol: 0.9 } },
  // Single stocks (US)
  { pattern: /\btesla\b|\btsla\b/, instrument: { ticker: "TSLA", symbol: "Tesla", kind: "equity", fallbackVol: 0.6 } },
  { pattern: /\bapple\b|\baapl\b/, instrument: { ticker: "AAPL", symbol: "Apple", kind: "equity", fallbackVol: 0.3 } },
  { pattern: /\bnvidia\b|\bnvda\b/, instrument: { ticker: "NVDA", symbol: "Nvidia", kind: "equity", fallbackVol: 0.5 } },
  { pattern: /\bmicrosoft\b|\bmsft\b/, instrument: { ticker: "MSFT", symbol: "Microsoft", kind: "equity", fallbackVol: 0.28 } },
  { pattern: /\bamazon\b|\bamzn\b/, instrument: { ticker: "AMZN", symbol: "Amazon", kind: "equity", fallbackVol: 0.35 } },
  { pattern: /\bgoogle\b|\balphabet\b|\bgoogl\b/, instrument: { ticker: "GOOGL", symbol: "Alphabet", kind: "equity", fallbackVol: 0.3 } },
  { pattern: /\b(meta|facebook)\b/, instrument: { ticker: "META", symbol: "Meta", kind: "equity", fallbackVol: 0.4 } },
  { pattern: /\bgamestop\b|\bgme\b/, instrument: { ticker: "GME", symbol: "GameStop", kind: "equity", fallbackVol: 0.9 } },
  { pattern: /\bnetflix\b|\bnflx\b/, instrument: { ticker: "NFLX", symbol: "Netflix", kind: "equity", fallbackVol: 0.4 } },
  // FX majors
  { pattern: /\beur\/?usd|euro\b/, instrument: { ticker: "EURUSD=X", symbol: "EUR/USD", kind: "forex", fallbackVol: 0.08 } },
  { pattern: /\bgbp\/?usd|pound\b/, instrument: { ticker: "GBPUSD=X", symbol: "GBP/USD", kind: "forex", fallbackVol: 0.09 } },
  { pattern: /\busd\/?jpy|yen\b/, instrument: { ticker: "USDJPY=X", symbol: "USD/JPY", kind: "forex", fallbackVol: 0.09 } },
];

/** Detects whether the market references a priceable instrument and has a price threshold. */
export function detectInstrument(market: NormalizedMarket): Instrument | undefined {
  const text = `${market.title} ${market.rules ?? ""}`.toLowerCase();
  if (!hasPriceThresholdCue(text)) return undefined;
  for (const { pattern, instrument } of INSTRUMENTS) {
    if (pattern.test(text)) return instrument;
  }
  return undefined;
}

function hasPriceThresholdCue(text: string): boolean {
  if (/\$\s?\d/.test(text)) return true;
  return /\b(above|below|over|under|hit|reach|exceed|top|drop to|fall to|trade at)\b\s+\$?\d/.test(text);
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: { regularMarketPrice?: number; currency?: string; symbol?: string };
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }>;
    error?: unknown;
  };
}

export async function getMarketDataObservation(db: Db, market: NormalizedMarket): Promise<SourceObservation> {
  const instrument = detectInstrument(market);
  if (!instrument) {
    return {
      sourceType: "market-data",
      sourceKey: `marketdata:none:${market.marketId}`,
      collectedAt: nowIso(),
      payload: {},
      available: false,
      reason: "Market text does not reference a supported priceable instrument with a threshold",
    };
  }

  const cacheKey = `yahoo:${instrument.ticker}:v2`;
  const cached = getCachedSource(db, "market-data", cacheKey);
  if (cached) return cached;

  try {
    const encodedTicker = encodeURIComponent(instrument.ticker);
    const dailyUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodedTicker}?range=3mo&interval=1d`;
    const intradayUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodedTicker}?range=5d&interval=5m`;
    const dailyResult = await resilientFetchJson<YahooChartResponse>(dailyUrl, {
      timeoutMs: 12_000,
      headers: { "user-agent": "Mozilla/5.0 pollybot/1.1 research and paper-trading bot" },
    });
    const intradayResult = await resilientFetchJson<YahooChartResponse>(intradayUrl, {
      timeoutMs: 12_000,
      headers: { "user-agent": "Mozilla/5.0 pollybot/1.1 research and paper-trading bot" },
    }).catch(() => undefined);
    const result = dailyResult.data.chart?.result?.[0];
    const closes = parseYahooCloses(dailyResult.data);
    const intradayCloses = intradayResult ? parseYahooCloses(intradayResult.data) : [];
    const latestDailyClose = closes[closes.length - 1];
    const latestIntradayClose = intradayCloses[intradayCloses.length - 1];
    const regularMarketPrice = result?.meta?.regularMarketPrice;
    let spot = latestIntradayClose ?? regularMarketPrice ?? latestDailyClose;
    let spotSource = latestIntradayClose ? "intraday-close" : regularMarketPrice ? "regular-market-price" : "daily-close";
    const regularVsDailyMove =
      regularMarketPrice && latestDailyClose ? Math.abs(Math.log(regularMarketPrice / latestDailyClose)) : 0;
    if (!latestIntradayClose && regularMarketPrice && latestDailyClose && regularVsDailyMove > 0.05) {
      spot = latestDailyClose;
      spotSource = "daily-close-regular-price-diverged";
    }
    if (!spot || closes.length < 2) {
      throw new Error("Yahoo Finance returned no usable price data");
    }
    const recent = closes.slice(-40); // ~2 trading months
    const realizedAnnualVolatility = calculateAnnualizedVolatility(recent);
    const hasHistory = realizedAnnualVolatility !== undefined && recent.length >= 10;
    const spotDiscrepancy =
      regularMarketPrice && latestIntradayClose
        ? Math.abs(Math.log(regularMarketPrice / latestIntradayClose))
        : regularVsDailyMove;
    const quality = Math.max(
      0.2,
      (hasHistory ? 0.72 : 0.45) -
        (latestIntradayClose ? 0 : 0.08) -
        (spotDiscrepancy > 0.05 ? 0.15 : 0),
    );

    const observation: SourceObservation = {
      sourceType: "market-data",
      sourceKey: cacheKey,
      collectedAt: nowIso(),
      // Spot updates intraday but volatility is daily; cache for 15 min to limit calls.
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      payload: {
        provider: "yahoo",
        ticker: instrument.ticker,
        symbol: instrument.symbol,
        kind: instrument.kind,
        usd: spot,
        spotSource,
        latestDailyClose,
        regularMarketPrice,
        latestIntradayClose,
        spotDiscrepancy,
        realizedAnnualVolatility: hasHistory ? realizedAnnualVolatility : undefined,
        fallbackAnnualVolatility: instrument.fallbackVol,
        historySamples: recent.length,
      },
      available: true,
      independent: true,
      quality,
      reason: hasHistory
        ? spotDiscrepancy > 0.05
          ? "Quote sources diverged; using the most conservative available spot reference"
          : undefined
        : "Spot is available but volatility history was thin; using a conservative fallback",
    };
    saveSourceObservation(db, null, observation);
    return observation;
  } catch (error) {
    const observation: SourceObservation = {
      sourceType: "market-data",
      sourceKey: cacheKey,
      collectedAt: nowIso(),
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      payload: { provider: "yahoo", ticker: instrument.ticker, symbol: instrument.symbol, kind: instrument.kind },
      available: false,
      independent: true,
      quality: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
    saveSourceObservation(db, null, observation);
    return observation;
  }
}

/** Extracts finite close prices from a Yahoo Finance chart payload. */
export function parseYahooCloses(payload: YahooChartResponse): number[] {
  const closes = payload.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
  return closes.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
}
