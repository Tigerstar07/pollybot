import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { AppConfig } from "./config";
import type { LiveOrderDecision, NormalizedMarket, PaperOrderDecision, ProbabilityEstimate, RankingResult, SourceObservation } from "./types";
import { nowIso } from "./utils";

export type Db = Database.Database;

export function openDatabase(config: AppConfig): Db {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  const db = new Database(config.databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS markets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      market_id TEXT NOT NULL,
      event_id TEXT,
      condition_id TEXT,
      question TEXT NOT NULL,
      category TEXT,
      outcomes_json TEXT NOT NULL,
      yes_token_id TEXT,
      no_token_id TEXT,
      yes_price REAL,
      no_price REAL,
      best_bid REAL,
      best_ask REAL,
      spread REAL,
      volume REAL,
      liquidity REAL,
      end_date TEXT,
      start_date TEXT,
      status TEXT,
      resolution_source TEXT,
      rules TEXT,
      tags_json TEXT,
      url TEXT,
      raw_json TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(provider, market_id)
    );

    CREATE TABLE IF NOT EXISTS market_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT NOT NULL,
      yes_price REAL,
      no_price REAL,
      best_bid REAL,
      best_ask REAL,
      spread REAL,
      volume REAL,
      liquidity REAL,
      raw_json TEXT,
      captured_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT,
      source_type TEXT NOT NULL,
      source_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      available INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      collected_at TEXT NOT NULL,
      expires_at TEXT,
      UNIQUE(source_type, source_key)
    );

    CREATE TABLE IF NOT EXISTS probability_estimates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT NOT NULL,
      yes_probability REAL NOT NULL,
      no_probability REAL NOT NULL,
      confidence REAL NOT NULL,
      method TEXT NOT NULL,
      reasoning TEXT,
      evidence_json TEXT,
      risks_json TEXT,
      should_skip INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rankings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT NOT NULL,
      liquidity_score REAL NOT NULL,
      clarity_score REAL NOT NULL,
      data_availability_score REAL NOT NULL,
      time_horizon_score REAL NOT NULL,
      edge_potential_score REAL NOT NULL,
      risk_score REAL NOT NULL,
      final_score REAL NOT NULL,
      skip_reasons_json TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS latest_rankings (
      market_id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      reason TEXT,
      final_score REAL NOT NULL,
      decision_snapshot_json TEXT NOT NULL,
      scan_batch_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS paper_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      side TEXT NOT NULL,
      price REAL NOT NULL,
      size_eur REAL NOT NULL,
      estimated_shares REAL NOT NULL,
      edge REAL NOT NULL,
      confidence REAL NOT NULL,
      forecast_prob REAL,
      market_prior_prob REAL,
      status TEXT NOT NULL,
      reasoning TEXT,
      created_at TEXT NOT NULL,
      closed_at TEXT,
      pnl_eur REAL
    );

    CREATE TABLE IF NOT EXISTS live_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      side TEXT NOT NULL,
      price REAL NOT NULL,
      size_eur REAL NOT NULL,
      external_order_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      source TEXT NOT NULL,
      size_eur REAL NOT NULL,
      shares REAL NOT NULL,
      average_price REAL NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paper_order_id INTEGER,
      market_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      winning_outcome TEXT,
      source TEXT NOT NULL,
      stake_eur REAL NOT NULL,
      payout_eur REAL NOT NULL,
      pnl_eur REAL NOT NULL,
      settled_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS forecast_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT NOT NULL,
      scan_batch_id TEXT NOT NULL,
      category TEXT NOT NULL,
      action TEXT NOT NULL,
      method TEXT NOT NULL,
      model_version TEXT NOT NULL,
      raw_yes_probability REAL NOT NULL,
      forecast_yes_probability REAL NOT NULL,
      market_yes_probability REAL NOT NULL,
      confidence REAL NOT NULL,
      data_quality REAL NOT NULL,
      independent_evidence_count INTEGER NOT NULL,
      scorable INTEGER NOT NULL DEFAULT 0,
      outcome_yes INTEGER,
      bot_brier REAL,
      market_brier REAL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      UNIQUE(market_id, scan_batch_id)
    );

    CREATE TABLE IF NOT EXISTS bankroll_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bankroll_eur REAL NOT NULL,
      open_exposure_eur REAL NOT NULL,
      daily_pnl_eur REAL NOT NULL,
      total_pnl_eur REAL NOT NULL,
      captured_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bot_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command TEXT NOT NULL,
      status TEXT NOT NULL,
      details_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      context TEXT NOT NULL,
      message TEXT NOT NULL,
      stack TEXT,
      extra_json TEXT,
      created_at TEXT NOT NULL
    );
  `);

  ensureColumn(db, "markets", "no_best_bid", "REAL");
  ensureColumn(db, "markets", "no_best_ask", "REAL");
  ensureColumn(db, "markets", "no_spread", "REAL");
  ensureColumn(db, "markets", "quote_captured_at", "TEXT");
  ensureColumn(db, "markets", "snapshot_captured_at", "TEXT");
  ensureColumn(db, "sources", "independent", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "sources", "quality", "REAL");
  ensureColumn(db, "probability_estimates", "independent_evidence_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "probability_estimates", "data_quality", "REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "probability_estimates", "model_uncertainty", "REAL NOT NULL DEFAULT 0.25");
  ensureColumn(db, "rankings", "decision_snapshot_json", "TEXT");
  ensureColumn(db, "rankings", "scan_batch_id", "TEXT");
  ensureColumn(db, "latest_rankings", "reason", "TEXT");
  ensureColumn(db, "paper_orders", "token_id", "TEXT");
  ensureColumn(db, "paper_orders", "fee_eur", "REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "paper_orders", "max_loss_eur", "REAL");
  ensureColumn(db, "paper_orders", "quote_captured_at", "TEXT");
  ensureColumn(db, "paper_orders", "decision_key", "TEXT");
  ensureColumn(db, "paper_orders", "forecast_prob", "REAL");
  ensureColumn(db, "paper_orders", "market_prior_prob", "REAL");
  ensureColumn(db, "paper_orders", "model_version", "TEXT");
  ensureColumn(db, "live_orders", "token_id", "TEXT");
  ensureColumn(db, "live_orders", "estimated_shares", "REAL");
  ensureColumn(db, "live_orders", "edge", "REAL");
  ensureColumn(db, "live_orders", "confidence", "REAL");
  ensureColumn(db, "live_orders", "forecast_prob", "REAL");
  ensureColumn(db, "live_orders", "market_prior_prob", "REAL");
  ensureColumn(db, "live_orders", "fee_eur", "REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "live_orders", "max_loss_eur", "REAL");
  ensureColumn(db, "live_orders", "quote_captured_at", "TEXT");
  ensureColumn(db, "live_orders", "decision_key", "TEXT");
  ensureColumn(db, "live_orders", "model_version", "TEXT");
  ensureColumn(db, "live_orders", "reasoning", "TEXT");
  ensureColumn(db, "live_orders", "response_status", "TEXT");
  ensureColumn(db, "live_orders", "error_message", "TEXT");
  ensureColumn(db, "live_orders", "updated_at", "TEXT");
  ensureColumn(db, "live_orders", "closed_at", "TEXT");
  ensureColumn(db, "live_orders", "pnl_eur", "REAL");
  ensureColumn(db, "settlements", "paper_order_id", "INTEGER");
  ensureColumn(db, "settlements", "winning_outcome", "TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_orders_decision_key ON paper_orders(decision_key) WHERE decision_key IS NOT NULL");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_live_orders_decision_key ON live_orders(decision_key) WHERE decision_key IS NOT NULL");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_settlements_paper_order_id ON settlements(paper_order_id) WHERE paper_order_id IS NOT NULL");
  db.exec("CREATE INDEX IF NOT EXISTS idx_markets_event_id ON markets(event_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_markets_end_date ON markets(end_date)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_latest_rankings_batch_action ON latest_rankings(scan_batch_id, action, final_score)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_forecast_records_unresolved ON forecast_records(scorable, resolved_at, market_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_forecast_records_resolved ON forecast_records(resolved_at, category)");
  // Keep the live gate fast without indexing the multi-million-row legacy model
  // history (whose raw source snapshots make older databases very large).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_forecast_records_v5_score
    ON forecast_records(category, market_id, created_at)
    WHERE model_version = 'pollybot-decision-v5'
      AND scorable = 1
      AND resolved_at IS NOT NULL
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_forecast_records_v5_all
    ON forecast_records(scorable, resolved_at, category, market_id, created_at)
    WHERE model_version = 'pollybot-decision-v5'
  `);
}

function ensureColumn(db: Db, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((existing) => existing.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function startBotRun(db: Db, command: string): number {
  const result = db
    .prepare("INSERT INTO bot_runs (command, status, started_at) VALUES (?, ?, ?)")
    .run(command, "running", nowIso());
  return Number(result.lastInsertRowid);
}

export function finishBotRun(db: Db, runId: number, status: string, details?: unknown): void {
  db.prepare("UPDATE bot_runs SET status = ?, details_json = ?, finished_at = ? WHERE id = ?").run(
    status,
    details ? JSON.stringify(details) : null,
    nowIso(),
    runId,
  );
}

export function recordError(db: Db, context: string, error: unknown, extra?: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  db.prepare("INSERT INTO errors (context, message, stack, extra_json, created_at) VALUES (?, ?, ?, ?, ?)").run(
    context,
    message,
    stack,
    extra ? JSON.stringify(extra) : null,
    nowIso(),
  );
}

export function upsertMarket(db: Db, market: NormalizedMarket): void {
  const previous = db.prepare(`
    SELECT yes_price, no_price, best_bid, best_ask, spread, volume, liquidity, snapshot_captured_at
    FROM markets WHERE provider = ? AND market_id = ?
  `).get(market.provider, market.marketId) as Record<string, unknown> | undefined;
  const capturedAt = nowIso();
  db.prepare(`
    INSERT INTO markets (
      provider, market_id, event_id, condition_id, question, category, outcomes_json,
      yes_token_id, no_token_id, yes_price, no_price, best_bid, best_ask, no_best_bid,
      no_best_ask, spread, no_spread, quote_captured_at,
      volume, liquidity, end_date, start_date, status, resolution_source, rules,
      tags_json, url, raw_json, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, market_id) DO UPDATE SET
      event_id=excluded.event_id,
      condition_id=excluded.condition_id,
      question=excluded.question,
      category=excluded.category,
      outcomes_json=excluded.outcomes_json,
      yes_token_id=excluded.yes_token_id,
      no_token_id=excluded.no_token_id,
      yes_price=excluded.yes_price,
      no_price=excluded.no_price,
      best_bid=excluded.best_bid,
      best_ask=excluded.best_ask,
      no_best_bid=excluded.no_best_bid,
      no_best_ask=excluded.no_best_ask,
      spread=excluded.spread,
      no_spread=excluded.no_spread,
      quote_captured_at=excluded.quote_captured_at,
      volume=excluded.volume,
      liquidity=excluded.liquidity,
      end_date=excluded.end_date,
      start_date=excluded.start_date,
      status=excluded.status,
      resolution_source=excluded.resolution_source,
      rules=excluded.rules,
      tags_json=excluded.tags_json,
      url=excluded.url,
      raw_json=excluded.raw_json,
      updated_at=excluded.updated_at
  `).run(
    market.provider,
    market.marketId,
    market.eventId ?? null,
    market.conditionId ?? null,
    market.title,
    market.category,
    JSON.stringify(market.outcomes),
    market.yesTokenId ?? null,
    market.noTokenId ?? null,
    market.yesPrice ?? null,
    market.noPrice ?? null,
    market.bestBid ?? null,
    market.bestAsk ?? null,
    market.noBestBid ?? null,
    market.noBestAsk ?? null,
    market.spread ?? null,
    market.noSpread ?? null,
    market.quoteCapturedAt ?? null,
    market.volume ?? null,
    market.liquidity ?? null,
    market.endDate ?? null,
    market.startDate ?? null,
    market.status,
    market.resolutionSource ?? null,
    market.rules ?? null,
    JSON.stringify(market.tags),
    market.url ?? null,
    JSON.stringify(market.raw),
    market.updatedAt,
  );

  // Two million near-identical raw snapshots grew the production DB to ~18 GB. Keep a
  // compact snapshot only when price/liquidity materially changes or six hours elapse.
  if (shouldCaptureMarketSnapshot(previous, market, capturedAt)) {
    db.prepare(`
      INSERT INTO market_snapshots (
        market_id, yes_price, no_price, best_bid, best_ask, spread, volume, liquidity, raw_json, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(
      market.marketId,
      market.yesPrice ?? null,
      market.noPrice ?? null,
      market.bestBid ?? null,
      market.bestAsk ?? null,
      market.spread ?? null,
      market.volume ?? null,
      market.liquidity ?? null,
      capturedAt,
    );
    db.prepare(`
      UPDATE markets SET snapshot_captured_at = ? WHERE provider = ? AND market_id = ?
    `).run(capturedAt, market.provider, market.marketId);
  }
}

function shouldCaptureMarketSnapshot(
  previous: Record<string, unknown> | undefined,
  market: NormalizedMarket,
  capturedAt: string,
): boolean {
  if (!previous) return true;
  const moved = (oldValue: unknown, nextValue: number | undefined, threshold: number) => {
    if (nextValue === undefined) return false;
    const old = Number(oldValue);
    return !Number.isFinite(old) || Math.abs(old - nextValue) >= threshold;
  };
  if (moved(previous.yes_price, market.yesPrice, 0.01)) return true;
  if (moved(previous.best_ask, market.bestAsk, 0.01)) return true;
  if (moved(previous.spread, market.spread, 0.02)) return true;
  const oldLiquidity = Number(previous.liquidity);
  if (market.liquidity !== undefined && Number.isFinite(oldLiquidity) && Math.abs(market.liquidity - oldLiquidity) >= Math.max(100, oldLiquidity * 0.25)) return true;
  const previousAt = Date.parse(String(previous.snapshot_captured_at ?? ""));
  return !Number.isFinite(previousAt) || Date.parse(capturedAt) - previousAt >= 6 * 3_600_000;
}

export function saveSourceObservation(db: Db, marketId: string | null, observation: SourceObservation): void {
  db.prepare(`
    INSERT INTO sources (
      market_id, source_type, source_key, payload_json, available, independent, quality, reason, collected_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_type, source_key) DO UPDATE SET
      market_id=excluded.market_id,
      payload_json=excluded.payload_json,
      available=excluded.available,
      independent=excluded.independent,
      quality=excluded.quality,
      reason=excluded.reason,
      collected_at=excluded.collected_at,
      expires_at=excluded.expires_at
  `).run(
    marketId,
    observation.sourceType,
    observation.sourceKey,
    JSON.stringify(observation.payload),
    observation.available ? 1 : 0,
    observation.independent ? 1 : 0,
    observation.quality ?? null,
    observation.reason ?? null,
    observation.collectedAt,
    observation.expiresAt ?? null,
  );
}

export function getCachedSource(db: Db, sourceType: string, sourceKey: string): SourceObservation | undefined {
  const row = db
    .prepare("SELECT * FROM sources WHERE source_type = ? AND source_key = ?")
    .get(sourceType, sourceKey) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const expiresAt = row.expires_at as string | undefined;
  if (expiresAt && Date.parse(expiresAt) < Date.now()) return undefined;
  return {
    sourceType: String(row.source_type),
    sourceKey: String(row.source_key),
    collectedAt: String(row.collected_at),
    expiresAt,
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    available: Boolean(row.available),
    independent: Boolean(row.independent),
    quality: row.quality === null || row.quality === undefined ? undefined : Number(row.quality),
    reason: row.reason ? String(row.reason) : undefined,
  };
}

export function saveProbabilityEstimate(db: Db, estimate: ProbabilityEstimate): void {
  if (estimate.independentEvidenceCount === 0 && estimate.shouldSkip) return;
  db.prepare(`
    INSERT INTO probability_estimates (
      market_id, yes_probability, no_probability, confidence, method, reasoning,
      evidence_json, risks_json, independent_evidence_count, data_quality, model_uncertainty,
      should_skip, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    estimate.marketId,
    estimate.estimatedYesProbability,
    estimate.estimatedNoProbability,
    estimate.confidence,
    estimate.method,
    estimate.reasoningSummary,
    JSON.stringify(estimate.keyEvidence),
    JSON.stringify(estimate.risks),
    estimate.independentEvidenceCount,
    estimate.dataQuality,
    estimate.modelUncertainty,
    estimate.shouldSkip ? 1 : 0,
    nowIso(),
  );
}

export function saveRanking(db: Db, ranking: RankingResult, scanBatchId?: string): void {
  const createdAt = nowIso();
  const decisionSnapshot = JSON.stringify(toDecisionSnapshot(ranking));
  db.prepare(`
    INSERT INTO latest_rankings (
      market_id, action, reason, final_score, decision_snapshot_json, scan_batch_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(market_id) DO UPDATE SET
      action=excluded.action,
      reason=excluded.reason,
      final_score=excluded.final_score,
      decision_snapshot_json=excluded.decision_snapshot_json,
      scan_batch_id=excluded.scan_batch_id,
      created_at=excluded.created_at
  `).run(ranking.market.marketId, ranking.action, ranking.reason, ranking.finalScore, decisionSnapshot, scanBatchId ?? null, createdAt);

  // The compact forecast table is the calibration history. Retain full historical
  // ranking snapshots only for actual bet decisions; latest_rankings already holds
  // the complete current scan and repeating 28k snapshots every 30 minutes caused
  // unbounded database growth.
  if (ranking.action === "PAPER_BET" || ranking.action === "LIVE_BET") db.prepare(`
    INSERT INTO rankings (
      market_id, liquidity_score, clarity_score, data_availability_score, time_horizon_score,
      edge_potential_score, risk_score, final_score, skip_reasons_json, action, reason,
      decision_snapshot_json, scan_batch_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ranking.market.marketId,
    ranking.liquidityScore,
    ranking.clarityScore,
    ranking.dataAvailabilityScore,
    ranking.timeHorizonScore,
    ranking.edgePotentialScore,
    ranking.riskScore,
    ranking.finalScore,
    JSON.stringify(ranking.skipReasons),
    ranking.action,
    ranking.reason,
    decisionSnapshot,
    scanBatchId ?? null,
    createdAt,
  );
  if (scanBatchId) saveForecastRecord(db, ranking, scanBatchId);
}

export function finalizeLatestRankingsBatch(db: Db, scanBatchId: string): number {
  // Run only after a scan finishes. If discovery/ranking crashes, callers never
  // reach this function and the last complete cache remains available.
  return db.prepare(`
    DELETE FROM latest_rankings
    WHERE scan_batch_id IS NULL OR scan_batch_id <> ?
  `).run(scanBatchId).changes;
}

export const FORECAST_MODEL_VERSION = "pollybot-decision-v5";

function saveForecastRecord(db: Db, ranking: RankingResult, scanBatchId: string): void {
  const marketPrior = clampProbability(ranking.market.yesPrice ?? 0.5);
  const rawProbability = clampProbability(ranking.estimate.estimatedYesProbability);
  const confidence = Math.max(0, Math.min(1, ranking.estimate.confidence));
  const forecastProbability = clampProbability(
    marketPrior + (rawProbability - marketPrior) * confidence,
  );
  const scorable =
    ranking.estimate.independentEvidenceCount > 0 &&
    ranking.estimate.dataQuality > 0 &&
    ranking.estimate.method !== "market-prior-only" &&
    ranking.market.status === "open" &&
    isFutureDate(ranking.market.endDate);
  // Do not persist the enormous market-prior-only/unmodeled population, but retain
  // evidence-bearing non-scorable rows so diagnostics still explain why they were not
  // eligible (closed market, missing end time, etc.).
  if (!scorable && ranking.estimate.independentEvidenceCount === 0) return;
  db.prepare(`
    INSERT OR IGNORE INTO forecast_records (
      market_id, scan_batch_id, category, action, method, model_version,
      raw_yes_probability, forecast_yes_probability, market_yes_probability,
      confidence, data_quality, independent_evidence_count, scorable, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ranking.market.marketId,
    scanBatchId,
    ranking.market.category,
    ranking.action,
    ranking.estimate.method,
    FORECAST_MODEL_VERSION,
    rawProbability,
    forecastProbability,
    marketPrior,
    confidence,
    ranking.estimate.dataQuality,
    ranking.estimate.independentEvidenceCount,
    scorable ? 1 : 0,
    nowIso(),
  );
}

export function savePaperOrder(db: Db, order: PaperOrderDecision): number {
  const result = db.prepare(`
    INSERT INTO paper_orders (
      market_id, outcome, side, token_id, price, size_eur, estimated_shares, edge,
      confidence, forecast_prob, market_prior_prob, fee_eur, max_loss_eur, quote_captured_at,
      decision_key, model_version, status, reasoning, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    order.marketId,
    order.outcome,
    order.side,
    order.tokenId,
    order.price,
    order.sizeEur,
    order.estimatedShares,
    order.edge,
    order.confidence,
    order.forecastProb,
    order.marketPriorProb,
    order.feeEur,
    order.maxLossEur,
    order.quoteCapturedAt,
    order.decisionKey,
    order.modelVersion,
    "OPEN",
    order.reasoning,
    nowIso(),
  );
  return Number(result.lastInsertRowid);
}

export function saveLiveOrder(db: Db, order: LiveOrderDecision): number {
  const result = db.prepare(`
    INSERT INTO live_orders (
      market_id, outcome, side, token_id, price, size_eur, estimated_shares, edge,
      confidence, forecast_prob, market_prior_prob, fee_eur, max_loss_eur, quote_captured_at,
      decision_key, model_version, reasoning, external_order_id, status, response_status,
      error_message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    order.marketId,
    order.outcome,
    order.side,
    order.tokenId,
    order.price,
    order.sizeEur,
    order.estimatedShares,
    order.edge,
    order.confidence,
    order.forecastProb,
    order.marketPriorProb,
    order.feeEur,
    order.maxLossEur,
    order.quoteCapturedAt,
    order.decisionKey,
    order.modelVersion,
    order.reasoning,
    order.externalOrderId ?? null,
    order.status,
    order.responseStatus ?? null,
    order.errorMessage ?? null,
    nowIso(),
    nowIso(),
  );
  return Number(result.lastInsertRowid);
}

// Arb sets (decision_key 'arb:...') are hedged NO baskets on mutually exclusive
// outcomes: their worst-case value at resolution is locked in at entry, so they are
// excluded from directional exposure limits and tracked under their own arb cap.
export function getOpenLiveExposure(db: Db, marketId?: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(size_eur), 0) AS exposure
       FROM live_orders
       WHERE status IN ('PENDING', 'OPEN')
         AND (decision_key IS NULL OR decision_key NOT LIKE 'arb:%')${
        marketId ? " AND market_id = ?" : ""
      }`,
    )
    .get(...(marketId ? [marketId] : [])) as { exposure: number };
  return Number(row.exposure ?? 0);
}

export function getOpenLiveEventExposure(db: Db, eventId?: string | null): number {
  if (!eventId) return 0;
  const row = db.prepare(`
    SELECT COALESCE(SUM(lo.size_eur), 0) AS exposure
    FROM live_orders lo
    JOIN markets m ON m.market_id = lo.market_id
    WHERE lo.status IN ('PENDING', 'OPEN')
      AND (lo.decision_key IS NULL OR lo.decision_key NOT LIKE 'arb:%')
      AND m.event_id = ?
  `).get(eventId) as { exposure: number };
  return Number(row.exposure ?? 0);
}

export function getOpenArbExposure(db: Db): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(size_eur), 0) AS exposure
    FROM live_orders
    WHERE status IN ('PENDING', 'OPEN') AND decision_key LIKE 'arb:%'
  `).get() as { exposure: number };
  return Number(row.exposure ?? 0);
}

// An arb leg that filled but could not be unwound after a partial basket is a real
// directional position; dropping the 'arb:' prefix puts it back under the normal
// exposure limits and loss guards.
export function retagArbOrderAsOrphan(db: Db, orderId: number): void {
  db.prepare(`
    UPDATE live_orders
    SET decision_key = 'orphaned-' || decision_key, updated_at = ?
    WHERE id = ? AND decision_key LIKE 'arb:%'
  `).run(nowIso(), orderId);
}

export function hasOpenArbOnEvent(db: Db, eventId: string): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM live_orders lo
    JOIN markets m ON m.market_id = lo.market_id
    WHERE lo.status IN ('PENDING', 'OPEN')
      AND lo.decision_key LIKE 'arb:%'
      AND m.event_id = ?
    LIMIT 1
  `).get(eventId);
  return Boolean(row);
}

export function updateLiveOrderStatus(
  db: Db,
  orderId: number,
  update: {
    status: string;
    externalOrderId?: string;
    responseStatus?: string;
    errorMessage?: string;
    executedPrice?: number;
    executedShares?: number;
    executedFeeEur?: number;
  },
): void {
  db.prepare(`
    UPDATE live_orders
    SET status = ?,
        external_order_id = COALESCE(?, external_order_id),
        response_status = COALESCE(?, response_status),
        error_message = ?,
        price = COALESCE(?, price),
        estimated_shares = COALESCE(?, estimated_shares),
        fee_eur = COALESCE(?, fee_eur),
        updated_at = ?
    WHERE id = ?
  `).run(
    update.status,
    update.externalOrderId ?? null,
    update.responseStatus ?? null,
    update.errorMessage ?? null,
    update.executedPrice ?? null,
    update.executedShares ?? null,
    update.executedFeeEur ?? null,
    nowIso(),
    orderId,
  );
}

export function getLiveStakeToday(db: Db): { count: number; stakeEur: number } {
  const row = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(size_eur), 0) AS stake
    FROM live_orders
    WHERE status IN ('PENDING', 'OPEN', 'CLOSED')
      AND datetime(created_at) >= datetime('now', 'start of day')
  `).get() as { count: number; stake: number };
  return { count: Number(row.count ?? 0), stakeEur: Number(row.stake ?? 0) };
}

export function hasRecentLiveOrder(
  db: Db,
  marketId: string,
  outcome: "YES" | "NO",
  cooldownMinutes: number,
): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM live_orders
    WHERE market_id = ? AND outcome = ?
      AND status IN ('PENDING', 'OPEN', 'CLOSED')
      AND datetime(created_at) >= datetime('now', ?)
    LIMIT 1
  `).get(marketId, outcome, `-${cooldownMinutes} minutes`);
  return Boolean(row);
}

export interface OpenLiveOrderRow {
  id: number;
  market_id: string;
  outcome: "YES" | "NO";
  token_id: string | null;
  price: number;
  size_eur: number;
  estimated_shares: number | null;
  external_order_id: string | null;
  status: "PENDING" | "OPEN";
  response_status: string | null;
}

export function getOpenLiveOrders(db: Db): OpenLiveOrderRow[] {
  return db.prepare(`
    SELECT id, market_id, outcome, token_id, price, size_eur, estimated_shares,
           external_order_id, status, response_status
    FROM live_orders
    WHERE status IN ('PENDING', 'OPEN')
    ORDER BY id ASC
  `).all() as OpenLiveOrderRow[];
}

export function settleLiveOrder(
  db: Db,
  orderId: number,
  pnlEur: number,
  responseStatus = "resolved",
): boolean {
  const result = db.prepare(`
    UPDATE live_orders
    SET status = 'CLOSED', response_status = ?, pnl_eur = ?, closed_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('PENDING', 'OPEN')
  `).run(responseStatus, pnlEur, nowIso(), nowIso(), orderId);
  return result.changes === 1;
}

export function getClosedLivePnl(db: Db): { daily: number; total: number } {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN datetime(closed_at) >= datetime('now', 'start of day') THEN pnl_eur ELSE 0 END), 0) AS daily,
      COALESCE(SUM(pnl_eur), 0) AS total
    FROM live_orders
    WHERE status = 'CLOSED' AND pnl_eur IS NOT NULL
  `).get() as { daily: number; total: number };
  return { daily: Number(row.daily ?? 0), total: Number(row.total ?? 0) };
}

export function getOpenExposure(db: Db, marketId?: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(size_eur), 0) AS exposure FROM paper_orders WHERE status = 'OPEN'${
        marketId ? " AND market_id = ?" : ""
      }`,
    )
    .get(...(marketId ? [marketId] : [])) as { exposure: number };
  return Number(row.exposure ?? 0);
}

export interface OpenPaperOrderRow {
  id: number;
  market_id: string;
  outcome: "YES" | "NO";
  size_eur: number;
  estimated_shares: number;
  price: number;
}

export function getOpenPaperOrders(db: Db): OpenPaperOrderRow[] {
  return db
    .prepare(
      "SELECT id, market_id, outcome, size_eur, estimated_shares, price FROM paper_orders WHERE status = 'OPEN' ORDER BY id ASC",
    )
    .all() as OpenPaperOrderRow[];
}

export function getDueForecastMarketIds(db: Db, limit = 250): string[] {
  const rows = db.prepare(`
    SELECT m.market_id
    FROM markets m
    WHERE m.end_date IS NOT NULL
      AND m.end_date <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND EXISTS (
        SELECT 1
        FROM forecast_records f
        WHERE f.market_id = m.market_id
          AND f.scorable = 1
          AND f.resolved_at IS NULL
      )
    ORDER BY m.end_date ASC
    LIMIT ?
  `).all(limit) as Array<{ market_id: string }>;
  return rows.map((row) => row.market_id);
}

export function settleForecastRecords(
  db: Db,
  marketId: string,
  winningOutcome: string,
): number {
  const normalized = winningOutcome.trim().toUpperCase();
  if (normalized !== "YES" && normalized !== "NO") return 0;
  const outcome = normalized === "YES" ? 1 : 0;
  const resolvedAt = nowIso();
  const result = db.prepare(`
    UPDATE forecast_records
    SET
      outcome_yes = ?,
      bot_brier = (forecast_yes_probability - ?) * (forecast_yes_probability - ?),
      market_brier = (market_yes_probability - ?) * (market_yes_probability - ?),
      resolved_at = ?
    WHERE market_id = ? AND scorable = 1 AND resolved_at IS NULL
  `).run(outcome, outcome, outcome, outcome, outcome, resolvedAt, marketId);
  return result.changes;
}

export interface SettledForecastRow {
  market_id: string;
  category: string;
  action: string;
  method: string;
  model_version: string;
  raw_yes_probability: number;
  forecast_yes_probability: number;
  market_yes_probability: number;
  confidence: number;
  data_quality: number;
  outcome_yes: number;
  bot_brier: number;
  market_brier: number;
  created_at: string;
  resolved_at: string;
}

export function getSettledForecasts(db: Db): SettledForecastRow[] {
  return db.prepare(`
    WITH first_forecast_per_market AS (
      SELECT
        market_id, category, action, method, model_version, raw_yes_probability,
        forecast_yes_probability, market_yes_probability, confidence, data_quality,
        outcome_yes, bot_brier, market_brier, created_at, resolved_at,
        ROW_NUMBER() OVER (PARTITION BY market_id ORDER BY created_at ASC, id ASC) AS market_rank
      FROM forecast_records
      WHERE scorable = 1
        AND model_version = ?
        AND resolved_at IS NOT NULL
        AND outcome_yes IS NOT NULL
    )
    SELECT
      market_id, category, action, method, model_version, raw_yes_probability,
      forecast_yes_probability, market_yes_probability, confidence, data_quality,
      outcome_yes, bot_brier, market_brier, created_at, resolved_at
    FROM first_forecast_per_market
    WHERE market_rank = 1
    ORDER BY resolved_at ASC
  `).all(FORECAST_MODEL_VERSION) as SettledForecastRow[];
}

export interface LiveCalibrationStats {
  category?: string;
  settledCount: number;
  botBrier?: number;
  marketBrier?: number;
  brierSkill?: number;
  meanBrierImprovement?: number;
  standardError?: number;
  lowerConfidenceImprovement?: number;
}

/**
 * Out-of-sample live gate inputs. One first forecast per market prevents repeated scans
 * of the same contract from fabricating sample size. Positive improvement means the bot
 * beat the contemporaneous market probability on Brier loss.
 */
export function getLiveCalibrationStats(
  db: Db,
  category?: string,
  zScore = 1.645,
): LiveCalibrationStats {
  const categoryClause = category ? "AND category = ?" : "";
  const params: Array<string | number> = [FORECAST_MODEL_VERSION];
  if (category) params.push(category);
  const row = db.prepare(`
    WITH scored AS (
      SELECT
        market_id,
        bot_brier,
        market_brier,
        market_brier - bot_brier AS improvement,
        ROW_NUMBER() OVER (PARTITION BY market_id ORDER BY created_at ASC, id ASC) AS market_rank
      FROM forecast_records
      WHERE model_version = ?
        AND scorable = 1
        AND resolved_at IS NOT NULL
        AND outcome_yes IS NOT NULL
        ${categoryClause}
    )
    SELECT
      COUNT(*) AS settled_count,
      AVG(bot_brier) AS bot_brier,
      AVG(market_brier) AS market_brier,
      AVG(improvement) AS mean_improvement,
      AVG(improvement * improvement) AS mean_squared_improvement
    FROM scored
    WHERE market_rank = 1
  `).get(...params) as {
    settled_count: number;
    bot_brier: number | null;
    market_brier: number | null;
    mean_improvement: number | null;
    mean_squared_improvement: number | null;
  };
  const settledCount = Number(row.settled_count ?? 0);
  if (
    settledCount === 0 ||
    row.bot_brier === null ||
    row.market_brier === null ||
    row.mean_improvement === null ||
    row.mean_squared_improvement === null
  ) {
    return { category, settledCount };
  }
  const botBrier = Number(row.bot_brier);
  const marketBrier = Number(row.market_brier);
  const meanBrierImprovement = Number(row.mean_improvement);
  const populationVariance = Math.max(
    0,
    Number(row.mean_squared_improvement) - meanBrierImprovement ** 2,
  );
  const sampleVariance = settledCount > 1
    ? populationVariance * (settledCount / (settledCount - 1))
    : Number.POSITIVE_INFINITY;
  const standardError = Math.sqrt(sampleVariance / settledCount);
  const lowerConfidenceImprovement = Number.isFinite(standardError)
    ? meanBrierImprovement - zScore * standardError
    : Number.NEGATIVE_INFINITY;
  return {
    category,
    settledCount,
    botBrier,
    marketBrier,
    brierSkill: marketBrier > 0 ? 1 - botBrier / marketBrier : undefined,
    meanBrierImprovement,
    standardError,
    lowerConfidenceImprovement,
  };
}

export function getForecastCounts(db: Db): {
  recorded: number;
  scorable: number;
  settled: number;
  pending: number;
} {
  const row = db.prepare(`
    WITH current_records AS (
      SELECT *
      FROM forecast_records
      WHERE model_version = ?
    ),
    market_states AS (
      SELECT
        market_id,
        MAX(CASE WHEN scorable = 1 THEN 1 ELSE 0 END) AS scorable,
        MAX(CASE WHEN scorable = 1 AND resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS settled
      FROM current_records
      GROUP BY market_id
    )
    SELECT
      (SELECT COUNT(*) FROM current_records) AS recorded,
      COALESCE(SUM(scorable), 0) AS scorable,
      COALESCE(SUM(settled), 0) AS settled,
      COALESCE(SUM(CASE WHEN scorable = 1 AND settled = 0 THEN 1 ELSE 0 END), 0) AS pending
    FROM market_states
  `).get(FORECAST_MODEL_VERSION) as Record<string, number | null>;
  return {
    recorded: Number(row.recorded ?? 0),
    scorable: Number(row.scorable ?? 0),
    settled: Number(row.settled ?? 0),
    pending: Number(row.pending ?? 0),
  };
}

export function settlePaperOrder(
  db: Db,
  settlement: {
    orderId: number;
    marketId: string;
    outcome: string;
    winningOutcome: string;
    source: string;
    stakeEur: number;
    payoutEur: number;
    pnlEur: number;
  },
): boolean {
  const settle = db.transaction(() => {
    const settledAt = nowIso();
    const close = db
      .prepare(
        "UPDATE paper_orders SET status = 'CLOSED', pnl_eur = ?, closed_at = ? WHERE id = ? AND status = 'OPEN'",
      )
      .run(settlement.pnlEur, settledAt, settlement.orderId);
    if (close.changes !== 1) return false;

    db.prepare(
      `INSERT INTO settlements (
         paper_order_id, market_id, outcome, winning_outcome, source,
         stake_eur, payout_eur, pnl_eur, settled_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      settlement.orderId,
      settlement.marketId,
      settlement.outcome,
      settlement.winningOutcome,
      settlement.source,
      settlement.stakeEur,
      settlement.payoutEur,
      settlement.pnlEur,
      settledAt,
    );
    return true;
  });
  return settle();
}

export interface SettledBetRow {
  market_id: string;
  outcome: "YES" | "NO";
  price: number;
  confidence: number;
  edge: number;
  forecast_prob: number | null;
  market_prior_prob: number;
  size_eur: number;
  pnl_eur: number;
  closed_at: string;
}

/** Settled paper bets with the bot's calibrated forecast, for calibration scoring. */
export function getSettledBets(db: Db): SettledBetRow[] {
  return db
    .prepare(
      `SELECT market_id, outcome, price, confidence, edge, forecast_prob,
              COALESCE(market_prior_prob, price) AS market_prior_prob,
              size_eur, pnl_eur, closed_at
       FROM paper_orders
       WHERE status = 'CLOSED' AND pnl_eur IS NOT NULL
       ORDER BY closed_at ASC`,
    )
    .all() as SettledBetRow[];
}

export type RecentOrderRow = { status: string; pnl_eur?: number | null; response_status?: string | null; created_at?: string | null };

export function getRecentPaperOrders(db: Db, limit = 50): RecentOrderRow[] {
  return db
    .prepare("SELECT status, pnl_eur, NULL AS response_status, created_at FROM paper_orders ORDER BY created_at DESC LIMIT ?")
    .all(limit) as RecentOrderRow[];
}

export function getRecentLiveOrders(db: Db, limit = 50): RecentOrderRow[] {
  // Arb legs are excluded: a settled arb set always books (legs - 1) losing legs
  // next to one winning leg, which would trip the recent-loss streak guard.
  return db
    .prepare(
      `SELECT status, pnl_eur, response_status, created_at
       FROM live_orders
       WHERE decision_key IS NULL OR decision_key NOT LIKE 'arb:%'
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as RecentOrderRow[];
}

export interface ArbCandidateEvent {
  event_id: string;
  market_count: number;
  yes_bid_sum: number;
}

export interface ArbEventMarketRow {
  market_id: string;
  question: string;
  no_token_id: string;
  yes_bid: number | null;
  end_date: string | null;
}

/**
 * Events worth verifying with live order books for a NO-basket arb. A subset of
 * mutually exclusive outcomes is arbitrageable when the sum of their YES bids
 * exceeds 1, so events whose stored YES bids already sum close to 1 are the only
 * ones worth spending book requests on. Stored quotes are stale; execution
 * re-verifies everything against live books.
 */
export function getArbCandidateEvents(
  db: Db,
  options: { maxHoursToEnd: number; minYesBidSum: number; maxStaleHours: number; limit: number },
): ArbCandidateEvent[] {
  return db.prepare(`
    SELECT event_id,
           COUNT(*) AS market_count,
           SUM(COALESCE(best_bid, yes_price, 0)) AS yes_bid_sum
    FROM markets
    WHERE event_id IS NOT NULL AND event_id != ''
      AND status = 'open'
      AND no_token_id IS NOT NULL AND no_token_id != ''
      AND end_date IS NOT NULL
      AND datetime(end_date) > datetime('now')
      AND datetime(end_date) <= datetime('now', '+' || ? || ' hours')
      AND datetime(updated_at) >= datetime('now', '-' || ? || ' hours')
    GROUP BY event_id
    HAVING market_count >= 2 AND yes_bid_sum >= ?
    ORDER BY yes_bid_sum DESC
    LIMIT ?
  `).all(
    options.maxHoursToEnd,
    options.maxStaleHours,
    options.minYesBidSum,
    options.limit,
  ) as ArbCandidateEvent[];
}

export function getArbEventMarkets(db: Db, eventId: string): ArbEventMarketRow[] {
  return db.prepare(`
    SELECT market_id, question, no_token_id, COALESCE(best_bid, yes_price) AS yes_bid, end_date
    FROM markets
    WHERE event_id = ?
      AND status = 'open'
      AND no_token_id IS NOT NULL AND no_token_id != ''
    ORDER BY COALESCE(best_bid, yes_price, 0) DESC
  `).all(eventId) as ArbEventMarketRow[];
}

export function getClosedPnl(db: Db): { daily: number; total: number } {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN datetime(closed_at) >= datetime('now', 'start of day') THEN pnl_eur ELSE 0 END), 0) AS daily,
      COALESCE(SUM(pnl_eur), 0) AS total
    FROM paper_orders
    WHERE status = 'CLOSED'
  `).get() as { daily: number; total: number };
  return { daily: Number(row.daily ?? 0), total: Number(row.total ?? 0) };
}

export function hasRecentPaperOrder(
  db: Db,
  marketId: string,
  outcome: "YES" | "NO",
  cooldownMinutes: number,
): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM paper_orders
    WHERE market_id = ? AND outcome = ?
      AND datetime(created_at) >= datetime('now', ?)
    LIMIT 1
  `).get(marketId, outcome, `-${cooldownMinutes} minutes`);
  return Boolean(row);
}

export function getLatestDecision(db: Db, marketId: string): RankingResult | undefined {
  const row = db.prepare(`
    SELECT decision_snapshot_json
    FROM latest_rankings
    WHERE market_id = ? AND decision_snapshot_json IS NOT NULL
    LIMIT 1
  `).get(marketId) as { decision_snapshot_json?: string } | undefined;
  if (!row?.decision_snapshot_json) return undefined;
  return JSON.parse(row.decision_snapshot_json) as RankingResult;
}

export function getLatestLiveCandidateRankings(db: Db, limit = 50, nearTermMaxHours = 36): RankingResult[] {
  const batch = db.prepare(`
    SELECT scan_batch_id
    FROM latest_rankings
    WHERE scan_batch_id IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 1
  `).get() as { scan_batch_id?: string } | undefined;
  if (!batch?.scan_batch_id) return [];
  const rows = db.prepare(`
    SELECT r.decision_snapshot_json
    FROM latest_rankings r
    LEFT JOIN markets m ON m.market_id = r.market_id
    WHERE r.scan_batch_id = ?
      AND r.action IN ('LIVE_BET', 'WATCH')
      AND r.decision_snapshot_json IS NOT NULL
    ORDER BY
      CASE r.action WHEN 'LIVE_BET' THEN 0 ELSE 1 END,
      CASE
        WHEN m.end_date IS NOT NULL
          AND datetime(m.end_date) > datetime('now')
          AND datetime(m.end_date) <= datetime('now', '+' || ? || ' hours')
        THEN 0 ELSE 1
      END,
      CASE WHEN m.end_date IS NULL THEN 1 ELSE 0 END,
      datetime(m.end_date) ASC,
      r.final_score DESC
    LIMIT ?
  `).all(batch.scan_batch_id, nearTermMaxHours, limit) as Array<{ decision_snapshot_json: string }>;
  return rows.flatMap((row) => {
    try {
      return [JSON.parse(row.decision_snapshot_json) as RankingResult];
    } catch {
      return [];
    }
  });
}

export function saveBankrollSnapshot(db: Db, bankrollEur: number, openExposureEur: number, dailyPnl: number, totalPnl: number): void {
  db.prepare(`
    INSERT INTO bankroll_snapshots (
      bankroll_eur, open_exposure_eur, daily_pnl_eur, total_pnl_eur, captured_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(bankrollEur, openExposureEur, dailyPnl, totalPnl, nowIso());
}

function toDecisionSnapshot(ranking: RankingResult): RankingResult {
  return {
    ...ranking,
    market: {
      ...ranking.market,
      raw: {},
    },
  };
}

function clampProbability(value: number): number {
  return Math.max(0.01, Math.min(0.99, value));
}

function isFutureDate(value: string | undefined): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > Date.now();
}
