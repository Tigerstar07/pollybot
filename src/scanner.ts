import type { AppConfig } from "./config";
import type { Db } from "./db";
import { finalizeLatestRankingsBatch, recordError, saveProbabilityEstimate, saveRanking, upsertMarket } from "./db";
import { printTopMarkets } from "./format";
import { logger } from "./logger";
import { estimateProbability } from "./probability/heuristics";
import { maybeEstimateWithLlm } from "./probability/llm";
import { applyLlmReview } from "./probability/review";
import { fetchOpenMarkets } from "./providers/polymarket/markets";
import { rankMarket } from "./ranking/ranker";
import { collectCheapSources } from "./sources";
import type { SportsOddsRequestBudget } from "./sources/sportsOddsSource";
import type { NormalizedMarket, RankingResult, SourceObservation } from "./types";
import { daysUntil } from "./utils";

export async function scanAndRank(config: AppConfig, db: Db, options: { print?: boolean } = {}): Promise<RankingResult[]> {
  const scanBatchId = crypto.randomUUID();
  const verbose = options.print !== false;
  const startedAt = Date.now();
  let markets: NormalizedMarket[] = [];
  try {
    if (verbose) {
      console.log(
        `[scan] fetching Polymarket markets ` +
          `(all=${config.scanAllMarkets}, pageLimit=${config.scanPageLimit}, maxEvents=${config.scanAllMarkets ? "all" : config.scanMaxEvents})`,
      );
    }
    markets = await fetchOpenMarkets(config, {
      onPage: verbose
        ? (page) => {
            console.log(
              `[scan] fetched page offset=${page.offset}: ${page.events} event(s), ` +
                `${page.markets} new market(s); totals ${page.totalEvents} event(s), ${page.totalMarkets} market(s)`,
            );
          }
        : undefined,
    });
  } catch (error) {
    logger.error("Failed to fetch open markets from Polymarket Gamma", error);
    recordError(db, "fetch-open-markets", error);
    // A total discovery failure is not a valid empty market set. Propagate it so
    // live commands exit non-zero and never continue into stale-cache execution.
    throw error;
  }
  if (verbose) {
    console.log(`[scan] fetched ${markets.length} unique market(s); storing snapshots`);
  }

  for (const market of markets) {
    try {
      upsertMarket(db, market);
    } catch (error) {
      logger.error(`Failed to upsert market ${market.marketId}`, error);
      recordError(db, "upsert-market:" + market.marketId, error);
    }
  }

  const rankings: RankingResult[] = [];
  const sportsOddsBudget: SportsOddsRequestBudget = {
    maxCalls: config.sportsOddsMaxCallsPerScan,
    usedCalls: 0,
  };
  const progressEvery = Math.max(250, Math.ceil(markets.length / 20));
  const actionCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  const researchPlan = planExternalResearchMarkets(config, markets);
  const researchMarketIds = new Set(researchPlan.map((market) => market.marketId));
  const plannedNews = researchPlan.filter((market) => isNewsLedCategory(market.category)).length;
  const orderedMarkets = [
    ...researchPlan,
    ...markets.filter((market) => !researchMarketIds.has(market.marketId)),
  ];
  if (verbose) {
    console.log(
      `[scan] external research plan: ${researchPlan.length}/${markets.length} market(s), ` +
        `${plannedNews} news-led; open/liquid/executable markets first`,
    );
  }
  const research = await collectResearchPlanSources(
    config,
    db,
    researchPlan,
    sportsOddsBudget,
    verbose,
  );
  let sourcedMarkets = 0;
  let independentEvidenceMarkets = 0;
  let sourceErrors = research.failures;
  for (const [index, market] of orderedMarkets.entries()) {
    try {
      const sources = research.sourcesByMarket.get(market.marketId) ?? [];
      if (sources.some((source) => source.available)) sourcedMarkets += 1;
      if (sources.some((source) => source.available && source.independent)) independentEvidenceMarkets += 1;
      const baseEstimate = estimateProbability(config, market, sources);
      const llmReview = sources.length > 0
        ? await maybeEstimateWithLlm(config, market, sources).catch(() => undefined)
        : undefined;
      const estimate = applyLlmReview(baseEstimate, llmReview);
      const ranking = rankMarket(config, market, estimate);
      saveProbabilityEstimate(db, estimate);
      saveRanking(db, ranking, scanBatchId);
      rankings.push(ranking);
      actionCounts.set(ranking.action, (actionCounts.get(ranking.action) ?? 0) + 1);
      categoryCounts.set(market.category, (categoryCounts.get(market.category) ?? 0) + 1);
    } catch (error) {
      sourceErrors += 1;
      logger.error(`Failed to scan/rank market ${market.marketId}`, error);
      recordError(db, "scan-market:" + market.marketId, error);
    }
    const processed = index + 1;
    if (verbose && (processed === orderedMarkets.length || processed % progressEvery === 0)) {
      console.log(
        `[scan] ranked ${processed}/${orderedMarkets.length} market(s); ` +
          `actions ${formatCounts(actionCounts)}; independent evidence ${independentEvidenceMarkets}; ` +
          `sports odds calls ${sportsOddsBudget.usedCalls}/${sportsOddsBudget.maxCalls}`,
      );
    }
  }

  finalizeLatestRankingsBatch(db, scanBatchId);
  const actionPriority = { LIVE_BET: 0, PAPER_BET: 0, WATCH: 1, UNMODELED: 2, SKIP: 3 };
  rankings.sort((a, b) => actionPriority[a.action] - actionPriority[b.action] || b.finalScore - a.finalScore);
  if (verbose) {
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`Fetched and normalized ${markets.length} markets from Polymarket Gamma.`);
    console.log(
      `[scan] complete in ${seconds}s; actions ${formatCounts(actionCounts)}; ` +
        `categories ${formatCounts(categoryCounts)}; markets with any source ${sourcedMarkets}; ` +
        `independent evidence ${independentEvidenceMarkets}; scan errors ${sourceErrors}`,
    );
    printTopMarkets(rankings, 20);
  }
  return rankings;
}

async function collectResearchPlanSources(
  config: AppConfig,
  db: Db,
  markets: NormalizedMarket[],
  sportsOddsBudget: SportsOddsRequestBudget,
  verbose: boolean,
): Promise<{ sourcesByMarket: Map<string, SourceObservation[]>; failures: number }> {
  const sourcesByMarket = new Map<string, SourceObservation[]>();
  let nextIndex = 0;
  let completed = 0;
  let failures = 0;
  const concurrency = Math.min(6, Math.max(1, markets.length));
  const progressEvery = Math.max(25, Math.ceil(markets.length / 8));
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= markets.length) return;
      const market = markets[index];
      if (!market) return;
      try {
        const sources = await collectCheapSources(config, db, market, { sportsOddsBudget });
        sourcesByMarket.set(market.marketId, sources);
      } catch (error) {
        failures += 1;
        logger.error(`Failed to collect sources for market ${market.marketId}`, error);
        recordError(db, `source-market:${market.marketId}`, error);
        sourcesByMarket.set(market.marketId, []);
      }
      completed += 1;
      if (verbose && (completed === markets.length || completed % progressEvery === 0)) {
        console.log(
          `[scan] researched ${completed}/${markets.length} planned market(s); ` +
            `sports odds calls ${sportsOddsBudget.usedCalls}/${sportsOddsBudget.maxCalls}; failures=${failures}`,
        );
      }
    }
  });
  await Promise.all(workers);
  return { sourcesByMarket, failures };
}

function shouldCollectExternalSources(config: AppConfig, market: NormalizedMarket): boolean {
  if (market.status !== "open") return false;
  const outcomes = market.outcomes.map((outcome) => outcome.toLowerCase());
  if (!market.yesTokenId || !market.noTokenId || outcomes.length !== 2 || !outcomes.includes("yes") || !outcomes.includes("no")) {
    return false;
  }
  const days = daysUntil(market.endDate);
  if (days === undefined) return false;
  const hours = days * 24;
  if (hours < config.minHoursToEnd || days > config.maxDaysToEnd) return false;
  // Gamma occasionally omits liquidity on otherwise open CLOB markets. Missing
  // metadata is not evidence of zero liquidity: keep it in the research plan and
  // let the fresh order-book check make the executable-liquidity decision. A
  // reported value below the configured floor is still rejected here.
  if (market.liquidity !== undefined && market.liquidity < config.minLiquidity) return false;
  const prices = [market.bestAsk ?? market.yesPrice, market.noBestAsk ?? market.noPrice]
    .filter((price): price is number => price !== undefined && Number.isFinite(price));
  if (!prices.some((price) => price >= config.liveMinPrice && price <= config.liveMaxPrice)) return false;
  const widestSpread = Math.max(market.spread ?? 0, market.noSpread ?? 0);
  return widestSpread === 0 || widestSpread <= config.maxSpread;
}

/**
 * Build a diverse, execution-aware external research plan. Gamma can return tens of
 * thousands of child markets, including resolved children inside still-active events.
 * Slow APIs must not be called on all of them or a 30-minute live cycle takes hours.
 * Unselected markets are still ranked immediately as UNMODELED/SKIP and can enter a
 * later plan if their liquidity, price, or horizon improves.
 */
export function planExternalResearchMarkets(config: AppConfig, markets: NormalizedMarket[]): NormalizedMarket[] {
  const maximum = Math.max(1, config.scanMaxExternalSourceMarkets ?? 600);
  const maximumNews = Math.min(maximum, Math.max(1, config.scanMaxNewsSourceMarkets ?? 30));
  const eligible = markets.filter((market) => shouldCollectExternalSources(config, market));
  const byCategory = new Map<string, NormalizedMarket[]>();
  for (const market of eligible) {
    const group = byCategory.get(market.category) ?? [];
    group.push(market);
    byCategory.set(market.category, group);
  }
  for (const group of byCategory.values()) group.sort((left, right) => researchPriority(right) - researchPriority(left));

  const selected: NormalizedMarket[] = [];
  const selectedIds = new Set<string>();
  const eventCounts = new Map<string, number>();
  let selectedNews = 0;
  const categoryPlan: Array<[string[], number, number]> = [
    [["weather"], Math.ceil(maximum * 0.45), 12],
    [["sports"], Math.ceil(maximum * 0.13), 3],
    [["esports"], Math.ceil(maximum * 0.06), 3],
    [["crypto"], Math.ceil(maximum * 0.08), 3],
    [["macro"], Math.ceil(maximum * 0.08), 4],
    [["finance"], Math.ceil(maximum * 0.05), 3],
    [["tech"], Math.ceil(maximum * 0.04), 3],
    [["culture"], Math.ceil(maximum * 0.03), 3],
    [["mentions", "politics", "geopolitics", "objective-event"], maximumNews, 2],
  ];

  for (const [categories, categoryLimit, perEventLimit] of categoryPlan) {
    const candidates = categories
      .flatMap((category) => byCategory.get(category) ?? [])
      .sort((left, right) => researchPriority(right) - researchPriority(left));
    let categorySelected = 0;
    for (const market of candidates) {
      if (selected.length >= maximum || categorySelected >= categoryLimit) break;
      if (selectedIds.has(market.marketId)) continue;
      const newsLed = isNewsLedCategory(market.category);
      if (newsLed && selectedNews >= maximumNews) continue;
      const eventKey = market.eventId ?? market.marketId;
      if ((eventCounts.get(eventKey) ?? 0) >= perEventLimit) continue;
      selected.push(market);
      selectedIds.add(market.marketId);
      eventCounts.set(eventKey, (eventCounts.get(eventKey) ?? 0) + 1);
      categorySelected += 1;
      if (newsLed) selectedNews += 1;
    }
  }

  return selected.sort((left, right) => researchPriority(right) - researchPriority(left));
}

function isNewsLedCategory(category: string): boolean {
  return category === "mentions" || category === "politics" || category === "geopolitics" || category === "objective-event";
}

function researchPriority(market: NormalizedMarket): number {
  const days = Math.max(0, daysUntil(market.endDate) ?? 365);
  const liquidity = Math.max(0, market.liquidity ?? 0);
  const volume = Math.max(0, market.volume ?? 0);
  const prices = [market.bestAsk ?? market.yesPrice, market.noBestAsk ?? market.noPrice]
    .filter((price): price is number => price !== undefined && Number.isFinite(price));
  const centrality = prices.length > 0 ? Math.max(...prices.map((price) => 1 - Math.abs(0.5 - price) * 2)) : 0;
  const spreadPenalty = Math.max(market.spread ?? 0.05, market.noSpread ?? market.spread ?? 0.05) * 30;
  const clarityBonus = (market.rules?.length ?? 0) >= 120 ? 2 : 0;
  return Math.log1p(liquidity) * 2 + Math.log1p(volume) * 0.35 + centrality * 6 + Math.max(0, 8 - Math.sqrt(days)) + clarityBonus - spreadPenalty;
}

function formatCounts(counts: Map<string, number>): string {
  if (counts.size === 0) return "none";
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `${key}=${count}`)
    .join(", ");
}
