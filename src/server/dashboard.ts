import type { AppConfig } from "../config";
import type { DashboardData, DashboardPaperOrder, DashboardRun } from "../dashboardTypes";
import { toDashboardDecision } from "../dashboardTypes";
import {
  getForecastCounts,
  getOpenLiveExposure,
  getSettledBets,
  getSettledForecasts,
  type Db,
} from "../db";
import {
  computeCalibration,
  computeForecastCalibration,
} from "../reports/calibration";
import type { RankingResult } from "../types";

export interface ScanState {
  running: boolean;
  startedAt?: string;
  error?: string;
}

export function readDashboard(config: AppConfig, db: Db, scan: ScanState): DashboardData {
  const batch = db.prepare(`
    SELECT scan_batch_id
    FROM latest_rankings
    WHERE scan_batch_id IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 1
  `).get() as { scan_batch_id?: string } | undefined;

  let rankings: RankingResult[] = [];
  let counts = {
    marketsScanned: 0,
    candidates: 0,
    watched: 0,
    unmodeled: 0,
    skipped: 0,
  };
  if (batch?.scan_batch_id) {
    const countRows = db.prepare(`
      SELECT action, COUNT(*) AS count
      FROM latest_rankings
      WHERE scan_batch_id = ?
      GROUP BY action
    `).all(batch.scan_batch_id) as Array<{ action: string; count: number }>;
    counts.marketsScanned = countRows.reduce((sum, row) => sum + Number(row.count), 0);
    for (const row of countRows) {
      if (row.action === "PAPER_BET" || row.action === "LIVE_BET") counts.candidates += Number(row.count);
      else if (row.action === "WATCH") counts.watched += Number(row.count);
      else if (row.action === "UNMODELED") counts.unmodeled += Number(row.count);
      else if (row.action === "SKIP") counts.skipped += Number(row.count);
    }

    const rows = db.prepare(`
      WITH category_ranked AS (
        SELECT
          r.decision_snapshot_json,
          r.action,
          r.final_score,
          m.category,
          ROW_NUMBER() OVER (
            PARTITION BY m.category
            ORDER BY
               CASE r.action WHEN 'PAPER_BET' THEN 0 WHEN 'LIVE_BET' THEN 0 WHEN 'WATCH' THEN 1 WHEN 'UNMODELED' THEN 2 ELSE 3 END,
              r.final_score DESC
          ) AS category_rank
        FROM latest_rankings r
        JOIN markets m ON m.market_id = r.market_id
        WHERE r.scan_batch_id = ? AND r.decision_snapshot_json IS NOT NULL
      )
      SELECT decision_snapshot_json
      FROM category_ranked
      WHERE category_rank <= 60
      ORDER BY category_rank,
        CASE action WHEN 'PAPER_BET' THEN 0 WHEN 'LIVE_BET' THEN 0 WHEN 'WATCH' THEN 1 WHEN 'UNMODELED' THEN 2 ELSE 3 END,
        final_score DESC
    `).all(batch.scan_batch_id) as Array<{ decision_snapshot_json: string }>;
    rankings = rows.flatMap((row) => {
      try {
        return [JSON.parse(row.decision_snapshot_json) as RankingResult];
      } catch {
        return [];
      }
    });
  }

  const paperExposure = db.prepare(
    "SELECT COALESCE(SUM(size_eur), 0) AS value FROM paper_orders WHERE status = 'OPEN'",
  ).get() as { value: number };
  const liveOrders = db.prepare("SELECT COUNT(*) AS count FROM live_orders").get() as { count: number };
  const paperCalibration = computeCalibration(getSettledBets(db));
  const forecastCalibration = computeForecastCalibration(getSettledForecasts(db));
  const forecastCounts = getForecastCounts(db);
  const sourceHealth = readSportsOddsHealth(config, db);
  const liveReadiness = buildLiveReadiness(
    config,
    paperCalibration,
    forecastCalibration,
  );
  const liveEnabled = config.enableRealTrading && !config.dryRun;
  const displayedExposure = liveEnabled ? getOpenLiveExposure(db) : Number(paperExposure.value ?? 0);

  return {
    generatedAt: new Date().toISOString(),
    safety: {
      mode: liveEnabled ? "live" : "paper",
      liveExecutionEnabled: liveEnabled,
      dryRun: config.dryRun,
      sportsOddsConfigured: Boolean(config.sportsOddsApiKey),
    },
    scan,
    summary: {
      ...counts,
      openExposureEur: displayedExposure,
      maxOpenExposureEur: config.maxOpenExposureEur,
      bankrollEur: config.bankrollEur,
      liveOrders: Number(liveOrders.count ?? 0),
      maxBetEur: config.maxBetEur,
    },
    decisions: rankings.map(toDashboardDecision),
    paperOrders: readPaperOrders(db),
    runs: readRuns(db),
    calibration: {
      paper: paperCalibration,
      forecasts: forecastCalibration,
      forecastCounts,
    },
    recentSettlements: readRecentSettlements(db),
    sourceHealth: { sportsOdds: sourceHealth },
    liveReadiness,
  };
}

function readSportsOddsHealth(
  config: AppConfig,
  db: Db,
): DashboardData["sourceHealth"]["sportsOdds"] {
  if (!config.sportsOddsApiKey) {
    return {
      configured: false,
      status: "unconfigured",
      cacheMinutes: config.sportsOddsCacheMinutes,
      maxCallsPerScan: config.sportsOddsMaxCallsPerScan,
      minRemaining: config.sportsOddsMinRemaining,
    };
  }
  const row = db.prepare(`
    SELECT payload_json, collected_at
    FROM sources
    WHERE source_type = 'sports-odds-feed'
    ORDER BY collected_at DESC
    LIMIT 1
  `).get() as { payload_json: string; collected_at: string } | undefined;
  if (!row) {
    return {
      configured: true,
      status: "unknown",
      cacheMinutes: config.sportsOddsCacheMinutes,
      maxCallsPerScan: config.sportsOddsMaxCallsPerScan,
      minRemaining: config.sportsOddsMinRemaining,
    };
  }
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    // Preserve an unknown state when a legacy row cannot be decoded.
  }
  const requestsRemaining = optionalNumber(payload.requestsRemaining);
  const requestsUsed = optionalNumber(payload.requestsUsed);
  const requestsLast = optionalNumber(payload.requestsLast);
  return {
    configured: true,
    status:
      requestsRemaining !== undefined &&
      requestsRemaining <= config.sportsOddsMinRemaining
        ? "quota-guard"
        : "ready",
    requestsRemaining,
    requestsUsed,
    requestsLast,
    lastFetchedAt: row.collected_at,
    cacheMinutes: config.sportsOddsCacheMinutes,
    maxCallsPerScan: config.sportsOddsMaxCallsPerScan,
    minRemaining: config.sportsOddsMinRemaining,
  };
}

function readRecentSettlements(
  db: Db,
): DashboardData["recentSettlements"] {
  const rows = db.prepare(`
    SELECT
      s.id, COALESCE(m.question, s.market_id) AS title, s.outcome,
      s.winning_outcome, s.stake_eur, s.pnl_eur, s.settled_at
    FROM settlements s
    LEFT JOIN markets m ON m.market_id = s.market_id
    ORDER BY s.id DESC
    LIMIT 12
  `).all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: Number(row.id),
    title: String(row.title),
    outcome: String(row.outcome),
    winningOutcome: row.winning_outcome
      ? String(row.winning_outcome)
      : undefined,
    stakeEur: Number(row.stake_eur),
    pnlEur: Number(row.pnl_eur),
    settledAt: String(row.settled_at),
  }));
}

function buildLiveReadiness(
  config: AppConfig,
  paper: ReturnType<typeof computeCalibration>,
  forecasts: ReturnType<typeof computeForecastCalibration>,
): DashboardData["liveReadiness"] {
  const gates = [
    {
      key: "forecast-sample",
      label: "Settled shadow forecasts",
      passed: forecasts.settledCount >= 100,
      detail: `${forecasts.settledCount} / 100 evidence-backed forecasts settled`,
    },
    {
      key: "forecast-skill",
      label: "Beats market benchmark",
      passed:
        forecasts.brierSkillScore !== undefined &&
        forecasts.brierSkillScore > 0,
      detail:
        forecasts.brierSkillScore === undefined
          ? "No Brier skill result yet"
          : `${(forecasts.brierSkillScore * 100).toFixed(1)}% Brier skill`,
    },
    {
      key: "paper-sample",
      label: "Settled paper positions",
      passed: paper.settledCount >= 100,
      detail: `${paper.settledCount} / 100 paper positions settled`,
    },
    {
      key: "paper-return",
      label: "Positive return after costs",
      passed: paper.settledCount >= 30 && paper.returnOnStake > 0,
      detail: `${(paper.returnOnStake * 100).toFixed(1)}% return on stake`,
    },
    {
      key: "order-signer",
      label: "Wallet and order signer",
      passed: Boolean(config.polymarketPrivateKey && config.polymarketFunderAddress),
      detail:
        config.polymarketPrivateKey && config.polymarketFunderAddress
          ? "Credentials configured; run npm run live-check for authenticated verification"
          : "Private key and funder address are not configured",
    },
  ];
  return { ready: gates.every((gate) => gate.passed), gates };
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readPaperOrders(db: Db): DashboardPaperOrder[] {
  const rows = db.prepare(`
    SELECT
      p.id, p.market_id, COALESCE(m.question, p.market_id) AS title, p.outcome, p.price,
      p.size_eur, p.estimated_shares, p.edge, p.confidence, p.status, p.pnl_eur, p.created_at
    FROM paper_orders p
    LEFT JOIN markets m ON m.market_id = p.market_id
    ORDER BY p.id DESC
    LIMIT 30
  `).all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: Number(row.id),
    marketId: String(row.market_id),
    title: String(row.title),
    outcome: String(row.outcome) as "YES" | "NO",
    price: Number(row.price),
    sizeEur: Number(row.size_eur),
    shares: Number(row.estimated_shares),
    edge: Number(row.edge),
    confidence: Number(row.confidence),
    status: String(row.status),
    pnlEur: row.pnl_eur === null || row.pnl_eur === undefined ? undefined : Number(row.pnl_eur),
    createdAt: String(row.created_at),
  }));
}

function readRuns(db: Db): DashboardRun[] {
  const rows = db.prepare(`
    SELECT id, command, status, details_json, started_at, finished_at
    FROM bot_runs
    ORDER BY id DESC
    LIMIT 12
  `).all() as Array<Record<string, unknown>>;
  return rows.map((row) => {
    let details: DashboardRun["details"];
    try {
      details = row.details_json ? JSON.parse(String(row.details_json)) as DashboardRun["details"] : undefined;
    } catch {
      details = undefined;
    }
    return {
      id: Number(row.id),
      command: String(row.command),
      status: String(row.status),
      startedAt: String(row.started_at),
      finishedAt: row.finished_at ? String(row.finished_at) : undefined,
      details,
    };
  });
}
