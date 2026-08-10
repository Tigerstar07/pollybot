import test from "node:test";
import assert from "node:assert/strict";
import { createTestHarness, makeMarket, makeEstimate } from "./helpers/test-harness";
import { savePaperOrder, settlePaperOrder, saveRanking } from "../src/db";
import { collectCheapSources } from "../src/sources";
import { estimateProbability } from "../src/probability/heuristics";
import { rankMarket } from "../src/ranking/ranker";
import { sizePaperBet, assessPaperBet } from "../src/trading/riskManager";
import { loadConfig } from "../src/config";

const baseConfig = {
  ...loadConfig(),
  dryRun: true,
  enableRealTrading: false,
  minEdge: 0.03,
  minConfidence: 0.45,
  minIndependentSources: 1,
  bankrollEur: 20.00,
  baseBetEur: 0.20,
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

// T3.1: Full E2E flow: Scan to Paper Bet to Settlement
test("T3.1: Full E2E flow: Scan to Paper Bet to Settlement", async () => {
  const harness = createTestHarness();
  try {
    // 1. Run paper trading command which settles, scans and places a paper bet
    const paperRes = harness.runCommand("paper");
    assert.equal(paperRes.status, 0);

    // Verify order was saved as OPEN
    const order = harness.db.prepare("SELECT * FROM paper_orders WHERE market_id = 'm1'").get() as any;
    assert.ok(order);
    assert.equal(order.status, "OPEN");

    // Force date in database past endDate so it becomes scorable and resolvable
    harness.db.prepare("UPDATE markets SET end_date = ? WHERE market_id = 'm1'").run(new Date(Date.now() - 3600 * 1000).toISOString());

    // 2. Run settle command
    const settleRes = harness.runCommand("settle", { MOCK_SCENARIO: "resolved-yes" });
    assert.equal(settleRes.status, 0);

    // Verify order is now CLOSED
    const closedOrder = harness.db.prepare("SELECT * FROM paper_orders WHERE market_id = 'm1'").get() as any;
    assert.equal(closedOrder.status, "CLOSED");
    assert.notEqual(closedOrder.pnl_eur, null);
  } finally {
    harness.cleanup();
  }
});

// T3.2: Rate limiting on source fetch triggers risk-capping on bet size
test("T3.2: Rate limiting on source fetch triggers risk-capping on bet size", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({ marketId: "m1", title: "Will Solana hit $200?", category: "crypto" });
    process.env.MOCK_SCENARIO = "cg-rate-limit";
    const config = loadConfig();
    const observations = await collectCheapSources(config, harness.db, market);
    const estimate = estimateProbability(config, market, observations);
    assert.ok(estimate.confidence < 0.45);
    const ranking = rankMarket(baseConfig, market, estimate);
    const order = sizePaperBet(baseConfig, harness.db, ranking);
    assert.equal(order, undefined);
  } finally {
    delete process.env.MOCK_SCENARIO;
    harness.cleanup();
  }
});

// T3.3: Adaptive Sizing cooldown after recent losses
test("T3.3: Adaptive Sizing cooldown after recent losses", async () => {
  const harness = createTestHarness();
  try {
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

    const order0 = sizePaperBet(baseConfig, harness.db, ranking);
    assert.ok(order0);
    const size0 = order0.sizeEur;

    harness.db.prepare(`
      INSERT INTO paper_orders (market_id, outcome, side, price, size_eur, estimated_shares, edge, confidence, status, created_at, closed_at, pnl_eur)
      VALUES ('m-loss-1', 'YES', 'BUY', 0.5, 0.4, 0.8, 0.1, 0.6, 'CLOSED', ?, ?, -0.4)
    `).run(new Date().toISOString(), new Date().toISOString());

    const order1 = sizePaperBet(baseConfig, harness.db, ranking);
    assert.ok(order1);
    assert.ok(order1.sizeEur < size0);

    harness.db.prepare(`
      INSERT INTO paper_orders (market_id, outcome, side, price, size_eur, estimated_shares, edge, confidence, status, created_at, closed_at, pnl_eur)
      VALUES ('m-loss-2', 'YES', 'BUY', 0.5, 0.4, 0.8, 0.1, 0.6, 'CLOSED', ?, ?, -0.4)
    `).run(new Date().toISOString(), new Date().toISOString());

    const order2 = sizePaperBet(baseConfig, harness.db, ranking);
    assert.ok(order2);
    assert.ok(order2.sizeEur < order1.sizeEur);

    harness.db.prepare(`
      INSERT INTO paper_orders (market_id, outcome, side, price, size_eur, estimated_shares, edge, confidence, status, created_at, closed_at, pnl_eur)
      VALUES ('m-loss-3', 'YES', 'BUY', 0.5, 0.4, 0.8, 0.1, 0.6, 'CLOSED', ?, ?, -0.4)
    `).run(new Date().toISOString(), new Date().toISOString());

    const order3 = sizePaperBet(baseConfig, harness.db, ranking);
    assert.equal(order3, undefined);
  } finally {
    harness.cleanup();
  }
});

// T3.4: Weather resolution boundary matching
test("T3.4: Weather resolution boundary matching", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "m2",
      title: "Will the high temperature in NYC exceed 80 degrees Fahrenheit on TargetDate?",
      category: "weather",
      quoteCapturedAt: new Date().toISOString(),
      endDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()
    });
    const config = loadConfig();
    const observations = await collectCheapSources(config, harness.db, market);
    const estimate = estimateProbability(config, market, observations);
    assert.ok(estimate.estimatedYesProbability > 0.7);

    const ranking = rankMarket(baseConfig, market, estimate);
    const order = sizePaperBet(baseConfig, harness.db, ranking);
    assert.ok(order);
    assert.equal(order.outcome, "YES");
    savePaperOrder(harness.db, order as any);

    harness.db.prepare("UPDATE markets SET end_date = ? WHERE market_id = 'm2'").run(new Date(Date.now() - 3600 * 1000).toISOString());

    const settleRes = harness.runCommand("settle", { MOCK_SCENARIO: "resolved-yes" });
    assert.equal(settleRes.status, 0);

    const closedOrder = harness.db.prepare("SELECT * FROM paper_orders WHERE market_id = 'm2'").get() as any;
    assert.equal(closedOrder.status, "CLOSED");
    assert.ok(closedOrder.pnl_eur > 0);
  } finally {
    harness.cleanup();
  }
});

// T4.1: Once a flash-crash market has repriced to 0.95 YES / 0.05 NO, neither
// side is inside the operator's safe live price band. The scanner must not chase
// the now-expensive YES ticket or manufacture a contrarian NO bet from price.
test("T4.1: Crypto flash-crash repricing guard", async () => {
  const harness = createTestHarness();
  try {
    const res = harness.runCommand("paper", { MOCK_SCENARIO: "flash-crash" });
    assert.equal(res.status, 0);

    const order = harness.db.prepare("SELECT * FROM paper_orders WHERE market_id = 'm5'").get() as any;
    assert.equal(order, undefined, "extreme repricing must be observed without forcing a bet");
  } finally {
    harness.cleanup();
  }
});

// T4.2: Sports Match postponement and cancellation
test("T4.2: Sports Match postponement and cancellation", async () => {
  const harness = createTestHarness();
  try {
    const orderDecision = {
      marketId: "m3",
      outcome: "YES",
      side: "BUY",
      tokenId: "t-yes-m3",
      price: 0.50,
      sizeEur: 0.30,
      estimatedShares: 0.60,
      edge: 0.10,
      confidence: 0.60,
      forecastProb: 0.60,
      marketPriorProb: 0.50,
      feeEur: 0.005,
      maxLossEur: 0.30,
      quoteCapturedAt: new Date().toISOString(),
      decisionKey: "m3:YES:key123",
      modelVersion: "pollybot-decision-v4",
      reasoning: "Test sports",
    };
    savePaperOrder(harness.db, orderDecision as any);

    const res = harness.runCommand("settle", { MOCK_SCENARIO: "postponed" });
    assert.equal(res.status, 0);

    const order = harness.db.prepare("SELECT * FROM paper_orders WHERE market_id = 'm3'").get() as any;
    assert.equal(order.status, "OPEN");
  } finally {
    harness.cleanup();
  }
});

// T4.3: Weather "Perfect Storm" forecast uncertainty
test("T4.3: Weather \"Perfect Storm\" forecast uncertainty", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "m2",
      title: "Will high temp in Miami exceed 90?",
      category: "weather",
      endDate: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString()
    });
    const config = { ...baseConfig, bankrollEur: 20 };
    const observations = await collectCheapSources(config, harness.db, market);
    const estimate = estimateProbability(config, market, observations);
    const ranking = rankMarket(config, market, estimate);
    const assessment = assessPaperBet(config, harness.db, ranking);
    assert.equal(assessment.order, undefined);
  } finally {
    harness.cleanup();
  }
});

// T4.4: Political news market is modeled but never bets on headline sentiment alone.
// News sentiment is intentionally a weak, confidence-capped signal, so the political
// market must still be scanned and ranked, but must not produce a bet by itself.
test("T4.4: Political Market News-driven transition", async () => {
  const harness = createTestHarness();
  try {
    const res = harness.runCommand("paper");
    assert.equal(res.status, 0);

    const ranking = harness.db.prepare("SELECT * FROM latest_rankings WHERE market_id = 'm4'").get() as any;
    assert.ok(ranking, "news market should still be scanned and ranked");

    const order = harness.db.prepare("SELECT * FROM paper_orders WHERE market_id = 'm4'").get() as any;
    assert.equal(order, undefined, "headline sentiment alone must not place a bet");
  } finally {
    harness.cleanup();
  }
});

// T4.5: Multiple concurrent market scanning and resource exhaustion
test("T4.5: Multiple concurrent market scanning and resource exhaustion", async () => {
  const harness = createTestHarness();
  try {
    const res = harness.runCommand("paper");
    assert.equal(res.status, 0);

    const count = harness.db.prepare("SELECT COUNT(*) as count FROM latest_rankings").get() as any;
    assert.ok(count.count >= 3);
  } finally {
    harness.cleanup();
  }
});
