import test from "node:test";
import assert from "node:assert/strict";
import { FORECAST_MODEL_VERSION, getLiveCalibrationStats } from "../src/db";
import { createTestHarness } from "./helpers/test-harness";

test("live calibration counts one time-gated forecast per resolved market", () => {
  const harness = createTestHarness();
  try {
    const insert = harness.db.prepare(`
      INSERT INTO forecast_records (
        market_id, scan_batch_id, category, action, method, model_version,
        raw_yes_probability, forecast_yes_probability, market_yes_probability,
        confidence, data_quality, independent_evidence_count, scorable,
        outcome_yes, bot_brier, market_brier, created_at, resolved_at
      ) VALUES (?, ?, 'sports', 'PAPER_BET', 'sports-devigged', ?, 0.8, 0.8, 0.6,
                0.9, 0.9, 3, 1, 1, ?, ?, ?, ?)
    `);
    for (let index = 0; index < 60; index += 1) {
      const firstAt = new Date(1_700_000_000_000 + index * 1000).toISOString();
      insert.run(`market-${index}`, `batch-${index}-a`, FORECAST_MODEL_VERSION, 0.04, 0.16, firstAt, firstAt);
      // A repeated later scan must not increase sample size or overwrite the time-gated score.
      const laterAt = new Date(Date.parse(firstAt) + 500).toISOString();
      insert.run(`market-${index}`, `batch-${index}-b`, FORECAST_MODEL_VERSION, 0.81, 0.01, laterAt, laterAt);
    }
    const stats = getLiveCalibrationStats(harness.db, "sports", 1.645);
    assert.equal(stats.settledCount, 60);
    assert.ok((stats.brierSkill ?? 0) > 0.7);
    assert.ok((stats.lowerConfidenceImprovement ?? 0) > 0);
  } finally {
    harness.cleanup();
  }
});
