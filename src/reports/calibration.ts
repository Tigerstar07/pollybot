import type { SettledBetRow, SettledForecastRow } from "../db";

export interface CalibrationBucket {
  label: string;
  count: number;
  avgForecast: number;
  hitRate: number;
}

export interface CalibrationReport {
  settledCount: number;
  forecastCount: number;
  totalStakeEur: number;
  totalPnlEur: number;
  returnOnStake: number;
  winRate: number;
  brierScore?: number;
  marketBrierScore?: number;
  brierSkillScore?: number;
  avgForecast?: number;
  avgMarketPrior?: number;
  realizedRate?: number;
  buckets: CalibrationBucket[];
}

export interface ForecastCategoryCalibration {
  category: string;
  count: number;
  brierScore: number;
  marketBrierScore: number;
  brierSkillScore?: number;
}

export interface ForecastCalibrationReport {
  settledCount: number;
  brierScore?: number;
  marketBrierScore?: number;
  brierSkillScore?: number;
  avgForecast?: number;
  avgMarketPrior?: number;
  realizedRate?: number;
  buckets: CalibrationBucket[];
  categories: ForecastCategoryCalibration[];
}

const BUCKET_EDGES = [0, 0.2, 0.4, 0.6, 0.8, 1.0001];

/**
 * Scores how well the bot's calibrated forecasts matched reality.
 *
 * - Brier score: mean squared error between the forecast probability for the side
 *   actually bet and the realized 0/1 outcome. Lower is better.
 * - The market Brier score uses the contemporaneous market prior for the same bets.
 *   Brier skill is positive only when the bot beats that relevant benchmark.
 * - Buckets compare average forecast vs realized hit rate per probability band: a
 *   well-calibrated bot has hitRate ≈ avgForecast in every bucket.
 * - returnOnStake is the realized profit per EUR 1 staked — the bottom line.
 *
 * Pure function over settled rows so it can be unit-tested without a database.
 */
export function computeCalibration(bets: SettledBetRow[]): CalibrationReport {
  const settledCount = bets.length;
  const totalStakeEur = round(bets.reduce((sum, bet) => sum + bet.size_eur, 0));
  const totalPnlEur = round(bets.reduce((sum, bet) => sum + bet.pnl_eur, 0));
  const wins = bets.filter((bet) => bet.pnl_eur > 0).length;
  const winRate = settledCount > 0 ? wins / settledCount : 0;
  const returnOnStake = totalStakeEur > 0 ? totalPnlEur / totalStakeEur : 0;

  const withForecast = bets.filter((bet): bet is SettledBetRow & { forecast_prob: number } => bet.forecast_prob !== null);
  const forecastCount = withForecast.length;

  const buckets: CalibrationBucket[] = [];
  for (let index = 0; index < BUCKET_EDGES.length - 1; index += 1) {
    const low = BUCKET_EDGES[index]!;
    const high = BUCKET_EDGES[index + 1]!;
    const inBucket = withForecast.filter((bet) => bet.forecast_prob >= low && bet.forecast_prob < high);
    if (inBucket.length === 0) continue;
    const avgForecast = inBucket.reduce((sum, bet) => sum + bet.forecast_prob, 0) / inBucket.length;
    const hitRate = inBucket.filter((bet) => bet.pnl_eur > 0).length / inBucket.length;
    buckets.push({
      label: `${(low * 100).toFixed(0)}-${(Math.min(high, 1) * 100).toFixed(0)}%`,
      count: inBucket.length,
      avgForecast: round(avgForecast),
      hitRate: round(hitRate),
    });
  }

  if (forecastCount === 0) {
    return { settledCount, forecastCount, totalStakeEur, totalPnlEur, returnOnStake, winRate, buckets };
  }

  const brierScore = round(
    withForecast.reduce((sum, bet) => {
      const outcome = bet.pnl_eur > 0 ? 1 : 0;
      return sum + (bet.forecast_prob - outcome) ** 2;
    }, 0) / forecastCount,
    4,
  );
  const marketBrierScore = round(
    withForecast.reduce((sum, bet) => {
      const outcome = bet.pnl_eur > 0 ? 1 : 0;
      return sum + (bet.market_prior_prob - outcome) ** 2;
    }, 0) / forecastCount,
    4,
  );
  const brierSkillScore =
    marketBrierScore > 0 ? round(1 - brierScore / marketBrierScore, 4) : undefined;
  const avgForecast = round(withForecast.reduce((sum, bet) => sum + bet.forecast_prob, 0) / forecastCount);
  const avgMarketPrior = round(
    withForecast.reduce((sum, bet) => sum + bet.market_prior_prob, 0) / forecastCount,
  );
  const realizedRate = round(withForecast.filter((bet) => bet.pnl_eur > 0).length / forecastCount);

  return {
    settledCount,
    forecastCount,
    totalStakeEur,
    totalPnlEur,
    returnOnStake,
    winRate,
    brierScore,
    marketBrierScore,
    brierSkillScore,
    avgForecast,
    avgMarketPrior,
    realizedRate,
    buckets,
  };
}

export function computeForecastCalibration(
  forecasts: SettledForecastRow[],
): ForecastCalibrationReport {
  if (forecasts.length === 0) {
    return { settledCount: 0, buckets: [], categories: [] };
  }

  const brierScore = round(
    forecasts.reduce((sum, forecast) => sum + forecast.bot_brier, 0) / forecasts.length,
    4,
  );
  const marketBrierScore = round(
    forecasts.reduce((sum, forecast) => sum + forecast.market_brier, 0) / forecasts.length,
    4,
  );
  const brierSkillScore =
    marketBrierScore > 0 ? round(1 - brierScore / marketBrierScore, 4) : undefined;
  const avgForecast = round(
    forecasts.reduce((sum, forecast) => sum + forecast.forecast_yes_probability, 0) /
      forecasts.length,
  );
  const avgMarketPrior = round(
    forecasts.reduce((sum, forecast) => sum + forecast.market_yes_probability, 0) /
      forecasts.length,
  );
  const realizedRate = round(
    forecasts.reduce((sum, forecast) => sum + forecast.outcome_yes, 0) / forecasts.length,
  );

  const buckets = buildForecastBuckets(forecasts);
  const categoryNames = [...new Set(forecasts.map((forecast) => forecast.category))].sort();
  const categories = categoryNames.map((category) => {
    const rows = forecasts.filter((forecast) => forecast.category === category);
    const categoryBrier = round(
      rows.reduce((sum, forecast) => sum + forecast.bot_brier, 0) / rows.length,
      4,
    );
    const categoryMarketBrier = round(
      rows.reduce((sum, forecast) => sum + forecast.market_brier, 0) / rows.length,
      4,
    );
    return {
      category,
      count: rows.length,
      brierScore: categoryBrier,
      marketBrierScore: categoryMarketBrier,
      brierSkillScore:
        categoryMarketBrier > 0
          ? round(1 - categoryBrier / categoryMarketBrier, 4)
          : undefined,
    };
  });

  return {
    settledCount: forecasts.length,
    brierScore,
    marketBrierScore,
    brierSkillScore,
    avgForecast,
    avgMarketPrior,
    realizedRate,
    buckets,
    categories,
  };
}

function buildForecastBuckets(forecasts: SettledForecastRow[]): CalibrationBucket[] {
  const buckets: CalibrationBucket[] = [];
  for (let index = 0; index < BUCKET_EDGES.length - 1; index += 1) {
    const low = BUCKET_EDGES[index]!;
    const high = BUCKET_EDGES[index + 1]!;
    const rows = forecasts.filter(
      (forecast) =>
        forecast.forecast_yes_probability >= low &&
        forecast.forecast_yes_probability < high,
    );
    if (rows.length === 0) continue;
    buckets.push({
      label: `${(low * 100).toFixed(0)}-${(Math.min(high, 1) * 100).toFixed(0)}%`,
      count: rows.length,
      avgForecast: round(
        rows.reduce((sum, forecast) => sum + forecast.forecast_yes_probability, 0) /
          rows.length,
      ),
      hitRate: round(
        rows.reduce((sum, forecast) => sum + forecast.outcome_yes, 0) / rows.length,
      ),
    });
  }
  return buckets;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
