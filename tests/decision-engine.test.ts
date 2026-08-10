import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, type AppConfig } from "../src/config";
import {
  getForecastCounts,
  getSettledForecasts,
  openDatabase,
  savePaperOrder,
  saveRanking,
  settleForecastRecords,
  settlePaperOrder,
} from "../src/db";
import {
  barrierProbability,
  estimateProbability,
  terminalProbability,
} from "../src/probability/heuristics";
import { applyLlmReview } from "../src/probability/review";
import { computeCalibration, computeForecastCalibration } from "../src/reports/calibration";
import { estimateTakerFeePerShare, rankMarket } from "../src/ranking/ranker";
import { matchMarketToOdds } from "../src/sources/sportsOddsSource";
import type { MarketResolution } from "../src/providers/polymarket/markets";
import { assessPaperBet } from "../src/trading/riskManager";
import { settleOrdersForResolution } from "../src/trading/settlement";
import type { OpenPaperOrderRow, SettledBetRow } from "../src/db";
import type { NormalizedMarket, ProbabilityEstimate, SourceObservation } from "../src/types";

const config: AppConfig = {
  ...loadConfig(),
  dryRun: true,
  enableRealTrading: false,
  minEdge: 0.1,
  minConfidence: 0.55,
  minIndependentSources: 1,
  minLiquidity: 250,
  maxSpread: 0.1,
  minHoursToEnd: 12,
  maxDaysToEnd: 365,
  liveMinHoursToEnd: 12,
  liveMaxHoursToEnd: 365 * 24,
  liveMinStakeEur: 0.05,
  slippageBuffer: 0.005,
};

test("market price alone cannot create a bet", () => {
  const market = makeMarket({ yesPrice: 0.58, noPrice: 0.42 });
  const estimate = estimateProbability(config, market, []);
  const ranking = rankMarket(config, market, estimate);

  assert.equal(estimate.method, "market-prior-only");
  assert.equal(estimate.independentEvidenceCount, 0);
  assert.equal(estimate.shouldSkip, true);
  assert.equal(ranking.action, "UNMODELED");
  assert.ok(ranking.edge.confidenceAdjustedEdge <= 0);
  assert.ok(ranking.skipReasons.includes("no independent evidence source"));
});

test("sports consensus excludes Polymarket and stale bookmaker lines", () => {
  const now = new Date();
  const market = makeMarket({
    category: "sports",
    title: "Will the Boston Celtics beat the Los Angeles Lakers?",
    endDate: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
  });
  const event = {
    id: "nba-test",
    sport_key: "basketball_nba",
    sport_title: "NBA",
    commence_time: market.endDate!,
    home_team: "Los Angeles Lakers",
    away_team: "Boston Celtics",
    bookmakers: [
      {
        key: "circa",
        title: "Circa",
        last_update: now.toISOString(),
        markets: [{ key: "h2h", outcomes: [{ name: "Boston Celtics", price: 2 }, { name: "Los Angeles Lakers", price: 2 }] }],
      },
      {
        key: "polymarket",
        title: "Polymarket",
        last_update: now.toISOString(),
        markets: [{ key: "h2h", outcomes: [{ name: "Boston Celtics", price: 1.01 }, { name: "Los Angeles Lakers", price: 10 }] }],
      },
      {
        key: "stale-book",
        title: "Stale Book",
        last_update: new Date(now.getTime() - 2 * 60 * 60_000).toISOString(),
        markets: [{ key: "h2h", outcomes: [{ name: "Boston Celtics", price: 1.1 }, { name: "Los Angeles Lakers", price: 8 }] }],
      },
    ],
  };
  const match = matchMarketToOdds(market, [event], 30);
  assert.ok(match);
  assert.equal(match.bookmakerCount, 1);
  assert.equal(match.probability, 0.5);
});

test("sports outright markets do not use h2h match odds", () => {
  const now = new Date();
  const market = makeMarket({
    category: "sports",
    title: "Will England win the 2026 FIFA World Cup?",
    endDate: new Date(now.getTime() + 365 * 24 * 60 * 60_000).toISOString(),
  });
  const h2hEvent = {
    id: "world-cup-match",
    sport_key: "soccer_fifa_world_cup",
    sport_title: "FIFA World Cup",
    commence_time: market.endDate!,
    home_team: "England",
    away_team: "Brazil",
    bookmakers: [
      {
        key: "circa",
        title: "Circa",
        last_update: now.toISOString(),
        markets: [{ key: "h2h", outcomes: [{ name: "England", price: 1.5 }, { name: "Brazil", price: 2.8 }] }],
      },
    ],
  };

  assert.equal(matchMarketToOdds(market, [h2hEvent], 30), undefined);
});

test("the engine can select NO when that is the stronger executable side", () => {
  const market = makeMarket({ yesPrice: 0.62, noPrice: 0.38, bestAsk: 0.63, noBestAsk: 0.39 });
  const source: SourceObservation = {
    sourceType: "manual-notes",
    sourceKey: "manual:test",
    collectedAt: new Date().toISOString(),
    available: true,
    independent: true,
    quality: 0.8,
    payload: {
      estimatedYesProbability: 0.18,
      confidence: 0.8,
      evidence: ["Independent base-rate model"],
      risks: ["Small sample"],
    },
  };
  const estimate = estimateProbability(config, market, [source]);
  const ranking = rankMarket(config, market, estimate);

  assert.equal(ranking.edge.outcome, "NO");
  assert.equal(ranking.action, "PAPER_BET");
  assert.ok(ranking.edge.confidenceAdjustedEdge > config.minEdge);
});

test("confidence shrinkage blocks a raw forecast that is not strong after calibration", () => {
  const market = makeMarket({ yesPrice: 0.64, noPrice: 0.36, bestAsk: 0.65, noBestAsk: 0.37 });
  const estimate = makeEstimate({ estimatedYesProbability: 0.8, estimatedNoProbability: 0.2, confidence: 0.4 });
  const ranking = rankMarket(config, market, estimate);

  assert.equal(ranking.action, "WATCH");
  assert.ok(ranking.edge.confidenceAdjustedEdge < config.minEdge);
});

test("confidence calibration cannot manufacture an edge opposite to the raw forecast", () => {
  const market = makeMarket({ yesPrice: 0.03, noPrice: 0.97, bestAsk: 0.03, noBestAsk: 0.98 });
  const ranking = rankMarket(
    config,
    market,
    makeEstimate({ estimatedYesProbability: 0.01, estimatedNoProbability: 0.99, confidence: 0.62 }),
  );

  assert.notEqual(ranking.action, "PAPER_BET");
  assert.ok(ranking.edge.calibratedProbability <= Math.max(ranking.edge.rawProbability, ranking.edge.marketPriorProbability));
  assert.ok(ranking.edge.calibratedProbability >= Math.min(ranking.edge.rawProbability, ranking.edge.marketPriorProbability));
});

test("fee model charges the documented crypto peak at a 0.50 price", () => {
  assert.equal(estimateTakerFeePerShare("crypto", 0.5), 0.0175);
  assert.equal(estimateTakerFeePerShare("geopolitics", 0.5), 0);
});

test("fee model uses the current documented sports taker rate", () => {
  assert.equal(estimateTakerFeePerShare("sports", 0.5, undefined, true), 0.0125);
});

test("an LLM review can veto but cannot manufacture or replace a base probability", () => {
  const base = makeEstimate({ estimatedYesProbability: 0.62, estimatedNoProbability: 0.38, confidence: 0.7 });
  const review = makeEstimate({ estimatedYesProbability: 0.85, estimatedNoProbability: 0.15, confidence: 0.9 });
  const result = applyLlmReview(base, review);

  assert.equal(result.estimatedYesProbability, base.estimatedYesProbability);
  assert.equal(result.confidence, base.confidence);
  assert.equal(result.shouldSkip, true);
  assert.ok(result.risks.some((risk) => risk.includes("disagreed")));
});

test("terminal crypto probability moves in the correct direction", () => {
  const nearerThreshold = terminalProbability(70_000, 75_000, 0.6, 30 / 365, "above");
  const fartherThreshold = terminalProbability(70_000, 100_000, 0.6, 30 / 365, "above");
  assert.ok(nearerThreshold > fartherThreshold);
  assert.ok(nearerThreshold > 0 && nearerThreshold < 1);
});

test("barrier probability exceeds terminal probability for a dip market", () => {
  const terminal = terminalProbability(60_000, 50_000, 0.44, 186 / 365, "below");
  const barrier = barrierProbability(60_000, 50_000, 0.44, 186 / 365, "below");
  assert.ok(barrier > terminal);
  assert.ok(barrier > 0.5);
});

test("crypto race markets with a 50-50 fallback are not modeled as binary price barriers", () => {
  const market = makeMarket({
    category: "crypto",
    title: "Will bitcoin hit $1m before GTA VI?",
    rules: "Resolves Yes if Bitcoin reaches $1,000,000 before the game releases. If neither occurs, resolves 50-50.",
  });
  const source: SourceObservation = {
    sourceType: "crypto-price",
    sourceKey: "crypto:test",
    collectedAt: new Date().toISOString(),
    available: true,
    independent: true,
    quality: 0.8,
    payload: { symbol: "BTC", usd: 60_000, realizedAnnualVolatility: 0.44 },
  };
  const estimate = estimateProbability(config, market, [source]);
  assert.equal(estimate.method, "market-prior-only");
  assert.equal(estimate.shouldSkip, true);
});

test("dip language selects the crypto barrier model", () => {
  const market = makeMarket({
    category: "crypto",
    title: "Will Bitcoin dip to $50,000 by December 31, 2026?",
    rules: "Resolves immediately if a final Low price is equal to or lower than $50,000.",
    endDate: new Date(Date.now() + 186 * 86_400_000).toISOString(),
  });
  const source: SourceObservation = {
    sourceType: "crypto-price",
    sourceKey: "crypto:test",
    collectedAt: new Date().toISOString(),
    available: true,
    independent: true,
    quality: 0.8,
    payload: { symbol: "BTC", usd: 60_000, realizedAnnualVolatility: 0.44 },
  };
  const estimate = estimateProbability(config, market, [source]);
  assert.equal(estimate.method, "crypto-barrier-model");
  assert.ok(estimate.estimatedYesProbability > 0.5);
});

test("paper execution requires a fresh quote and enforces same-side cooldown", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pollybot-test-"));
  const testConfig = { ...config, databasePath: path.join(tempDir, "test.sqlite"), paperOrderCooldownMinutes: 60 };
  const db = openDatabase(testConfig);
  try {
    const market = makeMarket({
      yesPrice: 0.28,
      noPrice: 0.72,
      bestAsk: 0.3,
      noBestAsk: 0.74,
      quoteCapturedAt: new Date().toISOString(),
      yesAskDepthEur: 5,
      noAskDepthEur: 5,
    });
    const ranking = rankMarket(
      testConfig,
      market,
      makeEstimate({ estimatedYesProbability: 0.82, estimatedNoProbability: 0.18, confidence: 0.8 }),
    );
    const first = assessPaperBet(testConfig, db, ranking);
    assert.ok(first.order);
    savePaperOrder(db, first.order!);

    const repeated = assessPaperBet(testConfig, db, ranking);
    assert.equal(repeated.order, undefined);
    assert.ok(repeated.blockers.some((blocker) => blocker.includes("cooldown")));

    const staleRanking = rankMarket(
      testConfig,
      { ...market, quoteCapturedAt: new Date(Date.now() - 120_000).toISOString() },
      makeEstimate({ estimatedYesProbability: 0.82, estimatedNoProbability: 0.18, confidence: 0.8 }),
    );
    const stale = assessPaperBet(testConfig, db, staleRanking);
    assert.ok(stale.blockers.some((blocker) => blocker.includes("older than")));
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("weather forecast above the threshold produces a high YES probability", () => {
  const market = makeMarket({
    category: "weather",
    title: "Will the high temperature in New York City be above 70°F on the resolution date?",
    rules: "Resolves Yes if the daily high exceeds 70 degrees.",
    endDate: new Date(Date.now() + 2 * 86_400_000).toISOString(),
  });
  const source: SourceObservation = {
    sourceType: "weather",
    sourceKey: "weather:test",
    collectedAt: new Date().toISOString(),
    available: true,
    independent: true,
    quality: 0.78,
    payload: { provider: "open-meteo", location: "New York City", metric: "high", unit: "fahrenheit", forecastValue: 85, leadDays: 2, targetDate: "2026-07-01" },
  };
  const estimate = estimateProbability(config, market, [source]);
  assert.ok(estimate.method.includes("weather"));
  assert.equal(estimate.shouldSkip, false);
  assert.ok(estimate.estimatedYesProbability > 0.9, `expected high YES, got ${estimate.estimatedYesProbability}`);
});

test("settlement pays winners EUR 1 per share and zeroes losers", () => {
  const resolution: MarketResolution = {
    marketId: "m1",
    closed: true,
    resolved: true,
    winningOutcome: "Yes",
    winningIndex: 0,
    outcomes: ["Yes", "No"],
    outcomePrices: [1, 0],
  };
  const orders: OpenPaperOrderRow[] = [
    { id: 1, market_id: "m1", outcome: "YES", size_eur: 0.3, estimated_shares: 0.5, price: 0.6 },
    { id: 2, market_id: "m1", outcome: "NO", size_eur: 0.2, estimated_shares: 0.5, price: 0.4 },
    { id: 3, market_id: "other", outcome: "YES", size_eur: 0.5, estimated_shares: 1, price: 0.5 },
  ];
  const settled = settleOrdersForResolution(resolution, orders);
  assert.equal(settled.length, 2, "only orders on the resolved market settle");
  const winner = settled.find((entry) => entry.orderId === 1)!;
  const loser = settled.find((entry) => entry.orderId === 2)!;
  assert.equal(winner.won, true);
  assert.equal(winner.pnlEur, 0.2); // 0.5 shares * EUR 1 - 0.3 stake
  assert.equal(loser.won, false);
  assert.equal(loser.pnlEur, -0.2); // total stake lost
});

test("an unresolved market settles nothing (fails closed)", () => {
  const resolution: MarketResolution = {
    marketId: "m1", closed: true, resolved: false, outcomes: ["Yes", "No"], outcomePrices: [0.55, 0.45],
  };
  const orders: OpenPaperOrderRow[] = [{ id: 1, market_id: "m1", outcome: "YES", size_eur: 0.3, estimated_shares: 0.5, price: 0.6 }];
  assert.equal(settleOrdersForResolution(resolution, orders).length, 0);
});

test("settlement persistence is atomic and idempotent", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pollybot-settlement-test-"));
  const db = openDatabase({ ...config, databasePath: path.join(tempDir, "test.sqlite") });
  try {
    const orderId = savePaperOrder(db, {
      marketId: "m1",
      outcome: "YES",
      side: "BUY",
      tokenId: "yes-token",
      price: 0.6,
      sizeEur: 0.3,
      estimatedShares: 0.5,
      edge: 0.12,
      confidence: 0.7,
      forecastProb: 0.75,
      marketPriorProb: 0.6,
      feeEur: 0,
      maxLossEur: 0.3,
      quoteCapturedAt: new Date().toISOString(),
      decisionKey: "m1:YES:test",
      modelVersion: "test-v1",
      reasoning: "test",
    });
    const settlement = {
      orderId,
      marketId: "m1",
      outcome: "YES",
      winningOutcome: "YES",
      source: "paper",
      stakeEur: 0.3,
      payoutEur: 0.5,
      pnlEur: 0.2,
    };

    assert.equal(settlePaperOrder(db, settlement), true);
    assert.equal(settlePaperOrder(db, settlement), false);
    const order = db.prepare("SELECT status, pnl_eur FROM paper_orders WHERE id = ?").get(orderId) as {
      status: string;
      pnl_eur: number;
    };
    const settlementCount = db.prepare("SELECT COUNT(*) AS count FROM settlements").get() as { count: number };
    assert.deepEqual(order, { status: "CLOSED", pnl_eur: 0.2 });
    assert.equal(settlementCount.count, 1);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("calibration scores forecasts against realized outcomes", () => {
  const bets: SettledBetRow[] = [
    settledBet({ forecast_prob: 0.8, pnl_eur: 0.2, size_eur: 0.3 }), // win
    settledBet({ forecast_prob: 0.7, pnl_eur: -0.3, size_eur: 0.3 }), // loss
    settledBet({ forecast_prob: 0.3, pnl_eur: -0.3, size_eur: 0.3 }), // loss
  ];
  const report = computeCalibration(bets);
  assert.equal(report.settledCount, 3);
  assert.equal(report.forecastCount, 3);
  assert.equal(report.totalPnlEur, -0.4);
  assert.ok(report.brierScore !== undefined && report.brierScore > 0 && report.brierScore < 1);
  assert.ok(report.marketBrierScore !== undefined && report.marketBrierScore > 0);
  assert.ok(report.brierSkillScore !== undefined);
  // Empty input must not throw and yields no Brier score.
  assert.equal(computeCalibration([]).brierScore, undefined);
});

test("shadow forecasts are versioned, settled, and scored against the market", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pollybot-forecast-test-"));
  const db = openDatabase({ ...config, databasePath: path.join(tempDir, "test.sqlite") });
  try {
    const market = makeMarket({ yesPrice: 0.6, noPrice: 0.4 });
    const ranking = rankMarket(
      config,
      market,
      makeEstimate({
        estimatedYesProbability: 0.8,
        estimatedNoProbability: 0.2,
        confidence: 0.75,
      }),
    );
    saveRanking(db, ranking, "batch-1");
    assert.deepEqual(getForecastCounts(db), {
      recorded: 1,
      scorable: 1,
      settled: 0,
      pending: 1,
    });
    assert.equal(settleForecastRecords(db, market.marketId, "Yes"), 1);
    const settled = getSettledForecasts(db);
    assert.equal(settled.length, 1);
    assert.equal(settled[0]?.outcome_yes, 1);
    const calibration = computeForecastCalibration(settled);
    assert.equal(calibration.settledCount, 1);
    assert.ok((calibration.brierScore ?? 1) < (calibration.marketBrierScore ?? 0));
    assert.ok((calibration.brierSkillScore ?? 0) > 0);

    const closedRanking = rankMarket(
      config,
      { ...market, marketId: "already-closed", status: "closed" },
      makeEstimate({ marketId: "already-closed" }),
    );
    saveRanking(db, closedRanking, "batch-2");
    saveRanking(db, ranking, "batch-3");
    assert.deepEqual(getForecastCounts(db), {
      recorded: 3,
      scorable: 1,
      settled: 1,
      pending: 0,
    });
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function settledBet(overrides: Partial<SettledBetRow>): SettledBetRow {
  return {
    market_id: "m",
    outcome: "YES",
    price: 0.6,
    confidence: 0.6,
    edge: 0.12,
    forecast_prob: 0.7,
    market_prior_prob: 0.6,
    size_eur: 0.3,
    pnl_eur: 0.1,
    closed_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeMarket(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    provider: "polymarket",
    marketId: "market-test",
    title: "Will the objectively measured value exceed the threshold by the stated date?",
    category: "objective-event",
    outcomes: ["Yes", "No"],
    yesTokenId: "yes-token",
    noTokenId: "no-token",
    yesPrice: 0.5,
    noPrice: 0.5,
    bestBid: 0.48,
    bestAsk: 0.5,
    noBestBid: 0.48,
    noBestAsk: 0.5,
    spread: 0.02,
    noSpread: 0.02,
    liquidity: 10_000,
    volume: 100_000,
    endDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    status: "open",
    resolutionSource: "Official published dataset",
    rules:
      "This market will resolve to Yes according to the official published dataset if the precisely defined value is greater than the threshold before the stated deadline. Otherwise it resolves No.",
    tags: [],
    raw: {},
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeEstimate(overrides: Partial<ProbabilityEstimate> = {}): ProbabilityEstimate {
  return {
    marketId: "market-test",
    estimatedYesProbability: 0.75,
    estimatedNoProbability: 0.25,
    confidence: 0.75,
    method: "test-independent-model",
    reasoningSummary: "Deterministic test estimate",
    keyEvidence: ["Fixture evidence"],
    risks: ["Fixture uncertainty"],
    independentEvidenceCount: 1,
    dataQuality: 0.8,
    modelUncertainty: 0.08,
    shouldSkip: false,
    ...overrides,
  };
}
