import type { AppConfig } from "../config";
import type { Db } from "../db";
import { getClosedPnl, getOpenExposure, saveBankrollSnapshot, savePaperOrder } from "../db";
import { printPaperOrders } from "../format";
import { refreshExecutableQuotes } from "../providers/polymarket/orderbook";
import { rankMarket } from "../ranking/ranker";
import { scanAndRank } from "../scanner";
import { sizePaperBet } from "./riskManager";

export async function runPaperTrading(config: AppConfig, db: Db): Promise<void> {
  const rankings = await scanAndRank(config, db, { print: true });
  const placed: Array<{ title: string; outcome: string; sizeEur: number; price: number; shares: number; edge: number; reason: string }> = [];

  for (const ranking of rankings) {
    if (placed.length >= 10) break;
    if (!shouldRefreshForPaperExecution(config, ranking)) continue;
    let refreshedRanking;
    try {
      const market = await refreshExecutableQuotes(config, ranking.market);
      refreshedRanking = rankMarket(config, market, ranking.estimate);
    } catch {
      // Execution always fails closed when a fresh two-sided book cannot be verified.
      continue;
    }
    const order = sizePaperBet(config, db, refreshedRanking);
    if (!order) continue;
    savePaperOrder(db, order);
    placed.push({
      title: refreshedRanking.market.title,
      outcome: order.outcome,
      sizeEur: order.sizeEur,
      price: order.price,
      shares: order.estimatedShares,
      edge: order.edge,
      reason: order.reasoning,
    });
  }

  const pnl = getClosedPnl(db);
  saveBankrollSnapshot(db, config.bankrollEur, getOpenExposure(db), pnl.daily, pnl.total);
  printPaperOrders(placed);
}

function shouldRefreshForPaperExecution(config: AppConfig, ranking: Awaited<ReturnType<typeof scanAndRank>>[number]): boolean {
  if (ranking.action === "PAPER_BET") return true;
  if (ranking.action !== "WATCH") return false;
  if (!ranking.edge.tokenId) return false;
  if (ranking.edge.confidenceAdjustedEdge < config.minEdge) return false;
  const quoteOnlySkips = new Set([
    `liquidity below ${config.minLiquidity}`,
    `spread above ${config.maxSpread}`,
  ]);
  return ranking.skipReasons.length > 0 && ranking.skipReasons.every((reason) => quoteOnlySkips.has(reason));
}
