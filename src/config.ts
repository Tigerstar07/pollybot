import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

const explicitProcessEnv = new Map(Object.entries(process.env));
dotenv.config({ path: ".env", quiet: true });
dotenv.config({ path: ".env.local", override: true, quiet: true });
for (const [key, value] of explicitProcessEnv) {
  process.env[key] = value;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return value.toLowerCase() === "true";
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringEnv(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export interface AppConfig {
  projectRoot: string;
  databasePath: string;
  dryRun: boolean;
  enableRealTrading: boolean;
  enableDirectionalLiveTrading: boolean;
  enableLlmReasoning: boolean;
  bankrollEur: number;
  baseBetEur: number;
  kellyFraction: number;
  maxBetEur: number;
  maxPerMarketEur: number;
  maxPerEventEur: number;
  maxOpenExposureEur: number;
  dailyLossLimitEur: number;
  totalLossLimitEur: number;
  minEdge: number;
  minConfidence: number;
  minIndependentSources: number;
  maxQuoteAgeSeconds: number;
  paperOrderCooldownMinutes: number;
  liveOrderCooldownMinutes: number;
  liveLossStreakLookbackHours: number;
  maxLiveTradesPerDay: number;
  maxLiveStakePerDayEur: number;
  liveMinStakeEur: number;
  allowLiveMinOrderTopUp: boolean;
  minLiveTopUpEdge: number;
  maxLiveTopUpBankrollFraction: number;
  liveMinPrice: number;
  liveMaxPrice: number;
  liveMinModelProbability: number;
  liveIntradayEnabled: boolean;
  liveIntradayMaxHours: number;
  liveIntradayMinEdge: number;
  liveIntradayMinConfidence: number;
  liveIntradayMinPrice: number;
  liveIntradayMaxPrice: number;
  liveIntradayMaxStakeEur: number;
  liveOpportunityReportLimit: number;
  liveCalibrationMinSettled: number;
  liveCalibrationMinCategorySettled: number;
  liveCalibrationMinBrierSkill: number;
  liveCalibrationZScore: number;
  arbEnabled: boolean;
  arbMinProfitEur: number;
  arbMinEdgeFraction: number;
  arbMaxStakeEur: number;
  arbMaxOpenEur: number;
  arbMaxLegs: number;
  arbMaxDaysToEnd: number;
  arbEventScanLimit: number;
  slippageBuffer: number;
  minLiquidity: number;
  maxSpread: number;
  minHoursToEnd: number;
  maxDaysToEnd: number;
  liveMinHoursToEnd: number;
  liveMaxHoursToEnd: number;
  liveNearTermMaxHours: number;
  liveSweepCandidateLimit: number;
  scanMaxEvents: number;
  scanPageLimit: number;
  scanAllMarkets: boolean;
  scanMaxExternalSourceMarkets?: number;
  scanMaxNewsSourceMarkets?: number;
  polymarketFrontendUrl: string;
  polymarketGammaUrl: string;
  polymarketClobUrl: string;
  llmProvider?: string;
  llmModel?: string;
  openAiCompatibleBaseUrl?: string;
  ollamaHost?: string;
  sportsOddsApiKey?: string;
  sportsOddsApiUrl: string;
  sportsOddsRegions: string;
  sportsOddsCacheMinutes: number;
  sportsOddsMaxAgeMinutes: number;
  sportsOddsMaxCallsPerScan: number;
  sportsOddsMinRemaining: number;
  tmdbApiKey?: string;
  fmpApiKey?: string;
  fmpApiUrl: string;
  fredApiKey?: string;
  fredApiUrl: string;
  polymarketPrivateKey?: string;
  polymarketFunderAddress?: string;
  polymarketSignatureType: 0 | 1 | 2 | 3;
  polymarketApiKey?: string;
  polymarketApiSecret?: string;
  polymarketApiPassphrase?: string;
  networkTimeoutMs: number;
  networkMaxRetries: number;
}

export function loadConfig(): AppConfig {
  const projectRoot = process.cwd();
  const databasePath = path.resolve(projectRoot, stringEnv("DATABASE_PATH", "data/pollybot.sqlite"));
  const maxPerMarketEur = numberEnv("MAX_PER_MARKET_EUR", 0.3);
  return {
    projectRoot,
    databasePath,
    dryRun: boolEnv("DRY_RUN", true),
    enableRealTrading: boolEnv("ENABLE_REAL_TRADING", false),
    // Real-money authentication is shared by directional and arbitrage execution, but
    // directional model bets require their own explicit switch. This prevents a live
    // arb/research runner from silently activating an unproven forecasting model.
    enableDirectionalLiveTrading: boolEnv("ENABLE_DIRECTIONAL_LIVE_TRADING", false),
    enableLlmReasoning: boolEnv("ENABLE_LLM_REASONING", false),
    bankrollEur: numberEnv("BANKROLL_EUR", 10),
    baseBetEur: numberEnv("BASE_BET_EUR", 0.1),
    kellyFraction: Math.max(0.01, Math.min(0.25, numberEnv("KELLY_FRACTION", 0.05))),
    maxBetEur: numberEnv("MAX_BET_EUR", 0.2),
    maxPerMarketEur,
    maxPerEventEur: numberEnv("MAX_PER_EVENT_EUR", maxPerMarketEur),
    maxOpenExposureEur: numberEnv("MAX_OPEN_EXPOSURE_EUR", 1),
    dailyLossLimitEur: numberEnv("DAILY_LOSS_LIMIT_EUR", 0.5),
    totalLossLimitEur: numberEnv("TOTAL_LOSS_LIMIT_EUR", 2),
    minEdge: numberEnv("MIN_EDGE", 0.03),
    minConfidence: numberEnv("MIN_CONFIDENCE", 0.45),
    minIndependentSources: Math.max(1, Math.floor(numberEnv("MIN_INDEPENDENT_SOURCES", 1))),
    maxQuoteAgeSeconds: Math.max(5, numberEnv("MAX_QUOTE_AGE_SECONDS", 30)),
    paperOrderCooldownMinutes: Math.max(0, numberEnv("PAPER_ORDER_COOLDOWN_MINUTES", 60)),
    liveOrderCooldownMinutes: Math.max(0, numberEnv("LIVE_ORDER_COOLDOWN_MINUTES", 1440)),
    // The 3-loss cooldown should pause a bad *streak*, not permanently freeze the bot: it
    // only counts losing bets whose decision was made inside this window. Otherwise 3 old
    // resolved losses deadlock trading forever (you can't win a bet you're never allowed to place).
    liveLossStreakLookbackHours: Math.max(1, numberEnv("LIVE_LOSS_STREAK_LOOKBACK_HOURS", 48)),
    maxLiveTradesPerDay: Math.max(1, Math.floor(numberEnv("MAX_LIVE_TRADES_PER_DAY", 1))),
    maxLiveStakePerDayEur: Math.max(0.05, numberEnv("MAX_LIVE_STAKE_PER_DAY_EUR", 0.2)),
    liveMinStakeEur: Math.max(0.01, numberEnv("LIVE_MIN_STAKE_EUR", 0.05)),
    allowLiveMinOrderTopUp: boolEnv("ALLOW_LIVE_MIN_ORDER_TOP_UP", false),
    minLiveTopUpEdge: Math.max(0, numberEnv("MIN_LIVE_TOP_UP_EDGE", 0.06)),
    maxLiveTopUpBankrollFraction: Math.max(0.01, Math.min(1, numberEnv("MAX_LIVE_TOP_UP_BANKROLL_FRACTION", 0.15))),
    liveMinPrice: Math.max(0, Math.min(1, numberEnv("LIVE_MIN_PRICE", 0.05))),
    liveMaxPrice: Math.max(0, Math.min(1, numberEnv("LIVE_MAX_PRICE", 0.95))),
    // "Only back more-likely-than-not outcomes." The bot's entire realized loss book
    // was longshot/coin-flip buys (cheap YES tickets, faded favorites); this floor makes
    // live execution refuse any side whose calibrated win probability is below it.
    liveMinModelProbability: Math.max(0, Math.min(1, numberEnv("LIVE_MIN_MODEL_PROBABILITY", 0.5))),
    liveIntradayEnabled: boolEnv("LIVE_INTRADAY_ENABLED", false),
    liveIntradayMaxHours: Math.max(1, numberEnv("LIVE_INTRADAY_MAX_HOURS", numberEnv("LIVE_NEAR_TERM_MAX_HOURS", 36))),
    liveIntradayMinEdge: Math.max(0, numberEnv("LIVE_INTRADAY_MIN_EDGE", 0.08)),
    liveIntradayMinConfidence: Math.max(0, Math.min(1, numberEnv("LIVE_INTRADAY_MIN_CONFIDENCE", 0.4))),
    liveIntradayMinPrice: Math.max(0, Math.min(1, numberEnv("LIVE_INTRADAY_MIN_PRICE", 0.01))),
    liveIntradayMaxPrice: Math.max(0, Math.min(1, numberEnv("LIVE_INTRADAY_MAX_PRICE", 0.98))),
    liveIntradayMaxStakeEur: Math.max(0.01, numberEnv("LIVE_INTRADAY_MAX_STAKE_EUR", numberEnv("LIVE_MIN_STAKE_EUR", 0.05))),
    liveOpportunityReportLimit: Math.max(10, Math.floor(numberEnv("LIVE_OPPORTUNITY_REPORT_LIMIT", 80))),
    // Directional trading must demonstrate out-of-sample skill over the market price.
    // The lower-confidence-bound test is evaluated globally and within the market's
    // category, using only the first forecast made for each resolved market.
    liveCalibrationMinSettled: Math.max(30, Math.floor(numberEnv("LIVE_CALIBRATION_MIN_SETTLED", 200))),
    liveCalibrationMinCategorySettled: Math.max(
      20,
      Math.floor(numberEnv("LIVE_CALIBRATION_MIN_CATEGORY_SETTLED", 50)),
    ),
    liveCalibrationMinBrierSkill: Math.max(
      0,
      Math.min(0.5, numberEnv("LIVE_CALIBRATION_MIN_BRIER_SKILL", 0.02)),
    ),
    liveCalibrationZScore: Math.max(1, Math.min(3, numberEnv("LIVE_CALIBRATION_Z_SCORE", 1.645))),
    arbEnabled: boolEnv("ARB_ENABLED", false),
    arbMinProfitEur: Math.max(0.01, numberEnv("ARB_MIN_PROFIT_EUR", 0.05)),
    arbMinEdgeFraction: Math.max(0.001, numberEnv("ARB_MIN_EDGE", 0.02)),
    arbMaxStakeEur: Math.max(0.5, numberEnv("ARB_MAX_STAKE_EUR", 5)),
    arbMaxOpenEur: Math.max(0.5, numberEnv("ARB_MAX_OPEN_EUR", 6)),
    arbMaxLegs: Math.max(2, Math.min(10, Math.floor(numberEnv("ARB_MAX_LEGS", 5)))),
    arbMaxDaysToEnd: Math.max(0.1, numberEnv("ARB_MAX_DAYS_TO_END", 30)),
    arbEventScanLimit: Math.max(1, Math.floor(numberEnv("ARB_EVENT_SCAN_LIMIT", 25))),
    slippageBuffer: Math.max(0, numberEnv("SLIPPAGE_BUFFER", 0.005)),
    minLiquidity: numberEnv("MIN_LIQUIDITY", 100),
    maxSpread: numberEnv("MAX_SPREAD", 0.15),
    minHoursToEnd: numberEnv("MIN_HOURS_TO_END", 2),
    maxDaysToEnd: numberEnv("MAX_DAYS_TO_END", 365),
    liveMinHoursToEnd: Math.max(0, numberEnv("LIVE_MIN_HOURS_TO_END", numberEnv("MIN_HOURS_TO_END", 2))),
    liveMaxHoursToEnd: Math.max(
      0.01,
      numberEnv("LIVE_MAX_HOURS_TO_END", numberEnv("MAX_DAYS_TO_END", 365) * 24),
    ),
    liveNearTermMaxHours: Math.max(1, numberEnv("LIVE_NEAR_TERM_MAX_HOURS", 36)),
    liveSweepCandidateLimit: Math.max(50, Math.floor(numberEnv("LIVE_SWEEP_CANDIDATE_LIMIT", 250))),
    scanMaxEvents: Math.max(1, Math.floor(numberEnv("SCAN_MAX_EVENTS", 500))),
    scanPageLimit: Math.min(100, Math.max(1, Math.floor(numberEnv("SCAN_PAGE_LIMIT", 100)))),
    scanAllMarkets: boolEnv("SCAN_ALL_MARKETS", false),
    // These are research-throughput budgets, not betting limits. Every discovered
    // market is still normalized/ranked; the budgets keep slow external APIs focused
    // on the diverse, executable subset that could actually become a live order.
    scanMaxExternalSourceMarkets: Math.max(50, Math.floor(numberEnv("SCAN_MAX_EXTERNAL_SOURCE_MARKETS", 600))),
    scanMaxNewsSourceMarkets: Math.max(5, Math.floor(numberEnv("SCAN_MAX_NEWS_SOURCE_MARKETS", 30))),
    polymarketFrontendUrl: stringEnv("POLYMARKET_FRONTEND_URL", "https://polymarket.com"),
    polymarketGammaUrl: stringEnv("POLYMARKET_GAMMA_URL", "https://gamma-api.polymarket.com"),
    polymarketClobUrl: stringEnv("POLYMARKET_CLOB_URL", "https://clob.polymarket.com"),
    llmProvider: process.env.LLM_PROVIDER,
    llmModel: process.env.LLM_MODEL,
    openAiCompatibleBaseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL,
    ollamaHost: process.env.OLLAMA_HOST,
    sportsOddsApiKey: process.env.SPORTS_ODDS_API_KEY,
    sportsOddsApiUrl: stringEnv("SPORTS_ODDS_API_URL", "https://api.the-odds-api.com"),
    sportsOddsRegions: stringEnv("SPORTS_ODDS_REGIONS", "eu"),
    sportsOddsCacheMinutes: Math.max(2, numberEnv("SPORTS_ODDS_CACHE_MINUTES", 15)),
    sportsOddsMaxAgeMinutes: Math.max(2, numberEnv("SPORTS_ODDS_MAX_AGE_MINUTES", 30)),
    sportsOddsMaxCallsPerScan: Math.max(0, Math.floor(numberEnv("SPORTS_ODDS_MAX_CALLS_PER_SCAN", 6))),
    sportsOddsMinRemaining: Math.max(0, Math.floor(numberEnv("SPORTS_ODDS_MIN_REMAINING", 50))),
    tmdbApiKey: process.env.TMDB_API_KEY,
    fmpApiKey: process.env.FMP_API_KEY,
    fmpApiUrl: stringEnv("FMP_API_URL", "https://financialmodelingprep.com"),
    fredApiKey: process.env.FRED_API_KEY,
    fredApiUrl: stringEnv("FRED_API_URL", "https://api.stlouisfed.org"),
    polymarketPrivateKey: process.env.POLYMARKET_PRIVATE_KEY,
    polymarketFunderAddress: process.env.POLYMARKET_FUNDER_ADDRESS,
    polymarketSignatureType: parseSignatureType(numberEnv("POLYMARKET_SIGNATURE_TYPE", 3)),
    polymarketApiKey: process.env.POLYMARKET_API_KEY,
    polymarketApiSecret: process.env.POLYMARKET_API_SECRET,
    polymarketApiPassphrase: process.env.POLYMARKET_API_PASSPHRASE,
    networkTimeoutMs: numberEnv("NETWORK_TIMEOUT_MS", 15000),
    networkMaxRetries: numberEnv("NETWORK_MAX_RETRIES", 3),
  };
}

function parseSignatureType(value: number): 0 | 1 | 2 | 3 {
  if (value === 0 || value === 1 || value === 2 || value === 3) return value;
  return 3;
}

export function assertLiveTradingAllowed(config: AppConfig): void {
  if (config.dryRun) {
    throw new Error("Live trading refused: DRY_RUN is true.");
  }
  if (process.env.ENABLE_REAL_TRADING !== "true") {
    throw new Error("Live trading refused: ENABLE_REAL_TRADING is not exactly true.");
  }
  if (process.env.LIVE_TRADING_CONFIRM !== "I_ACCEPT_REAL_MONEY_LOSS") {
    throw new Error(
      "Live trading refused: LIVE_TRADING_CONFIRM must be exactly I_ACCEPT_REAL_MONEY_LOSS.",
    );
  }
  if (config.bankrollEur <= 0 || config.maxBetEur <= 0 || config.maxBetEur > config.bankrollEur) {
    throw new Error("Live trading refused: bankroll and maximum bet limits are invalid.");
  }
}

/** Additional invariants for model-driven real-money bets (arbitrage is separate). */
export function assertDirectionalLiveTradingAllowed(config: AppConfig): void {
  assertLiveTradingAllowed(config);
  if (process.env.ENABLE_DIRECTIONAL_LIVE_TRADING !== "true") {
    throw new Error(
      "Directional live trading refused: ENABLE_DIRECTIONAL_LIVE_TRADING is not exactly true.",
    );
  }
  const fraction = (value: number): number => value / config.bankrollEur;
  if (fraction(config.maxBetEur) > 0.15) {
    throw new Error("Directional live trading refused: MAX_BET_EUR exceeds 15% of bankroll.");
  }
  if (fraction(config.maxOpenExposureEur) > 0.3) {
    throw new Error(
      "Directional live trading refused: MAX_OPEN_EXPOSURE_EUR exceeds 30% of bankroll.",
    );
  }
  if (fraction(config.maxLiveStakePerDayEur) > 0.3) {
    throw new Error(
      "Directional live trading refused: MAX_LIVE_STAKE_PER_DAY_EUR exceeds 30% of bankroll.",
    );
  }
  if (fraction(config.dailyLossLimitEur) > 0.15) {
    throw new Error(
      "Directional live trading refused: DAILY_LOSS_LIMIT_EUR exceeds 15% of bankroll.",
    );
  }
  if (fraction(config.totalLossLimitEur) > 0.3) {
    throw new Error(
      "Directional live trading refused: TOTAL_LOSS_LIMIT_EUR exceeds 30% of bankroll.",
    );
  }
  if (config.allowLiveMinOrderTopUp) {
    throw new Error(
      "Directional live trading refused: exchange-minimum stake top-ups must be disabled.",
    );
  }
  if (config.kellyFraction > 0.1) {
    throw new Error("Directional live trading refused: KELLY_FRACTION exceeds 10%.");
  }
  if (config.liveIntradayEnabled && config.liveIntradayMinConfidence < config.minConfidence) {
    throw new Error(
      "Directional live trading refused: the intraday confidence floor is below the standard floor.",
    );
  }
}
