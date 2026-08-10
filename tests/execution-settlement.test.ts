import test from "node:test";
import assert from "node:assert/strict";
import { createTestHarness, makeMarket, makeEstimate } from "./helpers/test-harness";
import { savePaperOrder, settlePaperOrder, saveRanking, upsertMarket } from "../src/db";
import { rankMarket } from "../src/ranking/ranker";
import { loadConfig } from "../src/config";

const baseConfig = {
  ...loadConfig(),
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
};

// T1.4.1: Paper order creation and database recording
test("T1.4.1: Paper order creation and database recording", async () => {
  const harness = createTestHarness();
  try {
    const orderDecision = {
      marketId: "m1",
      outcome: "YES",
      side: "BUY",
      tokenId: "t-yes-m1",
      price: 0.40,
      sizeEur: 0.30,
      estimatedShares: 0.75,
      edge: 0.10,
      confidence: 0.60,
      forecastProb: 0.55,
      marketPriorProb: 0.40,
      feeEur: 0.005,
      maxLossEur: 0.30,
      quoteCapturedAt: new Date().toISOString(),
      decisionKey: "m1:YES:key123",
      modelVersion: "pollybot-decision-v4",
      reasoning: "Test reason",
    };
    const orderId = savePaperOrder(harness.db, orderDecision as any);
    assert.ok(orderId > 0);
    const row = harness.db.prepare("SELECT * FROM paper_orders WHERE id = ?").get(orderId) as any;
    assert.ok(row);
    assert.equal(row.status, "OPEN");
    assert.equal(row.market_id, "m1");
    assert.equal(row.outcome, "YES");
    assert.equal(row.price, 0.40);
    assert.equal(row.size_eur, 0.30);
    assert.equal(row.estimated_shares, 0.75);
  } finally {
    harness.cleanup();
  }
});

// T1.4.2: Settle paper orders on market resolution
test("T1.4.2: Settle paper orders on market resolution", async () => {
  const harness = createTestHarness();
  try {
    const orderDecision = {
      marketId: "m1",
      outcome: "YES",
      side: "BUY",
      tokenId: "t-yes-m1",
      price: 0.60,
      sizeEur: 0.30,
      estimatedShares: 0.50,
      edge: 0.10,
      confidence: 0.60,
      forecastProb: 0.70,
      marketPriorProb: 0.60,
      feeEur: 0.005,
      maxLossEur: 0.30,
      quoteCapturedAt: new Date().toISOString(),
      decisionKey: "m1:YES:key123",
      modelVersion: "pollybot-decision-v4",
      reasoning: "Test reason",
    };
    savePaperOrder(harness.db, orderDecision as any);

    const res = harness.runCommand("settle", { MOCK_SCENARIO: "resolved-yes" });
    assert.equal(res.status, 0);

    const row = harness.db.prepare("SELECT * FROM paper_orders WHERE market_id = 'm1'").get() as any;
    assert.equal(row.status, "CLOSED");
    assert.equal(row.pnl_eur, 0.20);
    const setRow = harness.db.prepare("SELECT * FROM settlements WHERE market_id = 'm1'").get() as any;
    assert.ok(setRow);
    assert.equal(setRow.pnl_eur, 0.20);
  } finally {
    harness.cleanup();
  }
});

// T1.4.3: Scoring shadow forecasts
test("T1.4.3: Scoring shadow forecasts", async () => {
  const harness = createTestHarness();
  try {
    const market = makeMarket({
      marketId: "m1",
      yesPrice: 0.60,
      status: "open",
      endDate: new Date(Date.now() + 10 * 86_400_000).toISOString()
    });
    upsertMarket(harness.db, market);
    const ranking = rankMarket(
      baseConfig,
      market,
      makeEstimate({ estimatedYesProbability: 0.80, confidence: 0.70, independentEvidenceCount: 1, dataQuality: 0.8 })
    );
    saveRanking(harness.db, ranking, "batch-1");

    harness.db.prepare("UPDATE markets SET end_date = ? WHERE market_id = 'm1'").run(new Date(Date.now() - 3600 * 1000).toISOString());

    const res = harness.runCommand("settle", { MOCK_SCENARIO: "resolved-yes" });
    assert.equal(res.status, 0);

    const forecast = harness.db.prepare("SELECT * FROM forecast_records WHERE market_id = 'm1'").get() as any;
    assert.ok(forecast.resolved_at);
    assert.equal(forecast.outcome_yes, 1);
    assert.ok(Math.abs(forecast.bot_brier - 0.0676) < 0.0001);
    assert.ok(Math.abs(forecast.market_brier - 0.16) < 0.0001);
  } finally {
    harness.cleanup();
  }
});

// T1.4.4: Calibration report computation
test("T1.4.4: Calibration report computation", async () => {
  const harness = createTestHarness();
  try {
    harness.db.prepare(`
      INSERT INTO paper_orders (market_id, outcome, side, price, size_eur, estimated_shares, edge, confidence, status, created_at, closed_at, pnl_eur)
      VALUES
        ('m-win', 'YES', 'BUY', 0.60, 0.30, 0.50, 0.10, 0.60, 'CLOSED', ?, ?, 0.20),
        ('m-loss', 'YES', 'BUY', 0.60, 0.30, 0.50, 0.10, 0.60, 'CLOSED', ?, ?, -0.30)
    `).run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), new Date().toISOString());

    const res = harness.runCommand("report");
    assert.equal(res.status, 0);
    assert.ok(res.stdout.includes("PnL"));
    assert.ok(res.stdout.includes("-0.10"));
  } finally {
    harness.cleanup();
  }
});

// T1.4.5: Fail-closed settlement behavior
test("T1.4.5: Fail-closed settlement behavior", async () => {
  const harness = createTestHarness();
  try {
    const orderDecision = {
      marketId: "m1",
      outcome: "YES",
      side: "BUY",
      tokenId: "t-yes-m1",
      price: 0.60,
      sizeEur: 0.30,
      estimatedShares: 0.50,
      edge: 0.10,
      confidence: 0.60,
      forecastProb: 0.70,
      marketPriorProb: 0.60,
      feeEur: 0.005,
      maxLossEur: 0.30,
      quoteCapturedAt: new Date().toISOString(),
      decisionKey: "m1:YES:key123",
      modelVersion: "pollybot-decision-v4",
      reasoning: "Test reason",
    };
    savePaperOrder(harness.db, orderDecision as any);

    const res = harness.runCommand("settle", { MOCK_SCENARIO: "disputed" });
    assert.equal(res.status, 0);

    const row = harness.db.prepare("SELECT * FROM paper_orders WHERE market_id = 'm1'").get() as any;
    assert.equal(row.status, "OPEN");
    assert.equal(row.pnl_eur, null);
  } finally {
    harness.cleanup();
  }
});

// T2.4.1: Database constraint validation for duplicate paper orders
test("T2.4.1: Database constraint validation for duplicate paper orders", async () => {
  const harness = createTestHarness();
  try {
    const orderDecision = {
      marketId: "m1",
      outcome: "YES",
      side: "BUY",
      tokenId: "t-yes-m1",
      price: 0.40,
      sizeEur: 0.30,
      estimatedShares: 0.75,
      edge: 0.10,
      confidence: 0.60,
      forecastProb: 0.55,
      marketPriorProb: 0.40,
      feeEur: 0.005,
      maxLossEur: 0.30,
      quoteCapturedAt: new Date().toISOString(),
      decisionKey: "duplicate-key",
      modelVersion: "pollybot-decision-v4",
      reasoning: "Test reason",
    };
    savePaperOrder(harness.db, orderDecision as any);
    assert.throws(() => {
      savePaperOrder(harness.db, orderDecision as any);
    }, /UNIQUE constraint failed/);
  } finally {
    harness.cleanup();
  }
});

// T2.4.2: Settlement idempotency check
test("T2.4.2: Settlement idempotency check", async () => {
  const harness = createTestHarness();
  try {
    const orderDecision = {
      marketId: "m1",
      outcome: "YES",
      side: "BUY",
      tokenId: "t-yes-m1",
      price: 0.60,
      sizeEur: 0.30,
      estimatedShares: 0.50,
      edge: 0.10,
      confidence: 0.60,
      forecastProb: 0.70,
      marketPriorProb: 0.60,
      feeEur: 0.005,
      maxLossEur: 0.30,
      quoteCapturedAt: new Date().toISOString(),
      decisionKey: "m1:YES:key123",
      modelVersion: "pollybot-decision-v4",
      reasoning: "Test reason",
    };
    const orderId = savePaperOrder(harness.db, orderDecision as any);

    const settlementPayload = {
      orderId,
      marketId: "m1",
      outcome: "YES",
      winningOutcome: "Yes",
      source: "Gamma",
      stakeEur: 0.30,
      payoutHour: 0.50,
      payoutEur: 0.50,
      pnlEur: 0.20,
    };

    const first = settlePaperOrder(harness.db, settlementPayload as any);
    assert.equal(first, true);

    const second = settlePaperOrder(harness.db, settlementPayload as any);
    assert.equal(second, false);
  } finally {
    harness.cleanup();
  }
});

// T2.4.3: Resolution of an inactive/missing market
test("T2.4.3: Resolution of an inactive/missing market", async () => {
  const harness = createTestHarness();
  try {
    const orderDecision = {
      marketId: "missing",
      outcome: "YES",
      side: "BUY",
      tokenId: "t-yes-missing",
      price: 0.60,
      sizeEur: 0.30,
      estimatedShares: 0.50,
      edge: 0.10,
      confidence: 0.60,
      forecastProb: 0.70,
      marketPriorProb: 0.60,
      feeEur: 0.005,
      maxLossEur: 0.30,
      quoteCapturedAt: new Date().toISOString(),
      decisionKey: "missing:YES:key123",
      modelVersion: "pollybot-decision-v4",
      reasoning: "Test reason",
    };
    savePaperOrder(harness.db, orderDecision as any);

    const res = harness.runCommand("settle", { MOCK_SCENARIO: "market-not-found" });
    assert.equal(res.status, 0);

    const row = harness.db.prepare("SELECT * FROM paper_orders WHERE market_id = 'missing'").get() as any;
    assert.equal(row.status, "OPEN");
    const errCount = harness.db.prepare("SELECT COUNT(*) as count FROM errors").get() as any;
    assert.ok(errCount.count >= 1);
  } finally {
    harness.cleanup();
  }
});

// T2.4.4: Brier score calculation on zero resolved markets
test("T2.4.4: Brier score calculation on zero resolved markets", async () => {
  const harness = createTestHarness();
  try {
    const res = harness.runCommand("report");
    assert.equal(res.status, 0);
    assert.ok(res.stdout.includes("calibration"));
  } finally {
    harness.cleanup();
  }
});

// T2.4.5: Negative price resolution check
test("T2.4.5: Negative price resolution check", async () => {
  const harness = createTestHarness();
  try {
    const orderDecision = {
      marketId: "m1",
      outcome: "YES",
      side: "BUY",
      tokenId: "t-yes-m1",
      price: 0.60,
      sizeEur: 0.30,
      estimatedShares: 0.50,
      edge: 0.10,
      confidence: 0.60,
      forecastProb: 0.70,
      marketPriorProb: 0.60,
      feeEur: 0.005,
      maxLossEur: 0.30,
      quoteCapturedAt: new Date().toISOString(),
      decisionKey: "m1:YES:key123",
      modelVersion: "pollybot-decision-v4",
      reasoning: "Test reason",
    };
    savePaperOrder(harness.db, orderDecision as any);

    const res = harness.runCommand("settle", { MOCK_SCENARIO: "negative-price" });
    assert.equal(res.status, 0);

    const row = harness.db.prepare("SELECT * FROM paper_orders WHERE market_id = 'm1'").get() as any;
    assert.equal(row.status, "OPEN");
  } finally {
    harness.cleanup();
  }
});
