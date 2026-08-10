import type { AppConfig } from "./config";
import { loadConfig } from "./config";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Db } from "./db";
import { finishBotRun, getClosedPnl, getOpenExposure, openDatabase, recordError, saveBankrollSnapshot, startBotRun } from "./db";
import { runDiagnostics } from "./diagnostics/diagnose";
import { logger } from "./logger";
import { runReport } from "./reports/report";
import { scanAndRank } from "./scanner";
import { closeOpenLivePositions, reviewOpenLivePositions, runArbOnly, runLiveCandidateSweep, runLiveOpportunityReport, runLiveReadinessCheck, runLiveTrading } from "./trading/liveTrader";
import { runPaperTrading } from "./trading/paperTrader";
import { settleResolvedMarkets } from "./trading/settlement";

const command = process.argv[2] ?? "help";
const config = loadConfig();

async function main(): Promise<void> {
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const db = openDatabase(config);
  const runId = startBotRun(db, command);
  let releaseLiveLock: (() => void) | undefined;
  try {
    if (requiresExclusiveLiveExecution(command, config)) {
      releaseLiveLock = acquireLiveExecutionLock(config);
    }
    switch (command) {
      case "diagnose":
        await runDiagnostics(config);
        break;
      case "settle":
        await runSettlement(config, db);
        break;
      case "scan":
        await runSettlement(config, db, { quiet: true });
        await scanAndRank(config, db, { print: true });
        break;
      case "paper":
        await runSettlement(config, db, { quiet: true });
        await runPaperTrading(config, db);
        break;
      case "trade":
        await runLiveTrading(config, db);
        break;
      case "live-check":
        await runLiveReadinessCheck(config, db);
        break;
      case "live-sweep":
        await runLiveCandidateSweep(config, db);
        break;
      case "arb":
        await runArbOnly(config, db);
        break;
      case "live-review-open":
        await reviewOpenLivePositions(config, db);
        break;
      case "live-opportunities":
        await runLiveOpportunityReport(config, db);
        break;
      case "live-close-open":
        await closeOpenLivePositions(config, db, { orderIds: parseOrderIds(process.argv.slice(3)) });
        break;
      case "daily":
        if (config.enableRealTrading && !config.dryRun) {
          await runLiveTrading(config, db);
        } else {
          await runPaperTrading(config, db);
        }
        break;
      case "report":
        runReport(config, db);
        break;
      default:
        printHelp();
        break;
    }
    finishBotRun(db, runId, "ok");
  } catch (error) {
    recordError(db, command, error);
    finishBotRun(db, runId, "error", { message: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    releaseLiveLock?.();
    db.close();
  }
}

function requiresExclusiveLiveExecution(commandName: string, config: AppConfig): boolean {
  if (["trade", "live-sweep", "arb", "live-close-open"].includes(commandName)) return true;
  return commandName === "daily" && config.enableRealTrading && !config.dryRun;
}

function acquireLiveExecutionLock(config: AppConfig): () => void {
  const logDirectory = path.join(config.projectRoot, "logs");
  mkdirSync(logDirectory, { recursive: true });
  const lockPath = path.join(logDirectory, "live-execution.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, command, startedAt: new Date().toISOString() }));
      closeSync(fd);
      return () => {
        try {
          const current = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
          if (current.pid === process.pid) unlinkSync(lockPath);
        } catch {
          // A missing/replaced lock is never deleted blindly.
        }
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      let existingPid: number | undefined;
      try {
        existingPid = Number((JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number }).pid);
      } catch {
        // Invalid lock contents are treated as stale below.
      }
      if (existingPid && isProcessAlive(existingPid)) {
        throw new Error(
          `Live execution refused: another Pollybot process (${existingPid}) owns ${lockPath}.`,
        );
      }
      // The recorded owner is gone. Removing this one exact lock file is safe and
      // recoverable by the next command; broad/glob deletion is intentionally avoided.
      unlinkSync(lockPath);
    }
  }
  throw new Error("Live execution refused: could not acquire the single-process lock.");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runSettlement(config: AppConfig, db: Db, options: { quiet?: boolean } = {}): Promise<void> {
  const summary = await settleResolvedMarkets(config, db);
  if (summary.ordersSettled > 0) {
    const pnl = getClosedPnl(db);
    saveBankrollSnapshot(db, config.bankrollEur, getOpenExposure(db), pnl.daily, pnl.total);
  }
  if (options.quiet) {
    if (summary.ordersSettled > 0 || summary.liveOrdersSettled > 0 || summary.forecastsSettled > 0) {
      console.log(
        `Settled ${summary.ordersSettled} paper position(s), ${summary.liveOrdersSettled} live position(s), and ${summary.forecastsSettled} shadow forecast(s) across ${summary.marketsResolved} resolved market(s): realized EUR ${summary.realizedPnlEur.toFixed(2)}.`,
      );
    }
    return;
  }
  console.log("Pollybot settlement");
  console.log("");
  console.log(`open markets checked: ${summary.marketsChecked}`);
  console.log(`markets resolved:     ${summary.marketsResolved}`);
  console.log(`positions settled:    ${summary.ordersSettled}`);
  console.log(`live positions closed:${summary.liveOrdersSettled}`);
  console.log(`forecasts scored:     ${summary.forecastsSettled}`);
  console.log(`realized PnL:         EUR ${summary.realizedPnlEur.toFixed(2)}`);
  if (summary.errors > 0) console.log(`resolution errors:    ${summary.errors} (logged, will retry next run)`);
  if (summary.marketsChecked === 0) console.log("No open paper positions to settle.");
}

function printHelp(): void {
  console.log("pollybot");
  console.log("");
  console.log("Commands:");
  console.log("  npm run diagnose  # Polymarket network/geoblock diagnostics");
  console.log("  npm run scan      # Settle resolved bets, then fetch, store, rank, and print markets");
  console.log("  npm run paper     # Settle resolved bets, then scan and simulate tiny paper bets only");
  console.log("  npm run settle    # Close paper positions whose markets have officially resolved");
  console.log("  npm run trade     # Refuses unless explicit live flags are set");
  console.log("  npm run live-check# Verify geoblock, wallet auth, balance, allowance, and account status");
  console.log("  npm run live-sweep# Re-check latest cached live candidates and try one bounded order");
  console.log("  npm run arb       # Scan negRisk events for locked-profit NO-basket arbitrage");
  console.log("  npm run live-review-open # Review locally open matched live positions without selling");
  console.log("  npm run live-opportunities # Explain near-term/live blockers and useful fixes");
  console.log("  npm run live-close-open # Sell locally open matched live positions at the current best bid");
  console.log("                          # Optional: npm run live-close-open -- 3 4");
  console.log("  npm run daily     # Scheduled entry point: paper by default, live only after explicit activation");
  console.log("  npm run report    # Show bankroll, exposure, bets, ROI, calibration, and skipped reasons");
  console.log("");
  console.log(`Safety: DRY_RUN=${config.dryRun} ENABLE_REAL_TRADING=${config.enableRealTrading} maxBet=EUR ${config.maxBetEur.toFixed(2)}`);
}

function parseOrderIds(args: string[]): number[] | undefined {
  const ids = args
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
  return ids.length > 0 ? ids : undefined;
}

main().catch((error) => {
  logger.error("Command failed", error);
  process.exitCode = 1;
});
