import type { AppConfig } from "../config";
import type { Db } from "../db";
import {
  FORECAST_MODEL_VERSION,
  getClosedLivePnl,
  getClosedPnl,
  getLiveStakeToday,
  getLiveCalibrationStats,
  getOpenLiveEventExposure,
  getOpenLiveExposure,
  getOpenExposure,
  getRecentLiveOrders,
  getRecentPaperOrders,
  hasRecentLiveOrder,
  hasRecentPaperOrder,
} from "../db";
import type { PaperOrderDecision, RankingResult } from "../types";
import { clamp, daysUntil } from "../utils";

export interface PaperBetAssessment {
  order?: PaperOrderDecision;
  blockers: string[];
}

export interface LiveExecutionThresholds {
  profile: "standard" | "intraday";
  minEdge: number;
  minConfidence: number;
  minPrice: number;
  maxPrice: number;
  maxStakeEur: number;
}

export function assessPaperBet(config: AppConfig, db: Db, ranking: RankingResult): PaperBetAssessment {
  return assessBet(config, db, ranking, "paper");
}

export function assessLiveBet(config: AppConfig, db: Db, ranking: RankingResult): PaperBetAssessment {
  return assessBet(config, db, ranking, "live");
}

function assessBet(
  config: AppConfig,
  db: Db,
  ranking: RankingResult,
  mode: "paper" | "live",
): PaperBetAssessment {
  const blockers: string[] = [];
  const quoteCapturedAt = ranking.market.quoteCapturedAt;
  const quoteAgeMs = quoteCapturedAt ? Date.now() - Date.parse(quoteCapturedAt) : Number.POSITIVE_INFINITY;
  const marketExposure =
    mode === "live"
      ? getOpenLiveExposure(db, ranking.market.marketId)
      : getOpenExposure(db, ranking.market.marketId);
  const openExposure = mode === "live" ? getOpenLiveExposure(db) : getOpenExposure(db);
  const eventExposure =
    mode === "live" ? getOpenLiveEventExposure(db, ranking.market.eventId) : 0;
  const eventExposureRoom =
    mode === "live" && ranking.market.eventId
      ? config.maxPerEventEur - eventExposure
      : Number.POSITIVE_INFINITY;
  const liveThresholds = mode === "live" ? getLiveExecutionThresholds(config, ranking) : undefined;
  const requiredEdge = liveThresholds?.minEdge ?? config.minEdge;
  const requiredConfidence = liveThresholds?.minConfidence ?? config.minConfidence;
  const maxStakeEur = liveThresholds?.maxStakeEur ?? config.maxBetEur;
  const pnl = mode === "live" ? getClosedLivePnl(db) : getClosedPnl(db);
  const liveWatchSkipsAreExecutable =
    ranking.skipReasons.length === 0 ||
    ranking.skipReasons.every((reason) =>
      reason === `spread above ${config.maxSpread}` || reason === `liquidity below ${config.minLiquidity}`,
    );

  const decisionAllowed =
    ranking.action === "PAPER_BET" ||
    ranking.action === "LIVE_BET" ||
    (mode === "live" &&
      ranking.action === "WATCH" &&
      ranking.edge.confidenceAdjustedEdge >= requiredEdge &&
      ranking.estimate.confidence >= requiredConfidence &&
      ranking.estimate.independentEvidenceCount >= config.minIndependentSources &&
      liveWatchSkipsAreExecutable);
  if (!decisionAllowed) blockers.push("decision is not a trade candidate");
  if (!ranking.edge.tokenId) blockers.push("selected outcome has no token ID");
  if (!quoteCapturedAt || !Number.isFinite(quoteAgeMs) || quoteAgeMs > config.maxQuoteAgeSeconds * 1000) {
    blockers.push(`order-book quote is older than ${config.maxQuoteAgeSeconds} seconds`);
  }
  if (marketExposure >= config.maxPerMarketEur) blockers.push("per-market exposure limit reached");
  if (mode === "live" && ranking.market.eventId && eventExposure >= config.maxPerEventEur) {
    blockers.push("per-event live exposure limit reached");
  }
  if (openExposure >= config.maxOpenExposureEur) blockers.push("total open-exposure limit reached");
  if (openExposure >= config.bankrollEur) blockers.push(`no uncommitted ${mode} bankroll remains`);
  if (pnl.daily <= -config.dailyLossLimitEur) blockers.push("daily loss limit reached");
  if (pnl.total <= -config.totalLossLimitEur) blockers.push("total loss limit reached");
  if (ranking.edge.confidenceAdjustedEdge < requiredEdge) blockers.push("net edge is below the configured minimum");
  if (ranking.estimate.confidence < requiredConfidence) blockers.push("forecast confidence is below the configured minimum");
  if (ranking.estimate.independentEvidenceCount < config.minIndependentSources) blockers.push("independent evidence requirement is not met");
  const cooldownMinutes =
    mode === "live" ? config.liveOrderCooldownMinutes : config.paperOrderCooldownMinutes;
  const hasRecent =
    mode === "live"
      ? hasRecentLiveOrder(db, ranking.market.marketId, ranking.edge.outcome, cooldownMinutes)
      : hasRecentPaperOrder(db, ranking.market.marketId, ranking.edge.outcome, cooldownMinutes);
  if (hasRecent) {
    blockers.push(`same-side ${mode} order exists inside the ${cooldownMinutes}-minute cooldown`);
  }

  if (mode === "live") {
    if (!config.enableDirectionalLiveTrading) {
      blockers.push("directional live trading is disabled");
    }
    blockers.push(...getCalibrationBlockers(config, db, ranking.market.category));

    const livePrice = ranking.edge.marketAskPrice;
    const minLivePrice = liveThresholds?.minPrice ?? config.liveMinPrice;
    const maxLivePrice = liveThresholds?.maxPrice ?? config.liveMaxPrice;
    if (livePrice < minLivePrice) {
      blockers.push(`live ask price ${livePrice.toFixed(3)} is below the ${minLivePrice} floor (fee/longshot guard)`);
    }
    if (livePrice > maxLivePrice) {
      blockers.push(`live ask price ${livePrice.toFixed(3)} is above the ${maxLivePrice} ceiling (fee/longshot guard)`);
    }
    // "Most likely winnable" gate: never buy a side the model itself thinks is more likely
    // to lose than win. Every realized live loss so far was a longshot/coin-flip buy
    // (BTC 150k @0.001, silver/crude longshots, 1C weather buckets, faded temperature
    // favorites). Backing only favorites is what turns the remaining bankroll into wins.
    if (ranking.edge.calibratedProbability < config.liveMinModelProbability) {
      blockers.push(
        `model win probability ${(ranking.edge.calibratedProbability * 100).toFixed(0)}% is below the ` +
          `${(config.liveMinModelProbability * 100).toFixed(0)}% favorite floor (only back more-likely-than-not outcomes)`,
      );
    }
    // Forecast-based temperature markets resolve on ONE specific station (e.g. an airport
    // via Wunderground) that our Open-Meteo grid-point forecast routinely misses by a few
    // degrees. That mismatch, not lead time, is why every live temperature bet lost
    // (Jeddah 40C+, London, Seoul 28C, Shenzhen 27C). Keep them research/paper-only.
    if (isForecastOnlyTemperatureMarket(ranking)) {
      blockers.push(
        hoursUntilEnd(ranking) < 24
          ? "same-day temperature markets need station observations, not forecast-only live execution"
          : "temperature markets resolve on a specific station our grid forecast cannot match; not live-traded",
      );
    }
    if (isSingleSourceWeatherLongshot(ranking)) {
      blockers.push("single-source weather model will not buy a less-than-even outcome");
    }

    const daysToEnd = daysUntil(ranking.market.endDate);
    const hoursToEnd = daysToEnd === undefined ? undefined : daysToEnd * 24;
    if (hoursToEnd === undefined) {
      blockers.push("live expiry window cannot be verified");
    } else {
      if (hoursToEnd < config.liveMinHoursToEnd) {
        blockers.push(`market ends inside the ${config.liveMinHoursToEnd}-hour live minimum`);
      }
      if (hoursToEnd > config.liveMaxHoursToEnd) {
        blockers.push(`market ends beyond the ${config.liveMaxHoursToEnd}-hour live expiry window`);
      }
    }

    const today = getLiveStakeToday(db);
    if (today.count >= config.maxLiveTradesPerDay) {
      blockers.push(`daily live-trade limit of ${config.maxLiveTradesPerDay} reached`);
    }
    if (today.stakeEur >= config.maxLiveStakePerDayEur) {
      blockers.push(`daily live-stake limit of EUR ${config.maxLiveStakePerDayEur.toFixed(2)} reached`);
    }
  }

  const recent = mode === "live" ? getRecentLiveOrders(db, 10) : getRecentPaperOrders(db, 10);
  const lossStreakCutoff = Date.now() - config.liveLossStreakLookbackHours * 3_600_000;
  const recentClosed = recent.filter((order) => {
    if (order.pnl_eur === null || order.pnl_eur === undefined) return false;
    if (mode === "live" && order.response_status?.startsWith("closed_via_sell:")) return false;
    // Only bets whose decision was made recently count toward the streak, so stale losses
    // from a since-fixed strategy can't freeze trading indefinitely.
    if (order.created_at && Date.parse(order.created_at) < lossStreakCutoff) return false;
    return true;
  });
  const recentLosses = recentClosed.slice(0, 3).filter((order) => Number(order.pnl_eur) < 0).length;
  if (recentLosses >= 3) blockers.push(`three most recent settled ${mode} bets were losses`);
  if (blockers.length > 0) return { blockers };

  const price = ranking.edge.marketAskPrice;
  const probability = ranking.edge.calibratedProbability;
  const costPerShare = price + ranking.edge.feeCost + ranking.edge.slippageCost;
  if (costPerShare >= 1 || probability <= costPerShare) return { blockers: ["fee-adjusted Kelly stake is not positive"] };

  const decimalProfit = (1 - costPerShare) / costPerShare;
  const fullKelly = Math.max(0, (decimalProfit * probability - (1 - probability)) / decimalProfit);
  // Fractional Kelly controls model-estimation risk. Exchange minimums must never
  // increase this risk budget; an undersized order is skipped instead of topped up.
  const kellyCap = config.bankrollEur * fullKelly * config.kellyFraction;
  const edgeScaledBase =
    config.baseBetEur *
    ((ranking.edge.confidenceAdjustedEdge + ranking.edge.uncertaintyCost) / Math.max(requiredEdge, 0.0001)) *
    (ranking.estimate.confidence / Math.max(requiredConfidence, 0.0001));
  let size = Math.min(kellyCap, edgeScaledBase, maxStakeEur);
  if (recentLosses === 1) size *= 0.75;
  if (recentLosses === 2) size *= 0.5;

  const depth =
    ranking.edge.outcome === "YES" ? ranking.market.yesAskDepthEur : ranking.market.noAskDepthEur;
  if (depth !== undefined) size = Math.min(size, depth);
  size = Math.min(
    size,
    maxStakeEur,
    config.maxPerMarketEur - marketExposure,
    eventExposureRoom,
    config.maxOpenExposureEur - openExposure,
    config.bankrollEur - openExposure,
  );
  if (mode === "live") {
    const today = getLiveStakeToday(db);
    size = Math.min(size, config.maxLiveStakePerDayEur - today.stakeEur);
  }
  size = clamp(size, 0, maxStakeEur);
  const localMinimumStake = mode === "live" ? config.liveMinStakeEur : 0.05;
  const minimumOrderShares =
    ranking.edge.outcome === "YES"
      ? ranking.market.yesMinOrderSizeShares
      : ranking.market.noMinOrderSizeShares;
  if (mode === "live" && minimumOrderShares !== undefined) {
    const minimumStake = Math.max(minimumOrderShares * costPerShare, config.liveMinStakeEur);
    const canTopUp =
      config.allowLiveMinOrderTopUp &&
      ranking.edge.confidenceAdjustedEdge >= config.minLiveTopUpEdge &&
      minimumStake <= maxStakeEur &&
      minimumStake <= config.bankrollEur * config.maxLiveTopUpBankrollFraction &&
      minimumStake <= config.maxPerMarketEur - marketExposure &&
      minimumStake <= eventExposureRoom &&
      minimumStake <= config.maxOpenExposureEur - openExposure &&
      minimumStake <= config.maxLiveStakePerDayEur - getLiveStakeToday(db).stakeEur &&
      (depth === undefined || minimumStake <= depth);
    if (size < minimumStake && canTopUp) {
      size = minimumStake;
    }
  }
  if (size < localMinimumStake) {
    return {
      blockers: [
        `risk-adjusted stake is below the EUR ${localMinimumStake.toFixed(2)} ${mode} minimum`,
      ],
    };
  }

  const estimatedShares = size / costPerShare;
  if (
    mode === "live" &&
    minimumOrderShares !== undefined &&
    estimatedShares + 1e-9 < minimumOrderShares
  ) {
    return {
      blockers: [
        `stake would buy ${estimatedShares.toFixed(2)} shares, below Polymarket's ${minimumOrderShares} share minimum`,
      ],
    };
  }
  const feeEur = estimatedShares * ranking.edge.feeCost;
  const decisionKey = `${ranking.market.marketId}:${ranking.edge.outcome}:${quoteCapturedAt}`;
  return {
    blockers: [],
    order: {
      marketId: ranking.market.marketId,
      outcome: ranking.edge.outcome,
      side: "BUY",
      tokenId: ranking.edge.tokenId!,
      price,
      sizeEur: Number(size.toFixed(2)),
      estimatedShares: Number(estimatedShares.toFixed(6)),
      edge: ranking.edge.confidenceAdjustedEdge,
      confidence: ranking.estimate.confidence,
      forecastProb: Number(probability.toFixed(6)),
      marketPriorProb: Number(ranking.edge.marketPriorProbability.toFixed(6)),
      feeEur: Number(feeEur.toFixed(4)),
      maxLossEur: Number(size.toFixed(2)),
      quoteCapturedAt: quoteCapturedAt!,
      decisionKey,
      modelVersion: FORECAST_MODEL_VERSION,
      reasoning: ranking.reason,
    },
  };
}

function getCalibrationBlockers(config: AppConfig, db: Db, category: string): string[] {
  // Tests and explicitly non-directional workflows may opt out with zero. loadConfig()
  // deliberately enforces a positive production minimum.
  if (config.liveCalibrationMinSettled <= 0) return [];
  const blockers: string[] = [];
  const global = getLiveCalibrationStats(db, undefined, config.liveCalibrationZScore);
  if (global.settledCount < config.liveCalibrationMinSettled) {
    blockers.push(
      `current model has ${global.settledCount}/${config.liveCalibrationMinSettled} settled out-of-sample forecasts`,
    );
  } else {
    if ((global.brierSkill ?? Number.NEGATIVE_INFINITY) < config.liveCalibrationMinBrierSkill) {
      blockers.push(
        `current model Brier skill ${formatPercent(global.brierSkill)} is below ${formatPercent(config.liveCalibrationMinBrierSkill)}`,
      );
    }
    if ((global.lowerConfidenceImprovement ?? Number.NEGATIVE_INFINITY) <= 0) {
      blockers.push("current model has no statistically positive Brier improvement over the market");
    }
  }

  const categoryStats = getLiveCalibrationStats(db, category, config.liveCalibrationZScore);
  if (categoryStats.settledCount < config.liveCalibrationMinCategorySettled) {
    blockers.push(
      `${category} model has ${categoryStats.settledCount}/${config.liveCalibrationMinCategorySettled} settled out-of-sample forecasts`,
    );
  } else {
    if ((categoryStats.brierSkill ?? Number.NEGATIVE_INFINITY) < config.liveCalibrationMinBrierSkill) {
      blockers.push(
        `${category} model Brier skill ${formatPercent(categoryStats.brierSkill)} is below ${formatPercent(config.liveCalibrationMinBrierSkill)}`,
      );
    }
    if ((categoryStats.lowerConfidenceImprovement ?? Number.NEGATIVE_INFINITY) <= 0) {
      blockers.push(`${category} model has no statistically positive Brier improvement over the market`);
    }
  }
  return blockers;
}

function formatPercent(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "unavailable" : `${(value * 100).toFixed(1)}%`;
}

export function sizePaperBet(config: AppConfig, db: Db, ranking: RankingResult): PaperOrderDecision | undefined {
  return assessPaperBet(config, db, ranking).order;
}

export function getLiveExecutionThresholds(
  config: AppConfig,
  ranking: RankingResult,
): LiveExecutionThresholds {
  const hours = hoursUntilEnd(ranking);
  const intraday =
    config.liveIntradayEnabled &&
    hours >= config.liveMinHoursToEnd &&
    hours <= config.liveIntradayMaxHours;
  if (!intraday) {
    return {
      profile: "standard",
      minEdge: config.minEdge,
      minConfidence: config.minConfidence,
      minPrice: config.liveMinPrice,
      maxPrice: config.liveMaxPrice,
      maxStakeEur: config.maxBetEur,
    };
  }
  return {
    profile: "intraday",
    minEdge: config.liveIntradayMinEdge,
    minConfidence: config.liveIntradayMinConfidence,
    minPrice: config.liveIntradayMinPrice,
    maxPrice: config.liveIntradayMaxPrice,
    maxStakeEur: Math.min(config.maxBetEur, config.liveIntradayMaxStakeEur),
  };
}

function hoursUntilEnd(ranking: RankingResult): number {
  const days = daysUntil(ranking.market.endDate);
  return days === undefined ? Number.POSITIVE_INFINITY : days * 24;
}

function isForecastOnlyTemperatureMarket(ranking: RankingResult): boolean {
  if (ranking.market.category !== "weather") return false;
  const isTemperature = /\b(highest|lowest|temperature|temp|degrees?|celsius|fahrenheit)\b|°/i.test(
    `${ranking.market.title} ${ranking.market.rules ?? ""}`,
  );
  if (!isTemperature) return false;
  return !ranking.estimate.method.includes("weather-ensemble-calibrated") &&
    !ranking.estimate.method.includes("station-observation");
}

function isSingleSourceWeatherLongshot(ranking: RankingResult): boolean {
  if (ranking.market.category !== "weather") return false;
  if (ranking.estimate.independentEvidenceCount > 1) return false;
  return ranking.edge.rawProbability < 0.5;
}
