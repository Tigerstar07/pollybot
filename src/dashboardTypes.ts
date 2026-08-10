import type { MarketAction, RankingResult, TradeOutcome } from "./types";
import type {
  CalibrationReport,
  ForecastCalibrationReport,
} from "./reports/calibration";

export interface DashboardDecision {
  marketId: string;
  title: string;
  category: string;
  url?: string;
  endDate?: string;
  outcome: TradeOutcome;
  ask: number;
  priceSource: "orderbook" | "indicative";
  rawProbability: number;
  marketPriorProbability: number;
  calibratedProbability: number;
  netEdge: number;
  grossEdge: number;
  confidence: number;
  action: MarketAction;
  reason: string;
  skipReasons: string[];
  evidence: string[];
  risks: string[];
  method: string;
  independentEvidenceCount: number;
  dataQuality: number;
  modelUncertainty: number;
  feeCost: number;
  slippageCost: number;
  spreadCost: number;
  quoteCapturedAt?: string;
  finalScore: number;
  liquidityScore: number;
  clarityScore: number;
  timeHorizonScore: number;
}

export interface DashboardPaperOrder {
  id: number;
  marketId: string;
  title: string;
  outcome: TradeOutcome;
  price: number;
  sizeEur: number;
  shares: number;
  edge: number;
  confidence: number;
  status: string;
  pnlEur?: number;
  createdAt: string;
}

export interface DashboardRun {
  id: number;
  command: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  details?: {
    marketsScanned?: number;
    candidates?: number;
    watched?: number;
    skipped?: number;
    unmodeled?: number;
    forecastsSettled?: number;
    durationMs?: number;
  };
}

export interface DashboardData {
  generatedAt: string;
  safety: {
    mode: "paper" | "live";
    liveExecutionEnabled: boolean;
    dryRun: boolean;
    sportsOddsConfigured: boolean;
  };
  scan: {
    running: boolean;
    startedAt?: string;
    error?: string;
  };
  summary: {
    marketsScanned: number;
    candidates: number;
    watched: number;
    unmodeled: number;
    skipped: number;
    openExposureEur: number;
    maxOpenExposureEur: number;
    bankrollEur: number;
    liveOrders: number;
    maxBetEur: number;
  };
  decisions: DashboardDecision[];
  paperOrders: DashboardPaperOrder[];
  runs: DashboardRun[];
  calibration: {
    paper: CalibrationReport;
    forecasts: ForecastCalibrationReport;
    forecastCounts: {
      recorded: number;
      scorable: number;
      settled: number;
      pending: number;
    };
  };
  recentSettlements: Array<{
    id: number;
    title: string;
    outcome: string;
    winningOutcome?: string;
    stakeEur: number;
    pnlEur: number;
    settledAt: string;
  }>;
  sourceHealth: {
    sportsOdds: {
      configured: boolean;
      status: "ready" | "unconfigured" | "unknown" | "quota-guard";
      requestsRemaining?: number;
      requestsUsed?: number;
      requestsLast?: number;
      lastFetchedAt?: string;
      cacheMinutes: number;
      maxCallsPerScan: number;
      minRemaining: number;
    };
  };
  liveReadiness: {
    ready: boolean;
    gates: Array<{
      key: string;
      label: string;
      passed: boolean;
      detail: string;
    }>;
  };
}

export function toDashboardDecision(ranking: RankingResult): DashboardDecision {
  return {
    marketId: ranking.market.marketId,
    title: ranking.market.title,
    category: ranking.market.category,
    url: ranking.market.url,
    endDate: ranking.market.endDate,
    outcome: ranking.edge.outcome,
    ask: ranking.edge.marketAskPrice,
    priceSource: ranking.market.quoteCapturedAt ? "orderbook" : "indicative",
    rawProbability: ranking.edge.rawProbability,
    marketPriorProbability: ranking.edge.marketPriorProbability,
    calibratedProbability: ranking.edge.calibratedProbability,
    netEdge: ranking.edge.confidenceAdjustedEdge,
    grossEdge: ranking.edge.expectedValue,
    confidence: ranking.estimate.confidence,
    action: ranking.action,
    reason: ranking.reason,
    skipReasons: ranking.skipReasons,
    evidence: ranking.estimate.keyEvidence,
    risks: ranking.estimate.risks,
    method: ranking.estimate.method,
    independentEvidenceCount: ranking.estimate.independentEvidenceCount,
    dataQuality: ranking.estimate.dataQuality,
    modelUncertainty: ranking.estimate.modelUncertainty,
    feeCost: ranking.edge.feeCost,
    slippageCost: ranking.edge.slippageCost,
    spreadCost: ranking.edge.spreadCost,
    quoteCapturedAt: ranking.market.quoteCapturedAt,
    finalScore: ranking.finalScore,
    liquidityScore: ranking.liquidityScore,
    clarityScore: ranking.clarityScore,
    timeHorizonScore: ranking.timeHorizonScore,
  };
}
