import type { AppConfig } from "../config";
import type { Db } from "../db";
import {
  getArbCandidateEvents,
  getArbEventMarkets,
  getOpenArbExposure,
  hasOpenArbOnEvent,
  retagArbOrderAsOrphan,
  saveLiveOrder,
  settleLiveOrder,
  updateLiveOrderStatus,
} from "../db";
import { fetchBestBidAsk } from "../providers/polymarket/orderbook";
import type { createAuthenticatedClobClient } from "../providers/polymarket/orders";
import {
  getLiveAccountSnapshot,
  placeLiveMarketSellOrder,
  placeLiveShareBuyOrder,
} from "../providers/polymarket/orders";
import { toNumber } from "../utils";

type LiveClient = Awaited<ReturnType<typeof createAuthenticatedClobClient>>;

/**
 * NO-basket arbitrage on negRisk events.
 *
 * Polymarket negRisk events group mutually exclusive outcomes: at most one of them
 * resolves YES. Buying s NO shares on each of m of those outcomes therefore pays at
 * least s * (m - 1) at resolution, no matter which outcome wins. Whenever the sum of
 * the m best NO asks is below (m - 1), the difference is locked-in profit at entry.
 * Because the payout floor comes from exclusivity alone, any subset of the event's
 * outcomes works; the event does not need to be covered exhaustively.
 */
export interface ArbLegQuote {
  marketId: string;
  title: string;
  tokenId: string;
  noAsk: number;
  noBid?: number;
  noAskDepthShares: number;
  minOrderShares: number;
  tickSize: string;
  negRisk: boolean;
  feeRateBps?: number;
}

export interface ArbPlan {
  legs: ArbLegQuote[];
  shares: number;
  askSum: number;
  feePerShareSum: number;
  totalCostEur: number;
  guaranteedPayoutEur: number;
  guaranteedProfitEur: number;
  profitFraction: number;
}

export interface ArbPlanLimits {
  maxLegs: number;
  maxStakeEur: number;
  minProfitEur: number;
  minEdgeFraction: number;
  minOrderNotionalEur?: number;
}

const DEFAULT_MIN_ORDER_NOTIONAL_EUR = 1;
const MAX_BOOKS_PER_EVENT = 12;

export function planNoArbBasket(quotes: ArbLegQuote[], limits: ArbPlanLimits): ArbPlan | undefined {
  const usable = quotes
    .filter(
      (quote) =>
        quote.negRisk &&
        Number.isFinite(quote.noAsk) &&
        quote.noAsk > 0 &&
        quote.noAsk < 1 &&
        quote.noAskDepthShares > 0,
    )
    .sort((left, right) => left.noAsk - right.noAsk);
  const minNotional = limits.minOrderNotionalEur ?? DEFAULT_MIN_ORDER_NOTIONAL_EUR;
  let best: ArbPlan | undefined;

  for (let legCount = 2; legCount <= Math.min(limits.maxLegs, usable.length); legCount += 1) {
    const legs = usable.slice(0, legCount);
    const askSum = legs.reduce((sum, leg) => sum + leg.noAsk, 0);
    const feePerShareSum = legs.reduce(
      (sum, leg) =>
        sum + (leg.feeRateBps ?? 0) / 10_000 * leg.noAsk * (1 - leg.noAsk),
      0,
    );
    const perShareCost = askSum + feePerShareSum;
    const perShareProfit = legCount - 1 - perShareCost;
    if (perShareProfit <= 0) continue;

    const cheapestAsk = legs[0]!.noAsk;
    const minShares = Math.max(
      ...legs.map((leg) => leg.minOrderShares),
      minNotional / cheapestAsk,
    );
    const maxShares = Math.min(
      ...legs.map((leg) => leg.noAskDepthShares),
      limits.maxStakeEur / perShareCost,
    );
    const shares = Math.floor(maxShares * 100) / 100;
    if (shares < minShares) continue;

    const totalCostEur = shares * perShareCost;
    const guaranteedPayoutEur = shares * (legCount - 1);
    const guaranteedProfitEur = guaranteedPayoutEur - totalCostEur;
    if (guaranteedProfitEur < limits.minProfitEur) continue;
    if (guaranteedProfitEur < limits.minEdgeFraction * totalCostEur) continue;

    if (!best || guaranteedProfitEur > best.guaranteedProfitEur) {
      best = {
        legs,
        shares,
        askSum,
        feePerShareSum,
        totalCostEur,
        guaranteedPayoutEur,
        guaranteedProfitEur,
        profitFraction: guaranteedProfitEur / totalCostEur,
      };
    }
  }
  return best;
}

export async function runArbSweep(config: AppConfig, db: Db, client: LiveClient): Promise<void> {
  if (!config.arbEnabled) return;

  let collateral: number;
  try {
    collateral = (await getLiveAccountSnapshot(client)).collateralBalance;
  } catch (error) {
    console.log(`[arb] skipped: collateral could not be verified (${describe(error)})`);
    return;
  }
  const openArb = getOpenArbExposure(db);
  const budget = Math.min(config.arbMaxOpenEur - openArb, collateral - 0.1, config.arbMaxStakeEur);
  if (budget < 2 * DEFAULT_MIN_ORDER_NOTIONAL_EUR) {
    console.log(
      `[arb] skipped: budget EUR ${budget.toFixed(2)} is below the 2-leg minimum ` +
        `(open arb EUR ${openArb.toFixed(2)} / ${config.arbMaxOpenEur.toFixed(2)}, collateral ${collateral.toFixed(2)})`,
    );
    return;
  }

  const events = getArbCandidateEvents(db, {
    maxHoursToEnd: config.arbMaxDaysToEnd * 24,
    minYesBidSum: 0.98,
    maxStaleHours: 24,
    limit: config.arbEventScanLimit,
  });
  console.log(
    `[arb] scanning ${events.length} candidate event(s) for NO-basket arbs; ` +
      `budget EUR ${budget.toFixed(2)}, min profit EUR ${config.arbMinProfitEur.toFixed(2)}`,
  );

  let executedSets = 0;
  for (const event of events) {
    if (hasOpenArbOnEvent(db, event.event_id)) continue;

    const rows = getArbEventMarkets(db, event.event_id).slice(0, MAX_BOOKS_PER_EVENT);
    if (rows.length < 2) continue;

    const quotes: ArbLegQuote[] = [];
    for (const row of rows) {
      try {
        const [book, feeRateBps] = await Promise.all([
          fetchBestBidAsk(config, row.no_token_id),
          client.getFeeRateBps(row.no_token_id),
        ]);
        if (book.ask === undefined) continue;
        quotes.push({
          marketId: row.market_id,
          title: row.question,
          tokenId: row.no_token_id,
          noAsk: book.ask,
          noBid: book.bid,
          noAskDepthShares: sharesAtPrice(book.raw?.asks, book.ask),
          minOrderShares: toNumber(book.raw?.min_order_size) ?? 5,
          tickSize: book.raw?.tick_size ?? "0.01",
          negRisk: Boolean(book.raw?.neg_risk),
          feeRateBps,
        });
      } catch {
        // A missing book just removes one leg from the basket candidates.
      }
    }

    const plan = planNoArbBasket(quotes, {
      maxLegs: config.arbMaxLegs,
      maxStakeEur: budget,
      minProfitEur: config.arbMinProfitEur,
      minEdgeFraction: config.arbMinEdgeFraction,
    });
    if (!plan) {
      const near = bestAskSumSummary(quotes, config.arbMaxLegs);
      if (near) console.log(`[arb] event ${event.event_id}: no executable basket (${near})`);
      continue;
    }

    console.log(
      `[arb] executing ${plan.legs.length}-leg NO basket on event ${event.event_id}: ` +
        `${plan.shares.toFixed(2)} shares/leg, fee-aware cost EUR ${plan.totalCostEur.toFixed(2)}, ` +
        `guaranteed payout EUR ${plan.guaranteedPayoutEur.toFixed(2)} ` +
        `(locked profit EUR ${plan.guaranteedProfitEur.toFixed(2)}, ${(plan.profitFraction * 100).toFixed(1)}%)`,
    );
    for (const leg of plan.legs) {
      console.log(`[arb]   NO @ ${leg.noAsk.toFixed(3)} "${leg.title.slice(0, 70)}"`);
    }
    const executed = await executeArbPlan(config, db, client, event.event_id, plan);
    if (executed) executedSets += 1;
    // One set per sweep keeps collateral verification honest between sets.
    if (executed) break;
  }

  console.log(
    executedSets > 0
      ? `[arb] sweep complete: ${executedSets} arbitrage set(s) executed.`
      : "[arb] sweep complete: no basket met the locked-profit thresholds.",
  );
}

async function executeArbPlan(
  config: AppConfig,
  db: Db,
  client: LiveClient,
  eventId: string,
  plan: ArbPlan,
): Promise<boolean> {
  const filled: Array<{
    localOrderId: number;
    leg: ArbLegQuote;
    amountEur: number;
    executedShares: number;
    executedPrice: number;
  }> = [];
  let aborted = false;

  for (const leg of plan.legs) {
    const estimatedFeeEur =
      plan.shares * ((leg.feeRateBps ?? 0) / 10_000) * leg.noAsk * (1 - leg.noAsk);
    const amountEur = Number((plan.shares * leg.noAsk + estimatedFeeEur).toFixed(5));
    const decisionKey = `arb:${eventId}:${leg.marketId}:${Date.now()}`;
    const localOrderId = saveLiveOrder(db, {
      marketId: leg.marketId,
      outcome: "NO",
      side: "BUY",
      tokenId: leg.tokenId,
      price: leg.noAsk,
      sizeEur: amountEur,
      estimatedShares: plan.shares,
      edge: plan.profitFraction,
      confidence: 1,
      forecastProb: 1 - leg.noAsk,
      marketPriorProb: 1 - leg.noAsk,
      feeEur: 0,
      maxLossEur: amountEur,
      quoteCapturedAt: new Date().toISOString(),
      decisionKey,
      modelVersion: "arb-no-basket-v1",
      reasoning:
        `NO-basket arb on event ${eventId}: ${plan.legs.length} mutually exclusive legs, ` +
        `ask sum ${plan.askSum.toFixed(4)} vs guaranteed ${plan.legs.length - 1} per share.`,
      status: "PENDING",
    });

    try {
      const result = await placeLiveShareBuyOrder(config, client, {
        tokenId: leg.tokenId,
        shares: plan.shares,
        maxPrice: roundPriceUpToTick(leg.noAsk, leg.tickSize),
        tickSize: leg.tickSize,
        negRisk: true,
      });
      const localStatus = result.filled
        ? "OPEN"
        : result.responseStatus === "unmatched"
          ? "VOID"
          : result.responseStatus === "failed"
            ? "FAILED"
            : "PENDING";
      updateLiveOrderStatus(db, localOrderId, {
        status: localStatus,
        externalOrderId: result.orderId,
        responseStatus: result.responseStatus,
        executedPrice: result.executedPrice,
        executedShares: result.executedShares,
        executedFeeEur: result.executedFeeEur,
      });
      if (!result.filled) {
        console.log(`[arb] leg not confirmed (${result.responseStatus}) on "${leg.title.slice(0, 60)}"; aborting basket.`);
        if (localStatus === "PENDING") {
          // A submitted order can still confirm after our polling deadline. Do
          // not sell earlier legs while that outcome is unknown: quarantine the
          // entire partial basket under directional exposure and let startup
          // reconciliation resolve the pending order before any more trading.
          retagArbOrderAsOrphan(db, localOrderId);
          for (const prior of filled) retagArbOrderAsOrphan(db, prior.localOrderId);
          console.log(
            `[arb] submission state is unresolved; ${filled.length + 1} leg(s) quarantined and new trading is blocked pending reconciliation.`,
          );
          return false;
        }
        aborted = true;
        break;
      }
      if (!result.executedShares || !result.executedPrice) {
        throw new Error("confirmed arb leg did not return auditable fill quantity and price");
      }
      filled.push({
        localOrderId,
        leg,
        amountEur: Math.max(
          amountEur,
          result.executedShares * result.executedPrice + (result.executedFeeEur ?? Number.POSITIVE_INFINITY),
        ),
        executedShares: result.executedShares,
        executedPrice: result.executedPrice,
      });
    } catch (error) {
      updateLiveOrderStatus(db, localOrderId, { status: "FAILED", errorMessage: describe(error) });
      console.log(`[arb] leg failed on "${leg.title.slice(0, 60)}": ${describe(error)}; aborting basket.`);
      aborted = true;
      break;
    }
  }

  if (!aborted) {
    const totalShares = filled.reduce((sum, leg) => sum + leg.executedShares, 0);
    const largestLeg = Math.max(...filled.map((leg) => leg.executedShares));
    const conservativeCost = filled.reduce((sum, leg) => sum + leg.amountEur, 0);
    const guaranteedPayout = totalShares - largestLeg;
    const guaranteedProfit = guaranteedPayout - conservativeCost;
    if (
      guaranteedProfit >= config.arbMinProfitEur &&
      guaranteedProfit >= config.arbMinEdgeFraction * conservativeCost
    ) {
      console.log(
        `[arb] basket confirmed: ${filled.length} leg(s); audited locked profit EUR ${guaranteedProfit.toFixed(2)} until resolution.`,
      );
      return true;
    }
    console.log(
      `[arb] confirmed fills no longer meet the locked-profit floor (profit EUR ${guaranteedProfit.toFixed(4)}); unwinding.`,
    );
    aborted = true;
  }
  if (filled.length === 0) return false;

  console.log(`[arb] unwinding ${filled.length} already-filled leg(s) at best bid.`);
  for (const { localOrderId, leg, amountEur, executedShares } of filled) {
    try {
      const book = await fetchBestBidAsk(config, leg.tokenId);
      if (book.bid === undefined) throw new Error("no exit bid available");
      const result = await placeLiveMarketSellOrder(config, client, {
        tokenId: leg.tokenId,
        shares: executedShares,
        minPrice: roundPriceDownToTick(book.bid, leg.tickSize),
        tickSize: leg.tickSize,
        negRisk: true,
      });
      if (!result.filled) throw new Error(`unwind order status ${result.responseStatus}`);
      const proceeds = (result.executedShares ?? executedShares) * (result.executedPrice ?? book.bid);
      settleLiveOrder(db, localOrderId, Number((proceeds - amountEur).toFixed(4)), "closed_via_sell:arb_unwind");
      console.log(`[arb]   unwound "${leg.title.slice(0, 60)}" at ${book.bid.toFixed(3)}.`);
    } catch (error) {
      // The leg stays open as a directional position; retag it so directional
      // exposure limits see it and settlement closes it at resolution.
      retagArbOrderAsOrphan(db, localOrderId);
      console.log(
        `[arb]   WARNING: could not unwind "${leg.title.slice(0, 60)}" (${describe(error)}); ` +
          `leg now counts as directional exposure and settles at resolution.`,
      );
    }
  }
  return false;
}

function sharesAtPrice(entries: Array<{ price: string; size: string }> | undefined, price: number): number {
  return (entries ?? [])
    .filter((entry) => toNumber(entry.price) === price)
    .reduce((sum, entry) => sum + (toNumber(entry.size) ?? 0), 0);
}

function bestAskSumSummary(quotes: ArbLegQuote[], maxLegs: number): string | undefined {
  const usable = quotes
    .filter((quote) => quote.negRisk && quote.noAsk > 0 && quote.noAsk < 1)
    .sort((left, right) => left.noAsk - right.noAsk);
  if (usable.length < 2) return undefined;
  const legs = usable.slice(0, Math.min(maxLegs, usable.length));
  const askSum = legs.reduce((sum, leg) => sum + leg.noAsk, 0);
  return `best ${legs.length}-leg ask sum ${askSum.toFixed(4)} vs ${(legs.length - 1).toFixed(0)} payout`;
}

function roundPriceUpToTick(price: number, tickSizeValue: string): number {
  const tickSize = Number(tickSizeValue);
  if (!Number.isFinite(tickSize) || tickSize <= 0) return Number(price.toFixed(4));
  const decimals = Math.max(0, (tickSizeValue.split(".")[1] ?? "").length);
  return Number((Math.ceil(price / tickSize - 1e-9) * tickSize).toFixed(decimals));
}

function roundPriceDownToTick(price: number, tickSizeValue: string): number {
  const tickSize = Number(tickSizeValue);
  if (!Number.isFinite(tickSize) || tickSize <= 0) return Number(price.toFixed(4));
  const decimals = Math.max(0, (tickSizeValue.split(".")[1] ?? "").length);
  return Number((Math.floor(price / tickSize + 1e-9) * tickSize).toFixed(decimals));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
