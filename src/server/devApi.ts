import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config";
import { loadConfig } from "../config";
import {
  finishBotRun,
  getClosedPnl,
  getLatestDecision,
  getOpenExposure,
  openDatabase,
  recordError,
  saveBankrollSnapshot,
  savePaperOrder,
  startBotRun,
} from "../db";
import { refreshExecutableQuotes } from "../providers/polymarket/orderbook";
import { rankMarket } from "../ranking/ranker";
import { scanAndRank } from "../scanner";
import { assessPaperBet } from "../trading/riskManager";
import { settleResolvedMarkets } from "../trading/settlement";
import { readDashboard, type ScanState } from "./dashboard";

const scanState: ScanState = { running: false };

export async function handleDevApi(
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/")) {
    next();
    return;
  }

  try {
    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      const config = loadConfig();
      const db = openDatabase(config);
      try {
        sendJson(response, 200, readDashboard(config, db, { ...scanState }));
      } finally {
        db.close();
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/scan") {
      await runScan(response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/settle") {
      await runSettlement(response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/paper-orders") {
      const body = await readJsonBody(request);
      await simulatePaperOrder(response, String(body.marketId ?? ""));
      return;
    }

    sendJson(response, 404, { error: "API route not found" });
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function runScan(response: ServerResponse): Promise<void> {
  if (scanState.running) {
    sendJson(response, 409, { error: "A scan is already running" });
    return;
  }

  const config = loadConfig();
  const db = openDatabase(config);
  const runId = startBotRun(db, "dashboard-scan");
  const started = Date.now();
  scanState.running = true;
  scanState.startedAt = new Date(started).toISOString();
  scanState.error = undefined;
  try {
    const rankings = await scanAndRank(config, db, { print: false });
    const details = {
      marketsScanned: rankings.length,
      candidates: rankings.filter((ranking) => ranking.action === "PAPER_BET" || ranking.action === "LIVE_BET").length,
      watched: rankings.filter((ranking) => ranking.action === "WATCH").length,
      unmodeled: rankings.filter((ranking) => ranking.action === "UNMODELED").length,
      skipped: rankings.filter((ranking) => ranking.action === "SKIP").length,
      durationMs: Date.now() - started,
    };
    finishBotRun(db, runId, "ok", details);
    sendJson(response, 200, details);
  } catch (error) {
    scanState.error = error instanceof Error ? error.message : String(error);
    recordError(db, "dashboard-scan", error);
    finishBotRun(db, runId, "error", { message: scanState.error, durationMs: Date.now() - started });
    sendJson(response, 500, { error: scanState.error });
  } finally {
    scanState.running = false;
    db.close();
  }
}

async function runSettlement(response: ServerResponse): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config);
  const runId = startBotRun(db, "dashboard-settle");
  const started = Date.now();
  try {
    const summary = await settleResolvedMarkets(config, db);
    const pnl = getClosedPnl(db);
    saveBankrollSnapshot(
      db,
      config.bankrollEur,
      getOpenExposure(db),
      pnl.daily,
      pnl.total,
    );
    const details = { ...summary, durationMs: Date.now() - started };
    finishBotRun(db, runId, "ok", details);
    sendJson(response, 200, details);
  } catch (error) {
    recordError(db, "dashboard-settle", error);
    finishBotRun(db, runId, "error", {
      message: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    });
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    db.close();
  }
}

async function simulatePaperOrder(response: ServerResponse, marketId: string): Promise<void> {
  if (!marketId) {
    sendJson(response, 400, { error: "marketId is required" });
    return;
  }

  const config = loadConfig();
  const db = openDatabase(config);
  try {
    const previous = getLatestDecision(db, marketId);
    if (!previous) {
      sendJson(response, 404, { error: "Run a fresh scan before simulating this market" });
      return;
    }
    const refreshedMarket = await refreshExecutableQuotes(config, previous.market);
    const ranking = rankMarket(config, refreshedMarket, previous.estimate);
    const assessment = assessPaperBet(config, db, ranking);
    if (!assessment.order) {
      sendJson(response, 409, { error: "Paper order blocked", blockers: assessment.blockers, ranking });
      return;
    }
    const id = savePaperOrder(db, assessment.order);
    const pnl = getClosedPnl(db);
    saveBankrollSnapshot(db, config.bankrollEur, getOpenExposure(db), pnl.daily, pnl.total);
    sendJson(response, 201, { id, order: assessment.order, ranking });
  } catch (error) {
    recordError(db, "dashboard-paper-order", error, { marketId });
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  } finally {
    db.close();
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload));
}
