import test from "node:test";
import assert from "node:assert/strict";
import { createTestHarness, makeMarket, makeEstimate } from "./helpers/test-harness";
import { estimateProbability } from "../src/probability/heuristics";
import { applyLlmReview } from "../src/probability/review";
import { collectCheapSources } from "../src/sources";
import { loadConfig } from "../src/config";
import { detectWeatherTarget, extractWeatherStationCode } from "../src/sources/weatherSource";

// T1.2.1: Weather forecast heuristic probability mapping
test("T1.2.1: Weather forecast heuristic probability mapping", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "m2",
      title: "Will high temp in NYC exceed 80?",
      category: "weather",
      endDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()
    });
    const config = { ...loadConfig(), minIndependentSources: 1 };
    const observations = await collectCheapSources(config, harness.db, market);
    const estimate = estimateProbability(config, market, observations);
    assert.equal(estimate.shouldSkip, false);
    assert.match(estimate.method, /weather/);
    assert.ok(estimate.estimatedYesProbability > 0.5);
  } finally {
    harness.cleanup();
  }
});

test("rain forecast heuristic uses precipitation threshold defaults", () => {
  const market = makeMarket({
    marketId: "rain-market",
    title: "Will it rain in Prague on the resolution date?",
    category: "weather",
    endDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const config = loadConfig();
  const estimate = estimateProbability(config, market, [
    {
      sourceType: "weather",
      sourceKey: "weather:rain",
      collectedAt: new Date().toISOString(),
      available: true,
      independent: true,
      quality: 0.7,
      payload: {
        provider: "open-meteo",
        location: "Prague",
        metric: "rain",
        unit: "inch",
        forecastValue: 0.2,
        targetDate: "2026-07-01",
        leadDays: 2,
      },
    },
  ]);
  assert.equal(estimate.method, "weather-normal-forecast-model");
  assert.ok(estimate.estimatedYesProbability > 0.6, `expected rain YES edge, got ${estimate.estimatedYesProbability}`);
});

test("weather target parser uses explicit daily temperature date and Celsius unit", () => {
  const target = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const month = target.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const day = target.getUTCDate();
  const market = makeMarket({
    marketId: "weather-hk-33",
    title: `Will the highest temperature in Hong Kong be 33°C on ${month} ${day}?`,
    category: "weather",
    endDate: new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), 12)).toISOString(),
  });
  const detected = detectWeatherTarget(market);
  assert.ok(!("reason" in detected), "expected weather target to parse");
  assert.equal(detected.city.label, "Hong Kong");
  assert.equal(detected.metric, "high");
  assert.equal(detected.unit, "celsius");
  assert.equal(detected.targetDate, target.toISOString().slice(0, 10));
});

test("weather target parser recognizes lowest-temperature language and NOAA station URLs", () => {
  const target = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const month = target.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const day = target.getUTCDate();
  const market = makeMarket({
    marketId: "weather-tel-aviv-low",
    title: `Will the lowest temperature in Tel Aviv be 24°C on ${month} ${day}?`,
    category: "weather",
    rules: "Resolution uses https://www.weather.gov/wrh/timeseries?site=LLBG and the absolute daily min.",
    endDate: new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), 12)).toISOString(),
  });
  const detected = detectWeatherTarget(market);
  assert.ok(!("reason" in detected), "expected weather target to parse");
  assert.equal(detected.metric, "low");
  assert.equal(extractWeatherStationCode(market.rules ?? ""), "LLBG");
});

test("weather target parser prefers known Wunderground station coordinates", () => {
  const target = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const month = target.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const day = target.getUTCDate();
  const market = makeMarket({
    marketId: "weather-london-eglc",
    title: `Will the highest temperature in London be 21°C or below on ${month} ${day}?`,
    category: "weather",
    rules: "The resolution source will be Wunderground London City Airport Station: https://www.wunderground.com/history/daily/gb/london/EGLC.",
    resolutionSource: "https://www.wunderground.com/history/daily/gb/london/EGLC",
    endDate: new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), 12)).toISOString(),
  });
  const detected = detectWeatherTarget(market);
  assert.ok(!("reason" in detected), "expected weather target to parse");
  assert.equal(detected.city.label, "London City Airport (EGLC)");
  assert.equal(detected.city.longitude, 0.0553);
});

test("weather model prices exact Celsius temperature buckets", () => {
  const config = loadConfig();
  const baseSource = {
    sourceType: "weather",
    sourceKey: "weather:hk",
    collectedAt: new Date().toISOString(),
    available: true,
    independent: true,
    quality: 0.78,
    payload: {
      provider: "open-meteo",
      location: "Hong Kong",
      metric: "high",
      unit: "celsius",
      forecastValue: 33.4,
      targetDate: "2026-07-01",
      leadDays: 1,
    },
  } as const;
  const bucket33 = estimateProbability(config, makeMarket({
    marketId: "weather-hk-33",
    title: "Will the highest temperature in Hong Kong be 33°C on July 1?",
    category: "weather",
  }), [baseSource]);
  const bucket30 = estimateProbability(config, makeMarket({
    marketId: "weather-hk-30",
    title: "Will the highest temperature in Hong Kong be 30°C on July 1?",
    category: "weather",
  }), [baseSource]);
  const tail30OrBelow = estimateProbability(config, makeMarket({
    marketId: "weather-hk-30-below",
    title: "Will the highest temperature in Hong Kong be 30°C or below on July 1?",
    category: "weather",
  }), [baseSource]);
  assert.equal(bucket33.method, "weather-normal-forecast-model");
  assert.ok(bucket33.estimatedYesProbability > bucket30.estimatedYesProbability, `${bucket33.estimatedYesProbability} vs ${bucket30.estimatedYesProbability}`);
  assert.ok(tail30OrBelow.estimatedYesProbability < 0.2, `tail got ${tail30OrBelow.estimatedYesProbability}`);
});

test("weather model uses an ensemble distribution instead of one deterministic point", () => {
  const config = loadConfig();
  const market = makeMarket({
    marketId: "weather-ensemble",
    title: "Will the highest temperature in Seoul be 30°C or higher on July 16?",
    category: "weather",
    yesPrice: 0.5,
  });
  const estimate = estimateProbability(config, market, [{
    sourceType: "weather",
    sourceKey: "open-meteo-ensemble:test",
    collectedAt: new Date().toISOString(),
    available: true,
    independent: false,
    quality: 0.78,
    payload: {
      provider: "open-meteo-ensemble",
      location: "Seoul",
      metric: "high",
      unit: "celsius",
      forecastValue: 30.2,
      ensembleValues: [27.9, 28.5, 29, 29.4, 29.8, 30, 30.2, 30.5, 30.8, 31.1, 31.5, 32],
      targetDate: "2026-07-16",
      leadDays: 2,
    },
  }]);
  assert.equal(estimate.method, "weather-ensemble-distribution");
  assert.ok(estimate.keyEvidence.some((line) => line.includes("12 ensemble members")));
  assert.ok(estimate.estimatedYesProbability > 0.35 && estimate.estimatedYesProbability < 0.75);
});

test("completed resolution-station observations override forecasts", () => {
  const config = loadConfig();
  const market = makeMarket({
    marketId: "weather-station-final",
    title: "Will the highest temperature in London be 21°C or below on July 16?",
    category: "weather",
    yesPrice: 0.5,
  });
  const estimate = estimateProbability(config, market, [{
    sourceType: "weather",
    sourceKey: "aviationweather-metar:EGLC",
    collectedAt: new Date().toISOString(),
    available: true,
    independent: true,
    quality: 0.96,
    payload: {
      provider: "aviationweather-metar",
      stationCode: "EGLC",
      location: "London City Airport",
      metric: "high",
      unit: "celsius",
      observedExtreme: 20,
      observationComplete: true,
      targetDate: "2026-07-16",
      leadDays: 0,
    },
  }]);
  assert.equal(estimate.method, "weather-station-observation-complete");
  assert.ok(estimate.estimatedYesProbability > 0.98);
  assert.ok(estimate.confidence >= 0.85);
});

// T1.2.2: Crypto barrier model for path-dependent dip markets
test("T1.2.2: Crypto barrier model for path-dependent dip markets", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "m5",
      title: "Will Bitcoin dip to $50,000?",
      rules: "Resolves immediately if a final Low price is equal to or lower than $50,000.",
      category: "crypto",
      endDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString()
    });
    const config = loadConfig();
    const observations = await collectCheapSources(config, harness.db, market);
    const estimate = estimateProbability(config, market, observations);
    assert.equal(estimate.method, "crypto-barrier-model");
    assert.ok(estimate.estimatedYesProbability > 0.1);
  } finally {
    harness.cleanup();
  }
});

// T1.2.3: Sports devigged consensus probability
test("T1.2.3: Sports devigged consensus probability", async () => {
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
    const estimate = estimateProbability(config, market, observations);
    assert.equal(estimate.method, "sports-devigged-bookmaker-consensus");
    assert.equal(estimate.estimatedYesProbability, 0.5);
  } finally {
    harness.cleanup();
  }
});

// T1.2.4: News/search source forecasting
test("T1.2.4: News/search source forecasting", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "m4",
      title: "Will Biden announce nomination of X?",
      category: "politics",
    });
    const config = { ...loadConfig(), minIndependentSources: 1 };
    const observations = await collectCheapSources(config, harness.db, market);
    const estimate = estimateProbability(config, market, observations);
    assert.equal(estimate.shouldSkip, false);
    assert.equal(estimate.method, "news-headline-sentiment-model");
    assert.ok(estimate.estimatedYesProbability > 0.5);
    // News is intentionally a weak signal now: confidence is capped below the live-bet
    // threshold so headline sentiment alone can never place a real-money order.
    assert.ok(estimate.confidence >= 0.35 && estimate.confidence < 0.45, `confidence ${estimate.confidence}`);
  } finally {
    harness.cleanup();
  }
});

test("news requires explicit confirmation from distinct publishers before raising confidence", () => {
  const config = loadConfig();
  const market = makeMarket({
    marketId: "news-confirmed",
    title: "Will Acme officially launch Nova?",
    category: "tech",
    yesPrice: 0.25,
  });
  const publishedAt = new Date().toISOString();
  const estimate = estimateProbability(config, market, [{
    sourceType: "news",
    sourceKey: "news:confirmed",
    collectedAt: publishedAt,
    available: true,
    independent: true,
    quality: 0.74,
    payload: {
      articles: [
        { title: "Acme officially launches Nova", publisher: "publisher-a.example", publishedAt },
        { title: "Acme confirms it launched Nova", publisher: "publisher-b.example", publishedAt },
        { title: "Acme launches Nova after formal announcement", publisher: "publisher-c.example", publishedAt },
      ],
    },
  }]);
  assert.equal(estimate.method, "news-multi-publisher-confirmation");
  assert.ok(estimate.estimatedYesProbability >= 0.88);
  assert.ok(estimate.confidence >= 0.58);
});

// T1.2.5: LLM review veto on heuristics
test("T1.2.5: LLM review veto on heuristics", async () => {
  const base = makeEstimate({ estimatedYesProbability: 0.60, confidence: 0.7 });
  const review = makeEstimate({ estimatedYesProbability: 0.85, confidence: 0.9 });
  const result = applyLlmReview(base, review);
  assert.equal(result.estimatedYesProbability, 0.60);
  assert.equal(result.shouldSkip, true);
  assert.ok(result.risks.some(r => r.includes("disagreed")));
});

// T2.2.1: Division by zero or negative days in crypto volatility scaling
test("T2.2.1: Division by zero or negative days in crypto volatility scaling", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "m1",
      title: "Will Solana hit $200?",
      category: "crypto",
      endDate: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    });
    const config = loadConfig();
    const observations = await collectCheapSources(config, harness.db, market);
    const estimate = estimateProbability(config, market, observations);
    assert.ok(Number.isFinite(estimate.estimatedYesProbability));
  } finally {
    harness.cleanup();
  }
});

// T2.2.2: Extreme weather lead times (beyond 16 days)
test("T2.2.2: Extreme weather lead times (beyond 16 days)", async () => {
  const market = makeMarket({
    marketId: "m2",
    title: "Will temp in NYC exceed 80?",
    category: "weather",
    endDate: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString()
  });
  const res = detectWeatherTarget(market);
  assert.ok("reason" in res);
  assert.equal(res.reason, "Resolution date is beyond the 16-day forecast horizon");
});

// T2.2.3: Zero bookmakers in sports odds response
test("T2.2.3: Zero bookmakers in sports odds response", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "m3",
      title: "Will Celtics beat Lakers?",
      category: "sports",
      tags: ["NBA"],
      endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    });
    process.env.MOCK_SCENARIO = "sports-zero-books";
    const config = { ...loadConfig(), sportsOddsApiKey: "test-key" };
    const observations = await collectCheapSources(config, harness.db, market);
    const sportsObs = observations.find(o => o.sourceType === "sports-odds");
    assert.equal(sportsObs?.available, false);
    assert.ok(sportsObs?.reason?.includes("No sufficiently close") || sportsObs?.reason?.includes("bookmaker"));
  } finally {
    delete process.env.MOCK_SCENARIO;
    harness.cleanup();
  }
});

// T2.2.4: Empty or gibberish headlines in news source
test("T2.2.4: Empty or gibberish headlines in news source", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "m4",
      title: "Will Biden announce nomination of X?",
      category: "politics",
    });
    process.env.MOCK_SCENARIO = "news-empty";
    const config = loadConfig();
    const observations = await collectCheapSources(config, harness.db, market);
    const estimate = estimateProbability(config, market, observations);
    assert.equal(estimate.method, "market-prior-only");
    assert.equal(estimate.shouldSkip, true);
  } finally {
    delete process.env.MOCK_SCENARIO;
    harness.cleanup();
  }
});

// T2.2.5: Disputed / non-binary rules parsing
test("T2.2.5: Disputed / non-binary rules parsing", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "m1",
      title: "Will bitcoin hit $1m before GTA VI?",
      rules: "Resolves Yes if Bitcoin reaches $1,000,000 before the game releases. If neither occurs, resolves 50-50.",
      category: "crypto",
    });
    const config = loadConfig();
    const observations = await collectCheapSources(config, harness.db, market);
    const estimate = estimateProbability(config, market, observations);
    assert.equal(estimate.method, "market-prior-only");
    assert.equal(estimate.shouldSkip, true);
  } finally {
    harness.cleanup();
  }
});
