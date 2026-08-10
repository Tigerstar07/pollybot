import type { AppConfig } from "../config";
import type { EdgeEstimate, NormalizedMarket, ProbabilityEstimate, RankingResult, TradeOutcome } from "../types";
import { clamp, daysUntil } from "../utils";

export function rankMarket(config: AppConfig, market: NormalizedMarket, estimate: ProbabilityEstimate): RankingResult {
  const yesEdge = calculateEdge(config, market, estimate, "YES");
  const noEdge = calculateEdge(config, market, estimate, "NO");
  const edge = yesEdge.confidenceAdjustedEdge >= noEdge.confidenceAdjustedEdge ? yesEdge : noEdge;

  const liquidityScore = scoreLiquidity(market);
  const clarityScore = scoreClarity(market);
  const dataAvailabilityScore = clamp(estimate.dataQuality * 70 + estimate.independentEvidenceCount * 15, 0, 100);
  const timeHorizonScore = scoreTimeHorizon(market);
  const edgePotentialScore = clamp((edge.confidenceAdjustedEdge / Math.max(config.minEdge, 0.01)) * 80, 0, 100);
  const riskScore = scoreRisk(market);
  const skipReasons = getSkipReasons(config, market, estimate, clarityScore, riskScore);
  const baseFinalScore = clamp(
    liquidityScore * 0.18 +
      clarityScore * 0.18 +
      dataAvailabilityScore * 0.2 +
      timeHorizonScore * 0.12 +
      edgePotentialScore * 0.22 +
      (100 - riskScore) * 0.1,
    0,
    100,
  );
  const finalScore = clamp(baseFinalScore - skipReasons.length * 9 - (market.status !== "open" ? 35 : 0), 0, 100);
  const qualifies =
    skipReasons.length === 0 &&
    edge.confidenceAdjustedEdge >= config.minEdge &&
    estimate.confidence >= config.minConfidence;
  const evidenceOnlyReasons = new Set([
    "no independent evidence source",
    "probability estimator marked data insufficient",
  ]);
  const unmodeled =
    estimate.independentEvidenceCount < config.minIndependentSources &&
    skipReasons.length > 0 &&
    skipReasons.every((skipReason) => evidenceOnlyReasons.has(skipReason));
  const softSkipReasons = new Set([
    `liquidity below ${config.minLiquidity}`,
    `spread above ${config.maxSpread}`,
    `ends within ${config.minHoursToEnd} hours`,
    `capital lockup exceeds ${config.maxDaysToEnd} days`,
  ]);
  const hasOnlySoftSkips =
    skipReasons.length > 0 &&
    skipReasons.length <= 2 &&
    skipReasons.every((r) => softSkipReasons.has(r));
  const nearMissWatch =
    !qualifies &&
    !unmodeled &&
    estimate.independentEvidenceCount >= config.minIndependentSources &&
    (hasOnlySoftSkips || (skipReasons.length === 0 && edge.confidenceAdjustedEdge > 0));
  const action = qualifies
    ? config.enableRealTrading && config.enableDirectionalLiveTrading && !config.dryRun
      ? "LIVE_BET"
      : "PAPER_BET"
    : unmodeled
      ? "UNMODELED"
    : nearMissWatch
      ? "WATCH"
    : skipReasons.length > 0
      ? "SKIP"
      : "WATCH";
  const reason =
    unmodeled
      ? "No independent probability model; retained for research only"
      : skipReasons.length > 0
      ? skipReasons.slice(0, 3).join("; ")
      : qualifies
        ? `${edge.outcome} has ${(edge.confidenceAdjustedEdge * 100).toFixed(1)}% edge after confidence shrinkage and costs`
        : `best side is ${edge.outcome}, but net edge/confidence is below threshold`;

  return {
    market,
    estimate,
    edge,
    liquidityScore,
    clarityScore,
    dataAvailabilityScore,
    timeHorizonScore,
    edgePotentialScore,
    riskScore,
    finalScore,
    skipReasons,
    action,
    reason,
  };
}

function calculateEdge(
  config: AppConfig,
  market: NormalizedMarket,
  estimate: ProbabilityEstimate,
  outcome: TradeOutcome,
): EdgeEstimate {
  const isYes = outcome === "YES";
  const ask = clamp(
    (isYes ? market.bestAsk ?? market.yesPrice : market.noBestAsk ?? market.noPrice) ?? 1,
    0.001,
    0.999,
  );
  const bid = isYes ? market.bestBid : market.noBestBid;
  const spread = isYes ? market.spread : market.noSpread;
  const rawProbability = isYes ? estimate.estimatedYesProbability : estimate.estimatedNoProbability;
  const marketPriorProbability = clamp(
    (isYes ? market.yesPrice : market.noPrice) ?? ask,
    0.001,
    0.999,
  );
  const calibratedProbability =
    estimate.independentEvidenceCount === 0
      ? Math.min(marketPriorProbability, ask)
      : conservativeProbability(rawProbability, estimate.confidence, marketPriorProbability);
  const feeCost = estimateTakerFeePerShare(
    market.category,
    ask,
    market.takerFeeRate,
    market.feesEnabled,
  );
  const slippageCost = config.slippageBuffer;
  const uncertaintyCost = estimate.modelUncertainty * uncertaintyHaircutRate(estimate.method);
  const confidenceAdjustedEdge = calibratedProbability - ask - feeCost - slippageCost - uncertaintyCost;

  return {
    outcome,
    tokenId: isYes ? market.yesTokenId : market.noTokenId,
    marketAskPrice: ask,
    marketBidPrice: bid,
    rawProbability,
    marketPriorProbability,
    calibratedProbability,
    expectedValue: rawProbability - ask,
    spreadCost: spread !== undefined ? Math.max(0, spread) / 2 : 0,
    feeCost,
    slippageCost,
    uncertaintyCost,
    confidenceAdjustedEdge,
    minimumRequiredEdge: config.minEdge,
  };
}

export function conservativeProbability(probability: number, confidence: number, marketPrior: number): number {
  return clamp(marketPrior + (probability - marketPrior) * clamp(confidence, 0, 1), 0.01, 0.99);
}

export function estimateTakerFeePerShare(
  category: string,
  price: number,
  marketFeeRate?: number,
  feesEnabled?: boolean,
): number {
  if (feesEnabled === false) return 0;
  const feeRateByCategory: Record<string, number> = {
    crypto: 0.07,
    sports: 0.05,
    finance: 0.04,
    macro: 0.05,
    politics: 0.04,
    culture: 0.05,
    weather: 0.05,
    mentions: 0.04,
    tech: 0.04,
    geopolitics: 0,
    "objective-event": 0.05,
  };
  const feeRate =
    marketFeeRate !== undefined && Number.isFinite(marketFeeRate) && marketFeeRate >= 0
      ? marketFeeRate
      : feeRateByCategory[category] ?? 0.05;
  return feeRate * clamp(price, 0, 1) * (1 - clamp(price, 0, 1));
}

/**
 * Forecast families do not deserve the same error bar. This is deliberately a small
 * haircut on top of confidence-to-market shrinkage, not a second full calibration pass.
 * Weak text/news and single-point forecasts must clear more edge than structured odds,
 * multi-member ensembles, or an official observation that nearly determines resolution.
 */
function uncertaintyHaircutRate(method: string): number {
  if (/station-observation-complete|official-release-feed|official-statuspage/.test(method)) return 0.04;
  if (/sports-devigged|weather-ensemble/.test(method)) return 0.08;
  if (/structured-manual|crypto-|financial-|market-cap|macro-/.test(method)) return 0.12;
  if (/weather-normal/.test(method)) return 0.22;
  if (/news-/.test(method)) return 0.35;
  return 0.16;
}

function scoreLiquidity(market: NormalizedMarket): number {
  const liquidity = Math.max(market.liquidity ?? 0, executableAskDepthEur(market), 0);
  const volume = Math.max(market.volume ?? 0, 0);
  const depthScore = clamp(Math.log10(liquidity + volume + 1) * 18, 0, 100);
  const widestSpread = Math.max(market.spread ?? 0.05, market.noSpread ?? market.spread ?? 0.05);
  const spreadPenalty = clamp(widestSpread * 350, 0, 45);
  return clamp(depthScore - spreadPenalty, 0, 100);
}

function scoreClarity(market: NormalizedMarket): number {
  const text = `${market.title} ${market.rules ?? ""} ${market.resolutionSource ?? ""}`.toLowerCase();
  let score = 45;
  if (market.rules && market.rules.length > 120) score += 15;
  if (/\b(will resolve to|resolution source|according to|official|reported by|published by)\b/.test(text)) score += 20;
  if (/\b(exactly|by|before|after|at or above|greater than|less than)\b/.test(text)) score += 8;
  if (/\b(consensus|credible reporting|significant|substantial|reasonable|subjective|unclear|spirit of)\b/.test(text)) score -= 20;
  if (!market.resolutionSource && /\b(consensus|credible reporting)\b/.test(text)) score -= 10;
  return clamp(score, 0, 100);
}

function scoreTimeHorizon(market: NormalizedMarket): number {
  const days = daysUntil(market.endDate);
  if (days === undefined) return 25;
  if (days < 0) return 0;
  if (days < 0.5) return 10;
  if (days < 2) return 45;
  if (days <= 45) return 95;
  if (days <= 120) return 85;
  if (days <= 365) return 60;
  return 25;
}

function scoreRisk(market: NormalizedMarket): number {
  const text = `${market.title} ${market.rules ?? ""}`.toLowerCase();
  let risk = 35;
  if (market.category === "crypto" || market.category === "weather" || market.category === "macro") risk -= 15;
  if (market.category === "tech") risk += 10;
  if (market.category === "politics") risk += 25;
  if (market.category === "geopolitics") risk += 35;
  if (market.category === "sports" || market.category === "esports") risk += 20;
  if (/\b(rumor|leak|insider|announcement|resign|war|attack|ceasefire|celebrity)\b/.test(text)) risk += 20;
  if (/\b(subjective|significant|substantial|credible reporting|consensus)\b/.test(text)) risk += 15;
  if (Math.max(market.spread ?? 0, market.noSpread ?? 0) > 0.08) risk += 15;
  return clamp(risk, 0, 100);
}

function getSkipReasons(
  config: AppConfig,
  market: NormalizedMarket,
  estimate: ProbabilityEstimate,
  clarityScore: number,
  riskScore: number,
): string[] {
  const reasons: string[] = [];
  const days = daysUntil(market.endDate);
  const hours = (days ?? Number.POSITIVE_INFINITY) * 24;
  const outcomes = market.outcomes.map((outcome) => outcome.toLowerCase());
  const hasVerifiedExecutableDepth = executableAskDepthEur(market) >= Math.max(config.maxBetEur, 0.05);

  if (market.status !== "open") reasons.push(`market status is ${market.status}`);
  if (!market.yesTokenId || !market.noTokenId || outcomes.length !== 2 || !outcomes.includes("yes") || !outcomes.includes("no")) {
    reasons.push("not a binary YES/NO CLOB market");
  }
  if ((market.liquidity ?? 0) < config.minLiquidity && !hasVerifiedExecutableDepth) {
    reasons.push(`liquidity below ${config.minLiquidity}`);
  }
  if (Math.max(market.spread ?? 0.99, market.noSpread ?? market.spread ?? 0.99) > config.maxSpread) {
    reasons.push(`spread above ${config.maxSpread}`);
  }
  if (hours < config.minHoursToEnd) reasons.push(`ends within ${config.minHoursToEnd} hours`);
  if (isForecastOnlySameDayTemperatureMarket(market, estimate, hours)) {
    reasons.push("same-day temperature market needs station observations");
  }
  if (days === undefined) reasons.push("market end time is unavailable");
  if ((days ?? 0) > config.maxDaysToEnd) reasons.push(`capital lockup exceeds ${config.maxDaysToEnd} days`);
  if (clarityScore < 45) reasons.push("resolution rules are unclear");
  if (riskScore > 75) reasons.push("risk score too high");
  if (estimate.independentEvidenceCount < config.minIndependentSources) reasons.push("no independent evidence source");
  if (estimate.shouldSkip) reasons.push("probability estimator marked data insufficient");
  return [...new Set(reasons)];
}

function executableAskDepthEur(market: NormalizedMarket): number {
  return Math.max(market.yesAskDepthEur ?? 0, market.noAskDepthEur ?? 0);
}

function isForecastOnlySameDayTemperatureMarket(
  market: NormalizedMarket,
  estimate: ProbabilityEstimate,
  hoursUntilEnd: number,
): boolean {
  if (market.category !== "weather") return false;
  if (!estimate.method.includes("weather-")) return false;
  if (estimate.method.includes("station-observation")) return false;
  if (hoursUntilEnd >= 24) return false;
  return /\b(highest|lowest|temperature|temp|degrees?|celsius|fahrenheit)\b|°/i.test(
    `${market.title} ${market.rules ?? ""}`,
  );
}
