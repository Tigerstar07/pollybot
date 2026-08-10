import test from "node:test";
import assert from "node:assert/strict";
import { createTestHarness, makeMarket, makeEstimate } from "./helpers/test-harness";
import { assessPaperBet, sizePaperBet } from "../src/trading/riskManager";
import { rankMarket } from "../src/ranking/ranker";
import { loadConfig } from "../src/config";

const baseConfig = {
  ...loadConfig(),
  minEdge: 0.03,
  minConfidence: 0.45,
  minIndependentSources: 1,
  bankrollEur: 20.00,
  baseBetEur: 0.20,
  kellyFraction: 0.20,
  maxBetEur: 0.50,
  maxPerMarketEur: 1.00,
  maxOpenExposureEur: 5.00,
  dailyLossLimitEur: 2.00,
  totalLossLimitEur: 5.00,
  maxQuoteAgeSeconds: 30,
  paperOrderCooldownMinutes: 60,
  minLiquidity: 100,
  maxSpread: 0.15,
  minHoursToEnd: 2,
  maxDaysToEnd: 365,
  liveMinHoursToEnd: 2,
  liveMaxHoursToEnd: 365 * 24,
  liveMinStakeEur: 0.05,
};

// T1.3.1: Kelly betting sizing formula calculation
test("T1.3.1: Kelly betting sizing formula calculation", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      yesPrice: 0.495,
      noPrice: 0.505,
      bestAsk: 0.50,
      noBestAsk: 0.51,
      quoteCapturedAt: new Date().toISOString(),
      yesAskDepthEur: 10.0,
    });
    const ranking = rankMarket(
      baseConfig,
      market,
      makeEstimate({ estimatedYesProbability: 0.65, confidence: 0.45 })
    );
    const order = sizePaperBet(baseConfig, harness.db, ranking);
    assert.ok(order);
    // 20% fractional Kelly (was 5%, which pinned nearly every live stake below the
    // exchange minimum); the same inputs now size to 0.31 instead of 0.10.
    assert.equal(order.sizeEur, 0.31);
  } finally {
    harness.cleanup();
  }
});

// T1.3.2: Max exposure limits per market and total open
test("T1.3.2: Max exposure limits per market and total open", async () => {
  const harness = createTestHarness();
  try {
    harness.db.prepare(`
      INSERT INTO paper_orders (market_id, outcome, side, price, size_eur, estimated_shares, edge, confidence, status, created_at)
      VALUES ('m1', 'YES', 'BUY', 0.5, 0.80, 1.6, 0.1, 0.6, 'OPEN', ?)
    `).run(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());

    const market = makeMarket({
      marketId: "m1",
      yesPrice: 0.4,
      noPrice: 0.6,
      bestAsk: 0.4,
      noBestAsk: 0.6,
      quoteCapturedAt: new Date().toISOString(),
      yesAskDepthEur: 10,
    });
    const ranking = rankMarket(
      baseConfig,
      market,
      makeEstimate({ estimatedYesProbability: 0.7, confidence: 0.6 })
    );
    const order = sizePaperBet(baseConfig, harness.db, ranking);
    assert.ok(order);
    assert.equal(order.sizeEur, 0.20);
  } finally {
    harness.cleanup();
  }
});

// T1.3.3: Same-side trade cooldown
test("T1.3.3: Same-side trade cooldown", async () => {
  const harness = createTestHarness();
  try {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    harness.db.prepare(`
      INSERT INTO paper_orders (market_id, outcome, side, price, size_eur, estimated_shares, edge, confidence, status, created_at)
      VALUES ('m1', 'YES', 'BUY', 0.5, 0.2, 0.4, 0.1, 0.6, 'OPEN', ?)
    `).run(tenMinutesAgo);

    const market = makeMarket({
      marketId: "m1",
      yesPrice: 0.4,
      noPrice: 0.6,
      bestAsk: 0.4,
      noBestAsk: 0.6,
      quoteCapturedAt: new Date().toISOString(),
      yesAskDepthEur: 10,
    });
    const ranking = rankMarket(
      baseConfig,
      market,
      makeEstimate({ estimatedYesProbability: 0.7, confidence: 0.6 })
    );
    const assessment = assessPaperBet(baseConfig, harness.db, ranking);
    assert.equal(assessment.order, undefined);
    assert.ok(assessment.blockers.some(b => b.includes("cooldown")));
  } finally {
    harness.cleanup();
  }
});

// T1.3.4: Adaptive sizing based on historical losses
test("T1.3.4: Adaptive sizing based on historical losses", async () => {
  const harness = createTestHarness();
  try {
    harness.db.prepare(`
      INSERT INTO paper_orders (market_id, outcome, side, price, size_eur, estimated_shares, edge, confidence, status, created_at, closed_at, pnl_eur)
      VALUES ('m-other', 'YES', 'BUY', 0.5, 0.4, 0.8, 0.1, 0.6, 'CLOSED', ?, ?, -0.4)
    `).run(new Date().toISOString(), new Date().toISOString());

    const market = makeMarket({
      marketId: "m1",
      yesPrice: 0.4,
      noPrice: 0.6,
      bestAsk: 0.4,
      noBestAsk: 0.6,
      quoteCapturedAt: new Date().toISOString(),
      yesAskDepthEur: 10,
    });
    const ranking = rankMarket(
      baseConfig,
      market,
      makeEstimate({ estimatedYesProbability: 0.7, confidence: 0.6 })
    );
    const order = sizePaperBet(baseConfig, harness.db, ranking);
    assert.ok(order);
    // At 20% fractional Kelly the maxBet cap (0.50) binds; one recent loss scales it to 75% => 0.38
    assert.equal(order.sizeEur, 0.38);
  } finally {
    harness.cleanup();
  }
});

// T1.3.5: Loss limit halt (Daily & Total)
test("T1.3.5: Loss limit halt (Daily & Total)", async () => {
  const harness = createTestHarness();
  try {
    harness.db.prepare(`
      INSERT INTO paper_orders (market_id, outcome, side, price, size_eur, estimated_shares, edge, confidence, status, created_at, closed_at, pnl_eur)
      VALUES ('m-loss', 'YES', 'BUY', 0.5, 2.05, 4.1, 0.1, 0.6, 'CLOSED', ?, ?, -2.05)
    `).run(new Date().toISOString(), new Date().toISOString());

    const market = makeMarket({
      marketId: "m1",
      yesPrice: 0.4,
      noPrice: 0.6,
      bestAsk: 0.4,
      noBestAsk: 0.6,
      quoteCapturedAt: new Date().toISOString(),
      yesAskDepthEur: 10,
    });
    const ranking = rankMarket(
      baseConfig,
      market,
      makeEstimate({ estimatedYesProbability: 0.7, confidence: 0.6 })
    );
    const assessment = assessPaperBet(baseConfig, harness.db, ranking);
    assert.equal(assessment.order, undefined);
    assert.ok(assessment.blockers.some(b => b.includes("loss limit reached")));
  } finally {
    harness.cleanup();
  }
});

// T2.3.1: Stale quote blocking
test("T2.3.1: Stale quote blocking", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "m1",
      yesPrice: 0.4,
      noPrice: 0.6,
      bestAsk: 0.4,
      noBestAsk: 0.6,
      quoteCapturedAt: new Date(Date.now() - 35 * 1000).toISOString(),
      yesAskDepthEur: 10,
    });
    const ranking = rankMarket(
      baseConfig,
      market,
      makeEstimate({ estimatedYesProbability: 0.7, confidence: 0.6 })
    );
    const assessment = assessPaperBet(baseConfig, harness.db, ranking);
    assert.equal(assessment.order, undefined);
    assert.ok(assessment.blockers.some(b => b.includes("quote is older than")));
  } finally {
    harness.cleanup();
  }
});

// T2.3.2: Insufficient liquidity blocking
test("T2.3.2: Insufficient liquidity blocking", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "m1",
      yesPrice: 0.4,
      noPrice: 0.6,
      bestAsk: 0.4,
      noBestAsk: 0.6,
      quoteCapturedAt: new Date().toISOString(),
      yesAskDepthEur: 0.04,
    });
    const ranking = rankMarket(
      baseConfig,
      market,
      makeEstimate({ estimatedYesProbability: 0.7, confidence: 0.6 })
    );
    const assessment = assessPaperBet(baseConfig, harness.db, ranking);
    assert.equal(assessment.order, undefined);
    assert.ok(assessment.blockers.some(b => b.includes("below the EUR 0.05 paper minimum")));
  } finally {
    harness.cleanup();
  }
});

// T2.3.3: High-slippage/wide-spread conservative sizing
test("T2.3.3: High-slippage/wide-spread conservative sizing", async () => {
  const harness = createTestHarness();
  try {
    // Raise the flat ceilings so cost-sensitive sizing (Kelly / edge scaling) binds
    // instead of the caps, keeping the wide-vs-narrow comparison meaningful.
    const config = { ...baseConfig, maxBetEur: 5.0, maxPerMarketEur: 5.0 };
    const wideMarket = makeMarket({
      marketId: "m1",
      yesPrice: 0.50,
      noPrice: 0.50,
      bestBid: 0.40,
      bestAsk: 0.55, // spread 0.15
      spread: 0.15,
      quoteCapturedAt: new Date().toISOString(),
      yesAskDepthEur: 10,
    });
    const narrowMarket = makeMarket({
      marketId: "m2",
      yesPrice: 0.50,
      noPrice: 0.50,
      bestBid: 0.49,
      bestAsk: 0.50,
      spread: 0.01,
      quoteCapturedAt: new Date().toISOString(),
      yesAskDepthEur: 10,
    });
    const estimate = makeEstimate({ estimatedYesProbability: 0.85, confidence: 0.6 });
    const wideOrder = sizePaperBet(config, harness.db, rankMarket(config, wideMarket, estimate));
    const narrowOrder = sizePaperBet(
      config,
      harness.db,
      rankMarket(config, { ...narrowMarket, marketId: "m2" }, { ...estimate, marketId: "m2" }),
    );
    assert.ok(wideOrder);
    assert.ok(narrowOrder);
    assert.ok(wideOrder.sizeEur < narrowOrder.sizeEur);
  } finally {
    harness.cleanup();
  }
});

// T2.3.4: Three trailing losses automatic veto
test("T2.3.4: Three trailing losses automatic veto", async () => {
  const harness = createTestHarness();
  try {
    for (let i = 0; i < 3; i++) {
      harness.db.prepare(`
        INSERT INTO paper_orders (market_id, outcome, side, price, size_eur, estimated_shares, edge, confidence, status, created_at, closed_at, pnl_eur)
        VALUES (?, 'YES', 'BUY', 0.5, 0.2, 0.4, 0.1, 0.6, 'CLOSED', ?, ?, -0.2)
      `).run(`m-loss-${i}`, new Date().toISOString(), new Date().toISOString());
    }

    const market = makeMarket({
      marketId: "m1",
      yesPrice: 0.4,
      noPrice: 0.6,
      bestAsk: 0.4,
      noBestAsk: 0.6,
      quoteCapturedAt: new Date().toISOString(),
      yesAskDepthEur: 10,
    });
    const ranking = rankMarket(
      baseConfig,
      market,
      makeEstimate({ estimatedYesProbability: 0.7, confidence: 0.6 })
    );
    const assessment = assessPaperBet(baseConfig, harness.db, ranking);
    assert.equal(assessment.order, undefined);
    assert.ok(assessment.blockers.some(b => b.includes("three most recent settled paper bets were losses")));
  } finally {
    harness.cleanup();
  }
});

// T2.3.5: Absolute boundary of daily loss limit
test("T2.3.5: Absolute boundary of daily loss limit", async () => {
  const harness = createTestHarness();
  try {
    harness.db.prepare(`
      INSERT INTO paper_orders (market_id, outcome, side, price, size_eur, estimated_shares, edge, confidence, status, created_at, closed_at, pnl_eur)
      VALUES ('m-loss', 'YES', 'BUY', 0.5, 1.99, 3.98, 0.1, 0.6, 'CLOSED', ?, ?, -1.99)
    `).run(new Date().toISOString(), new Date().toISOString());

    const market = makeMarket({
      marketId: "m1",
      yesPrice: 0.4,
      noPrice: 0.6,
      bestAsk: 0.4,
      noBestAsk: 0.6,
      quoteCapturedAt: new Date().toISOString(),
      yesAskDepthEur: 10,
    });
    const ranking = rankMarket(
      baseConfig,
      market,
      makeEstimate({ estimatedYesProbability: 0.7, confidence: 0.6 })
    );
    const assessment = assessPaperBet(baseConfig, harness.db, ranking);
    assert.ok(assessment.order);
  } finally {
    harness.cleanup();
  }
});
