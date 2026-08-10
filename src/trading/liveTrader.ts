import type { AppConfig } from "../config";
import { assertDirectionalLiveTradingAllowed, assertLiveTradingAllowed } from "../config";
import type { Db } from "../db";
import {
  getLatestLiveCandidateRankings,
  getLatestDecision,
  getLiveCalibrationStats,
  getOpenLiveOrders,
  getOpenLiveExposure,
  saveLiveOrder,
  settleLiveOrder,
  updateLiveOrderStatus,
} from "../db";
import { checkGeoblock } from "../providers/polymarket/geoblock";
import { refreshExecutableQuoteForOutcome, refreshExecutableQuotes } from "../providers/polymarket/orderbook";
import {
  createAuthenticatedClobClient,
  getConditionalTokenBalance,
  getLiveAccountSnapshot,
  getLiveOrderExecutions,
  placeLiveMarketOrder,
  placeLiveMarketSellOrder,
} from "../providers/polymarket/orders";
import { estimateProbability } from "../probability/heuristics";
import { rankMarket } from "../ranking/ranker";
import { scanAndRank } from "../scanner";
import { collectCheapSources } from "../sources";
import type { RankingResult } from "../types";
import { daysUntil } from "../utils";
import { runArbSweep } from "./arbTrader";
import { assessLiveBet, getLiveExecutionThresholds } from "./riskManager";
import { settleResolvedMarkets } from "./settlement";

export async function runLiveTrading(config: AppConfig, db: Db): Promise<void> {
  const session = await prepareLiveSession(config, db, { settle: true });
  if (!session) return;

  console.log(
    `Starting live scan with ${session.account.collateralBalance.toFixed(2)} collateral available; ` +
      `hard daily stake limit EUR ${config.maxLiveStakePerDayEur.toFixed(2)}.`,
  );
  const rankings = await scanAndRank(config, db, { print: true });
  await executeLiveRankings(config, db, session.client, session.account.collateralBalance, rankings);
  await runArbSweepSafely(config, db, session.client);
}

export async function runLiveCandidateSweep(config: AppConfig, db: Db): Promise<void> {
  const session = await prepareLiveSession(config, db, { settle: false });
  if (!session) return;
  const rankings = getLatestLiveCandidateRankings(
    db,
    config.liveSweepCandidateLimit,
    config.liveNearTermMaxHours,
  );
  if (rankings.length === 0) {
    console.log("Live sweep complete: no cached live candidates. Run a full scan first.");
    await runArbSweepSafely(config, db, session.client);
    return;
  }
  console.log(
    `Starting live sweep over ${rankings.length} cached candidate(s) with ` +
      `${session.account.collateralBalance.toFixed(2)} collateral available; ` +
      `prioritizing <= ${config.liveNearTermMaxHours}h markets first.`,
  );
  await executeLiveRankings(config, db, session.client, session.account.collateralBalance, rankings, { refreshEvidence: true });
  await runArbSweepSafely(config, db, session.client);
}

export async function runArbOnly(config: AppConfig, db: Db): Promise<void> {
  const session = await prepareLiveSession(config, db, { settle: false });
  if (!session) return;
  if (!config.arbEnabled) {
    console.log("[arb] ARB_ENABLED is not true; nothing to do.");
    return;
  }
  await runArbSweepSafely(config, db, session.client);
}

async function runArbSweepSafely(
  config: AppConfig,
  db: Db,
  client: Awaited<ReturnType<typeof createAuthenticatedClobClient>>,
): Promise<void> {
  if (!config.arbEnabled) return;
  try {
    await runArbSweep(config, db, client);
  } catch (error) {
    console.log(`[arb] sweep failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function runLiveOpportunityReport(config: AppConfig, db: Db): Promise<void> {
  const session = await prepareLiveSession(config, db, { settle: false });
  if (!session) return;

  const cached = getLatestLiveCandidateRankings(
    db,
    config.liveSweepCandidateLimit,
    config.liveNearTermMaxHours,
  );
  const rankings = orderLiveRankings(config, cached).slice(0, config.liveOpportunityReportLimit);
  const blockerCounts = new Map<string, number>();
  const fixCounts = new Map<string, number>();
  const ready: string[] = [];
  const blocked: string[] = [];

  console.log("Live opportunity report");
  console.log("");
  console.log(`cached candidates inspected: ${rankings.length}/${cached.length}`);
  console.log(`near-term window: <= ${config.liveNearTermMaxHours}h; intraday lane: ${config.liveIntradayEnabled ? "ON" : "off"}`);
  console.log(`collateral available: ${session.account.collateralBalance.toFixed(2)}; local open exposure: EUR ${getOpenLiveExposure(db).toFixed(2)}`);
  console.log("");

  for (const ranking of rankings) {
    let evidenceRanking = ranking;
    try {
      evidenceRanking = await refreshRankingEvidence(config, db, ranking);
    } catch {
      // Keep the cached snapshot; the assessment below will still explain stale or missing evidence.
    }

    let assessedRanking = evidenceRanking;
    if (evidenceRanking.edge.tokenId) {
      try {
        const market = await refreshExecutableQuoteForOutcome(config, evidenceRanking.market, evidenceRanking.edge.outcome);
        assessedRanking = rankMarket(config, market, evidenceRanking.estimate);
      } catch {
        // Quote-refresh failures are reported through stale quote / no-depth blockers where applicable.
      }
    }

    const thresholds = getLiveExecutionThresholds(config, assessedRanking);
    const assessment = assessLiveBet(config, db, assessedRanking);
    const line =
      `"${shortTitle(assessedRanking.market.title)}" ${assessedRanking.edge.outcome} ` +
      `end=${formatHoursUntil(assessedRanking)} profile=${thresholds.profile} ` +
      `ask=${assessedRanking.edge.marketAskPrice.toFixed(3)} edge=${assessedRanking.edge.confidenceAdjustedEdge.toFixed(4)} ` +
      `conf=${assessedRanking.estimate.confidence.toFixed(3)}`;

    if (assessment.order) {
      const localExposure = getOpenLiveExposure(db);
      const spendable = Math.min(
        session.account.collateralBalance,
        config.bankrollEur - localExposure,
        config.maxOpenExposureEur - localExposure,
      );
      if (assessment.order.sizeEur <= spendable) {
        ready.push(`${line} -> stake EUR ${assessment.order.sizeEur.toFixed(2)}`);
        continue;
      }
      const blocker = `verified spendable collateral ${spendable.toFixed(2)} is below stake ${assessment.order.sizeEur.toFixed(2)}`;
      blockerCounts.set(blocker, (blockerCounts.get(blocker) ?? 0) + 1);
      const fixes = [...new Set(fixesForBlocker(blocker))];
      for (const fix of fixes) fixCounts.set(fix, (fixCounts.get(fix) ?? 0) + 1);
      blocked.push(`${line}\n  blocked: ${blocker}\n  fix: ${fixes.join(" | ")}`);
      continue;
    }

    const blockers = assessment.blockers.length > 0 ? assessment.blockers : ["not selected for live execution"];
    for (const blocker of blockers) blockerCounts.set(blocker, (blockerCounts.get(blocker) ?? 0) + 1);
    const fixes = [...new Set(blockers.flatMap((blocker) => fixesForBlocker(blocker)))];
    for (const fix of fixes) fixCounts.set(fix, (fixCounts.get(fix) ?? 0) + 1);
    blocked.push(`${line}\n  blocked: ${blockers.join("; ")}\n  fix: ${fixes.join(" | ")}`);
  }

  console.log("Ready now:");
  if (ready.length === 0) console.log("  none");
  for (const row of ready.slice(0, 10)) console.log(`  ${row}`);

  console.log("");
  console.log("Closest blocked opportunities:");
  if (blocked.length === 0) console.log("  none");
  for (const row of blocked.slice(0, 20)) console.log(`  ${row}`);

  console.log("");
  console.log(`Top blockers: ${formatTopBlockers(blockerCounts) || "none"}`);
  console.log(`Most useful fixes: ${formatTopBlockers(fixCounts) || "none"}`);
  printBroadUntradeableSummary(db);
}

export async function closeOpenLivePositions(
  config: AppConfig,
  db: Db,
  options: { orderIds?: number[] } = {},
): Promise<void> {
  const session = await prepareLiveSession(config, db, { settle: false });
  if (!session) return;

  const requestedIds = new Set(options.orderIds ?? []);
  const openOrders = getOpenLiveOrders(db)
    .filter((order) => order.status === "OPEN")
    .filter((order) => requestedIds.size === 0 || requestedIds.has(order.id));
  if (openOrders.length === 0) {
    console.log(
      requestedIds.size > 0
        ? "Live close complete: none of the requested order IDs are locally open matched positions."
        : "Live close complete: no locally open matched live positions.",
    );
    return;
  }

  let closed = 0;
  for (const group of groupOpenOrdersByToken(openOrders)) {
    const orderIds = group.orders.map((order) => order.id).join(", ");

    const balanceShares = await getConditionalTokenBalance(session.client, group.tokenId);
    const localShareEstimate = group.orders.reduce((sum, order) => sum + localEstimatedShares(order), 0);
    const sharesToSell = roundShares(
      requestedIds.size > 0 ? Math.min(balanceShares, localShareEstimate) : balanceShares,
    );
    if (sharesToSell <= 0) {
      console.log(`Live close blocked for local order(s) ${orderIds}: no conditional-token balance found.`);
      continue;
    }

    const book = await session.client.getOrderBook(group.tokenId);
    const bestBid = [...(book.bids ?? [])].sort((a, b) => Number(b.price) - Number(a.price))[0];
    if (!bestBid) {
      console.log(`Live close blocked for local order(s) ${orderIds}: no executable bid is currently available.`);
      continue;
    }

    const tickSize = (await session.client.getTickSize(group.tokenId)) ?? "0.01";
    const minPrice = roundSellPriceToTick(Number(bestBid.price), tickSize);
    const bidDepthShares = Number(bestBid.size);
    if (!Number.isFinite(minPrice) || minPrice <= 0) {
      console.log(`Live close blocked for local order(s) ${orderIds}: best bid price is invalid.`);
      continue;
    }
    if (!Number.isFinite(bidDepthShares) || bidDepthShares + 1e-9 < sharesToSell) {
      console.log(
        `Live close blocked for local order(s) ${orderIds}: best bid depth ${bestBid.size} is below ${sharesToSell.toFixed(6)} shares.`,
      );
      continue;
    }

    const result = await placeLiveMarketSellOrder(config, session.client, {
      tokenId: group.tokenId,
      shares: sharesToSell,
      minPrice,
      tickSize,
      negRisk: await session.client.getNegRisk(group.tokenId),
    });

    if (!result.filled) {
      console.log(
        `Polymarket accepted close order ${result.orderId} with status ${result.responseStatus}; local position(s) ${orderIds} remain open.`,
      );
      continue;
    }

    const estimatedProceeds = sharesToSell * minPrice;
    const totalStake = group.orders.reduce((sum, order) => sum + order.size_eur, 0);
    for (const order of group.orders) {
      const share = totalStake > 0 ? order.size_eur / totalStake : 1 / group.orders.length;
      const estimatedPnl = Number((estimatedProceeds * share - order.size_eur).toFixed(4));
      if (settleLiveOrder(db, order.id, estimatedPnl, `closed_via_sell:${result.responseStatus}`)) {
        closed += 1;
      }
    }
    console.log(
      `Closed live position(s) ${orderIds}: sold ${sharesToSell.toFixed(6)} shares at min ${minPrice.toFixed(4)}, ` +
        `estimated combined PnL EUR ${(estimatedProceeds - totalStake).toFixed(2)}, close order ${result.orderId}.`,
    );
  }

  console.log(
    closed > 0
      ? `Live close complete: ${closed} position(s) closed.`
      : "Live close complete: no positions were closed.",
  );
}

export async function reviewOpenLivePositions(config: AppConfig, db: Db): Promise<void> {
  const session = await prepareLiveSession(config, db, { settle: false });
  if (!session) return;

  const openOrders = getOpenLiveOrders(db).filter((order) => order.status === "OPEN");
  if (openOrders.length === 0) {
    console.log("Live position review: no locally open matched live positions.");
    return;
  }

  console.log(`Live position review: ${openOrders.length} locally open matched position(s).`);
  for (const group of groupOpenOrdersByToken(openOrders)) {
    const orderIds = group.orders.map((order) => order.id).join(", ");
    const first = group.orders[0]!;
    const latest = getLatestDecision(db, first.market_id);
    const reviewed = latest ? await refreshReviewRanking(config, db, latest).catch(() => latest) : undefined;
    const title = reviewed?.market.title ?? first.market_id;
    const balanceShares = await getConditionalTokenBalance(session.client, group.tokenId).catch(() => 0);
    const book = await session.client.getOrderBook(group.tokenId).catch(() => undefined);
    const bestBid = [...(book?.bids ?? [])].sort((a, b) => Number(b.price) - Number(a.price))[0];
    const bidPrice = bestBid ? Number(bestBid.price) : undefined;
    const localStake = group.orders.reduce((sum, order) => sum + order.size_eur, 0);
    const localShares = group.orders.reduce((sum, order) => sum + localEstimatedShares(order), 0);
    const exitShares = Math.min(balanceShares, localShares || balanceShares);
    const exitValue = bidPrice && Number.isFinite(bidPrice) ? exitShares * bidPrice : undefined;
    const estimatedPnl = exitValue === undefined ? undefined : exitValue - localStake;
    const heldProbability =
      reviewed && first.outcome === "YES"
        ? reviewed.estimate.estimatedYesProbability
        : reviewed
          ? reviewed.estimate.estimatedNoProbability
          : undefined;
    const closeFlags = [
      reviewed && reviewed.edge.outcome !== first.outcome && reviewed.edge.confidenceAdjustedEdge >= config.minEdge
        ? `latest model favors ${reviewed.edge.outcome}`
        : undefined,
      bidPrice === undefined ? "no current exit bid" : undefined,
      heldProbability !== undefined && heldProbability < 0.08 ? "held side now has very low model probability" : undefined,
    ].filter((flag): flag is string => Boolean(flag));

    console.log("");
    console.log(`#${orderIds} ${first.outcome} ${title}`);
    console.log(`  local stake EUR ${localStake.toFixed(2)}; local shares ${localShares.toFixed(6)}; wallet shares ${balanceShares.toFixed(6)}`);
    console.log(
      bidPrice === undefined
        ? "  exit: no bid available"
        : `  exit: best bid ${bidPrice.toFixed(4)}, estimated value EUR ${exitValue!.toFixed(2)}, estimated PnL EUR ${estimatedPnl!.toFixed(2)}`,
    );
    console.log(
      heldProbability === undefined
        ? "  model: no latest local model snapshot"
        : `  model: held-side raw probability ${(heldProbability * 100).toFixed(1)}%; best current side ${reviewed!.edge.outcome}`,
    );
    console.log(`  flags: ${closeFlags.length > 0 ? closeFlags.join("; ") : "none"}`);
  }
}

async function refreshReviewRanking(
  config: AppConfig,
  db: Db,
  latest: NonNullable<ReturnType<typeof getLatestDecision>>,
): Promise<NonNullable<ReturnType<typeof getLatestDecision>>> {
  return refreshRankingEvidence(config, db, latest);
}

async function refreshRankingEvidence(
  config: AppConfig,
  db: Db,
  latest: Awaited<ReturnType<typeof scanAndRank>>[number],
): Promise<Awaited<ReturnType<typeof scanAndRank>>[number]> {
  const sources = await collectCheapSources(config, db, latest.market);
  const estimate = estimateProbability(config, latest.market, sources);
  return rankMarket(config, latest.market, estimate);
}

function groupOpenOrdersByToken(orders: ReturnType<typeof getOpenLiveOrders>): Array<{
  tokenId: string;
  orders: ReturnType<typeof getOpenLiveOrders>;
}> {
  const groups = new Map<string, ReturnType<typeof getOpenLiveOrders>>();
  for (const order of orders) {
    if (!order.token_id) {
      console.log(`Live close blocked for local order ${order.id}: missing token ID.`);
      continue;
    }
    const existing = groups.get(order.token_id) ?? [];
    existing.push(order);
    groups.set(order.token_id, existing);
  }
  return [...groups.entries()].map(([tokenId, groupedOrders]) => ({ tokenId, orders: groupedOrders }));
}

function localEstimatedShares(order: ReturnType<typeof getOpenLiveOrders>[number]): number {
  if (order.estimated_shares !== null && order.estimated_shares !== undefined && Number.isFinite(order.estimated_shares)) {
    return Number(order.estimated_shares);
  }
  return order.price > 0 ? order.size_eur / order.price : 0;
}

async function prepareLiveSession(
  config: AppConfig,
  db: Db,
  options: { settle: boolean },
): Promise<{ client: Awaited<ReturnType<typeof createAuthenticatedClobClient>>; account: Awaited<ReturnType<typeof getLiveAccountSnapshot>> } | undefined> {
  try {
    assertLiveTradingAllowed(config);
  } catch (error) {
    console.log("Live trading refused.");
    console.log(error instanceof Error ? error.message : String(error));
    return;
  }

  console.log(`[live] preparing live session; settlement=${options.settle ? "on" : "off"}`);
  const geo = await checkGeoblock(config);
  if (!geo.ok || geo.blocked) {
    console.log("Live trading refused.");
    console.log(
      geo.ok
        ? `Polymarket geoblock reports blocked for ${geo.country ?? "unknown"} ${geo.region ?? ""}.`
        : "The official geoblock endpoint could not be verified.",
    );
    return;
  }

  if (options.settle) await settleResolvedMarkets(config, db, { print: true });

  let client;
  try {
    client = await createAuthenticatedClobClient(config);
  } catch (error) {
    console.log("Live trading refused: wallet authentication failed.");
    console.log(error instanceof Error ? error.message : String(error));
    return;
  }

  let account;
  try {
    account = await getLiveAccountSnapshot(client);
  } catch (error) {
    console.log("Live trading refused: balance, allowance, and account status could not be verified.");
    console.log(error instanceof Error ? error.message : String(error));
    return;
  }
  if (account.closedOnly) {
    console.log("Live trading refused: Polymarket reports this account is close-only.");
    return;
  }
  if (account.collateralBalance < 0.05) {
    console.log("Live trading refused: available collateral is below 0.05.");
    return;
  }
  if (account.minimumAllowance < 0.05) {
    console.log("Live trading refused: collateral allowance is below 0.05.");
    return;
  }

  const pendingReady = await reconcilePendingLiveOrders(db, client);
  if (!pendingReady) {
    console.log(
      "Live trading refused: at least one prior order is still unconfirmed; no new cash will be risked.",
    );
    return;
  }

  return { client, account };
}

async function reconcilePendingLiveOrders(
  db: Db,
  client: Awaited<ReturnType<typeof createAuthenticatedClobClient>>,
): Promise<boolean> {
  const pending = getOpenLiveOrders(db).filter((order) => order.status === "PENDING");
  if (pending.length === 0) return true;
  const withRemoteId = pending.filter((order) => Boolean(order.external_order_id));
  if (withRemoteId.length > 0) {
    const executions = await getLiveOrderExecutions(
      client,
      withRemoteId.map((order) => order.external_order_id!),
    );
    for (const order of withRemoteId) {
      const execution = executions.get(order.external_order_id!);
      if (execution?.state === "confirmed") {
        updateLiveOrderStatus(db, order.id, {
          status: "OPEN",
          responseStatus: "confirmed",
          executedPrice: execution.executedPrice,
          executedShares: execution.executedShares,
          executedFeeEur: execution.executedFeeEur,
        });
      } else if (execution?.state === "failed") {
        updateLiveOrderStatus(db, order.id, {
          status: "FAILED",
          responseStatus: "failed",
          errorMessage: "remote trade reached terminal FAILED status",
        });
      }
    }
  }
  const unresolved = getOpenLiveOrders(db).filter((order) => order.status === "PENDING");
  if (unresolved.length > 0) {
    console.log(
      `[live] reconciliation left ${unresolved.length} pending order(s); manual/API confirmation is required.`,
    );
    return false;
  }
  console.log(`[live] reconciled ${pending.length} pending order(s) against confirmed trade history.`);
  return true;
}

async function executeLiveRankings(
  config: AppConfig,
  db: Db,
  client: Awaited<ReturnType<typeof createAuthenticatedClobClient>>,
  collateralBalance: number,
  rankings: Awaited<ReturnType<typeof scanAndRank>>,
  options: { refreshEvidence?: boolean } = {},
): Promise<void> {
  try {
    assertDirectionalLiveTradingAllowed(config);
  } catch (error) {
    console.log(
      `[live] directional model execution disabled: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  const placed: Array<{
    title: string;
    outcome: string;
    sizeEur: number;
    price: number;
    orderId: string;
  }> = [];
  let remainingCollateral = collateralBalance;
  const orderedRankings = orderLiveRankings(config, rankings);
  const nearTermCount = orderedRankings.filter((ranking) => isNearTermLiveMarket(config, ranking)).length;
  const stats = {
    considered: 0,
    skippedBeforeQuote: 0,
    evidenceRefreshed: 0,
    quoteRefreshed: 0,
    quoteRefreshFailed: 0,
    riskBlocked: 0,
    duplicateBlocked: 0,
    submitted: 0,
    failed: 0,
  };
  const blockerCounts = new Map<string, number>();
  console.log(
    `[live] evaluating ${orderedRankings.length} ranked candidate(s); nearTerm<=${config.liveNearTermMaxHours}h=${nearTermCount}; ` +
      `refreshEvidence=${Boolean(options.refreshEvidence)}; ` +
      `local exposure EUR ${getOpenLiveExposure(db).toFixed(2)} / ${config.maxOpenExposureEur.toFixed(2)}; ` +
      `per-event cap EUR ${config.maxPerEventEur.toFixed(2)}`,
  );

  for (const ranking of orderedRankings) {
    if (placed.length >= config.maxLiveTradesPerDay) break;
    stats.considered += 1;

    let evidenceRanking = ranking;
    if (options.refreshEvidence) {
      try {
        evidenceRanking = await refreshRankingEvidence(config, db, ranking);
        stats.evidenceRefreshed += 1;
      } catch (error) {
        console.log(
          `Evidence refresh failed for "${ranking.market.title}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
    }

    if (!shouldRefreshForLiveExecution(config, evidenceRanking)) {
      stats.skippedBeforeQuote += 1;
      continue;
    }

    let refreshedRanking;
    try {
      const market = await refreshExecutableQuotes(config, evidenceRanking.market);
      refreshedRanking = rankMarket(config, market, evidenceRanking.estimate);
      stats.quoteRefreshed += 1;
    } catch (error) {
      try {
        const market = await refreshExecutableQuoteForOutcome(config, evidenceRanking.market, evidenceRanking.edge.outcome);
        refreshedRanking = rankMarket(config, market, evidenceRanking.estimate);
        stats.quoteRefreshed += 1;
      } catch (fallbackError) {
        stats.quoteRefreshFailed += 1;
        console.log(
          `Quote refresh failed for "${evidenceRanking.market.title}": ${
            fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          }`,
        );
        continue;
      }
    }

    const assessment = assessLiveBet(config, db, refreshedRanking);
    if (assessment.blockers.length > 0 || !assessment.order) {
      stats.riskBlocked += 1;
      for (const blocker of assessment.blockers) {
        blockerCounts.set(blocker, (blockerCounts.get(blocker) ?? 0) + 1);
      }
      console.log(
        `Live candidate blocked: "${shortTitle(refreshedRanking.market.title)}" ` +
          `${refreshedRanking.edge.outcome} edge=${refreshedRanking.edge.confidenceAdjustedEdge.toFixed(4)} ` +
          `conf=${refreshedRanking.estimate.confidence.toFixed(3)}: ${assessment.blockers.join("; ")}`,
      );
      continue;
    }
    const order = assessment.order;
    const localExposure = getOpenLiveExposure(db);
    const spendable = Math.min(
      remainingCollateral,
      config.bankrollEur - localExposure,
      config.maxOpenExposureEur - localExposure,
    );
    if (order.sizeEur > spendable) {
      stats.riskBlocked += 1;
      const blocker = `verified spendable collateral ${spendable.toFixed(2)} is below stake ${order.sizeEur.toFixed(2)}`;
      blockerCounts.set(blocker, (blockerCounts.get(blocker) ?? 0) + 1);
      console.log(
        `Live candidate blocked: "${shortTitle(refreshedRanking.market.title)}": ${blocker}.`,
      );
      continue;
    }

    let localOrderId: number;
    try {
      localOrderId = saveLiveOrder(db, {
        marketId: order.marketId,
        outcome: order.outcome,
        side: "BUY",
        tokenId: order.tokenId,
        price: order.price,
        sizeEur: order.sizeEur,
        estimatedShares: order.estimatedShares,
        edge: order.edge,
        confidence: order.confidence,
        forecastProb: order.forecastProb,
        marketPriorProb: order.marketPriorProb,
        feeEur: order.feeEur,
        maxLossEur: order.maxLossEur,
        quoteCapturedAt: order.quoteCapturedAt,
        decisionKey: order.decisionKey,
        modelVersion: order.modelVersion,
        reasoning: order.reasoning,
        status: "PENDING",
      });
    } catch (error) {
      stats.duplicateBlocked += 1;
      console.log(
        `Live candidate blocked: its decision key is already reserved (${error instanceof Error ? error.message : String(error)}).`,
      );
      continue;
    }

    const tickSize =
      order.outcome === "YES"
        ? refreshedRanking.market.yesTickSize ?? "0.01"
        : refreshedRanking.market.noTickSize ?? "0.01";
    const maxPrice = roundPriceToTick(
      Math.min(0.99, order.price + config.slippageBuffer),
      tickSize,
    );

    try {
      stats.submitted += 1;
      const result = await placeLiveMarketOrder(config, client, {
        tokenId: order.tokenId,
        amountEur: order.sizeEur,
        maxPrice,
        tickSize,
        negRisk: Boolean(refreshedRanking.market.negRisk),
      });
      const localStatus =
        result.responseStatus === "confirmed"
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
        console.log(
          `Polymarket accepted order ${result.orderId} with status ${result.responseStatus}; no filled position was recorded yet.`,
        );
        if (localStatus === "PENDING") {
          console.log("Live evaluation stopped until the accepted order reaches a terminal trade status.");
          break;
        }
        continue;
      }

      remainingCollateral -= order.sizeEur;
      placed.push({
        title: refreshedRanking.market.title,
        outcome: order.outcome,
        sizeEur: order.sizeEur,
        price: maxPrice,
        orderId: result.orderId,
      });
      console.log(
        `Live FOK order confirmed: ${order.outcome} on "${refreshedRanking.market.title}", ` +
          `stake ${order.sizeEur.toFixed(2)}, max price ${maxPrice.toFixed(4)}, order ${result.orderId}.`,
      );
    } catch (error) {
      stats.failed += 1;
      updateLiveOrderStatus(db, localOrderId, {
        status: "FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      console.log(
        `Live order failed for "${refreshedRanking.market.title}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  console.log(
    `[live] evaluation summary: considered=${stats.considered}, prefilter-skipped=${stats.skippedBeforeQuote}, ` +
      `evidence-refreshed=${stats.evidenceRefreshed}, quote-refreshed=${stats.quoteRefreshed}, ` +
      `quote-failed=${stats.quoteRefreshFailed}, risk-blocked=${stats.riskBlocked}, ` +
      `duplicates=${stats.duplicateBlocked}, submitted=${stats.submitted}, matched=${placed.length}, failed=${stats.failed}`,
  );
  if (blockerCounts.size > 0) {
    console.log(`[live] top blockers: ${formatTopBlockers(blockerCounts)}`);
  }
  console.log(
    placed.length > 0
      ? `Live run complete: ${placed.length} matched order(s).`
      : "Live run complete: no order met every evidence, price, account, and risk gate.",
  );
}

function orderLiveRankings(config: AppConfig, rankings: RankingResult[]): RankingResult[] {
  return [...rankings].sort((left, right) => {
    const leftExecutable = shouldRefreshForLiveExecution(config, left) ? 0 : 1;
    const rightExecutable = shouldRefreshForLiveExecution(config, right) ? 0 : 1;
    if (leftExecutable !== rightExecutable) return leftExecutable - rightExecutable;

    const leftAction = left.action === "LIVE_BET" ? 0 : 1;
    const rightAction = right.action === "LIVE_BET" ? 0 : 1;
    if (leftAction !== rightAction) return leftAction - rightAction;

    // Spend scarce collateral on risk-adjusted expected return, not on the shortest
    // expiry or the highest nominal win probability. A 90% outcome bought at 95 cents is
    // worse than a well-supported 65% outcome at 50 cents even though it "wins" more.
    const leftOpportunity = robustOpportunityScore(left);
    const rightOpportunity = robustOpportunityScore(right);
    if (Math.abs(leftOpportunity - rightOpportunity) > 1e-9) return rightOpportunity - leftOpportunity;

    const leftNearTerm = isNearTermLiveMarket(config, left) ? 0 : 1;
    const rightNearTerm = isNearTermLiveMarket(config, right) ? 0 : 1;
    if (leftNearTerm !== rightNearTerm) return leftNearTerm - rightNearTerm;
    const leftHours = hoursUntilMarketEnd(left);
    const rightHours = hoursUntilMarketEnd(right);
    if (leftHours !== rightHours) return leftHours - rightHours;
    return right.finalScore - left.finalScore;
  });
}

function robustOpportunityScore(ranking: RankingResult): number {
  const cost = Math.max(
    0.03,
    ranking.edge.marketAskPrice + ranking.edge.feeCost + ranking.edge.slippageCost,
  );
  const edgeReturn = ranking.edge.confidenceAdjustedEdge / cost;
  const depth = ranking.edge.outcome === "YES" ? ranking.market.yesAskDepthEur : ranking.market.noAskDepthEur;
  const liquidityBonus = Math.log1p(Math.max(0, depth ?? ranking.market.liquidity ?? 0)) * 0.002;
  const hours = hoursUntilMarketEnd(ranking);
  const lockupPenalty = Number.isFinite(hours) ? Math.min(0.03, Math.sqrt(Math.max(0, hours) / 24) * 0.002) : 0.03;
  return edgeReturn * ranking.estimate.confidence + liquidityBonus - lockupPenalty;
}

function isNearTermLiveMarket(config: AppConfig, ranking: RankingResult): boolean {
  const hours = hoursUntilMarketEnd(ranking);
  return hours >= config.liveMinHoursToEnd && hours <= config.liveNearTermMaxHours;
}

function hoursUntilMarketEnd(ranking: RankingResult): number {
  const days = daysUntil(ranking.market.endDate);
  return days === undefined ? Number.POSITIVE_INFINITY : days * 24;
}

function shortTitle(title: string): string {
  return title.length <= 90 ? title : `${title.slice(0, 87)}...`;
}

function formatTopBlockers(counts: Map<string, number>): string {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([blocker, count]) => `${count}x ${blocker}`)
    .join(" | ");
}

function shouldRefreshForLiveExecution(config: AppConfig, ranking: Awaited<ReturnType<typeof scanAndRank>>[number]): boolean {
  const thresholds = getLiveExecutionThresholds(config, ranking);
  if (ranking.action === "LIVE_BET") return true;
  if (ranking.action !== "WATCH") return false;
  if (!ranking.edge.tokenId) return false;
  if (ranking.edge.confidenceAdjustedEdge < thresholds.minEdge) return false;
  if (ranking.estimate.confidence < thresholds.minConfidence) return false;
  if (ranking.skipReasons.length === 0) return true;
  const quoteOnlySkips = new Set([
    `liquidity below ${config.minLiquidity}`,
    `spread above ${config.maxSpread}`,
  ]);
  return ranking.skipReasons.length > 0 && ranking.skipReasons.every((reason) => quoteOnlySkips.has(reason));
}

function formatHoursUntil(ranking: RankingResult): string {
  const hours = hoursUntilMarketEnd(ranking);
  if (!Number.isFinite(hours)) return "unknown";
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function fixesForBlocker(blocker: string): string[] {
  if (blocker.includes("probability estimator marked data insufficient")) {
    return ["build a category-specific model/source instead of using the generic fallback"];
  }
  if (blocker.includes("no independent evidence source")) {
    return ["add a source connector/manual note for this category"];
  }
  if (blocker.includes("not a binary YES/NO CLOB market")) {
    return ["skip multi-outcome/non-CLOB markets or add explicit outcome mapping"];
  }
  if (blocker.includes("market end time is unavailable")) {
    return ["skip until Polymarket exposes a reliable end time"];
  }
  if (blocker.includes("resolution rules are unclear")) {
    return ["skip or add manual research notes for the market rules"];
  }
  if (blocker.includes("forecast confidence")) {
    return ["add a stronger source/API for this market type or lower LIVE_INTRADAY_MIN_CONFIDENCE"];
  }
  if (blocker.includes("net edge")) {
    return ["wait for a better price or lower the relevant edge threshold"];
  }
  if (blocker.includes("below the") && blocker.includes("floor")) {
    return ["lower LIVE_INTRADAY_MIN_PRICE/LIVE_MIN_PRICE only if accepting penny-longshot risk"];
  }
  if (blocker.includes("above the") && blocker.includes("ceiling")) {
    return ["raise LIVE_INTRADAY_MAX_PRICE/LIVE_MAX_PRICE only if accepting near-certain-price risk"];
  }
  if (blocker.includes("independent evidence")) {
    return ["add a source connector/manual note for this category"];
  }
  if (blocker.includes("decision is not a trade candidate")) {
    return ["use intraday lane for near-term markets or improve model evidence"];
  }
  if (blocker.includes("per-event")) {
    return ["raise MAX_PER_EVENT_EUR or reduce existing exposure in that event"];
  }
  if (blocker.includes("per-market")) {
    return ["raise MAX_PER_MARKET_EUR or reduce that market exposure"];
  }
  if (blocker.includes("total open-exposure")) {
    return ["raise MAX_OPEN_EXPOSURE_EUR or close current positions"];
  }
  if (blocker.includes("daily live-trade")) {
    return ["raise MAX_LIVE_TRADES_PER_DAY"];
  }
  if (blocker.includes("daily live-stake")) {
    return ["raise MAX_LIVE_STAKE_PER_DAY_EUR"];
  }
  if (blocker.includes("cooldown")) {
    return ["lower LIVE_ORDER_COOLDOWN_MINUTES"];
  }
  if (blocker.includes("share minimum") || blocker.includes("risk-adjusted stake")) {
    return ["raise LIVE_INTRADAY_MAX_STAKE_EUR/MAX_BET_EUR or keep skipping exchange-minimum-oversized bets"];
  }
  if (blocker.includes("quote is older")) {
    return ["refresh CLOB quote or wait for the next sweep"];
  }
  if (blocker.includes("liquidity") || blocker.includes("spread")) {
    return ["wait for better order-book depth or loosen liquidity/spread settings"];
  }
  return ["review the market-specific blocker before loosening gates"];
}

function printBroadUntradeableSummary(db: Db): void {
  const rows = db.prepare(`
    WITH latest_batch AS (
      SELECT scan_batch_id
      FROM latest_rankings
      WHERE scan_batch_id IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1
    )
    SELECT r.action, r.reason, COUNT(*) AS count
    FROM latest_rankings r
    JOIN latest_batch b ON b.scan_batch_id = r.scan_batch_id
    WHERE r.action IN ('SKIP', 'UNMODELED')
    GROUP BY r.action, r.reason
    ORDER BY count DESC
    LIMIT 12
  `).all() as Array<{ action: string; reason: string; count: number }>;

  console.log("");
  console.log("Broad untradeable scan categories:");
  if (rows.length === 0) {
    console.log("  none");
    return;
  }
  for (const row of rows) {
    const fixes = [...new Set(row.reason.split("; ").flatMap((reason) => fixesForBlocker(reason)))];
    console.log(`  ${row.count}x ${row.action}: ${row.reason}`);
    console.log(`     fix: ${fixes.join(" | ")}`);
  }
}

function roundPriceToTick(price: number, tickSizeValue: string): number {
  const tickSize = Number(tickSizeValue);
  if (!Number.isFinite(tickSize) || tickSize <= 0) return Number(price.toFixed(4));
  const decimals = Math.max(0, (tickSizeValue.split(".")[1] ?? "").length);
  return Number((Math.ceil(price / tickSize) * tickSize).toFixed(decimals));
}

function roundSellPriceToTick(price: number, tickSizeValue: string): number {
  const tickSize = Number(tickSizeValue);
  if (!Number.isFinite(tickSize) || tickSize <= 0) return Number(price.toFixed(4));
  const decimals = Math.max(0, (tickSizeValue.split(".")[1] ?? "").length);
  return Number((Math.floor(price / tickSize) * tickSize).toFixed(decimals));
}

function roundShares(shares: number): number {
  if (!Number.isFinite(shares) || shares <= 0) return 0;
  return Math.floor(shares * 1_000_000) / 1_000_000;
}

export async function runLiveReadinessCheck(config: AppConfig, db: Db): Promise<void> {
  console.log("Pollybot live readiness");
  console.log("");
  console.log(`dry run:                 ${config.dryRun}`);
  console.log(`real trading flag:       ${config.enableRealTrading}`);
  console.log(`directional live flag:   ${config.enableDirectionalLiveTrading}`);
  console.log(`configured bankroll:     EUR ${config.bankrollEur.toFixed(2)}`);
  console.log(`maximum single stake:    EUR ${config.maxBetEur.toFixed(2)}`);
  console.log(`maximum daily live stake:EUR ${config.maxLiveStakePerDayEur.toFixed(2)}`);
  console.log(`maximum open exposure:   EUR ${config.maxOpenExposureEur.toFixed(2)}`);
  console.log(`local open live exposure:EUR ${getOpenLiveExposure(db).toFixed(2)}`);
  let directionalConfigError: string | undefined;
  try {
    assertDirectionalLiveTradingAllowed(config);
  } catch (error) {
    directionalConfigError = error instanceof Error ? error.message : String(error);
  }
  const calibration = getLiveCalibrationStats(db, undefined, config.liveCalibrationZScore);
  const calibrationReady =
    calibration.settledCount >= config.liveCalibrationMinSettled &&
    (calibration.brierSkill ?? Number.NEGATIVE_INFINITY) >= config.liveCalibrationMinBrierSkill &&
    (calibration.lowerConfidenceImprovement ?? Number.NEGATIVE_INFINITY) > 0;
  console.log(
    `current-model calibration:${calibration.settledCount} settled, skill ${formatOptionalPercent(calibration.brierSkill)}, ` +
      `confidence-bound ${formatSigned(calibration.lowerConfidenceImprovement)}`,
  );
  console.log(
    `directional model gate:   ${!directionalConfigError && calibrationReady ? "READY globally (category gate still applies)" : "BLOCKED"}`,
  );
  if (directionalConfigError) console.log(`directional config:       ${directionalConfigError}`);

  const geo = await checkGeoblock(config);
  console.log(
    `geoblock:                ${
      geo.ok
        ? `${geo.blocked ? "BLOCKED" : "allowed"} (${geo.country ?? "unknown"}/${geo.region ?? "unknown"}, ${geo.resolver ?? "system"})`
        : `unverified (${geo.error ?? "unknown error"})`
    }`,
  );

  if (!config.polymarketPrivateKey) {
    console.log("wallet authentication:   missing POLYMARKET_PRIVATE_KEY");
    console.log("result: NOT READY; no real order can be submitted.");
    return;
  }

  try {
    const client = await createAuthenticatedClobClient(config);
    const account = await getLiveAccountSnapshot(client);
    console.log("wallet authentication:   OK");
    console.log(`collateral available:     ${account.collateralBalance.toFixed(2)}`);
    console.log(`minimum allowance:        ${account.minimumAllowance.toFixed(2)}`);
    console.log(`account close-only:       ${account.closedOnly}`);
    console.log(`remote open orders:       ${account.openOrderCount}`);
    const ready =
      geo.ok &&
      !geo.blocked &&
      !account.closedOnly &&
      account.collateralBalance >= 0.05 &&
      account.minimumAllowance >= 0.05;
    console.log(
      `result: ${
        ready
          ? "ACCOUNT READY; directional bets remain subject to risk and calibration gates."
          : "NOT READY"
      }`,
    );
  } catch (error) {
    console.log(`wallet/account check:     FAILED (${error instanceof Error ? error.message : String(error)})`);
    console.log("result: NOT READY; no real order can be submitted.");
  }
}

function formatOptionalPercent(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "unavailable" : `${(value * 100).toFixed(1)}%`;
}

function formatSigned(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "unavailable" : value.toFixed(5);
}
