import type { AppConfig } from "../config";
import type { Db } from "../db";
import type { OpenPaperOrderRow } from "../db";
import {
  getDueForecastMarketIds,
  getOpenLiveOrders,
  getOpenPaperOrders,
  recordError,
  settleForecastRecords,
  settleLiveOrder,
  settlePaperOrder,
} from "../db";
import type { MarketResolution } from "../providers/polymarket/markets";
import { fetchMarketResolution } from "../providers/polymarket/markets";

export interface SettlementSummary {
  marketsChecked: number;
  marketsResolved: number;
  ordersSettled: number;
  liveOrdersSettled: number;
  forecastsSettled: number;
  realizedPnlEur: number;
  errors: number;
}

export interface OrderSettlement {
  orderId: number;
  marketId: string;
  outcome: "YES" | "NO";
  winningOutcome: string;
  won: boolean;
  stakeEur: number;
  payoutEur: number;
  pnlEur: number;
}

/**
 * Pure money-math: given a resolved market and the open orders on it, compute how each
 * position settles. Each winning share pays EUR 1; losers pay nothing. The stake was
 * already fee/slippage-adjusted at entry, so realized PnL = payout - stake. Returns an
 * empty list if the market is not cleanly resolved (fails closed).
 */
export function settleOrdersForResolution(
  resolution: MarketResolution,
  orders: OpenPaperOrderRow[],
): OrderSettlement[] {
  if (!resolution.resolved || !resolution.winningOutcome) return [];
  const winner = resolution.winningOutcome.trim().toUpperCase();
  return orders
    .filter((order) => order.market_id === resolution.marketId)
    .map((order) => {
      const won = order.outcome.toUpperCase() === winner;
      const payoutEur = won ? order.estimated_shares : 0;
      const pnlEur = Number((payoutEur - order.size_eur).toFixed(4));
      return {
        orderId: order.id,
        marketId: order.market_id,
        outcome: order.outcome,
        winningOutcome: winner,
        won,
        stakeEur: order.size_eur,
        payoutEur: Number(payoutEur.toFixed(4)),
        pnlEur,
      };
    });
}

/**
 * Closes open paper positions whose markets have officially resolved on Polymarket.
 * Each winning share pays EUR 1; a losing position pays nothing. The stake was already
 * fee- and slippage-adjusted at entry, so realized PnL = payout - stake.
 *
 * This is the loop that turns the bot from "places bets" into "has a track record":
 * without it, paper PnL stays at zero forever and the calibration report is empty.
 */
export async function settleResolvedMarkets(
  config: AppConfig,
  db: Db,
  options: { print?: boolean } = {},
): Promise<SettlementSummary> {
  if (options.print) console.log("[settle] loading open positions and due forecast markets");
  const openOrders = getOpenPaperOrders(db);
  const openLiveOrders = getOpenLiveOrders(db).filter((order) => order.status === "OPEN");
  const dueForecastMarkets = getDueForecastMarketIds(db);
  const marketIds = [
    ...new Set([
      ...openOrders.map((order) => order.market_id),
      ...openLiveOrders.map((order) => order.market_id),
      ...dueForecastMarkets,
    ]),
  ];
  const summary: SettlementSummary = {
    marketsChecked: marketIds.length,
    marketsResolved: 0,
    ordersSettled: 0,
    liveOrdersSettled: 0,
    forecastsSettled: 0,
    realizedPnlEur: 0,
    errors: 0,
  };
  if (options.print) {
    console.log(
      `[settle] checking ${marketIds.length} market(s): ` +
        `${openOrders.length} open paper, ${openLiveOrders.length} open live, ` +
        `${dueForecastMarkets.length} due forecast market(s)`,
    );
  }

  const progressEvery = Math.max(10, Math.ceil(marketIds.length / 10));
  for (const [index, marketId] of marketIds.entries()) {
    let resolution;
    try {
      resolution = await fetchMarketResolution(config, marketId);
    } catch (error) {
      summary.errors += 1;
      recordError(db, "settlement", error, { marketId });
      logSettlementProgress(options.print, index + 1, marketIds.length, progressEvery, summary);
      continue;
    }
    if (!resolution.resolved || !resolution.winningOutcome) {
      logSettlementProgress(options.print, index + 1, marketIds.length, progressEvery, summary);
      continue;
    }
    const settlements = settleOrdersForResolution(resolution, openOrders);
    summary.marketsResolved += 1;
    if (options.print) {
      console.log(`[settle] resolved ${resolution.marketId}: ${resolution.winningOutcome}`);
    }
    summary.forecastsSettled += settleForecastRecords(
      db,
      resolution.marketId,
      resolution.winningOutcome,
    );

    for (const settlement of settlements) {
      const recorded = settlePaperOrder(db, {
        orderId: settlement.orderId,
        marketId: settlement.marketId,
        outcome: settlement.outcome,
        winningOutcome: settlement.winningOutcome,
        source: "paper",
        stakeEur: settlement.stakeEur,
        payoutEur: settlement.payoutEur,
        pnlEur: settlement.pnlEur,
      });
      if (!recorded) continue;
      summary.ordersSettled += 1;
      summary.realizedPnlEur = Number((summary.realizedPnlEur + settlement.pnlEur).toFixed(4));
    }

    for (const order of openLiveOrders.filter((candidate) => candidate.market_id === marketId)) {
      const won = order.outcome.toUpperCase() === resolution.winningOutcome.toUpperCase();
      const payout = won ? Number(order.estimated_shares ?? 0) : 0;
      const pnl = Number((payout - order.size_eur).toFixed(4));
      if (!settleLiveOrder(db, order.id, pnl)) continue;
      summary.liveOrdersSettled += 1;
      summary.realizedPnlEur = Number((summary.realizedPnlEur + pnl).toFixed(4));
    }
    logSettlementProgress(options.print, index + 1, marketIds.length, progressEvery, summary);
  }

  if (options.print) {
    console.log(
      `[settle] complete: checked=${summary.marketsChecked}, resolved=${summary.marketsResolved}, ` +
        `paperClosed=${summary.ordersSettled}, liveClosed=${summary.liveOrdersSettled}, ` +
        `forecastsScored=${summary.forecastsSettled}, realizedPnL=EUR ${summary.realizedPnlEur.toFixed(2)}, ` +
        `errors=${summary.errors}`,
    );
  }
  return summary;
}

function logSettlementProgress(
  print: boolean | undefined,
  checked: number,
  total: number,
  progressEvery: number,
  summary: SettlementSummary,
): void {
  if (!print || (checked !== total && checked % progressEvery !== 0)) return;
  console.log(
    `[settle] checked ${checked}/${total}; resolved=${summary.marketsResolved}, ` +
      `paperClosed=${summary.ordersSettled}, liveClosed=${summary.liveOrdersSettled}, ` +
      `forecastsScored=${summary.forecastsSettled}, errors=${summary.errors}`,
  );
}
