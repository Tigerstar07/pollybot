import test from "node:test";
import assert from "node:assert/strict";
import { finalizeLatestRankingsBatch, saveRanking } from "../src/db";
import type { MarketAction, RankingResult } from "../src/types";
import { createTestHarness, makeEstimate, makeMarket } from "./helpers/test-harness";

function makeRanking(marketId: string, action: MarketAction): RankingResult {
  const market = makeMarket({ marketId });
  return {
    market,
    estimate: makeEstimate({ marketId, independentEvidenceCount: 0, shouldSkip: action === "SKIP" }),
    edge: {
      outcome: "YES",
      tokenId: market.yesTokenId,
      marketAskPrice: market.bestAsk ?? 0.5,
      rawProbability: 0.75,
      marketPriorProbability: 0.5,
      calibratedProbability: 0.65,
      expectedValue: 0.15,
      spreadCost: 0.01,
      feeCost: 0,
      slippageCost: 0,
      uncertaintyCost: 0.03,
      confidenceAdjustedEdge: 0.11,
      minimumRequiredEdge: 0.03,
    },
    liquidityScore: 80,
    clarityScore: 80,
    dataAvailabilityScore: 80,
    timeHorizonScore: 80,
    edgePotentialScore: 80,
    riskScore: 20,
    finalScore: 70,
    skipReasons: action === "SKIP" ? ["fixture blocker"] : [],
    action,
    reason: action === "SKIP" ? "fixture blocker" : "fixture candidate",
  };
}

test("latest ranking cache prunes stale batches while historical rows keep only bet decisions", () => {
  const harness = createTestHarness();
  try {
    saveRanking(harness.db, makeRanking("old-skip", "SKIP"), "old-batch");
    saveRanking(harness.db, makeRanking("current-skip", "SKIP"), "current-batch");
    saveRanking(harness.db, makeRanking("current-bet", "PAPER_BET"), "current-batch");

    const removed = finalizeLatestRankingsBatch(harness.db, "current-batch");
    assert.equal(removed, 1);
    assert.deepEqual(
      harness.db.prepare("SELECT market_id FROM latest_rankings ORDER BY market_id").all(),
      [{ market_id: "current-bet" }, { market_id: "current-skip" }],
    );
    assert.deepEqual(
      harness.db.prepare("SELECT market_id FROM rankings ORDER BY market_id").all(),
      [{ market_id: "current-bet" }],
    );
  } finally {
    harness.cleanup();
  }
});
