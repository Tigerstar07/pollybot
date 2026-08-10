import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config";
import { estimateProbability } from "../src/probability/heuristics";
import { detectInstrument, parseYahooCloses } from "../src/sources/marketDataSource";
import { buildQuery, parseRssTitles } from "../src/sources/newsSource";
import { makeMarket } from "./helpers/test-harness";
import type { SourceObservation } from "../src/types";

// Unit tests must not inherit the operator's stricter live evidence threshold.
const config = { ...loadConfig(), minIndependentSources: 1 };

test("parseYahooCloses extracts finite close prices and tolerates gaps", () => {
  const payload = {
    chart: { result: [{ indicators: { quote: [{ close: [30.4, null, 31.0, 0] }] } }] },
  };
  assert.deepEqual(parseYahooCloses(payload), [30.4, 31.0]);
  assert.deepEqual(parseYahooCloses({}), []);
});

test("parseRssTitles extracts item headlines and skips the channel title", () => {
  const xml =
    '<rss><channel><title>Query</title>' +
    "<item><title>Headline A &amp; more</title></item>" +
    "<item><title>Headline B</title></item></channel></rss>";
  assert.deepEqual(parseRssTitles(xml), ["Headline A & more", "Headline B"]);
});

test("detectInstrument maps priceable assets only when a threshold is present", () => {
  const silver = makeMarket({ title: "Will Silver (SI) hit (HIGH) $200 by end of June?", category: "objective-event" });
  assert.equal(detectInstrument(silver)?.ticker, "SI=F");

  const oil = makeMarket({ title: "Will Crude Oil (CL) hit $150 by end of June?", category: "objective-event" });
  assert.equal(detectInstrument(oil)?.ticker, "CL=F");

  const sp = makeMarket({ title: "Will the S&P 500 close above $6,000 this week?", category: "objective-event" });
  assert.equal(detectInstrument(sp)?.kind, "index");

  // No threshold cue -> not routed to the price feed.
  assert.equal(detectInstrument(makeMarket({ title: "Will gold be popular this year?" })), undefined);
  // No supported instrument.
  assert.equal(detectInstrument(makeMarket({ title: "Will it rain above $5 somewhere?" })), undefined);
});

test("financial price model produces a sane probability for a commodity threshold market", () => {
  const market = makeMarket({
    marketId: "silver-1",
    title: "Will Silver hit $200 by end of year?",
    category: "objective-event",
    yesPrice: 0.02,
    noPrice: 0.98,
    endDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  const source: SourceObservation = {
    sourceType: "market-data",
    sourceKey: "stooq:xagusd:d",
    collectedAt: new Date().toISOString(),
    available: true,
    independent: true,
    quality: 0.72,
    payload: { provider: "stooq", symbol: "Silver", kind: "metal", usd: 35, realizedAnnualVolatility: 0.28 },
  };
  const estimate = estimateProbability(config, market, [source]);
  assert.ok(estimate.method.includes("financial"));
  assert.equal(estimate.shouldSkip, false);
  // $35 spot reaching $200 is very unlikely -> YES probability should be low.
  assert.ok(estimate.estimatedYesProbability < 0.2, `got ${estimate.estimatedYesProbability}`);
});

test("financial model reads a (LOW) downward-barrier market as a drop, not 'already above'", () => {
  const market = makeMarket({
    marketId: "silver-low",
    title: "Will Silver (SI) hit (LOW) $55 by end of June?",
    category: "objective-event",
    yesPrice: 0.17,
    noPrice: 0.83,
    endDate: new Date(Date.now() + 12 * 3_600_000).toISOString(),
  });
  const source: SourceObservation = {
    sourceType: "market-data",
    sourceKey: "yahoo:SI=F:d",
    collectedAt: new Date().toISOString(),
    available: true,
    independent: true,
    quality: 0.72,
    payload: { provider: "yahoo", symbol: "Silver", kind: "metal", usd: 58, realizedAnnualVolatility: 0.3 },
  };
  const estimate = estimateProbability(config, market, [source]);
  assert.ok(estimate.method.includes("financial"));
  // Silver at $58 dipping to $55 within ~half a day is unlikely. The OLD bug parsed this
  // as "above $55" and returned ~0.99 YES (and bet the wrong side); the fix must keep YES low.
  assert.ok(estimate.estimatedYesProbability < 0.3, `expected low YES, got ${estimate.estimatedYesProbability}`);
});

test("ambiguous 'hit $X' direction is inferred from spot vs threshold", () => {
  const base = {
    sourceType: "market-data",
    sourceKey: "yahoo:GC=F:d",
    collectedAt: new Date().toISOString(),
    available: true,
    independent: true,
    quality: 0.72,
    payload: { provider: "yahoo", symbol: "Gold", kind: "metal", usd: 100, realizedAnnualVolatility: 0.2 },
  } as SourceObservation;
  const soon = new Date(Date.now() + 12 * 3_600_000).toISOString();
  const neutralRules = "Resolves yes when the price touches the stated level.";
  // Threshold far ABOVE spot -> must rise to hit it -> unlikely soon -> low YES.
  const up = estimateProbability(config, makeMarket({ marketId: "g1", title: "Will Gold hit $130 by Friday?", rules: neutralRules, endDate: soon }), [base]);
  assert.ok(up.estimatedYesProbability < 0.3, `up got ${up.estimatedYesProbability}`);
  // Threshold far BELOW spot -> must fall to hit it -> unlikely soon -> low YES.
  const down = estimateProbability(config, makeMarket({ marketId: "g2", title: "Will Gold hit $70 by Friday?", rules: neutralRules, endDate: soon }), [base]);
  assert.ok(down.estimatedYesProbability < 0.3, `down got ${down.estimatedYesProbability}`);
});

test("financial barrier blocks suspicious already-crossed source against a penny market", () => {
  const market = makeMarket({
    marketId: "oil-suspicious-cross",
    title: "Will Crude Oil (CL) hit (HIGH) $80 by end of June?",
    category: "objective-event",
    yesPrice: 0.012,
    noPrice: 0.988,
    bestAsk: 0.012,
    endDate: new Date(Date.now() + 12 * 3_600_000).toISOString(),
  });
  const source: SourceObservation = {
    sourceType: "market-data",
    sourceKey: "yahoo:CL=F:v2",
    collectedAt: new Date().toISOString(),
    available: true,
    independent: true,
    quality: 0.72,
    payload: {
      provider: "yahoo",
      symbol: "WTI Crude",
      kind: "energy",
      usd: 80.1,
      realizedAnnualVolatility: 0.4,
      spotSource: "regular-market-price",
    },
  };
  const estimate = estimateProbability(config, market, [source]);
  assert.equal(estimate.method, "financial-source-mismatch");
  assert.equal(estimate.shouldSkip, true);
  assert.ok(estimate.estimatedYesProbability < 0.05, `got ${estimate.estimatedYesProbability}`);
});

test("financial barrier blocks extreme same-day required moves", () => {
  const market = makeMarket({
    marketId: "oil-too-far",
    title: "Will Crude Oil (CL) hit (HIGH) $80 by end of June?",
    category: "objective-event",
    yesPrice: 0.012,
    noPrice: 0.988,
    bestAsk: 0.012,
    endDate: new Date(Date.now() + 12 * 3_600_000).toISOString(),
  });
  const source: SourceObservation = {
    sourceType: "market-data",
    sourceKey: "yahoo:CL=F:v2",
    collectedAt: new Date().toISOString(),
    available: true,
    independent: true,
    quality: 0.72,
    payload: {
      provider: "yahoo",
      symbol: "WTI Crude",
      kind: "energy",
      usd: 75.84,
      realizedAnnualVolatility: 0.4,
      spotSource: "intraday-close",
    },
  };
  const estimate = estimateProbability(config, market, [source]);
  assert.equal(estimate.shouldSkip, true);
  assert.ok(estimate.estimatedYesProbability <= 0.05, `got ${estimate.estimatedYesProbability}`);
  assert.ok(estimate.risks.some((risk) => risk.includes("required move is too extreme")));
});

test("buildQuery drops noise words and bare numbers and caps length", () => {
  const q = buildQuery("Will Biden officially announce nomination of X to Supreme Court by 2026?");
  assert.ok(!q.includes("will"));
  assert.ok(!q.split(" ").includes("2026"));
  assert.ok(q.split(" ").length <= 6);
  assert.ok(q.includes("biden") || q.includes("nomination") || q.includes("supreme"));
});
