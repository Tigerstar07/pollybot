import type { AppConfig } from "../config";
import type { Db } from "../db";
import { getCachedSource, saveSourceObservation } from "../db";
import type { NormalizedMarket, SourceObservation } from "../types";
import { clamp, nowIso, toNumber } from "../utils";
import { resilientFetchJson } from "../utils/fetch";

interface OddsOutcome {
  name: string;
  price: number;
}

interface OddsMarket {
  key: string;
  outcomes: OddsOutcome[];
}

interface Bookmaker {
  key: string;
  title: string;
  last_update: string;
  markets: OddsMarket[];
}

export interface OddsEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: Bookmaker[];
}

export interface SportsOddsRequestBudget {
  maxCalls: number;
  usedCalls: number;
}

type OddsMarketKey = "h2h" | "outrights";

const SPORT_KEYS: Array<[RegExp, string]> = [
  [/\bleague of legends\b|\blol\b/i, "esports_lol"],
  [/\bcounter[- ]strike\b|\bcs2\b|\bcs:go\b/i, "esports_cs2"],
  [/\bdota\s?2\b/i, "esports_dota2"],
  [/\bvalorant\b/i, "esports_valorant"],
  [/\boverwatch\b/i, "esports_overwatch"],
  [/\brainbow six\b|\br6 siege\b|\br6\b/i, "esports_r6"],
  [/\bhonor of kings\b/i, "esports_honor_of_kings"],
  [/\bmobile legends\b/i, "esports_mobile_legends"],
  [/\bnba\b|\bceltics\b|\blakers\b|\bwarriors\b|\bknicks\b|\bnets\b|\bheat\b|\bbulls\b|\bmavericks\b|\bmavs\b|\bnuggets\b|\bsuns\b|\b76ers\b|\bsixers\b|\bbucks\b|\bcavaliers\b|\bcavs\b|\btimberwolves\b|\bwolves\b|\bclippers\b|\bspurs\b|\brockets\b|\bgrizzlies\b|\bpelicans\b|\bmagic\b|\bpacers\b|\bpistons\b|\bhawks\b|\bhornets\b|\braptors\b|\bjazz\b|\btrail blazers\b|\bblazers\b|\bkings\b|\bthunder\b/i, "basketball_nba"],
  [/\bwnba\b/i, "basketball_wnba"],
  [/\bncaab\b|\bcollege basketball\b/i, "basketball_ncaab"],
  [/\bnfl\b|\bchiefs\b|\beagles\b|\bcowboys\b|\bpackers\b|\bpatriots\b|\b49ers\b|\bniners\b|\bgiants\b|\bjets\b|\bbills\b|\bdolphins\b|\bravens\b|\bsteelers\b|\bbengals\b|\bbrowns\b|\btexans\b|\bcolts\b|\bjaguars\b|\btitans\b|\bbroncos\b|\braiders\b|\bchargers\b|\bseahawks\b|\brams\b|\bcardinals\b|\bfalcons\b|\bpanthers\b|\bsaints\b|\bbuccaneers\b|\bbucs\b|\bvikings\b|\blions\b|\bbears\b|\bcommanders\b/i, "americanfootball_nfl"],
  [/\bncaaf\b|\bcollege football\b/i, "americanfootball_ncaaf"],
  [/\bmlb\b|\byankees\b|\bmets\b|\bred sox\b|\bdodgers\b|\bgiants\b|\bpadres\b|\bangels\b|\bastros\b|\brangers\b|\bmariners\b|\bathletics\b|\ba's\b|\bcubs\b|\bwhite sox\b|\bcardinals\b|\bbrewers\b|\breds\b|\bpirates\b|\bphillies\b|\bbraves\b|\bnationals\b|\bmarlins\b|\brays\b|\bblue jays\b|\borioles\b|\btwins\b|\btigers\b|\bguardians\b|\broyals\b|\brockies\b|\bdiamondbacks\b/i, "baseball_mlb"],
  [/\bnhl\b|\brangers\b|\bislanders\b|\bdevils\b|\bboston bruins\b|\bbruins\b|\bmaple leafs\b|\bleafs\b|\bcanadiens\b|\bsenators\b|\bsabres\b|\bred wings\b|\bpenguins\b|\bflyers\b|\bcapitals\b|\bhurricanes\b|\blightning\b|\bpanthers\b|\bblue jackets\b|\bblackhawks\b|\bblues\b|\bwild\b|\bjets\b|\bstars\b|\bavalanche\b|\bgolden knights\b|\boilers\b|\bflames\b|\bcanucks\b|\bkraken\b|\bkings\b|\bducks\b|\bsharks\b|\bcoyotes\b|\butah\b/i, "icehockey_nhl"],
  [/\bufc\b|\bmma\b/i, "mma_mixed_martial_arts"],
  [/\bwta\b|\bwomen'?s tennis\b/i, "tennis_wta"],
  [/\batp\b|\bmen'?s tennis\b|\btennis\b/i, "tennis_atp"],
  [/\bworld cup\b|\bfifa\b/i, "soccer_fifa_world_cup"],
  [/\bepl\b|\bpremier league\b/i, "soccer_epl"],
  [/\bchampions league\b|\bucl\b/i, "soccer_uefa_champs_league"],
  [/\beuropa league\b|\buel\b/i, "soccer_uefa_europa_league"],
  [/\bla liga\b|\blaliga\b/i, "soccer_spain_la_liga"],
  [/\bserie a\b/i, "soccer_italy_serie_a"],
  [/\bbundesliga\b/i, "soccer_germany_bundesliga"],
  [/\bligue 1\b/i, "soccer_france_ligue_one"],
  [/\bmls\b/i, "soccer_usa_mls"],
];

const OUTRIGHT_SPORT_KEYS: Array<[RegExp, string]> = [
  [/\bfifa\b.*\bworld cup\b.*\b(win|winner|champion|champions)\b|\b(win|winner|champion|champions)\b.*\bfifa\b.*\bworld cup\b|\bworld cup winner\b/i, "soccer_fifa_world_cup_winner"],
  [/\bworld series\b.*\b(win|winner|champion|champions)\b|\b(win|winner|champion|champions)\b.*\bworld series\b|\bworld series winner\b/i, "baseball_mlb_world_series_winner"],
];

interface SportCatalogItem {
  key: string;
  group?: string;
  title?: string;
  description?: string;
  active?: boolean;
  has_outrights?: boolean;
}

export async function getSportsOddsObservation(
  config: AppConfig,
  db: Db,
  market: NormalizedMarket,
  budget?: SportsOddsRequestBudget,
): Promise<SourceObservation> {
  if (!config.sportsOddsApiKey) return unavailable(market, "SPORTS_ODDS_API_KEY is not configured");
  const sportText = `${market.title} ${market.tags.join(" ")}`;
  const marketType: OddsMarketKey = isOutrightMarket(market) ? "outrights" : "h2h";
  const detectedSportKey =
    marketType === "outrights"
      ? detectOutrightSportKey(sportText) ?? await detectSportKeyFromCatalog(config, db, sportText, { requireOutrights: true })
      : detectSportKey(sportText) ?? await detectSportKeyFromCatalog(config, db, sportText);
  const sportKey = detectedSportKey && await isCatalogConfirmedSportKey(config, db, detectedSportKey)
    ? detectedSportKey
    : detectedSportKey?.startsWith("esports_")
      ? await detectSportKeyFromCatalog(config, db, sportText, { requireOutrights: marketType === "outrights" })
      : detectedSportKey;
  if (!sportKey) {
    return unavailable(
      market,
      marketType === "outrights"
        ? "Outright/futures market needs an external outrights feed; h2h match odds are not used"
        : "League is not yet mapped to an external odds feed",
    );
  }

  try {
    const events = await getOddsFeed(config, db, sportKey, marketType, budget);
    const match = matchMarketToOdds(market, events, config.sportsOddsMaxAgeMinutes, marketType);
    if (!match) {
      return unavailable(
        market,
        marketType === "outrights"
          ? `No sufficiently close ${sportKey} outright/contestant match was found`
          : `No sufficiently close ${sportKey} event/team match was found`,
      );
    }

    return {
      sourceType: "sports-odds",
      sourceKey: `sports:${market.marketId}`,
      collectedAt: nowIso(),
      expiresAt: new Date(Date.now() + 2 * 60_000).toISOString(),
      available: true,
      independent: true,
      quality: match.quality,
      payload: {
        provider: "the-odds-api",
        sportKey,
        eventId: match.event.id,
        event: `${match.event.away_team} @ ${match.event.home_team}`,
        commenceTime: match.event.commence_time,
        target: match.target,
        fairYesProbability: match.probability,
        bookmakerCount: match.bookmakerCount,
        probabilityDispersion: match.dispersion,
        matchedScore: match.matchScore,
        freshestBookmakerUpdate: match.freshestBookmakerUpdate,
        matchingMethod: marketType === "outrights" ? "outright-contestant-name" : "team-name-and-start-time",
      },
    };
  } catch (error) {
    return unavailable(market, error instanceof Error ? error.message : String(error));
  }
}

export function detectSportKey(text: string): string | undefined {
  return SPORT_KEYS.find(([pattern]) => pattern.test(text))?.[1];
}

export function detectOutrightSportKey(text: string): string | undefined {
  return OUTRIGHT_SPORT_KEYS.find(([pattern]) => pattern.test(text))?.[1];
}

function isOutrightMarket(market: NormalizedMarket): boolean {
  const text = `${market.title} ${market.rules ?? ""}`.toLowerCase();
  return /\b(win|winner|champion|champions|championship|tournament|world cup|world series|super bowl|stanley cup|nba finals)\b/.test(text) &&
    !/\b(beat|defeat|vs\.?|versus|moneyline|spread|total|over\/under)\b/.test(text);
}

async function detectSportKeyFromCatalog(
  config: AppConfig,
  db: Db,
  text: string,
  options: { requireOutrights?: boolean } = {},
): Promise<string | undefined> {
  const catalog = await getSportsCatalog(config, db).catch(() => []);
  if (catalog.length === 0) return undefined;
  const marketText = normalize(text);
  const candidates = catalog
    .filter((sport) => sport.active !== false)
    .filter((sport) => !options.requireOutrights || sport.has_outrights === true)
    .map((sport) => {
      const title = normalize(sport.title ?? "");
      const group = normalize(sport.group ?? "");
      const description = normalize(sport.description ?? "");
      const keyText = normalize(sport.key.replace(/_/g, " "));
      let score = 0;
      if (title && marketText.includes(title)) score += 1.2;
      if (group && marketText.includes(group)) score += 0.25;
      if (description && marketText.includes(description)) score += 0.35;
      for (const token of tokens(`${sport.title ?? ""} ${sport.description ?? ""} ${sport.key.replace(/_/g, " ")}`)) {
        if (marketText.includes(token)) score += token.length > 5 ? 0.12 : 0.08;
      }
      if (options.requireOutrights && sport.has_outrights) score += 0.35;
      if (/\bworld cup\b/.test(marketText) && /\bworld cup\b/.test(`${title} ${description} ${keyText}`)) score += 1;
      if (/\bwinner|win|champion|champions\b/.test(marketText) && /\bwinner|champion|champions\b/.test(`${title} ${description} ${keyText}`)) score += 0.75;
      return { sport, score };
    })
    .sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const second = candidates[1];
  if (!best || best.score < 0.5) return undefined;
  if (second && best.score - second.score < 0.15) return undefined;
  return best.sport.key;
}

async function isCatalogConfirmedSportKey(config: AppConfig, db: Db, sportKey: string): Promise<boolean> {
  if (!sportKey.startsWith("esports_")) return true;
  const catalog = await getSportsCatalog(config, db).catch(() => []);
  return catalog.some((sport) => sport.active !== false && sport.key === sportKey);
}

async function getSportsCatalog(config: AppConfig, db: Db): Promise<SportCatalogItem[]> {
  const cacheKey = "the-odds-api:sports-catalog:all";
  const cached = getCachedSource(db, "sports-odds-catalog", cacheKey);
  if (cached?.available && Array.isArray(cached.payload.sports)) {
    return cached.payload.sports as unknown as SportCatalogItem[];
  }
  const url = new URL("/v4/sports/", config.sportsOddsApiUrl);
  url.searchParams.set("apiKey", config.sportsOddsApiKey ?? "");
  url.searchParams.set("all", "true");
  const result = await resilientFetchJson<SportCatalogItem[]>(url, {
    timeoutMs: 12_000,
    headers: { "user-agent": "pollybot/1.1 research and paper-trading bot" },
  });
  const sports = Array.isArray(result.data) ? result.data : [];
  saveSourceObservation(db, null, {
    sourceType: "sports-odds-catalog",
    sourceKey: cacheKey,
    collectedAt: nowIso(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    available: true,
    independent: true,
    quality: 0.55,
    payload: { sports },
  });
  return sports;
}

async function getOddsFeed(
  config: AppConfig,
  db: Db,
  sportKey: string,
  marketType: OddsMarketKey,
  budget?: SportsOddsRequestBudget,
): Promise<OddsEvent[]> {
  const cacheKey = `the-odds-api:${sportKey}:${config.sportsOddsRegions}:${marketType}`;
  const cached = getCachedSource(db, "sports-odds-feed", cacheKey);
  if (cached?.available && Array.isArray(cached.payload.events)) return cached.payload.events as OddsEvent[];

  const lastKnownRemaining = getLastKnownRemainingQuota(db);
  if (lastKnownRemaining !== undefined && lastKnownRemaining <= config.sportsOddsMinRemaining) {
    throw new Error(
      `Sports odds quota guard preserved the final ${config.sportsOddsMinRemaining} monthly credits`,
    );
  }
  if (budget && budget.usedCalls >= budget.maxCalls) {
    throw new Error(`Sports odds per-scan request budget of ${budget.maxCalls} was reached`);
  }
  if (budget) budget.usedCalls += 1;

  const url = new URL(`/v4/sports/${sportKey}/odds/`, config.sportsOddsApiUrl);
  url.searchParams.set("apiKey", config.sportsOddsApiKey ?? "");
  url.searchParams.set("regions", config.sportsOddsRegions);
  url.searchParams.set("markets", marketType);
  url.searchParams.set("oddsFormat", "decimal");
  url.searchParams.set("dateFormat", "iso");
  const result = await resilientFetchJson<OddsEvent[]>(url, {
    timeoutMs: 15_000,
    headers: { "user-agent": "pollybot/1.1 research and paper-trading bot" },
  });
  const events = result.data;
  const cacheMs = config.sportsOddsCacheMinutes * 60_000;
  const observation: SourceObservation = {
    sourceType: "sports-odds-feed",
    sourceKey: cacheKey,
    collectedAt: nowIso(),
    expiresAt: new Date(Date.now() + cacheMs).toISOString(),
    available: true,
    independent: true,
    quality: 0.75,
    payload: {
      events,
      requestsRemaining: result.headers.get("x-requests-remaining") ?? undefined,
      requestsUsed: result.headers.get("x-requests-used") ?? undefined,
      requestsLast: result.headers.get("x-requests-last") ?? undefined,
      cacheMinutes: config.sportsOddsCacheMinutes,
    },
  };
  saveSourceObservation(db, null, observation);
  return events;
}

export function matchMarketToOdds(
  market: NormalizedMarket,
  events: OddsEvent[],
  maxLineAgeMinutes = 30,
  marketType: OddsMarketKey = isOutrightMarket(market) ? "outrights" : "h2h",
): {
  event: OddsEvent;
  target: string;
  probability: number;
  bookmakerCount: number;
  dispersion: number;
  quality: number;
  matchScore: number;
  freshestBookmakerUpdate?: string;
} | undefined {
  if (marketType === "outrights") return matchMarketToOutrights(market, events, maxLineAgeMinutes);
  return matchMarketToH2h(market, events, maxLineAgeMinutes);
}

function matchMarketToH2h(
  market: NormalizedMarket,
  events: OddsEvent[],
  maxLineAgeMinutes = 30,
): ReturnType<typeof matchMarketToOdds> {
  const marketText = normalize(market.title);
  const leftSideText = normalize(market.title.split(/\bvs\.?|\bversus\b/i)[0] ?? "");
  const candidates = events.flatMap((event) => {
    const homeScore = nameMatchScore(marketText, event.home_team);
    const awayScore = nameMatchScore(marketText, event.away_team);
    const leftHomeScore = leftSideText ? nameMatchScore(leftSideText, event.home_team) : 0;
    const leftAwayScore = leftSideText ? nameMatchScore(leftSideText, event.away_team) : 0;
    const target =
      Math.max(leftHomeScore, leftAwayScore) >= 0.6
        ? leftHomeScore >= leftAwayScore
          ? event.home_team
          : event.away_team
        : homeScore >= awayScore
          ? event.home_team
          : event.away_team;
    const targetScore = Math.max(homeScore, awayScore);
    const bothTeamsBonus = Math.min(homeScore, awayScore) > 0.6 ? 0.2 : 0;
    const endDistanceHours = market.endDate
      ? Math.abs(Date.parse(market.endDate) - Date.parse(event.commence_time)) / 3_600_000
      : 24;
    const timeScore = clamp(1 - endDistanceHours / 72, 0, 1);
    return [{ event, target, score: targetScore + bothTeamsBonus + timeScore * 0.2 }];
  });
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score < 0.72 || !/\b(win|beat|defeat|moneyline|victorious|vs\.?|versus)\b/i.test(market.title)) return undefined;
  const second = candidates[1];
  if (second && best.score - second.score < 0.08) return undefined;

  const probabilities: number[] = [];
  let freshestBookmakerUpdateMs = 0;
  const maxLineAgeMs = maxLineAgeMinutes * 60_000;
  for (const bookmaker of best.event.bookmakers ?? []) {
    if (bookmaker.key.toLowerCase() === "polymarket") continue;
    const updatedAt = Date.parse(bookmaker.last_update);
    if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > maxLineAgeMs) continue;
    const h2h = bookmaker.markets.find((bookMarket) => bookMarket.key === "h2h");
    if (!h2h || h2h.outcomes.length < 2) continue;
    const inverse = h2h.outcomes.map((outcome) => ({ name: outcome.name, value: 1 / Number(outcome.price) }));
    const total = inverse.reduce((sum, outcome) => sum + outcome.value, 0);
    const target = inverse.find((outcome) => normalize(outcome.name) === normalize(best.target));
    if (target && total > 0) {
      probabilities.push(target.value / total);
      freshestBookmakerUpdateMs = Math.max(freshestBookmakerUpdateMs, updatedAt);
    }
  }
  if (probabilities.length === 0) return undefined;

  probabilities.sort((a, b) => a - b);
  const probability = median(probabilities);
  const mean = probabilities.reduce((sum, value) => sum + value, 0) / probabilities.length;
  const dispersion = Math.sqrt(probabilities.reduce((sum, value) => sum + (value - mean) ** 2, 0) / probabilities.length);
  const quality = clamp(0.48 + Math.min(0.24, probabilities.length * 0.035) - dispersion, 0.4, 0.82);
  return {
    event: best.event,
    target: best.target,
    probability,
    bookmakerCount: probabilities.length,
    dispersion,
    quality,
    matchScore: best.score,
    freshestBookmakerUpdate:
      freshestBookmakerUpdateMs > 0 ? new Date(freshestBookmakerUpdateMs).toISOString() : undefined,
  };
}

function matchMarketToOutrights(
  market: NormalizedMarket,
  events: OddsEvent[],
  maxLineAgeMinutes = 30,
): ReturnType<typeof matchMarketToOdds> {
  const marketText = normalize(market.title);
  const outcomeCandidates = events.flatMap((event) =>
    (event.bookmakers ?? []).flatMap((bookmaker) =>
      (bookmaker.markets ?? [])
        .filter((bookMarket) => bookMarket.key === "outrights")
        .flatMap((bookMarket) =>
          (bookMarket.outcomes ?? []).map((outcome) => ({
            event,
            target: outcome.name,
            score: nameMatchScore(marketText, outcome.name),
          })),
        ),
    ),
  );
  outcomeCandidates.sort((a, b) => b.score - a.score);
  const best = outcomeCandidates[0];
  if (!best || best.score < 0.72) return undefined;
  const second = outcomeCandidates.find((candidate) => normalize(candidate.target) !== normalize(best.target));
  if (second && best.score - second.score < 0.08) return undefined;

  const probabilities: number[] = [];
  let bookmakerCount = 0;
  let freshestBookmakerUpdateMs = 0;
  const maxLineAgeMs = maxLineAgeMinutes * 60_000;
  for (const event of events) {
    for (const bookmaker of event.bookmakers ?? []) {
      if (bookmaker.key.toLowerCase() === "polymarket") continue;
      const updatedAt = Date.parse(bookmaker.last_update);
      if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > maxLineAgeMs) continue;
      const outright = bookmaker.markets.find((bookMarket) => bookMarket.key === "outrights");
      if (!outright || outright.outcomes.length < 2) continue;
      const inverse = outright.outcomes.map((outcome) => ({ name: outcome.name, value: 1 / Number(outcome.price) }));
      const total = inverse.reduce((sum, outcome) => sum + outcome.value, 0);
      const target = inverse.find((outcome) => normalize(outcome.name) === normalize(best.target));
      if (target && total > 0) {
        probabilities.push(target.value / total);
        bookmakerCount += 1;
        freshestBookmakerUpdateMs = Math.max(freshestBookmakerUpdateMs, updatedAt);
      }
    }
  }
  if (probabilities.length === 0) return undefined;

  probabilities.sort((a, b) => a - b);
  const probability = median(probabilities);
  const mean = probabilities.reduce((sum, value) => sum + value, 0) / probabilities.length;
  const dispersion = Math.sqrt(probabilities.reduce((sum, value) => sum + (value - mean) ** 2, 0) / probabilities.length);
  const quality = clamp(0.5 + Math.min(0.22, bookmakerCount * 0.03) - dispersion, 0.38, 0.78);
  return {
    event: best.event,
    target: best.target,
    probability,
    bookmakerCount,
    dispersion,
    quality,
    matchScore: best.score,
    freshestBookmakerUpdate:
      freshestBookmakerUpdateMs > 0 ? new Date(freshestBookmakerUpdateMs).toISOString() : undefined,
  };
}

function getLastKnownRemainingQuota(db: Db): number | undefined {
  const rows = db.prepare(`
    SELECT payload_json
    FROM sources
    WHERE source_type = 'sports-odds-feed'
    ORDER BY collected_at DESC
    LIMIT 12
  `).all() as Array<{ payload_json: string }>;
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      const value = Number(payload.requestsRemaining);
      if (Number.isFinite(value)) return value;
    } catch {
      // Ignore malformed legacy rows and continue looking for a usable quota header.
    }
  }
  return undefined;
}

function nameMatchScore(marketText: string, teamName: string): number {
  const teamTokens = tokens(teamName);
  if (teamTokens.length === 0) return 0;
  const matched = teamTokens.filter((token) => marketText.includes(token)).length;
  return matched / teamTokens.length;
}

function tokens(value: string): string[] {
  const ignored = new Set(["fc", "cf", "the", "city", "united"]);
  return normalize(value).split(" ").filter((token) => token.length > 2 && !ignored.has(token));
}

function normalize(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
}

function median(values: number[]): number {
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2 : values[middle] ?? 0;
}

function unavailable(market: NormalizedMarket, reason: string): SourceObservation {
  return {
    sourceType: "sports-odds",
    sourceKey: `sports:${market.marketId}`,
    collectedAt: nowIso(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    payload: {},
    available: false,
    independent: true,
    quality: 0,
    reason,
  };
}
