import test from "node:test";
import assert from "node:assert/strict";
import { createTestHarness, makeMarket } from "./helpers/test-harness";
import { collectCheapSources } from "../src/sources";
import { getCryptoPriceObservation } from "../src/sources/cryptoPriceSource";
import { getWeatherObservation } from "../src/sources/weatherSource";
import { detectOutrightSportKey, detectSportKey } from "../src/sources/sportsOddsSource";
import { getMacroCalendarObservation } from "../src/sources/macroCalendarSource";
import { getFredObservation } from "../src/sources/fredSource";
import { getWikidataCultureObservation } from "../src/sources/wikidataCultureSource";
import { getMarketCapObservation } from "../src/sources/marketCapSource";
import { getTechObservation } from "../src/sources/techSource";
import { inferCategory } from "../src/providers/polymarket/markets";
import { estimateProbability } from "../src/probability/heuristics";
import { loadConfig } from "../src/config";
import { planExternalResearchMarkets } from "../src/scanner";
import type { SourceObservation } from "../src/types";

// T1.1.1: Fetch and normalize Polymarket Gamma events
test("T1.1.1: Fetch and normalize Polymarket Gamma events", async () => {
  const harness = createTestHarness();
  try {
    const res = harness.runCommand("scan");
    assert.equal(res.status, 0);
    const row = harness.db.prepare("SELECT * FROM markets WHERE market_id = 'm1'").get() as any;
    assert.ok(row);
    assert.equal(row.question, "Will Sol hit $200 before July?");
    assert.equal(row.category, "crypto");
  } finally {
    harness.cleanup();
  }
});

test("external research plan prioritizes diverse executable markets and skips dead inventory", () => {
  const config = {
    ...loadConfig(),
    maxDaysToEnd: 45,
    scanMaxExternalSourceMarkets: 5,
    scanMaxNewsSourceMarkets: 2,
  };
  const markets = [
    ...[0, 1, 2].map((index) => makeMarket({
      marketId: `weather-${index}`,
      eventId: `weather-event-${index}`,
      category: "weather",
      title: `Will the high temperature in City ${index} exceed 25°C?`,
      liquidity: 10_000 - index * 500,
    })),
    ...[0, 1, 2, 3].map((index) => makeMarket({
      marketId: `news-${index}`,
      eventId: `news-event-${index}`,
      category: "politics",
      title: `Will official ${index} resign before the deadline?`,
      liquidity: 8_000 - index * 500,
    })),
    makeMarket({ marketId: "closed", status: "closed", liquidity: 1_000_000 }),
    makeMarket({ marketId: "illiquid", liquidity: 1 }),
  ];
  const planned = planExternalResearchMarkets(config, markets);
  assert.equal(planned.length, 5);
  assert.equal(planned.filter((market) => market.category === "politics").length, 2);
  assert.ok(planned.some((market) => market.marketId === "weather-0"));
  assert.ok(!planned.some((market) => market.marketId === "closed" || market.marketId === "illiquid"));
});

test("external research plan verifies markets when Gamma omits liquidity metadata", () => {
  const config = {
    ...loadConfig(),
    scanMaxExternalSourceMarkets: 10,
  };
  const missingLiquidity = makeMarket({
    marketId: "missing-liquidity",
    category: "crypto",
    liquidity: undefined,
  });
  const explicitlyIlliquid = makeMarket({
    marketId: "explicitly-illiquid",
    category: "crypto",
    liquidity: Math.max(0, config.minLiquidity - 1),
  });
  const planned = planExternalResearchMarkets(config, [missingLiquidity, explicitlyIlliquid]);
  assert.ok(planned.some((market) => market.marketId === "missing-liquidity"));
  assert.ok(!planned.some((market) => market.marketId === "explicitly-illiquid"));
});

// T1.1.2: CoinGecko crypto price source integration
test("T1.1.2: CoinGecko crypto price source integration", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({ marketId: "m1", title: "Will Solana hit $200?", category: "crypto" });
    const obs = await getCryptoPriceObservation(harness.db, market);
    assert.ok(obs.available);
    assert.equal(obs.payload.usd, 150);
    assert.ok(obs.payload.realizedAnnualVolatility !== undefined);
  } finally {
    harness.cleanup();
  }
});

// T1.1.3: Open-Meteo weather source integration
test("T1.1.3: Open-Meteo weather source integration", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "m2",
      title: "Will the high temperature in NYC exceed 80 degrees Fahrenheit on TargetDate?",
      category: "weather",
      endDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()
    });
    const obs = await getWeatherObservation(harness.db, market);
    assert.ok(obs.available);
    assert.equal(obs.payload.location, "New York City");
    assert.equal(obs.payload.metric, "high");
    assert.equal(obs.payload.forecastValue, 85);
  } finally {
    harness.cleanup();
  }
});

test("Open-Meteo geocoding fallback handles rain markets for unmapped cities", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "weather-rain-prague",
      title: "Will it rain in Prague on TargetDate?",
      category: "weather",
      endDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const obs = await getWeatherObservation(harness.db, market);
    assert.ok(obs.available);
    assert.equal(obs.payload.metric, "rain");
    assert.equal(obs.payload.location, "Prague, Hlavni mesto Praha, CZ");
    assert.equal(obs.payload.forecastValue, 0.2);
  } finally {
    harness.cleanup();
  }
});

test("weather collection returns a provider ensemble when sources are available", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "weather-ensemble-nyc",
      title: "Will the high temperature in NYC exceed 80 degrees Fahrenheit on TargetDate?",
      category: "weather",
      endDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const observations = await collectCheapSources(loadConfig(), harness.db, market);
    const providers = observations
      .filter((obs) => obs.sourceType === "weather" && obs.available)
      .map((obs) => String(obs.payload.provider));
    assert.ok(providers.includes("open-meteo"));
    assert.ok(providers.includes("met-norway-locationforecast"));
    assert.ok(providers.includes("nws-hourly"));
  } finally {
    harness.cleanup();
  }
});

function weatherObs(forecastValue: number, unit: "celsius" | "fahrenheit", leadDays: number, targetDate: string): SourceObservation {
  return {
    sourceType: "weather",
    sourceKey: "weather-fixture",
    collectedAt: new Date().toISOString(),
    available: true,
    independent: true,
    quality: 0.78,
    payload: { provider: "open-meteo", location: "Jeddah", metric: "high", unit, forecastValue, targetDate, leadDays },
  };
}

test("weather station-mismatch guard refuses to fade a strongly disagreeing market", () => {
  // Reproduces the Jeddah loss: forecast 36C, market prices "40C or higher" ~80%, station hit 40C+.
  const endDate = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  const market = makeMarket({
    marketId: "jeddah-40",
    title: "Will the highest temperature in Jeddah be 40°C or higher on June 30?",
    category: "weather",
    yesPrice: 0.8,
    bestAsk: 0.82,
    endDate,
  });
  const estimate = estimateProbability(loadConfig(), market, [weatherObs(36, "celsius", 0, endDate.slice(0, 10))]);
  assert.ok(estimate.estimatedYesProbability < 0.2, "model still thinks 40C+ is unlikely");
  assert.ok(estimate.confidence < 0.45, `confidence must be capped below the trade threshold, got ${estimate.confidence}`);
  assert.ok(estimate.shouldSkip, "a strong model-vs-market divergence on weather must not place a bet");
});

test("normal weather edge (small divergence) is still tradeable", () => {
  const endDate = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  const market = makeMarket({
    marketId: "jeddah-35-or-higher",
    title: "Will the highest temperature in Jeddah be 35°C or higher on June 30?",
    category: "weather",
    yesPrice: 0.55,
    bestAsk: 0.57,
    endDate,
  });
  const estimate = estimateProbability(loadConfig(), market, [weatherObs(36, "celsius", 0, endDate.slice(0, 10))]);
  assert.ok(estimate.confidence > 0.45, `normal weather edge should keep full confidence, got ${estimate.confidence}`);
  assert.equal(estimate.method, "weather-normal-forecast-model");
});

// T1.1.4: Sports odds api integration and devigging
test("T1.1.4: Sports odds api integration and devigging", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "m3",
      title: "Will the Boston Celtics beat the Los Angeles Lakers?",
      category: "sports",
      tags: ["NBA"],
      endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    });
    const config = { ...loadConfig(), sportsOddsApiKey: "test-key" };
    const observations = await collectCheapSources(config, harness.db, market);
    const sportsObs = observations.find(o => o.sourceType === "sports-odds");
    assert.ok(sportsObs?.available);
    assert.equal(sportsObs?.payload.fairYesProbability, 0.5);
    assert.equal(sportsObs?.payload.bookmakerCount, 1);
  } finally {
    harness.cleanup();
  }
});

test("sports source maps World Cup and major league team wording", () => {
  assert.equal(detectSportKey("Will Argentina beat Brazil in the World Cup?"), "soccer_fifa_world_cup");
  assert.equal(detectOutrightSportKey("Will Argentina win the 2026 FIFA World Cup?"), "soccer_fifa_world_cup_winner");
  assert.equal(detectSportKey("Will Yankees beat Dodgers tonight?"), "baseball_mlb");
  assert.equal(detectSportKey("Will WTA player win the match?"), "tennis_wta");
});

test("esports markets route through external odds instead of generic news", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "lol-kc-liquid",
      title: "Karmine Corp vs Team Liquid",
      category: "esports",
      tags: ["League of Legends"],
      endDate: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    });
    const config = { ...loadConfig(), sportsOddsApiKey: "test-key" };
    const observations = await collectCheapSources(config, harness.db, market);
    const sportsObs = observations.find(o => o.sourceType === "sports-odds");
    assert.ok(sportsObs?.available);
    assert.equal(sportsObs.payload.sportKey, "esports_lol");
    assert.equal(sportsObs.payload.target, "Karmine Corp");
    assert.ok(Number(sportsObs.payload.fairYesProbability) > 0.5);
  } finally {
    harness.cleanup();
  }
});

test("sports source uses outrights for World Cup winner markets", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "world-cup-spain",
      title: "Will Spain win the 2026 FIFA World Cup?",
      category: "sports",
      tags: ["World Cup"],
      endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const config = { ...loadConfig(), sportsOddsApiKey: "test-key" };
    const observations = await collectCheapSources(config, harness.db, market);
    const sportsObs = observations.find(o => o.sourceType === "sports-odds");
    assert.ok(sportsObs?.available);
    assert.equal(sportsObs.payload.sportKey, "soccer_fifa_world_cup_winner");
    assert.equal(sportsObs.payload.matchingMethod, "outright-contestant-name");
    assert.ok(Number(sportsObs.payload.fairYesProbability) > 0.1);
    assert.ok(Number(sportsObs.payload.fairYesProbability) < 0.25);
  } finally {
    harness.cleanup();
  }
});

test("BLS macro source models CPI threshold markets", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "cpi-over-2",
      title: "Will US CPI inflation be above 2% in June?",
      category: "macro",
    });
    const obs = await getMacroCalendarObservation(harness.db, market);
    assert.ok(obs.available);
    assert.equal(obs.payload.metric, "cpi_yoy");
    const estimate = estimateProbability(loadConfig(), market, [obs]);
    assert.match(estimate.method, /macro-bls-threshold-model/);
    assert.ok(estimate.estimatedYesProbability > 0.5);
  } finally {
    harness.cleanup();
  }
});

test("FRED macro source models a federal funds rate threshold market", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "fedfunds-over-3",
      title: "Will the federal funds rate be above 3% in December 2026?",
      category: "macro",
    });
    const config = { ...loadConfig(), fredApiKey: "test-key" };
    const obs = await getFredObservation(config, harness.db, market);
    assert.ok(obs.available);
    assert.equal(obs.payload.provider, "fred");
    assert.equal(obs.payload.seriesId, "FEDFUNDS");
    const estimate = estimateProbability(config, market, [obs]);
    assert.match(estimate.method, /macro-fred-threshold-model/);
    assert.ok(estimate.estimatedYesProbability > 0.5); // ~3.63% is above 3%
  } finally {
    harness.cleanup();
  }
});

test("US macro sources refuse foreign economies and categorical rate meetings", async () => {
  const harness = createTestHarness();
  try {
    const usMarket = makeMarket({ marketId: "us-gdp", title: "Will US real GDP growth exceed 2% in Q3 2026?", category: "macro" });
    const chinaMarket = makeMarket({ marketId: "china-gdp", title: "Will China GDP growth in Q2 2026 be less than 4.0%?", category: "macro" });
    const colombiaMeeting = makeMarket({ marketId: "colombia-rate", title: "Will the Central Bank of Colombia increase its rate by 50+ bps at the July meeting?", category: "macro" });
    const fedMeeting = makeMarket({ marketId: "fed-meeting", title: "Will the Fed make no change at the July meeting?", category: "macro" });
    const config = { ...loadConfig(), fredApiKey: "test-key" };
    const us = await getFredObservation(config, harness.db, usMarket);
    const china = await getFredObservation(config, harness.db, chinaMarket);
    const colombia = await getFredObservation(config, harness.db, colombiaMeeting);
    const meeting = await getFredObservation(config, harness.db, fedMeeting);
    assert.ok(us.available, "US GDP market should resolve a FRED series");
    assert.equal(china.available, false, "China GDP market must not be matched to US GDP data");
    assert.equal(colombia.available, false, "Colombia's central bank must not be matched to US FEDFUNDS");
    assert.equal(meeting.available, false, "categorical Fed meetings need a meeting-specific model");
    // And end-to-end it must not produce a FRED-backed forecast that could place a bet.
    const observations = await collectCheapSources(config, harness.db, chinaMarket);
    assert.ok(!observations.some((o) => o.sourceType === "macro-economic" && o.available));
    const estimate = estimateProbability(config, chinaMarket, observations);
    assert.doesNotMatch(estimate.method, /macro-/);
  } finally {
    harness.cleanup();
  }
});

test("macro-tagged largest-company markets route to the market-cap source", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "amzn-largest-macro",
      title: "Will Amazon be the largest company in the world by market cap on December 31, 2026?",
      category: "macro",
      endDate: new Date(Date.now() + 120 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const config = { ...loadConfig(), fmpApiKey: "test-key" };
    const observations = await collectCheapSources(config, harness.db, market);
    assert.ok(observations.some((o) => o.sourceType === "market-cap" && o.available));
    assert.ok(!observations.some((o) => o.sourceType === "macro-economic" && o.available));
  } finally {
    harness.cleanup();
  }
});

test("FRED routes ahead of BLS for rate/yield/GDP/PCE markets", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "tenyr-yield",
      title: "Will the 10-year Treasury yield exceed 4% on December 31, 2026?",
      category: "macro",
      endDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const config = { ...loadConfig(), fredApiKey: "test-key" };
    const observations = await collectCheapSources(config, harness.db, market);
    const macroObs = observations.find((o) => o.sourceType === "macro-economic" && o.available);
    assert.ok(macroObs);
    assert.equal(macroObs.payload.provider, "fred");
    assert.equal(macroObs.payload.seriesId, "DGS10");
  } finally {
    harness.cleanup();
  }
});

test("Wikidata culture source resolves a release-date market without a key", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "test-movie-release",
      title: "Will Test Movie be released before August 31, 2026?",
      category: "culture",
      endDate: new Date("2026-08-31T00:00:00Z").toISOString(),
    });
    const obs = await getWikidataCultureObservation(harness.db, market);
    assert.ok(obs.available);
    assert.equal(obs.payload.provider, "wikidata");
    assert.equal((obs.payload.matchedResult as any).releaseDate, "2026-07-15");
    const estimate = estimateProbability(loadConfig(), market, [obs]);
    assert.match(estimate.method, /culture-wikidata-release-date/);
    assert.ok(estimate.estimatedYesProbability > 0.8); // released 2026-07-15, before deadline
  } finally {
    harness.cleanup();
  }
});

test("official tech source can confirm OpenAI release markets", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "gpt-56",
      title: "Will GPT-5.6 be released by July 31?",
      category: "tech",
      endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const obs = await getTechObservation(harness.db, market);
    assert.ok(obs.available);
    assert.ok(obs.payload.matchedOfficialPost);
    const estimate = estimateProbability(loadConfig(), market, [obs]);
    assert.match(estimate.method, /tech-official-release-feed/);
    assert.ok(estimate.estimatedYesProbability > 0.9);
  } finally {
    harness.cleanup();
  }
});

test("category inference separates market families and respects editorial tags", () => {
  assert.equal(inferCategory("Karmine Corp vs Team Liquid League of Legends"), "esports");
  assert.equal(inferCategory("Will GPT-5.6 be released by July 31?"), "tech");
  assert.equal(inferCategory("Will CPI inflation be above 3%?"), "macro");
  assert.equal(inferCategory("Will the movie win an Oscar?"), "culture");
  assert.equal(inferCategory("Will Trump mention NVIDIA?", ["Mentions"]), "mentions");
  assert.equal(inferCategory("Will NVIDIA stock exceed $200?", ["Finance"]), "finance");
  assert.equal(inferCategory("Will the president impose China tariffs?", ["Politics"]), "politics");
});

test("FMP market-cap source models a $X trillion market-cap threshold market", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "aapl-4t",
      title: "Will Apple reach a $4 trillion market cap by December 31, 2026?",
      category: "tech",
      endDate: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const config = { ...loadConfig(), fmpApiKey: "test-key" };
    const obs = await getMarketCapObservation(config, harness.db, market);
    assert.ok(obs.available);
    assert.equal(obs.payload.kind, "threshold");
    assert.equal((obs.payload.target as any).ticker, "AAPL");
    assert.equal((obs.payload.target as any).marketCap, 4.0e12);
    const estimate = estimateProbability(config, market, [obs]);
    assert.match(estimate.method, /market-cap-(barrier|terminal)/);
    assert.ok(estimate.estimatedYesProbability > 0.5);
  } finally {
    harness.cleanup();
  }
});

test("FMP market-cap source ranks a largest-company market against the basket", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "nvda-largest",
      title: "Will Nvidia be the largest company in the world by market cap on December 31, 2026?",
      category: "tech",
      endDate: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const config = { ...loadConfig(), fmpApiKey: "test-key" };
    const obs = await getMarketCapObservation(config, harness.db, market);
    assert.ok(obs.available);
    assert.equal(obs.payload.kind, "ranking");
    assert.equal((obs.payload.competitor as any).ticker, "AAPL");
    const estimate = estimateProbability(config, market, [obs]);
    assert.match(estimate.method, /market-cap-ranking-relative-model/);
    assert.ok(estimate.estimatedYesProbability > 0.5);
    assert.ok(estimate.estimatedYesProbability < 0.9);
  } finally {
    harness.cleanup();
  }
});

test("market-cap markets route to FMP, not the share-price feed", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "aapl-cap-route",
      title: "Will Apple be worth more than $4 trillion on December 31, 2026?",
      category: "tech",
      endDate: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const config = { ...loadConfig(), fmpApiKey: "test-key" };
    const observations = await collectCheapSources(config, harness.db, market);
    assert.ok(observations.some((o) => o.sourceType === "market-cap" && o.available));
    assert.ok(!observations.some((o) => o.sourceType === "market-data" && o.available));
  } finally {
    harness.cleanup();
  }
});

// T1.1.5: News/web search integration
test("T1.1.5: News/web search integration", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "m4",
      title: "Will Biden officially announce nomination of X to Supreme Court?",
      category: "politics",
    });
    const config = loadConfig();
    const observations = await collectCheapSources(config, harness.db, market);
    const newsObs = observations.find(o => o.sourceType === "news");
    assert.ok(newsObs?.available);
    const articles = newsObs?.payload.articles;
    assert.ok(Array.isArray(articles) && articles.length > 0);
  } finally {
    harness.cleanup();
  }
});

// T2.1.1: Network timeout handling on market fetch
test("T2.1.1: Network timeout handling on market fetch", async () => {
  const harness = createTestHarness();
  try {
    const res = harness.runCommand("scan", { MOCK_SCENARIO: "timeout" });
    assert.notEqual(res.status, 0, "a total discovery outage must fail the command");
    const errCount = harness.db.prepare("SELECT COUNT(*) as count FROM errors").get() as any;
    assert.ok(errCount.count >= 1);
  } finally {
    harness.cleanup();
  }
});

// T2.1.2: Exponential backoff on rate limit (HTTP 429)
test("T2.1.2: Exponential backoff on rate limit (HTTP 429)", async () => {
  const harness = createTestHarness();
  try {
    const res = harness.runCommand("scan", { MOCK_SCENARIO: "rate-limit" });
    assert.equal(res.status, 0);
    const row = harness.db.prepare("SELECT * FROM markets WHERE market_id = 'm1'").get() as any;
    assert.ok(row);
  } finally {
    harness.cleanup();
  }
});

// T2.1.3: Partial page failure in multi-page scan
test("T2.1.3: Partial page failure in multi-page scan", async () => {
  const harness = createTestHarness();
  try {
    const res = harness.runCommand("scan", {
      MOCK_SCENARIO: "partial-failure",
      SCAN_MAX_EVENTS: "20",
      SCAN_PAGE_LIMIT: "10"
    });
    assert.equal(res.status, 0);
    const row = harness.db.prepare("SELECT * FROM markets WHERE market_id = 'm1'").get() as any;
    assert.ok(row);
  } finally {
    harness.cleanup();
  }
});

// T2.1.4: Volatility history unavailability on CoinGecko
test("T2.1.4: Volatility history unavailability on CoinGecko", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({ marketId: "m1", title: "Will Solana hit $200?", category: "crypto" });
    process.env.MOCK_SCENARIO = "cg-volatility-fail";
    const obs = await getCryptoPriceObservation(harness.db, market);
    assert.ok(obs.available);
    assert.equal(obs.payload.realizedAnnualVolatility, undefined);
    assert.equal(obs.payload.fallbackAnnualVolatility, 1.0);
    assert.equal(obs.quality, 0.45);
  } finally {
    delete process.env.MOCK_SCENARIO;
    harness.cleanup();
  }
});

// T2.1.5: Weather target past date handling
test("T2.1.5: Weather target past date handling", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "m2",
      title: "Will high temp in NYC exceed 80?",
      category: "weather",
      endDate: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    });
    const obs = await getWeatherObservation(harness.db, market);
    assert.equal(obs.available, false);
    assert.equal(obs.reason, "Weather market resolution date is in the past");
  } finally {
    harness.cleanup();
  }
});
