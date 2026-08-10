import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config";
import {
  getLatestLiveCandidateRankings,
  getOpenLiveExposure,
  saveLiveOrder,
  saveRanking,
  upsertMarket,
} from "../src/db";
import { rankMarket } from "../src/ranking/ranker";
import { assessLiveBet } from "../src/trading/riskManager";
import { createTestHarness, makeEstimate, makeMarket } from "./helpers/test-harness";

const liveConfig = {
  ...loadConfig(),
  dryRun: false,
  enableRealTrading: true,
  enableDirectionalLiveTrading: true,
  liveCalibrationMinSettled: 0,
  liveCalibrationMinCategorySettled: 0,
  bankrollEur: 10,
  baseBetEur: 0.1,
  kellyFraction: 0.2,
  maxBetEur: 0.2,
  maxPerMarketEur: 0.3,
  maxPerEventEur: 0.3,
  maxOpenExposureEur: 1,
  maxLiveTradesPerDay: 1,
  maxLiveStakePerDayEur: 0.2,
  liveMinStakeEur: 0.05,
  liveOrderCooldownMinutes: 1440,
  liveMinHoursToEnd: 0.25,
  liveMaxHoursToEnd: 365 * 24,
  liveNearTermMaxHours: 36,
  liveSweepCandidateLimit: 250,
  minHoursToEnd: 0.25,
  maxDaysToEnd: 365,
  minEdge: 0.03,
  minConfidence: 0.45,
  minIndependentSources: 1,
  // These mechanics tests exercise reservation/cap/expiry/share-min logic with
  // deliberately extreme prices, so they opt out of the live price-band guard.
  liveMinPrice: 0,
  liveMaxPrice: 1,
  // ...and out of the favorite floor: several fixtures assert sizing/cap mechanics with
  // sub-0.5 model probabilities. Dedicated tests below cover the floor itself.
  liveMinModelProbability: 0,
};

test("live risk uses live exposure, reserves before submission, and enforces the daily cap", () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "live-market",
      yesPrice: 0.01,
      noPrice: 0.99,
      bestBid: 0.005,
      bestAsk: 0.01,
      noBestBid: 0.985,
      noBestAsk: 0.99,
      quoteCapturedAt: new Date().toISOString(),
      yesAskDepthEur: 10,
      yesMinOrderSizeShares: 5,
      yesTickSize: "0.001",
    });
    const ranking = rankMarket(
      liveConfig,
      market,
      makeEstimate({
        marketId: "live-market",
        estimatedYesProbability: 0.3,
        estimatedNoProbability: 0.7,
        confidence: 0.8,
      }),
    );
    const assessment = assessLiveBet(liveConfig, harness.db, ranking);
    assert.ok(assessment.order);

    const order = assessment.order;
    saveLiveOrder(harness.db, {
      marketId: order.marketId,
      outcome: order.outcome,
      side: "BUY",
      tokenId: order.tokenId,
      price: order.price,
      sizeEur: order.sizeEur,
      estimatedShares: order.estimatedShares,
      edge: order.edge,
      confidence: order.confidence,
      forecastProb: order.forecastProb,
      marketPriorProb: order.marketPriorProb,
      feeEur: order.feeEur,
      maxLossEur: order.maxLossEur,
      quoteCapturedAt: order.quoteCapturedAt,
      decisionKey: order.decisionKey,
      modelVersion: order.modelVersion,
      reasoning: order.reasoning,
      status: "PENDING",
    });
    assert.equal(getOpenLiveExposure(harness.db), order.sizeEur);

    const secondMarket = makeMarket({
      ...market,
      marketId: "live-market-2",
      quoteCapturedAt: new Date().toISOString(),
    });
    const secondRanking = rankMarket(
      liveConfig,
      secondMarket,
      makeEstimate({
        marketId: "live-market-2",
        estimatedYesProbability: 0.3,
        estimatedNoProbability: 0.7,
        confidence: 0.8,
      }),
    );
    const secondAssessment = assessLiveBet(liveConfig, harness.db, secondRanking);
    assert.equal(secondAssessment.order, undefined);
    assert.ok(secondAssessment.blockers.some((blocker) => blocker.includes("daily live-trade limit")));
  } finally {
    harness.cleanup();
  }
});

test("live risk refuses orders below the exchange share minimum", () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "minimum-market",
      yesPrice: 0.5,
      noPrice: 0.5,
      bestAsk: 0.5,
      noBestAsk: 0.5,
      quoteCapturedAt: new Date().toISOString(),
      yesAskDepthEur: 10,
      yesMinOrderSizeShares: 5,
    });
    const ranking = rankMarket(
      liveConfig,
      market,
      makeEstimate({
        marketId: "minimum-market",
        estimatedYesProbability: 0.9,
        estimatedNoProbability: 0.1,
        confidence: 0.9,
      }),
    );
    const assessment = assessLiveBet(liveConfig, harness.db, ranking);
    assert.equal(assessment.order, undefined);
    assert.ok(assessment.blockers.some((blocker) => blocker.includes("share minimum")));
  } finally {
    harness.cleanup();
  }
});

test("live risk caps exposure across markets sharing the same event", () => {
  const harness = createTestHarness();
  try {
    const eventConfig = {
      ...liveConfig,
      maxBetEur: 2,
      maxPerMarketEur: 2,
      maxPerEventEur: 0.5,
      maxOpenExposureEur: 5,
      maxLiveTradesPerDay: 10,
      maxLiveStakePerDayEur: 5,
      allowLiveMinOrderTopUp: true,
    };
    const eventId = "world-cup-2026";
    const firstMarket = makeMarket({
      marketId: "event-market-1",
      eventId,
      yesPrice: 0.2,
      noPrice: 0.8,
      bestAsk: 0.2,
      noBestAsk: 0.8,
      quoteCapturedAt: new Date().toISOString(),
    });
    upsertMarket(harness.db, firstMarket);
    saveLiveOrder(harness.db, {
      marketId: firstMarket.marketId,
      outcome: "YES",
      side: "BUY",
      tokenId: "event-token-1",
      price: 0.2,
      sizeEur: 0.5,
      estimatedShares: 2.5,
      edge: 0.1,
      confidence: 0.8,
      forecastProb: 0.65,
      marketPriorProb: 0.2,
      feeEur: 0.01,
      maxLossEur: 0.5,
      quoteCapturedAt: new Date().toISOString(),
      decisionKey: "event-market-1:YES:test",
      modelVersion: "test",
      reasoning: "existing event exposure fixture",
      status: "OPEN",
    });

    const secondMarket = makeMarket({
      marketId: "event-market-2",
      eventId,
      yesPrice: 0.2,
      noPrice: 0.8,
      bestAsk: 0.2,
      noBestAsk: 0.8,
      quoteCapturedAt: new Date().toISOString(),
      yesAskDepthEur: 10,
      yesMinOrderSizeShares: 5,
    });
    upsertMarket(harness.db, secondMarket);
    const ranking = rankMarket(
      eventConfig,
      secondMarket,
      makeEstimate({
        marketId: secondMarket.marketId,
        estimatedYesProbability: 0.65,
        estimatedNoProbability: 0.35,
        confidence: 0.9,
      }),
    );
    const assessment = assessLiveBet(eventConfig, harness.db, ranking);
    assert.equal(assessment.order, undefined);
    assert.ok(assessment.blockers.includes("per-event live exposure limit reached"));
  } finally {
    harness.cleanup();
  }
});

test("live sweep candidate cache prioritizes near-term markets before long-term scores", () => {
  const harness = createTestHarness();
  try {
    const batchId = "near-term-live-batch";
    const nearMarket = makeMarket({
      marketId: "near-term-market",
      endDate: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
      quoteCapturedAt: new Date().toISOString(),
    });
    const longMarket = makeMarket({
      marketId: "long-term-market",
      endDate: new Date(Date.now() + 20 * 86_400_000).toISOString(),
      quoteCapturedAt: new Date().toISOString(),
    });
    upsertMarket(harness.db, nearMarket);
    upsertMarket(harness.db, longMarket);

    const nearRanking = {
      ...rankMarket(
        liveConfig,
        nearMarket,
        makeEstimate({ marketId: nearMarket.marketId, confidence: 0.8 }),
      ),
      action: "WATCH" as const,
      finalScore: 10,
    };
    const longRanking = {
      ...rankMarket(
        liveConfig,
        longMarket,
        makeEstimate({ marketId: longMarket.marketId, confidence: 0.8 }),
      ),
      action: "WATCH" as const,
      finalScore: 95,
    };
    saveRanking(harness.db, longRanking, batchId);
    saveRanking(harness.db, nearRanking, batchId);

    const cached = getLatestLiveCandidateRankings(harness.db, 2, 36);
    assert.deepEqual(cached.map((ranking) => ranking.market.marketId), [
      "near-term-market",
      "long-term-market",
    ]);
  } finally {
    harness.cleanup();
  }
});

test("intraday live lane permits small high-edge near-term bets below the standard confidence gate", () => {
  const harness = createTestHarness();
  try {
    const intradayConfig = {
      ...liveConfig,
      baseBetEur: 1.1,
      maxBetEur: 3,
      maxPerMarketEur: 3,
      maxPerEventEur: 3,
      maxOpenExposureEur: 8,
      maxLiveTradesPerDay: 10,
      maxLiveStakePerDayEur: 10,
      liveMinStakeEur: 1.1,
      allowLiveMinOrderTopUp: true,
      minLiveTopUpEdge: 0.015,
      liveMinPrice: 0.05,
      liveIntradayEnabled: true,
      liveIntradayMaxHours: 36,
      liveIntradayMinEdge: 0.08,
      liveIntradayMinConfidence: 0.4,
      liveIntradayMinPrice: 0.01,
      liveIntradayMaxPrice: 0.98,
      liveIntradayMaxStakeEur: 1.1,
    };
    const market = makeMarket({
      marketId: "intraday-market",
      yesPrice: 0.02,
      noPrice: 0.98,
      bestAsk: 0.02,
      noBestAsk: 0.98,
      quoteCapturedAt: new Date().toISOString(),
      yesAskDepthEur: 20,
      yesMinOrderSizeShares: 5,
      endDate: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    });
    const ranking = {
      ...rankMarket(
        intradayConfig,
        market,
        makeEstimate({
          marketId: market.marketId,
          estimatedYesProbability: 0.35,
          estimatedNoProbability: 0.65,
          confidence: 0.42,
          independentEvidenceCount: 1,
        }),
      ),
      action: "WATCH" as const,
      skipReasons: [],
    };
    const assessment = assessLiveBet(intradayConfig, harness.db, ranking);
    assert.ok(assessment.order);
    assert.equal(assessment.order.sizeEur, 1.1);
  } finally {
    harness.cleanup();
  }
});

test("live risk refuses same-day forecast-only temperature markets", () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "same-day-weather",
      title: "Will the highest temperature in London be 21°C or below on June 30?",
      category: "weather",
      yesPrice: 0.05,
      noPrice: 0.95,
      bestAsk: 0.055,
      noBestAsk: 0.95,
      quoteCapturedAt: new Date().toISOString(),
      yesAskDepthEur: 10,
      yesMinOrderSizeShares: 5,
      endDate: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      rules: "Resolves from Wunderground London City Airport Station.",
    });
    const ranking = rankMarket(
      {
        ...liveConfig,
        liveIntradayEnabled: true,
        liveIntradayMinPrice: 0.01,
        liveIntradayMaxPrice: 0.98,
      },
      market,
      makeEstimate({
        marketId: market.marketId,
        estimatedYesProbability: 0.33,
        estimatedNoProbability: 0.67,
        confidence: 0.58,
        method: "weather-normal-forecast-model",
      }),
    );
    assert.ok(ranking.skipReasons.includes("same-day temperature market needs station observations"));
    const assessment = assessLiveBet(liveConfig, harness.db, ranking);
    assert.ok(assessment.blockers.includes("same-day temperature markets need station observations, not forecast-only live execution"));
  } finally {
    harness.cleanup();
  }
});

test("live risk refuses buys below the favorite (model win probability) floor", () => {
  const harness = createTestHarness();
  try {
    const favoriteConfig = { ...liveConfig, liveMinModelProbability: 0.6, minEdge: 0.01 };
    const market = makeMarket({
      marketId: "longshot-favorite-floor",
      category: "crypto",
      yesPrice: 0.3,
      noPrice: 0.7,
      bestAsk: 0.3,
      noBestAsk: 0.7,
      quoteCapturedAt: new Date().toISOString(),
      yesAskDepthEur: 10,
      yesMinOrderSizeShares: 5,
    });
    const ranking = rankMarket(
      favoriteConfig,
      market,
      makeEstimate({
        marketId: "longshot-favorite-floor",
        estimatedYesProbability: 0.4,
        estimatedNoProbability: 0.6,
        confidence: 0.8,
      }),
    );
    // Chosen side is the cheap YES longshot; its calibrated win prob (~0.38) is under 0.6.
    assert.equal(ranking.edge.outcome, "YES");
    const assessment = assessLiveBet(favoriteConfig, harness.db, ranking);
    assert.equal(assessment.order, undefined);
    assert.ok(assessment.blockers.some((blocker) => blocker.includes("favorite floor")));
  } finally {
    harness.cleanup();
  }
});

test("live risk refuses multi-day forecast-only temperature markets", () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "multi-day-weather",
      title: "Will the highest temperature in Seoul be 28°C on July 4?",
      category: "weather",
      yesPrice: 0.43,
      noPrice: 0.57,
      bestAsk: 0.43,
      noBestAsk: 0.57,
      quoteCapturedAt: new Date().toISOString(),
      yesAskDepthEur: 10,
      yesMinOrderSizeShares: 5,
      endDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      rules: "Resolves from the official station high for the day.",
    });
    const ranking = rankMarket(
      liveConfig,
      market,
      makeEstimate({
        marketId: "multi-day-weather",
        estimatedYesProbability: 0.27,
        estimatedNoProbability: 0.73,
        confidence: 0.6,
        method: "weather-normal-forecast-model",
      }),
    );
    const assessment = assessLiveBet(liveConfig, harness.db, ranking);
    assert.equal(assessment.order, undefined);
    assert.ok(
      assessment.blockers.some((blocker) =>
        blocker.includes("temperature markets resolve on a specific station"),
      ),
    );
  } finally {
    harness.cleanup();
  }
});

test("live risk refuses single-source weather longshot buys", () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "weather-longshot",
      title: "Will the highest temperature in London be 21°C or below on July 2?",
      category: "weather",
      yesPrice: 0.05,
      noPrice: 0.95,
      bestAsk: 0.055,
      noBestAsk: 0.95,
      quoteCapturedAt: new Date().toISOString(),
      yesAskDepthEur: 10,
      yesMinOrderSizeShares: 5,
      endDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      rules: "Resolves from Wunderground London City Airport Station.",
    });
    const ranking = rankMarket(
      {
        ...liveConfig,
        liveMinPrice: 0.01,
        maxBetEur: 1.5,
        maxPerMarketEur: 1.5,
        maxLiveStakePerDayEur: 1.5,
        allowLiveMinOrderTopUp: true,
      },
      market,
      makeEstimate({
        marketId: market.marketId,
        estimatedYesProbability: 0.33,
        estimatedNoProbability: 0.67,
        confidence: 0.58,
        method: "weather-normal-forecast-model",
        independentEvidenceCount: 1,
      }),
    );
    const assessment = assessLiveBet(liveConfig, harness.db, ranking);
    assert.ok(assessment.blockers.includes("single-source weather model will not buy a less-than-even outcome"));
  } finally {
    harness.cleanup();
  }
});

test("live risk refuses extreme-price longshots outside the price band", () => {
  const harness = createTestHarness();
  try {
    const bandConfig = {
      ...liveConfig,
      liveMinPrice: 0.05,
      liveMaxPrice: 0.95,
      maxBetEur: 1.5,
      maxPerMarketEur: 1.5,
      maxLiveStakePerDayEur: 1.5,
      allowLiveMinOrderTopUp: true,
    };
    const market = makeMarket({
      marketId: "longshot-market",
      yesPrice: 0.01,
      noPrice: 0.99,
      bestBid: 0.005,
      bestAsk: 0.01,
      noBestBid: 0.985,
      noBestAsk: 0.99,
      quoteCapturedAt: new Date().toISOString(),
      yesAskDepthEur: 10,
      yesMinOrderSizeShares: 5,
      yesTickSize: "0.001",
    });
    const ranking = rankMarket(
      bandConfig,
      market,
      makeEstimate({
        marketId: "longshot-market",
        estimatedYesProbability: 0.3,
        estimatedNoProbability: 0.7,
        confidence: 0.8,
      }),
    );
    const assessment = assessLiveBet(bandConfig, harness.db, ranking);
    assert.equal(assessment.order, undefined);
    assert.ok(assessment.blockers.some((blocker) => blocker.includes("price-band") || blocker.includes("floor")));
  } finally {
    harness.cleanup();
  }
});

test("live risk refuses long-dated markets outside the live expiry window", () => {
  const harness = createTestHarness();
  try {
    const nearExpiryConfig = {
      ...liveConfig,
      liveMinHoursToEnd: 0.25,
      liveMaxHoursToEnd: 72,
      maxLiveStakePerDayEur: 1.5,
      maxBetEur: 1.5,
      maxPerMarketEur: 1.5,
      allowLiveMinOrderTopUp: true,
    };
    const market = makeMarket({
      marketId: "long-dated-market",
      yesPrice: 0.2,
      noPrice: 0.8,
      bestAsk: 0.2,
      noBestAsk: 0.8,
      quoteCapturedAt: new Date().toISOString(),
      yesAskDepthEur: 10,
      yesMinOrderSizeShares: 5,
      endDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    const ranking = rankMarket(
      nearExpiryConfig,
      market,
      makeEstimate({
        marketId: "long-dated-market",
        estimatedYesProbability: 0.6,
        estimatedNoProbability: 0.4,
        confidence: 0.9,
      }),
    );
    const assessment = assessLiveBet(nearExpiryConfig, harness.db, ranking);
    assert.equal(assessment.order, undefined);
    assert.ok(assessment.blockers.some((blocker) => blocker.includes("live expiry window")));
  } finally {
    harness.cleanup();
  }
});

test("live risk does not freeze after manual sell exits from known-bad positions", () => {
  const harness = createTestHarness();
  try {
    for (let index = 0; index < 3; index += 1) {
      harness.db.prepare(`
        INSERT INTO live_orders (
          market_id, outcome, side, token_id, price, size_eur, estimated_shares,
          decision_key, status, response_status, created_at, updated_at, closed_at, pnl_eur
        ) VALUES (?, 'YES', 'BUY', ?, 0.2, 1.0, 5.0, ?, 'CLOSED', 'closed_via_sell:matched', ?, ?, ?, -0.8)
      `).run(
        `bad-${index}`,
        `token-${index}`,
        `bad-${index}:YES:test`,
        new Date(Date.now() - (index + 1) * 60_000).toISOString(),
        new Date(Date.now() - (index + 1) * 60_000).toISOString(),
        new Date(Date.now() - (index + 1) * 60_000).toISOString(),
      );
    }

    const forgivingConfig = {
      ...liveConfig,
      maxBetEur: 2,
      maxPerMarketEur: 2,
      maxLiveTradesPerDay: 10,
      maxLiveStakePerDayEur: 10,
      allowLiveMinOrderTopUp: true,
      dailyLossLimitEur: 10,
      totalLossLimitEur: 10,
    };
    const market = makeMarket({
      marketId: "fresh-market",
      yesPrice: 0.2,
      noPrice: 0.8,
      bestAsk: 0.2,
      noBestAsk: 0.8,
      quoteCapturedAt: new Date().toISOString(),
      yesAskDepthEur: 10,
      yesMinOrderSizeShares: 5,
    });
    const ranking = rankMarket(
      forgivingConfig,
      market,
      makeEstimate({
        marketId: "fresh-market",
        estimatedYesProbability: 0.65,
        estimatedNoProbability: 0.35,
        confidence: 0.9,
      }),
    );
    const assessment = assessLiveBet(forgivingConfig, harness.db, ranking);
    assert.ok(!assessment.blockers.some((blocker) => blocker.includes("three most recent settled live bets")));
  } finally {
    harness.cleanup();
  }
});

test("directional live risk blocks an unvalidated current model", () => {
  const harness = createTestHarness();
  try {
    const config = {
      ...liveConfig,
      liveCalibrationMinSettled: 200,
      liveCalibrationMinCategorySettled: 50,
      liveCalibrationMinBrierSkill: 0.02,
      liveCalibrationZScore: 1.645,
    };
    const market = makeMarket({
      marketId: "unvalidated-model",
      category: "sports",
      bestAsk: 0.2,
      noBestAsk: 0.8,
      quoteCapturedAt: new Date().toISOString(),
      yesAskDepthEur: 10,
      yesMinOrderSizeShares: 5,
    });
    const ranking = rankMarket(
      config,
      market,
      makeEstimate({
        marketId: market.marketId,
        estimatedYesProbability: 0.8,
        estimatedNoProbability: 0.2,
        confidence: 0.9,
        independentEvidenceCount: 3,
      }),
    );
    const assessment = assessLiveBet(config, harness.db, ranking);
    assert.equal(assessment.order, undefined);
    assert.ok(assessment.blockers.some((blocker) => blocker.includes("settled out-of-sample forecasts")));
  } finally {
    harness.cleanup();
  }
});
