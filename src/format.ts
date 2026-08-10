import type { RankingResult } from "./types";
import { formatMoney, formatPct, formatSigned } from "./utils";

export function printTopMarkets(rankings: RankingResult[], limit = 20): void {
  console.log("");
  console.log("Top candidate markets:");
  console.log("");

  for (const [index, ranking] of rankings.slice(0, limit).entries()) {
    const market = ranking.market;
    console.log(`${index + 1}. ${market.title}`);
    console.log(`   category: ${market.category}`);
    console.log(
      `   side: ${ranking.edge.outcome} | ask: ${formatMoney(ranking.edge.marketAskPrice)} | raw fair: ${formatPct(ranking.edge.rawProbability)} | net edge: ${formatSigned(ranking.edge.confidenceAdjustedEdge)}`,
    );
    console.log(
      `   confidence: ${formatPct(ranking.estimate.confidence)} | liquidity: ${formatMoney(market.liquidity)} | spread: ${formatMoney(market.spread)} | final: ${ranking.finalScore.toFixed(1)}`,
    );
    console.log(`   action: ${ranking.action}`);
    console.log(`   reason: ${ranking.reason}`);
    if (market.url) console.log(`   url: ${market.url}`);
    console.log("");
  }
}

export function printPaperOrders(orders: Array<{ title: string; outcome: string; sizeEur: number; price: number; shares: number; edge: number; reason: string }>): void {
  console.log("");
  console.log("Paper orders:");
  if (orders.length === 0) {
    console.log("No paper orders qualified under the current edge, confidence, and risk limits.");
    return;
  }
  for (const [index, order] of orders.entries()) {
    console.log(`${index + 1}. ${order.title}`);
    console.log(`   ${order.outcome} | size: EUR ${order.sizeEur.toFixed(2)} | price: ${order.price.toFixed(3)} | shares: ${order.shares.toFixed(4)} | edge: ${formatSigned(order.edge)}`);
    console.log(`   reason: ${order.reason}`);
  }
}
