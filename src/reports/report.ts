import type { AppConfig } from "../config";
import type { Db } from "../db";
import { getForecastCounts, getLiveCalibrationStats, getSettledBets, getSettledForecasts } from "../db";
import { computeCalibration, computeForecastCalibration } from "./calibration";

export function runReport(config: AppConfig, db: Db): void {
  const exposure = db.prepare("SELECT COALESCE(SUM(size_eur), 0) AS value FROM paper_orders WHERE status = 'OPEN'").get() as { value: number };
  const liveExposure = db.prepare("SELECT COALESCE(SUM(size_eur), 0) AS value FROM live_orders WHERE status IN ('PENDING', 'OPEN')").get() as { value: number };
  const liveOrders = db.prepare("SELECT COUNT(*) AS count FROM live_orders").get() as { count: number };
  const liveClosed = db.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(size_eur), 0) AS stake,
           COALESCE(SUM(pnl_eur), 0) AS pnl,
           COALESCE(SUM(CASE WHEN pnl_eur > 0 THEN 1 ELSE 0 END), 0) AS wins
    FROM live_orders
    WHERE status = 'CLOSED' AND pnl_eur IS NOT NULL
  `).get() as { count: number; stake: number; pnl: number; wins: number };
  const liveFailed = db.prepare("SELECT COUNT(*) AS count FROM live_orders WHERE status = 'FAILED'").get() as { count: number };
  const closed = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(pnl_eur), 0) AS pnl FROM paper_orders WHERE status = 'CLOSED'").get() as {
    count: number;
    pnl: number;
  };
  const wins = db.prepare("SELECT COUNT(*) AS count FROM paper_orders WHERE status = 'CLOSED' AND pnl_eur > 0").get() as { count: number };
  const avgEdge = db
    .prepare("SELECT AVG(edge) AS value FROM paper_orders WHERE status <> 'VOID'")
    .get() as { value?: number };
  const openOrders = db.prepare("SELECT COUNT(*) AS count FROM paper_orders WHERE status = 'OPEN'").get() as { count: number };
  const top = db
    .prepare(
      `WITH latest_batch AS (
         SELECT scan_batch_id
         FROM latest_rankings
         WHERE scan_batch_id IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 1
       )
       SELECT m.question, m.category, r.final_score, r.action, r.reason
       FROM latest_rankings r
       JOIN latest_batch b ON b.scan_batch_id = r.scan_batch_id
       JOIN markets m ON m.market_id = r.market_id
       WHERE m.status = 'open'
         AND m.end_date IS NOT NULL
         AND datetime(m.end_date) > datetime('now')
       ORDER BY
         CASE r.action
           WHEN 'LIVE_BET' THEN 0
           WHEN 'PAPER_BET' THEN 0
           WHEN 'WATCH' THEN 1
           ELSE 2
         END,
         r.final_score DESC,
         r.created_at DESC
       LIMIT 10`,
    )
    .all() as Array<{ question: string; category: string; final_score: number; action: string; reason: string }>;
  const skipped = db
    .prepare(
      `WITH latest_batch AS (
         SELECT scan_batch_id
         FROM latest_rankings
         WHERE scan_batch_id IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 1
       )
       SELECT r.reason, COUNT(*) AS count
       FROM latest_rankings r
       JOIN latest_batch b ON b.scan_batch_id = r.scan_batch_id
       WHERE r.action = 'SKIP'
       GROUP BY r.reason
       ORDER BY count DESC
       LIMIT 10`,
    )
    .all() as Array<{ reason: string; count: number }>;

  const roi = config.bankrollEur > 0 ? (closed.pnl + liveClosed.pnl) / config.bankrollEur : 0;
  const winRate = closed.count > 0 ? wins.count / closed.count : 0;

  console.log("Pollybot report");
  console.log("");
  console.log(`bankroll: EUR ${config.bankrollEur.toFixed(2)}`);
  console.log(`open exposure: EUR ${Number(exposure.value ?? 0).toFixed(2)}`);
  console.log(`live exposure: EUR ${Number(liveExposure.value ?? 0).toFixed(2)}`);
  console.log(`recorded live orders: ${Number(liveOrders.count ?? 0)}`);
  console.log(
    `closed live bets: ${liveClosed.count}; PnL EUR ${Number(liveClosed.pnl).toFixed(2)} on EUR ${Number(liveClosed.stake).toFixed(2)} staked ` +
      `(${liveClosed.stake > 0 ? ((liveClosed.pnl / liveClosed.stake) * 100).toFixed(1) : "0.0"}% return; ${liveClosed.wins} profitable exits)`,
  );
  console.log(`failed live submissions: ${liveFailed.count}`);
  console.log(`open paper bets: ${openOrders.count}`);
  console.log(`closed bets: ${closed.count}`);
  console.log(`win rate: ${(winRate * 100).toFixed(1)}%`);
  console.log(`realized PnL / configured bankroll: ${(roi * 100).toFixed(1)}%`);
  console.log(`average recorded edge: ${avgEdge.value === undefined || avgEdge.value === null ? "-" : Number(avgEdge.value).toFixed(3)}`);
  console.log("");
  console.log("Current top markets:");
  for (const [index, row] of top.entries()) {
    console.log(`${index + 1}. ${row.question}`);
    console.log(`   ${row.category} | score ${row.final_score.toFixed(1)} | ${row.action} | ${row.reason}`);
  }
  console.log("");
  printCalibration(db);
  printForecastCalibration(db);
  printLiveCalibrationGate(config, db);

  console.log("");
  console.log("Common skip reasons:");
  for (const row of skipped) console.log(`  ${row.count}x ${row.reason}`);
}

function printLiveCalibrationGate(config: AppConfig, db: Db): void {
  const stats = getLiveCalibrationStats(db, undefined, config.liveCalibrationZScore);
  const enough = stats.settledCount >= config.liveCalibrationMinSettled;
  const skill = stats.brierSkill ?? Number.NEGATIVE_INFINITY;
  const positiveBound = (stats.lowerConfidenceImprovement ?? Number.NEGATIVE_INFINITY) > 0;
  const ready = enough && skill >= config.liveCalibrationMinBrierSkill && positiveBound;
  console.log("");
  console.log("Directional live calibration gate:");
  console.log(`  status: ${ready ? "globally ready (category gate still applies)" : "BLOCKED"}`);
  console.log(`  settled markets: ${stats.settledCount}/${config.liveCalibrationMinSettled}`);
  console.log(
    `  Brier skill: ${stats.brierSkill === undefined ? "-" : `${(stats.brierSkill * 100).toFixed(1)}%`} ` +
      `(minimum ${(config.liveCalibrationMinBrierSkill * 100).toFixed(1)}%)`,
  );
  console.log(
    `  one-sided confidence bound on Brier improvement: ${
      stats.lowerConfidenceImprovement === undefined ? "-" : stats.lowerConfidenceImprovement.toFixed(5)
    } (must be > 0)`,
  );
}

function printForecastCalibration(db: Db): void {
  const counts = getForecastCounts(db);
  const calibration = computeForecastCalibration(getSettledForecasts(db));
  console.log("");
  console.log("Evidence-backed shadow forecasts:");
  console.log(
    `  recorded: ${counts.scorable} scorable (${counts.pending} pending, ${counts.settled} settled)`,
  );
  if (calibration.settledCount === 0) {
    console.log("  No resolved shadow forecasts yet.");
    return;
  }
  console.log(`  bot Brier score:  ${calibration.brierScore?.toFixed(4) ?? "-"}`);
  console.log(
    `  market benchmark: ${calibration.marketBrierScore?.toFixed(4) ?? "-"}`,
  );
  console.log(
    `  Brier skill:      ${
      calibration.brierSkillScore === undefined
        ? "-"
        : `${(calibration.brierSkillScore * 100).toFixed(1)}%`
    }`,
  );
  for (const category of calibration.categories) {
    console.log(
      `  ${category.category}: n=${category.count}, skill=${
        category.brierSkillScore === undefined
          ? "-"
          : `${(category.brierSkillScore * 100).toFixed(1)}%`
      }`,
    );
  }
}

function printCalibration(db: Db): void {
  const calibration = computeCalibration(getSettledBets(db));
  console.log("Forecast calibration (settled bets only):");
  if (calibration.settledCount === 0) {
    console.log("  No settled bets yet. Run `npm run paper`, then `npm run settle` after markets resolve.");
    return;
  }
  console.log(`  settled bets:     ${calibration.settledCount}`);
  console.log(`  realized PnL:     EUR ${calibration.totalPnlEur.toFixed(2)} on EUR ${calibration.totalStakeEur.toFixed(2)} staked`);
  console.log(`  return on stake:  ${(calibration.returnOnStake * 100).toFixed(1)}%`);
  if (calibration.brierScore !== undefined) {
    console.log(`  bot Brier score:  ${calibration.brierScore.toFixed(4)} (lower is better)`);
    console.log(`  market benchmark: ${calibration.marketBrierScore?.toFixed(4) ?? "-"}`);
    console.log(
      `  Brier skill:      ${
        calibration.brierSkillScore === undefined
          ? "-"
          : `${(calibration.brierSkillScore * 100).toFixed(1)}% (${calibration.brierSkillScore > 0 ? "bot better" : "market better"})`
      }`,
    );
    console.log(
      `  avg probability:  bot ${((calibration.avgForecast ?? 0) * 100).toFixed(1)}% | market ${((calibration.avgMarketPrior ?? 0) * 100).toFixed(1)}% | realized ${((calibration.realizedRate ?? 0) * 100).toFixed(1)}%`,
    );
  }
  if (calibration.buckets.length > 0) {
    console.log("  forecast bucket -> realized hit rate:");
    for (const bucket of calibration.buckets) {
      console.log(
        `    ${bucket.label.padStart(8)} | n=${String(bucket.count).padStart(3)} | predicted ${(bucket.avgForecast * 100).toFixed(0)}% -> actual ${(bucket.hitRate * 100).toFixed(0)}%`,
      );
    }
  }
}
