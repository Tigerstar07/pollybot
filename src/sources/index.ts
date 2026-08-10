import type { AppConfig } from "../config";
import type { Db } from "../db";
import { saveSourceObservation } from "../db";
import type { NormalizedMarket, SourceObservation } from "../types";
import { getCryptoPriceObservation } from "./cryptoPriceSource";
import { getCultureObservation } from "./cultureSource";
import { detectFredSeries, getFredObservation } from "./fredSource";
import { getMacroCalendarObservation } from "./macroCalendarSource";
import { getWikidataCultureObservation } from "./wikidataCultureSource";
import { detectMarketCapMarket, getMarketCapObservation } from "./marketCapSource";
import { detectInstrument, getMarketDataObservation } from "./marketDataSource";
import { readManualNotes } from "./manualNotesSource";
import { getNewsObservation } from "./newsSource";
import { getSportsOddsObservation, type SportsOddsRequestBudget } from "./sportsOddsSource";
import { getTechObservation } from "./techSource";
import { getWeatherObservations } from "./weatherSource";

/**
 * Gathers cheap/free evidence for a market. The router is category-aware: each market
 * only pays for the source calls that could plausibly inform it. A manual research note
 * is always honored as an independent override. Adding a new evidence source (including
 * a future LLM forecaster) means registering one more branch here plus a consumer in
 * probability/heuristics.ts.
 */
export async function collectCheapSources(
  config: AppConfig,
  db: Db,
  market: NormalizedMarket,
  options: { sportsOddsBudget?: SportsOddsRequestBudget } = {},
): Promise<SourceObservation[]> {
  const observations: SourceObservation[] = [];

  const manual = readManualNotes(config, market);
  observations.push(manual);

  switch (market.category) {
    case "crypto": {
      const crypto = await getCryptoPriceObservation(db, market);
      observations.push(crypto);
      // Fall back to the generic price feed for crypto assets CoinGecko did not resolve.
      if (!crypto.available && detectInstrument(market)) {
        observations.push(await getMarketDataObservation(db, market));
      }
      break;
    }
    case "sports":
    case "esports":
      observations.push(await getSportsOddsObservation(config, db, market, options.sportsOddsBudget));
      break;
    case "weather":
      observations.push(...await getWeatherObservations(db, market));
      break;
    case "macro":
      // "Largest company by market cap" markets are sometimes tagged macro; route them to
      // the market-cap source. Otherwise FRED covers rates/yields/GDP/PCE and BLS covers
      // CPI/unemployment/payrolls.
      if (detectMarketCapMarket(market)) {
        observations.push(await getMarketCapObservation(config, db, market));
      } else if (detectFredSeries(market)) {
        observations.push(await getFredObservation(config, db, market));
      } else {
        observations.push(await getMacroCalendarObservation(db, market));
      }
      break;
    case "tech": {
      const tech = await getTechObservation(db, market);
      observations.push(tech);
      if (detectMarketCapMarket(market)) {
        const marketCap = await getMarketCapObservation(config, db, market);
        observations.push(marketCap);
        if (!tech.available && !marketCap.available) observations.push(await getNewsObservation(market));
      } else if (detectInstrument(market)) {
        const marketData = await getMarketDataObservation(db, market);
        observations.push(marketData);
        if (!tech.available && !marketData.available) observations.push(await getNewsObservation(market));
      } else if (!tech.available) {
        observations.push(await getNewsObservation(market));
      }
      break;
    }
    case "culture": {
      // TMDB needs a key (and is region-blocked for some users); Wikidata is the keyless,
      // non-geoblocked fallback for movie/TV release-date evidence.
      const culture = config.tmdbApiKey
        ? await getCultureObservation(config, db, market)
        : await getWikidataCultureObservation(db, market);
      observations.push(culture);
      if (!culture.available) observations.push(await getNewsObservation(market));
      break;
    }
    default: {
      // politics, geopolitics, culture, objective-event.
      // Market-cap/"largest company" questions get the FMP feed; price-threshold markets
      // (gold/silver/oil/indices/stocks) get the financial feed; everything else falls back
      // to free news headlines.
      if (detectMarketCapMarket(market)) {
        const marketCap = await getMarketCapObservation(config, db, market);
        observations.push(marketCap);
        if (!marketCap.available) observations.push(await getNewsObservation(market));
      } else if (detectInstrument(market)) {
        const marketData = await getMarketDataObservation(db, market);
        observations.push(marketData);
        if (!marketData.available) observations.push(await getNewsObservation(market));
      } else {
        observations.push(await getNewsObservation(market));
      }
      break;
    }
  }

  for (const observation of observations) {
    saveSourceObservation(db, market.marketId, observation);
  }
  return observations;
}
