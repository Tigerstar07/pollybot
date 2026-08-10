import test from "node:test";
import assert from "node:assert/strict";
import { planNoArbBasket, type ArbLegQuote } from "../src/trading/arbTrader";

function makeLeg(overrides: Partial<ArbLegQuote> = {}): ArbLegQuote {
  return {
    marketId: overrides.marketId ?? `m-${Math.random().toString(36).slice(2, 8)}`,
    title: overrides.title ?? "Test outcome",
    tokenId: overrides.tokenId ?? `t-${Math.random().toString(36).slice(2, 8)}`,
    noAsk: overrides.noAsk ?? 0.5,
    noBid: overrides.noBid,
    noAskDepthShares: overrides.noAskDepthShares ?? 100,
    minOrderShares: overrides.minOrderShares ?? 5,
    tickSize: overrides.tickSize ?? "0.01",
    negRisk: overrides.negRisk ?? true,
    feeRateBps: overrides.feeRateBps,
  };
}

const limits = {
  maxLegs: 5,
  maxStakeEur: 5,
  minProfitEur: 0.05,
  minEdgeFraction: 0.02,
};

test("finds a 2-leg NO basket when asks sum below 1", () => {
  const plan = planNoArbBasket(
    [makeLeg({ noAsk: 0.45 }), makeLeg({ noAsk: 0.45 }), makeLeg({ noAsk: 0.97 })],
    limits,
  );
  assert.ok(plan);
  assert.equal(plan.legs.length, 2);
  assert.ok(Math.abs(plan.askSum - 0.9) < 1e-9);
  // 5 EUR budget at ask sum 0.9 buys 5.55 shares/leg; guaranteed payout 1 per share pair.
  assert.ok(plan.shares > 5);
  assert.ok(plan.guaranteedProfitEur > 0.5);
  assert.ok(Math.abs(plan.guaranteedPayoutEur - plan.shares) < 1e-9);
});

test("returns nothing when the book has normal overround", () => {
  const plan = planNoArbBasket(
    [makeLeg({ noAsk: 0.52 }), makeLeg({ noAsk: 0.52 }), makeLeg({ noAsk: 0.9 })],
    limits,
  );
  assert.equal(plan, undefined);
});

test("rejects legs without the negRisk exclusivity guarantee", () => {
  const plan = planNoArbBasket(
    [makeLeg({ noAsk: 0.4, negRisk: false }), makeLeg({ noAsk: 0.4 }), makeLeg({ noAsk: 0.4 })],
    limits,
  );
  assert.ok(plan);
  // Only the two negRisk legs qualify even though the non-negRisk leg is cheap.
  assert.ok(plan.legs.every((leg) => leg.negRisk));
  assert.equal(plan.legs.length, 2);
});

test("respects depth: shares capped by the thinnest leg", () => {
  const plan = planNoArbBasket(
    [makeLeg({ noAsk: 0.4, noAskDepthShares: 7 }), makeLeg({ noAsk: 0.4, noAskDepthShares: 100 })],
    limits,
  );
  assert.ok(plan);
  assert.ok(plan.shares <= 7);
});

test("refuses baskets that cannot clear the 5-share and 1-EUR-per-leg minimums", () => {
  const plan = planNoArbBasket(
    [makeLeg({ noAsk: 0.45, noAskDepthShares: 3 }), makeLeg({ noAsk: 0.45, noAskDepthShares: 3 })],
    limits,
  );
  assert.equal(plan, undefined);
});

test("prefers a wider basket when it locks more profit", () => {
  // Three legs at 0.6: payout 2, cost 1.8 -> 0.2/share set; the 2-leg prefix
  // (1.2 cost vs payout 1) would lose. Planner must pick m=3, not m=2.
  // Budget must cover 5 shares x 1.8 ask sum, hence the raised stake limit.
  const plan = planNoArbBasket(
    [makeLeg({ noAsk: 0.6 }), makeLeg({ noAsk: 0.6 }), makeLeg({ noAsk: 0.6 })],
    { ...limits, maxStakeEur: 12 },
  );
  assert.ok(plan);
  assert.equal(plan.legs.length, 3);
  assert.ok(plan.guaranteedProfitEur > 0);
});

test("enforces the minimum edge fraction", () => {
  // 0.5% locked edge is real but below the 2% configured floor.
  const plan = planNoArbBasket(
    [makeLeg({ noAsk: 0.4975 }), makeLeg({ noAsk: 0.4975 })],
    limits,
  );
  assert.equal(plan, undefined);
});

test("fee-aware arb planning rejects a raw ask discount consumed by taker fees", () => {
  const plan = planNoArbBasket(
    [
      makeLeg({ noAsk: 0.49, feeRateBps: 500 }),
      makeLeg({ noAsk: 0.49, feeRateBps: 500 }),
    ],
    limits,
  );
  assert.equal(plan, undefined);
});
