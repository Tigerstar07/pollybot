export type MarketAction = "UNMODELED" | "SKIP" | "WATCH" | "PAPER_BET" | "LIVE_BET";
export type TradeOutcome = "YES" | "NO";

export interface NormalizedMarket {
  provider: "polymarket";
  marketId: string;
  eventId?: string;
  conditionId?: string;
  slug?: string;
  eventSlug?: string;
  title: string;
  category: string;
  outcomes: string[];
  yesTokenId?: string;
  noTokenId?: string;
  yesPrice?: number;
  noPrice?: number;
  bestBid?: number;
  bestAsk?: number;
  noBestBid?: number;
  noBestAsk?: number;
  spread?: number;
  noSpread?: number;
  quoteCapturedAt?: string;
  yesAskDepthEur?: number;
  noAskDepthEur?: number;
  yesMinOrderSizeShares?: number;
  noMinOrderSizeShares?: number;
  yesTickSize?: string;
  noTickSize?: string;
  negRisk?: boolean;
  feesEnabled?: boolean;
  takerFeeRate?: number;
  volume?: number;
  liquidity?: number;
  endDate?: string;
  startDate?: string;
  status: string;
  resolutionSource?: string;
  rules?: string;
  tags: string[];
  url?: string;
  raw: Record<string, unknown>;
  updatedAt: string;
}

export interface SourceObservation {
  sourceType: string;
  sourceKey: string;
  collectedAt: string;
  expiresAt?: string;
  payload: Record<string, unknown>;
  available: boolean;
  independent?: boolean;
  quality?: number;
  reason?: string;
}

export interface ProbabilityEstimate {
  marketId: string;
  estimatedYesProbability: number;
  estimatedNoProbability: number;
  confidence: number;
  method: string;
  reasoningSummary: string;
  keyEvidence: string[];
  risks: string[];
  independentEvidenceCount: number;
  dataQuality: number;
  modelUncertainty: number;
  shouldSkip: boolean;
}

export interface EdgeEstimate {
  outcome: TradeOutcome;
  tokenId?: string;
  marketAskPrice: number;
  marketBidPrice?: number;
  rawProbability: number;
  marketPriorProbability: number;
  calibratedProbability: number;
  expectedValue: number;
  spreadCost: number;
  feeCost: number;
  slippageCost: number;
  uncertaintyCost: number;
  confidenceAdjustedEdge: number;
  minimumRequiredEdge: number;
}

export interface RankingResult {
  market: NormalizedMarket;
  estimate: ProbabilityEstimate;
  edge: EdgeEstimate;
  liquidityScore: number;
  clarityScore: number;
  dataAvailabilityScore: number;
  timeHorizonScore: number;
  edgePotentialScore: number;
  riskScore: number;
  finalScore: number;
  skipReasons: string[];
  action: MarketAction;
  reason: string;
}

export interface PaperOrderDecision {
  marketId: string;
  outcome: TradeOutcome;
  side: "BUY";
  tokenId: string;
  price: number;
  sizeEur: number;
  estimatedShares: number;
  edge: number;
  confidence: number;
  forecastProb: number;
  marketPriorProb: number;
  feeEur: number;
  maxLossEur: number;
  quoteCapturedAt: string;
  decisionKey: string;
  modelVersion: string;
  reasoning: string;
}

export interface LiveOrderDecision {
  marketId: string;
  outcome: TradeOutcome;
  side: "BUY";
  tokenId: string;
  price: number;
  sizeEur: number;
  estimatedShares: number;
  edge: number;
  confidence: number;
  forecastProb: number;
  marketPriorProb: number;
  feeEur: number;
  maxLossEur: number;
  quoteCapturedAt: string;
  decisionKey: string;
  modelVersion: string;
  reasoning: string;
  externalOrderId?: string;
  status: string;
  responseStatus?: string;
  errorMessage?: string;
}
