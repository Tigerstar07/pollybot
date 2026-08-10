import type { AppConfig } from "../config";
import type { NormalizedMarket, ProbabilityEstimate, SourceObservation } from "../types";
import { clamp, daysUntil, toNumber } from "../utils";

interface EvidenceEstimate {
  probability: number;
  confidence: number;
  quality: number;
  method: string;
  evidence: string[];
  risks: string[];
}

export function estimateProbability(
  config: AppConfig,
  market: NormalizedMarket,
  sources: SourceObservation[],
): ProbabilityEstimate {
  const estimates: EvidenceEstimate[] = [];
  const crypto = sources.find((source) => source.sourceType === "crypto-price" && source.available);
  const sports = sources.find((source) => source.sourceType === "sports-odds" && source.available);
  const weatherSources = sources.filter((source) => source.sourceType === "weather" && source.available);
  const manual = sources.find((source) => source.sourceType === "manual-notes" && source.available);
  const news = sources.find((source) => source.sourceType === "news" && source.available);
  const marketData = sources.find((source) => source.sourceType === "market-data" && source.available);
  const marketCap = sources.find((source) => source.sourceType === "market-cap" && source.available);
  const macro = sources.find((source) => source.sourceType === "macro-economic" && source.available);
  const tech = sources.find((source) => source.sourceType === "tech-official" && source.available);
  const culture = sources.find(
    (source) => (source.sourceType === "culture-tmdb" || source.sourceType === "culture-wikidata") && source.available,
  );

  if (market.category === "crypto" && crypto) {
    const cryptoEstimate = estimateCryptoMarket(market, crypto);
    if (cryptoEstimate) estimates.push(cryptoEstimate);
  }

  // Commodities, equity indices, single stocks and FX priced via the free Stooq feed,
  // modeled with the same lognormal terminal/barrier math as crypto.
  if (marketData) {
    const financialEstimate = estimateFinancialMarket(market, marketData);
    if (financialEstimate) estimates.push(financialEstimate);
  }

  // Single-company market-cap markets ("largest company", "$X trillion valuation"). Runs
  // regardless of category since these surface under both tech and objective-event.
  if (marketCap) {
    const marketCapEstimate = estimateMarketCapMarket(market, marketCap);
    if (marketCapEstimate) estimates.push(marketCapEstimate);
  }

  if ((market.category === "sports" || market.category === "esports") && sports) {
    const sportsEstimate = estimateSportsMarket(sports);
    if (sportsEstimate) estimates.push(sportsEstimate);
  }

  if (market.category === "weather" && weatherSources.length > 0) {
    const weatherEstimate = estimateWeatherMarket(market, weatherSources);
    if (weatherEstimate) estimates.push(weatherEstimate);
  }

  if (market.category === "macro" && macro) {
    const macroEstimate = estimateMacroMarket(market, macro);
    if (macroEstimate) estimates.push(macroEstimate);
  }

  if (market.category === "tech" && tech) {
    const techEstimate = estimateTechMarket(market, tech);
    if (techEstimate) estimates.push(techEstimate);
  }

  if (market.category === "culture" && culture) {
    const cultureEstimate = estimateCultureMarket(market, culture);
    if (cultureEstimate) estimates.push(cultureEstimate);
  }

  if ((market.category === "politics" || market.category === "geopolitics" || market.category === "culture" || market.category === "tech" || market.category === "finance" || market.category === "mentions" || market.category === "objective-event") && news) {
    const newsEstimate = estimateNewsMarket(market, news);
    if (newsEstimate) estimates.push(newsEstimate);
  }

  if (manual) {
    const manualEstimate = estimateFromManualNote(manual);
    if (manualEstimate) estimates.push(manualEstimate);
  }

  const independentEvidenceCount = sources.filter((source) => source.available && source.independent).length;
  if (estimates.length === 0) {
    const implied = clamp(market.yesPrice ?? 0.5, 0.001, 0.999);
    return {
      marketId: market.marketId,
      estimatedYesProbability: implied,
      estimatedNoProbability: 1 - implied,
      confidence: 0.25,
      method: "market-prior-only",
      reasoningSummary:
        "No independent, structured evidence was available. The market price is retained only as a prior and cannot create a bet.",
      keyEvidence: [`Market prior ${(implied * 100).toFixed(1)}% (not independent evidence)`],
      risks: [
        "No source-backed forecast",
        "Market momentum and price are not independent evidence",
        ...sources.filter((source) => !source.available && source.reason).map((source) => source.reason!),
      ],
      independentEvidenceCount,
      dataQuality: 0,
      modelUncertainty: 0.25,
      shouldSkip: true,
    };
  }

  let weightedProbability = 0;
  let totalWeight = 0;
  let weightedConfidence = 0;
  let weightedQuality = 0;
  for (const estimate of estimates) {
    const weight = Math.max(0.05, estimate.confidence * estimate.quality);
    weightedProbability += estimate.probability * weight;
    weightedConfidence += estimate.confidence * weight;
    weightedQuality += estimate.quality * weight;
    totalWeight += weight;
  }

  const yes = clamp(weightedProbability / totalWeight, 0.01, 0.99);
  const confidence = clamp(weightedConfidence / totalWeight, 0.05, 0.85);
  const dataQuality = clamp(weightedQuality / totalWeight, 0, 1);
  const modelUncertainty = clamp((1 - confidence) * Math.abs(yes - 0.5) + (1 - dataQuality) * 0.05, 0.02, 0.3);
  const shouldSkip =
    independentEvidenceCount < config.minIndependentSources ||
    confidence < 0.35 ||
    dataQuality < 0.25;

  return {
    marketId: market.marketId,
    estimatedYesProbability: yes,
    estimatedNoProbability: 1 - yes,
    confidence,
    method: estimates.map((estimate) => estimate.method).join("+"),
    reasoningSummary:
      estimates.length === 1
        ? `Forecast uses one independent evidence model: ${estimates[0]?.method}.`
        : `Forecast is a quality-weighted ensemble of ${estimates.length} independent evidence models.`,
    keyEvidence: estimates.flatMap((estimate) => estimate.evidence).slice(0, 8),
    risks: [...new Set(estimates.flatMap((estimate) => estimate.risks))].slice(0, 8),
    independentEvidenceCount,
    dataQuality,
    modelUncertainty,
    shouldSkip,
  };
}

function estimateSportsMarket(source: SourceObservation): EvidenceEstimate | undefined {
  const probability = toNumber(source.payload.fairYesProbability);
  const bookmakerCount = Math.max(0, Math.floor(toNumber(source.payload.bookmakerCount) ?? 0));
  const dispersion = toNumber(source.payload.probabilityDispersion) ?? 0.1;
  if (probability === undefined || probability <= 0 || probability >= 1 || bookmakerCount < 1) return undefined;
  const quality = clamp(source.quality ?? 0.55, 0.35, 0.85);
  const confidence = clamp(0.44 + Math.min(0.2, bookmakerCount * 0.025) - dispersion * 0.8, 0.4, 0.72);
  return {
    probability,
    confidence,
    quality,
    method: "sports-devigged-bookmaker-consensus",
    evidence: [
      `${bookmakerCount} bookmaker line(s), de-vigged before averaging`,
      `Matched event: ${String(source.payload.event)}`,
      `Target participant: ${String(source.payload.target)}`,
      `Consensus fair probability ${(probability * 100).toFixed(1)}%`,
    ],
    risks: [
      "Sportsbook consensus is a market-based external benchmark, not a proprietary predictive model",
      "Team-name and event-time matching must be reviewed before any paper order",
      ...(dispersion > 0.06 ? ["Bookmaker estimates have material dispersion"] : []),
    ],
  };
}

function estimateNewsMarket(market: NormalizedMarket, source: SourceObservation): EvidenceEstimate | undefined {
  const articles = source.payload.articles ?? [];
  if (!Array.isArray(articles) || articles.length === 0) return undefined;
  const keywords = newsKeywords(market.title);
  const now = Date.now();
  const classified = (articles as Array<Record<string, unknown>>)
    .map((article) => {
      const title = String(article.title ?? "").trim();
      const normalized = title.toLowerCase();
      const publishedAt = Date.parse(String(article.publishedAt ?? ""));
      const fresh = !Number.isFinite(publishedAt) || now - publishedAt <= 96 * 3_600_000;
      const matches = keywords.filter((keyword) => normalized.includes(keyword)).length;
      const relevant = keywords.length <= 2 ? matches >= 1 : matches >= Math.min(3, Math.ceil(keywords.length * 0.45));
      const explicitlyNegative = /\b(den(?:y|ies|ied)|reject(?:s|ed)?|fail(?:s|ed)?|cancel(?:s|led)?|withdraw(?:s|n)?|postpone(?:s|d)?|delay(?:s|ed)?|rule(?:s|d) out|will not|won't|not going to|no deal|collapse(?:s|d)?)\b/.test(normalized);
      const explicitlyConfirmed = !explicitlyNegative && /\b(officially |formally )?(announc(?:es|ed)|confirm(?:s|ed)|sign(?:s|ed)|pass(?:es|ed)|approve(?:s|d)|launch(?:es|ed)|release(?:s|d)|resign(?:s|ed)|elect(?:s|ed)|win(?:s|ning)?|agree(?:s|d)|complete(?:s|d)|close(?:s|d) the deal|acquire(?:s|d)|capture(?:s|d)|ceasefire (?:takes effect|begins))\b/.test(normalized);
      const publisher = String(article.publisher ?? article.provider ?? "unknown").toLowerCase();
      return { title, fresh, relevant, explicitlyNegative, explicitlyConfirmed, publisher };
    })
    .filter((article) => article.title && article.fresh && article.relevant);
  if (classified.length === 0) return undefined;

  const positivePublishers = new Set(classified.filter((article) => article.explicitlyConfirmed).map((article) => article.publisher));
  const negativePublishers = new Set(classified.filter((article) => article.explicitlyNegative).map((article) => article.publisher));
  const positiveScore = positivePublishers.size;
  const negativeScore = negativePublishers.size;
  const prior = clamp(market.yesPrice ?? market.bestAsk ?? 0.5, 0.02, 0.98);
  const conflict = positiveScore > 0 && negativeScore > 0;
  const confirmedYes = positiveScore >= 3 && negativeScore === 0;
  const confirmedNo = negativeScore >= 3 && positiveScore === 0;

  if (confirmedYes || confirmedNo) {
    const probability = confirmedYes ? Math.max(prior, 0.88) : Math.min(prior, 0.12);
    const publisherCount = confirmedYes ? positiveScore : negativeScore;
    return {
      probability,
      confidence: clamp(0.58 + publisherCount * 0.018, 0.58, 0.7),
      quality: clamp(source.quality ?? 0.7, 0.58, 0.8),
      method: "news-multi-publisher-confirmation",
      evidence: [
        `${publisherCount} distinct publisher(s) explicitly ${confirmedYes ? "confirm" : "deny"} the event`,
        ...classified
          .filter((article) => confirmedYes ? article.explicitlyConfirmed : article.explicitlyNegative)
          .slice(0, 4)
          .map((article) => article.title),
      ],
      risks: [
        "Headline confirmation can still differ from the market's exact deadline, scope, or resolution source",
        "The market rules remain authoritative even when reporting appears conclusive",
      ],
    };
  }

  // Weak or conflicting news cannot invent a 50/50 probability. It only nudges the
  // contemporaneous market prior, and the later uncertainty haircut makes this lane
  // research/ensemble evidence rather than a standalone live trigger.
  const net = positiveScore - negativeScore;
  const shift = clamp(net * 0.035, -0.12, 0.12);
  return {
    probability: clamp(prior + shift, 0.05, 0.95),
    confidence: clamp(0.36 + Math.min(0.08, classified.length * 0.008) - (conflict ? 0.08 : 0), 0.3, 0.44),
    quality: clamp(source.quality ?? 0.5, 0.3, 0.62),
    method: "news-headline-sentiment-model",
    evidence: [
      `${classified.length}/${articles.length} fresh headline(s) matched the market subject`,
      `Explicit publisher signals: confirmation=${positiveScore}, denial=${negativeScore}`,
    ],
    risks: [
      "Weak/conflicting news only nudges the market prior and is capped below standalone live confidence",
      ...(conflict ? ["Publishers report conflicting event states"] : []),
    ],
  };
}

function newsKeywords(title: string): string[] {
  const stop = new Set([
    "will", "would", "could", "should", "the", "this", "that", "with", "from", "into", "before", "after",
    "have", "has", "been", "being", "market", "resolve", "yes", "what", "when", "where", "which", "than",
  ]);
  return [...new Set(title.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)
    .filter((word) => word.length >= 3 && !stop.has(word) && !/^20\d{2}$/.test(word)))]
    .slice(0, 8);
}

function estimateMacroMarket(market: NormalizedMarket, source: SourceObservation): EvidenceEstimate | undefined {
  const latestValue = toNumber(source.payload.latestValue);
  const std = Math.max(
    toNumber(source.payload.standardDeviation) ?? toNumber(source.payload.defaultStd) ?? 0.25,
    toNumber(source.payload.defaultStd) ?? 0.1,
  );
  const metric = String(source.payload.metric ?? "macro");
  const unit = String(source.payload.unit ?? "");
  const threshold = extractNumericThreshold(`${market.title} ${market.rules ?? ""}`);
  const direction = inferAboveBelow(`${market.title} ${market.rules ?? ""}`);
  if (latestValue === undefined || threshold === undefined || !direction) return undefined;

  const z = (threshold - latestValue) / Math.max(std, 0.0001);
  const above = 1 - normalCdf(z);
  const yes = direction === "above" ? above : 1 - above;
  const leadDays = Math.max(daysUntil(market.endDate) ?? 30, 0);
  const quality = clamp(source.quality ?? 0.62, 0.35, 0.78);
  const confidence = clamp(0.46 + quality * 0.18 - Math.min(0.12, leadDays / 365), 0.38, 0.64);
  const provider = String(source.payload.provider ?? "");
  const providerTag = provider.includes("fred") ? "fred" : "bls";
  const providerName = providerTag === "fred" ? "FRED (St. Louis Fed)" : "BLS";

  return {
    probability: clamp(yes, 0.01, 0.99),
    confidence,
    quality,
    method: `macro-${providerTag}-threshold-model`,
    evidence: [
      `${String(source.payload.label ?? metric)} latest ${formatMacroValue(latestValue, unit)} for ${String(source.payload.latestPeriod ?? "latest period")}`,
      `Parsed ${direction} threshold ${formatMacroValue(threshold, unit)} with ${formatMacroValue(std, unit)} recent modeled spread`,
    ],
    risks: [
      `${providerName} latest value is official historical data, not a true nowcast or economist consensus`,
      "Release calendar timing and market wording may refer to a future print that is not yet published",
    ],
  };
}

function estimateTechMarket(market: NormalizedMarket, source: SourceObservation): EvidenceEstimate | undefined {
  const kind = String(source.payload.marketKind ?? "official-event");
  const matchedPost = source.payload.matchedOfficialPost as Record<string, unknown> | undefined;
  const matchedIncident = source.payload.matchedIncident as Record<string, unknown> | undefined;
  const daysToEnd = daysUntil(market.endDate);
  const deadlinePassed = daysToEnd !== undefined && daysToEnd < 0;
  const quality = clamp(source.quality ?? 0.62, 0.35, 0.82);

  if (kind === "release") {
    if (matchedPost) {
      const postTitle = String(matchedPost.title ?? "untitled");
      // A name match is NOT a release. These markets resolve on "made available to the
      // general public", but the feed also carries previews/teasers/waitlists ("Previewing
      // GPT-5.6 Sol...") that explicitly mean NOT-yet-available. Only treat a post as
      // release-confirming when its wording positively signals public availability;
      // otherwise it is a mention that fades an informed market on nothing.
      if (postConfirmsGeneralRelease(postTitle)) {
        return {
          probability: 0.96,
          confidence: clamp(0.62 + quality * 0.16, 0.58, 0.76),
          quality,
          method: "tech-official-release-feed",
          evidence: [`Official ${String(source.payload.provider)} post confirms release: ${postTitle}`],
          risks: ["Model/product wording can differ from Polymarket's exact resolution wording"],
        };
      }
      return {
        probability: deadlinePassed ? 0.1 : 0.4,
        confidence: 0.4,
        quality: Math.min(quality, 0.5),
        method: "tech-official-release-mention-only",
        evidence: [`Official ${String(source.payload.provider)} post mentions the product but does not confirm public availability: ${postTitle}`],
        risks: [
          "A preview/teaser/announcement is not a general-availability release",
          "Model/product wording can differ from Polymarket's exact resolution wording",
        ],
      };
    }
    return {
      probability: deadlinePassed ? 0.06 : 0.42,
      confidence: deadlinePassed ? 0.66 : 0.36,
      quality: Math.min(quality, deadlinePassed ? 0.68 : 0.42),
      method: "tech-official-release-absence",
      evidence: [`No matching official ${String(source.payload.provider)} release post was found in the fetched feed`],
      risks: [
        "Official RSS coverage may omit some changelog or documentation releases",
        "Absence of a post before the deadline is weak evidence while time remains",
      ],
    };
  }

  if (kind === "status") {
    const status = String(matchedIncident?.status ?? "").toLowerCase();
    const resolved = Boolean(matchedIncident?.resolvedAt) || status.includes("resolved");
    if (matchedIncident && resolved) {
      return {
        probability: 0.93,
        confidence: clamp(0.6 + quality * 0.14, 0.56, 0.74),
        quality,
        method: "tech-official-statuspage",
        evidence: [`Official status incident matched and resolved: ${String(matchedIncident.name ?? "unnamed incident")}`],
        risks: ["Status-page incident wording may not match Polymarket's exact geography/product scope"],
      };
    }
    if (matchedIncident) {
      return {
        probability: daysToEnd !== undefined && daysToEnd > 0 ? 0.62 : 0.18,
        confidence: 0.48,
        quality: Math.min(quality, 0.55),
        method: "tech-official-statuspage-active",
        evidence: [`Official status incident matched but is not resolved: ${String(matchedIncident.name ?? "unnamed incident")}`],
        risks: ["Open incidents often resolve quickly, but exact deadline/product scope remains uncertain"],
      };
    }
  }

  return undefined;
}

// True only when an official post title positively signals the product is now available to
// the public. Preview/teaser/waitlist/"coming soon" wording is treated as NOT-a-release, so a
// mere name mention can no longer spike a "released by <date>" market to 96%.
function postConfirmsGeneralRelease(title: string): boolean {
  const t = title.toLowerCase();
  if (/\b(preview|previewing|teaser|coming soon|coming to|wait ?list|early access|sneak peek|upcoming|sign[- ]?ups?|will (?:launch|release|be available|ship)|research preview)\b/.test(t)) {
    return false;
  }
  return /\b(introduc\w+|now available|available (?:now|today|to|for|in|starting)|is (?:now )?(?:available|live|out|here)|launch(?:ed|ing|es)?|roll\w* out|releas\w+|general availability|out now|ship(?:ped|ping|s)?|we(?:'| a)re (?:releasing|launching|shipping))\b/.test(t);
}

function estimateCultureMarket(market: NormalizedMarket, source: SourceObservation): EvidenceEstimate | undefined {
  const text = `${market.title} ${market.rules ?? ""}`.toLowerCase();
  // No trailing \b: it must still match "release"/"released"/"releasing"/"premiered".
  if (!/\b(releas|premier|debut|launch|come out|comes out)/i.test(text)) return undefined;
  const matched = source.payload.matchedResult as Record<string, unknown> | undefined;
  const score = toNumber(source.payload.matchScore) ?? 0;
  const releaseDate = typeof matched?.releaseDate === "string" ? matched.releaseDate : undefined;
  if (!matched || !releaseDate || score < 0.55 || !market.endDate) return undefined;
  const releaseMs = Date.parse(releaseDate);
  const deadlineMs = Date.parse(market.endDate);
  if (!Number.isFinite(releaseMs) || !Number.isFinite(deadlineMs)) return undefined;
  const yes = releaseMs <= deadlineMs ? 0.93 : 0.08;
  const quality = clamp((source.quality ?? 0.55) + Math.min(0.12, score * 0.08), 0.35, 0.74);
  const provider = source.sourceType === "culture-wikidata" ? "wikidata" : "tmdb";
  const providerName = provider === "wikidata" ? "Wikidata" : "TMDB";
  return {
    probability: yes,
    confidence: clamp(0.52 + quality * 0.14, 0.48, 0.68),
    quality,
    method: `culture-${provider}-release-date`,
    evidence: [`${providerName} matched ${String(matched.title ?? "title")} with release date ${releaseDate}`],
    risks: [
      `${providerName} is useful for release-date checks but may not be the exact Polymarket resolution source`,
      "Title matching is conservative and requires review for sequels/remakes",
    ],
  };
}

function estimateFromManualNote(source: SourceObservation): EvidenceEstimate | undefined {
  const probability =
    toNumber(source.payload.estimatedYesProbability) ??
    toNumber(source.payload.yesProbability) ??
    toNumber(source.payload.probability);
  if (probability === undefined || probability < 0 || probability > 1) return undefined;

  const confidence = clamp(toNumber(source.payload.confidence) ?? 0.55, 0.1, 0.85);
  const evidence = stringArray(source.payload.evidence);
  const risks = stringArray(source.payload.risks);
  return {
    probability,
    confidence,
    quality: clamp(source.quality ?? 0.7, 0.1, 0.9),
    method: "structured-manual-research",
    evidence: evidence.length > 0 ? evidence : ["Structured manual probability note"],
    risks: risks.length > 0 ? risks : ["Manual estimate has not been independently reproduced by the bot"],
  };
}

function estimateWeatherMarket(market: NormalizedMarket, sources: SourceObservation[]): EvidenceEstimate | undefined {
  const stationObservation = sources.find(
    (source) => String(source.payload.provider ?? "") === "aviationweather-metar",
  );
  if (stationObservation?.payload.observationComplete && toNumber(stationObservation.payload.observedExtreme) !== undefined) {
    return estimateSingleWeatherMarket(market, {
      ...stationObservation,
      payload: {
        ...stationObservation.payload,
        provider: "aviationweather-station-final",
        forecastValue: stationObservation.payload.observedExtreme,
        leadDays: 0,
      },
    });
  }
  const estimates = sources
    .filter((source) => source !== stationObservation)
    .map((source) => estimateSingleWeatherMarket(market, source, stationObservation))
    .filter((estimate): estimate is EvidenceEstimate => Boolean(estimate));
  if (estimates.length === 0) return undefined;
  if (estimates.length === 1) return estimates[0];

  let weightedProbability = 0;
  let weightedConfidence = 0;
  let weightedQuality = 0;
  let totalWeight = 0;
  for (const estimate of estimates) {
    const weight = Math.max(0.05, estimate.confidence * estimate.quality);
    weightedProbability += estimate.probability * weight;
    weightedConfidence += estimate.confidence * weight;
    weightedQuality += estimate.quality * weight;
    totalWeight += weight;
  }

  const probability = clamp(weightedProbability / totalWeight, 0.01, 0.99);
  const probabilities = estimates.map((estimate) => estimate.probability);
  const disagreement = Math.max(...probabilities) - Math.min(...probabilities);
  const confidence = clamp(
    weightedConfidence / totalWeight + Math.min(0.04, (estimates.length - 1) * 0.015) - Math.min(0.22, disagreement * 0.55),
    0.28,
    0.68,
  );
  const quality = clamp(
    weightedQuality / totalWeight - Math.min(0.16, disagreement * 0.35),
    0.25,
    0.82,
  );

  return {
    probability,
    confidence: disagreement > 0.25 ? Math.min(confidence, 0.42) : confidence,
    quality: disagreement > 0.25 ? Math.min(quality, 0.55) : quality,
    method:
      `${estimates.some((estimate) => estimate.method.includes("weather-ensemble")) ? "weather-ensemble-calibrated" : "weather-provider-ensemble"}` +
      `${stationObservation ? "+station-observation" : ""}`,
    evidence: [
      `${estimates.length} weather provider/model estimate(s) were combined`,
      ...(stationObservation
        ? [`Exact resolution station ${String(stationObservation.payload.stationCode)} observed ${formatWeatherValue(toNumber(stationObservation.payload.observedExtreme)!, String(stationObservation.payload.metric), String(stationObservation.payload.unit))} so far`]
        : []),
      ...estimates.flatMap((estimate) => estimate.evidence.slice(0, 2)).slice(0, 7),
      ...(disagreement > 0.15 ? [`Provider probability disagreement ${(disagreement * 100).toFixed(1)} percentage points`] : []),
    ],
    risks: [
      "Weather ensemble still depends on forecasts rather than confirmed resolution-station observations",
      ...(disagreement > 0.15 ? ["Weather providers disagree materially; confidence is reduced"] : []),
      ...[...new Set(estimates.flatMap((estimate) => estimate.risks))].slice(0, 6),
    ],
  };
}

function estimateSingleWeatherMarket(
  market: NormalizedMarket,
  source: SourceObservation,
  stationObservation?: SourceObservation,
): EvidenceEstimate | undefined {
  let forecastValue = toNumber(source.payload.forecastValue);
  const leadDays = Math.max(toNumber(source.payload.leadDays) ?? 0, 0);
  const unit = String(source.payload.unit ?? "fahrenheit");
  const metric = String(source.payload.metric ?? "high");
  const provider = String(source.payload.provider ?? "unknown");
  const stationExtreme = toNumber(stationObservation?.payload.observedExtreme);
  if (forecastValue !== undefined && stationExtreme !== undefined) {
    if (metric === "high") forecastValue = Math.max(forecastValue, stationExtreme);
    if (metric === "low") forecastValue = Math.min(forecastValue, stationExtreme);
  }
  const text = `${market.title} ${market.rules ?? ""}`;
  const range = extractWeatherRange(text, metric);
  const threshold = range ? undefined : extractWeatherThreshold(text, metric, unit);
  const direction = range ? undefined : inferWeatherDirection(text, metric);
  if (forecastValue === undefined || (!range && (threshold === undefined || !direction))) return undefined;

  // Forecast error grows with lead time. A normal centered on the model forecast turns
  // "high above 88F" or "rain over 0.1in" into a threshold-clear probability.
  const isFinalStation = provider === "aviationweather-station-final";
  const ensembleValues = Array.isArray(source.payload.ensembleValues)
    ? source.payload.ensembleValues
        .map(Number)
        .filter(Number.isFinite)
        .map((value) => {
          if (stationExtreme === undefined) return value;
          if (metric === "high") return Math.max(value, stationExtreme);
          if (metric === "low") return Math.min(value, stationExtreme);
          return value;
        })
    : [];
  const std = isFinalStation
    ? unit === "celsius" ? 0.08 : 0.15
    : ensembleValues.length >= 10
      ? weatherEnsembleKernelStd(metric, unit, forecastValue, leadDays)
      : weatherForecastStd(metric, unit, forecastValue, leadDays);
  let yes: number;
  let parsedEvidence: string;
  const probabilityAt = (value: number): number => {
    if (range) {
      const lowerCdf = range.lower === undefined ? 0 : normalCdf((range.lower - value) / std);
      const upperCdf = range.upper === undefined ? 1 : normalCdf((range.upper - value) / std);
      return upperCdf - lowerCdf;
    }
    const z = (threshold! - value) / std;
    const above = 1 - normalCdf(z);
    return direction === "above" ? above : 1 - above;
  };
  yes = ensembleValues.length >= 10
    ? ensembleValues.reduce((sum, value) => sum + probabilityAt(value), 0) / ensembleValues.length
    : probabilityAt(forecastValue);
  parsedEvidence = range
    ? `Parsed temperature bucket ${formatWeatherRange(range, unit)}`
    : `Parsed ${direction} threshold ${formatWeatherValue(threshold!, metric, unit)}`;
  let quality = clamp(source.quality ?? 0.6, 0.3, 0.85);
  const confidenceCap = metric === "high" || metric === "low" ? 0.66 : 0.58;
  let confidence = clamp(0.44 + quality * 0.18 - leadDays * 0.012, 0.34, confidenceCap);
  if (ensembleValues.length >= 10) confidence = clamp(0.56 + quality * 0.2 - leadDays * 0.01, 0.5, stationObservation ? 0.76 : 0.7);
  if (isFinalStation) {
    confidence = 0.86;
    quality = 0.96;
  }

  // Station-mismatch guard: these markets resolve on ONE specific station, while our
  // forecast is an Open-Meteo grid point. When a liquid market disagrees with our model by
  // a wide margin, the market almost certainly reflects the resolution station better than
  // we do (this is exactly how a Jeddah "40°C+" bet lost: forecast 36°C, station hit 40°C+,
  // market priced it ~80%). Rather than fade the market on a biased point forecast, we drop
  // confidence below the trade threshold so the bet is blocked.
  const modelYes = clamp(yes, 0.01, 0.99);
  const marketYes = clamp(market.yesPrice ?? market.bestAsk ?? modelYes, 0.01, 0.99);
  const marketDivergence = Math.abs(modelYes - marketYes);
  // Only the dangerous case: the market is itself confident (priced near an extreme) AND
  // our model takes the opposite side by a wide margin. That is fading a station-aware
  // favorite on a grid-point forecast — the Jeddah failure. A wide gap against a *neutral*
  // market (~0.5) is a normal high-conviction edge and must NOT be suppressed.
  const marketConfident = marketYes > 0.65 || marketYes < 0.35;
  const oppositeSides = (modelYes - 0.5) * (marketYes - 0.5) < 0;
  const stationMismatchSuspected = marketDivergence > 0.4 && marketConfident && oppositeSides;
  if (stationMismatchSuspected) {
    confidence = Math.min(confidence, 0.3);
    quality = Math.min(quality, 0.35);
  }

  return {
    probability: modelYes,
    confidence,
    quality,
    method: isFinalStation
      ? "weather-station-observation-complete"
      : ensembleValues.length >= 10
        ? "weather-ensemble-distribution"
        : "weather-normal-forecast-model",
    evidence: [
      `${String(source.payload.location)} ${weatherMetricLabel(metric)} ${isFinalStation ? "observed" : "forecast"} ${formatWeatherValue(forecastValue, metric, unit)} for ${String(source.payload.targetDate)}`,
      parsedEvidence,
      `${leadDays.toFixed(1)} days of forecast lead time (${formatWeatherValue(std, metric, unit)} modeled spread)`,
      ...(ensembleValues.length >= 10 ? [`${ensembleValues.length} ensemble members define the forecast distribution`] : []),
      ...(stationExtreme !== undefined && !isFinalStation
        ? [`Forecast distribution constrained by observed-so-far station extreme ${formatWeatherValue(stationExtreme, metric, unit)}`]
        : []),
    ],
    risks: [
      ...(ensembleValues.length >= 10 || isFinalStation ? [] : ["Single-model deterministic forecast; no ensemble spread was used"]),
      "Resolution station and observation window may differ from the forecast point",
      ...(stationMismatchSuspected
        ? [`Model (${(modelYes * 100).toFixed(0)}%) diverges sharply from the market (${(marketYes * 100).toFixed(0)}%); likely a forecast/station mismatch, so confidence is capped below the trade threshold`]
        : []),
      ...(metric === "rain" || metric === "precipitation" || metric === "snowfall"
        ? ["Precipitation totals are especially sensitive to local station choice"]
        : []),
      ...(leadDays > 7 ? ["Forecast lead time exceeds one week, so confidence is reduced"] : []),
    ],
  };
}

function weatherEnsembleKernelStd(metric: string, unit: string, forecastValue: number, leadDays: number): number {
  if (metric === "high" || metric === "low") {
    const base = unit === "celsius" ? 1.1 : 2;
    return base + Math.min(unit === "celsius" ? 1.2 : 2.2, leadDays * (unit === "celsius" ? 0.12 : 0.22));
  }
  return Math.max(0.05, weatherForecastStd(metric, unit, forecastValue, leadDays) * 0.45);
}

function estimateFinancialMarket(market: NormalizedMarket, source: SourceObservation): EvidenceEstimate | undefined {
  if (!isSupportedThresholdContract(market)) return undefined;
  const currentPrice = toNumber(source.payload.usd);
  const realizedVolatility = toNumber(source.payload.realizedAnnualVolatility);
  const fallbackVolatility = toNumber(source.payload.fallbackAnnualVolatility) ?? 0.3;
  const annualVolatility = clamp(realizedVolatility ?? fallbackVolatility, 0.05, 2.5);
  const threshold = extractDollarThreshold(`${market.title} ${market.rules ?? ""}`);
  const direction = resolvePriceDirection(`${market.title} ${market.rules ?? ""}`, currentPrice, threshold);
  const days = Math.max(daysUntil(market.endDate) ?? 30, 1 / 24);
  if (!currentPrice || !threshold || !direction) return undefined;

  const years = days / 365;
  const pathDependent = isPathDependent(`${market.title} ${market.rules ?? ""}`);
  const suspiciousCross = suspiciousBarrierCross(market, currentPrice, threshold, direction, pathDependent);
  if (suspiciousCross) {
    return sourceMismatchEstimate(
      market,
      source,
      currentPrice,
      threshold,
      direction,
      "financial-source-mismatch",
      suspiciousCross,
    );
  }
  const yes = pathDependent
    ? barrierProbability(currentPrice, threshold, annualVolatility, years, direction)
    : terminalProbability(currentPrice, threshold, annualVolatility, years, direction);
  const requiredMove = requiredLogMove(currentPrice, threshold, direction);
  const sigmaMove = annualVolatility * Math.sqrt(years);
  const moveSigma = requiredMove > 0 && sigmaMove > 0 ? requiredMove / sigmaMove : 0;
  const implausibleNearTermBarrier = pathDependent && days <= 2 && moveSigma >= 3;
  const quality = implausibleNearTermBarrier
    ? Math.min(0.24, clamp(source.quality ?? (realizedVolatility ? 0.7 : 0.45), 0.1, 0.82))
    : clamp(source.quality ?? (realizedVolatility ? 0.7 : 0.45), 0.1, 0.82);
  const distance = Math.abs(Math.log(currentPrice / threshold));
  const baseConfidence = clamp(
    0.42 + quality * 0.2 + Math.min(0.08, distance * 0.12) - (pathDependent ? 0.04 : 0),
    0.35,
    0.66,
  );
  const confidence = implausibleNearTermBarrier ? Math.min(0.34, baseConfidence) : baseConfidence;
  const symbol = String(source.payload.symbol ?? source.payload.ticker ?? "instrument");

  return {
    probability: clamp(implausibleNearTermBarrier ? Math.min(yes, 0.05) : yes, 0.01, 0.99),
    confidence,
    quality,
    method: pathDependent ? "financial-barrier-model" : "financial-terminal-lognormal-model",
    evidence: [
      `${symbol} spot about $${currentPrice.toLocaleString("en-US")} (${String(source.payload.provider ?? "stooq")})`,
      `Parsed ${direction} threshold $${threshold.toLocaleString("en-US")}`,
      `${days.toFixed(1)} days to the recorded market end`,
      `${realizedVolatility ? "realized" : "fallback"} annualized volatility ${(annualVolatility * 100).toFixed(0)}%`,
      ...(implausibleNearTermBarrier
        ? [`Required move is about ${(requiredMove * 100).toFixed(1)}% (${moveSigma.toFixed(1)} volatility units) before expiry`]
        : []),
    ],
    risks: [
      pathDependent
        ? "Barrier model assumes continuous prices and a constant volatility regime"
        : "Terminal model assumes a constant volatility regime and zero expected return",
      "Daily close spot may differ from the resolution source or intraday observation window",
      ...(realizedVolatility ? [] : ["Historical volatility was unavailable, so confidence is capped"]),
      ...(implausibleNearTermBarrier
        ? ["Near-term required move is too extreme for live execution; confidence and quality are capped"]
        : []),
    ],
  };
}

function estimateMarketCapMarket(market: NormalizedMarket, source: SourceObservation): EvidenceEstimate | undefined {
  const kind = String(source.payload.kind ?? "");
  const target = source.payload.target as Record<string, unknown> | undefined;
  const targetCap = toNumber(target?.marketCap);
  const targetVol = clamp(toNumber(target?.annualVol) ?? 0.35, 0.05, 1.5);
  const targetName = String(target?.name ?? "target company");
  const days = Math.max(daysUntil(market.endDate) ?? 30, 1 / 24);
  const years = days / 365;
  if (!targetCap) return undefined;

  if (kind === "threshold") {
    const text = `${market.title} ${market.rules ?? ""}`;
    const threshold = extractMarketCapThreshold(text);
    const direction = inferCapDirection(text);
    if (!threshold || !direction) return undefined;
    const pathDependent = /\b(reach|hit|touch|first to|at any point|surpass|cross)\b/i.test(text);
    const yes = pathDependent
      ? barrierProbability(targetCap, threshold, targetVol, years, direction)
      : terminalProbability(targetCap, threshold, targetVol, years, direction);
    const distance = Math.abs(Math.log(targetCap / threshold));
    const quality = clamp(source.quality ?? 0.62, 0.3, 0.78);
    const confidence = clamp(0.42 + quality * 0.2 + Math.min(0.08, distance * 0.12) - (pathDependent ? 0.04 : 0), 0.35, 0.66);
    return {
      probability: clamp(yes, 0.01, 0.99),
      confidence,
      quality,
      method: pathDependent ? "market-cap-barrier-model" : "market-cap-terminal-lognormal-model",
      evidence: [
        `${targetName} market cap about ${formatUsd(targetCap)} (FMP)`,
        `Parsed ${direction} market-cap threshold ${formatUsd(threshold)}`,
        `${days.toFixed(1)} days to the recorded market end; ${(targetVol * 100).toFixed(0)}% annualized volatility prior`,
      ],
      risks: [
        "Market cap is modeled as a zero-drift lognormal; share-count changes, buybacks and dilution are ignored",
        "FMP market cap may differ slightly from the exact Polymarket resolution source or timestamp",
      ],
    };
  }

  // pairwise / ranking: relative lognormal of the two companies' caps.
  const competitor = source.payload.competitor as Record<string, unknown> | undefined;
  const competitorCap = toNumber(competitor?.marketCap);
  const competitorVol = clamp(toNumber(competitor?.annualVol) ?? 0.35, 0.05, 1.5);
  const competitorName = String(competitor?.name ?? "competitor");
  if (!competitorCap) return undefined;

  // Assumed correlation is deliberately modest: a lower correlation widens the relative
  // spread and pulls the forecast toward 50/50, which is the conservative direction here.
  const rho = 0.4;
  const sigmaRelative = Math.sqrt(Math.max(1e-6, targetVol ** 2 + competitorVol ** 2 - 2 * rho * targetVol * competitorVol));
  const logLead = Math.log(targetCap / competitorCap);
  const yes =
    years <= 0 || sigmaRelative <= 0
      ? logLead > 0
        ? 0.99
        : 0.01
      : clamp(normalCdf(logLead / (sigmaRelative * Math.sqrt(years))), 0.01, 0.99);
  const lead = Math.abs(logLead);
  const quality = clamp((source.quality ?? 0.62) - 0.04, 0.3, 0.74);
  const confidence = clamp(0.4 + quality * 0.18 + Math.min(0.06, lead * 0.2), 0.35, 0.62);
  const leaderName = logLead >= 0 ? targetName : competitorName;
  return {
    probability: yes,
    confidence,
    quality,
    method: kind === "ranking" ? "market-cap-ranking-relative-model" : "market-cap-pairwise-relative-model",
    evidence: [
      `${targetName} market cap ${formatUsd(targetCap)} vs ${competitorName} ${formatUsd(competitorCap)} (FMP)`,
      kind === "ranking"
        ? `${competitorName} is the largest competing company in the tracked basket`
        : `Pairwise comparison against ${competitorName}`,
      `Current leader ${leaderName}; ${(sigmaRelative * 100).toFixed(0)}% relative volatility over ${days.toFixed(1)} days (assumed ${(rho * 100).toFixed(0)}% correlation)`,
    ],
    risks: [
      "Relative model assumes a constant correlation between the two companies and zero expected drift",
      kind === "ranking"
        ? "Only the single strongest competitor is modeled; a third company overtaking is not captured"
        : "Only the two named companies are compared",
      "FMP market cap may differ slightly from the exact Polymarket resolution source or timestamp",
    ],
  };
}

function estimateCryptoMarket(market: NormalizedMarket, source: SourceObservation): EvidenceEstimate | undefined {
  if (!isSupportedThresholdContract(market)) return undefined;
  const currentPrice = toNumber(source.payload.usd);
  const realizedVolatility = toNumber(source.payload.realizedAnnualVolatility);
  const fallbackVolatility = toNumber(source.payload.fallbackAnnualVolatility) ?? 0.9;
  const annualVolatility = clamp(realizedVolatility ?? fallbackVolatility, 0.15, 2.5);
  const threshold = extractDollarThreshold(`${market.title} ${market.rules ?? ""}`);
  const direction = resolvePriceDirection(`${market.title} ${market.rules ?? ""}`, currentPrice, threshold);
  const days = Math.max(daysUntil(market.endDate) ?? 30, 1 / 24);
  if (!currentPrice || !threshold || !direction) return undefined;

  const years = days / 365;
  const pathDependent = isPathDependent(`${market.title} ${market.rules ?? ""}`);
  const suspiciousCross = suspiciousBarrierCross(market, currentPrice, threshold, direction, pathDependent);
  if (suspiciousCross) {
    return sourceMismatchEstimate(
      market,
      source,
      currentPrice,
      threshold,
      direction,
      "crypto-source-mismatch",
      suspiciousCross,
    );
  }
  const yes = pathDependent
    ? barrierProbability(currentPrice, threshold, annualVolatility, years, direction)
    : terminalProbability(currentPrice, threshold, annualVolatility, years, direction);
  const requiredMove = requiredLogMove(currentPrice, threshold, direction);
  const sigmaMove = annualVolatility * Math.sqrt(years);
  const moveSigma = requiredMove > 0 && sigmaMove > 0 ? requiredMove / sigmaMove : 0;
  const implausibleNearTermBarrier = pathDependent && days <= 2 && moveSigma >= 3.5;
  const quality = implausibleNearTermBarrier
    ? Math.min(0.24, clamp(source.quality ?? (realizedVolatility ? 0.75 : 0.45), 0.1, 0.85))
    : clamp(source.quality ?? (realizedVolatility ? 0.75 : 0.45), 0.1, 0.85);
  const distance = Math.abs(Math.log(currentPrice / threshold));
  const baseConfidence = clamp(
    0.42 + quality * 0.2 + Math.min(0.08, distance * 0.12) - (pathDependent ? 0.04 : 0),
    0.35,
    0.68,
  );
  const confidence = implausibleNearTermBarrier ? Math.min(0.34, baseConfidence) : baseConfidence;

  return {
    probability: clamp(implausibleNearTermBarrier ? Math.min(yes, 0.05) : yes, 0.01, 0.99),
    confidence,
    quality,
    method: pathDependent ? "crypto-barrier-model" : "crypto-terminal-lognormal-model",
    evidence: [
      `${String(source.payload.symbol)} spot about $${currentPrice.toLocaleString("en-US")}`,
      `Parsed ${direction} threshold $${threshold.toLocaleString("en-US")}`,
      `${days.toFixed(1)} days to the recorded market end`,
      `${realizedVolatility ? "30-day realized" : "fallback"} annualized volatility ${(annualVolatility * 100).toFixed(0)}%`,
      ...(implausibleNearTermBarrier
        ? [`Required move is about ${(requiredMove * 100).toFixed(1)}% (${moveSigma.toFixed(1)} volatility units) before expiry`]
        : []),
    ],
    risks: [
      pathDependent
        ? "Barrier model assumes continuous prices and a constant volatility regime"
        : "Terminal model assumes a constant volatility regime and zero expected return",
      "The source spot price may differ from the resolution source or precise observation window",
      ...(realizedVolatility ? [] : ["Historical volatility was unavailable, so confidence is capped"]),
      ...(implausibleNearTermBarrier
        ? ["Near-term required move is too extreme for live execution; confidence and quality are capped"]
        : []),
    ],
  };
}

function suspiciousBarrierCross(
  market: NormalizedMarket,
  spot: number,
  threshold: number,
  direction: "above" | "below",
  pathDependent: boolean,
): string | undefined {
  if (!pathDependent) return undefined;
  const crossed = direction === "above" ? spot >= threshold : spot <= threshold;
  if (!crossed) return undefined;
  const marketPrior = clamp(market.yesPrice ?? market.bestAsk ?? 0.5, 0.001, 0.999);
  if (marketPrior > 0.2) return undefined;
  return `source says the barrier is already crossed, but the YES market prior is only ${(marketPrior * 100).toFixed(1)}%`;
}

function sourceMismatchEstimate(
  market: NormalizedMarket,
  source: SourceObservation,
  spot: number,
  threshold: number,
  direction: "above" | "below",
  method: string,
  reason: string,
): EvidenceEstimate {
  const symbol = String(source.payload.symbol ?? source.payload.ticker ?? "instrument");
  const marketPrior = clamp(market.yesPrice ?? market.bestAsk ?? 0.5, 0.001, 0.999);
  return {
    probability: marketPrior,
    confidence: 0.2,
    quality: 0.2,
    method,
    evidence: [
      `${symbol} spot reference $${spot.toLocaleString("en-US")}`,
      `Parsed ${direction} threshold $${threshold.toLocaleString("en-US")}`,
      reason,
    ],
    risks: [
      "Source quote may be stale, from the wrong contract, or not aligned with the Polymarket resolution source",
      "Barrier is treated as unconfirmed until market price or a second source agrees",
    ],
  };
}

function requiredLogMove(spot: number, threshold: number, direction: "above" | "below"): number {
  return direction === "above"
    ? Math.max(0, Math.log(threshold / spot))
    : Math.max(0, Math.log(spot / threshold));
}

export function terminalProbability(
  spot: number,
  threshold: number,
  annualVolatility: number,
  years: number,
  direction: "above" | "below",
): number {
  if (years <= 0 || annualVolatility <= 0) {
    return direction === "above" ? Number(spot > threshold) : Number(spot < threshold);
  }
  const sigmaRootT = annualVolatility * Math.sqrt(years);
  const z = (Math.log(threshold / spot) + 0.5 * annualVolatility ** 2 * years) / sigmaRootT;
  const above = 1 - normalCdf(z);
  return direction === "above" ? above : 1 - above;
}

export function barrierProbability(
  spot: number,
  threshold: number,
  annualVolatility: number,
  years: number,
  direction: "above" | "below",
): number {
  if (direction === "above" && spot >= threshold) return 0.99;
  if (direction === "below" && spot <= threshold) return 0.99;
  if (years <= 0 || annualVolatility <= 0) return 0.01;

  const distance = direction === "above" ? Math.log(threshold / spot) : Math.log(spot / threshold);
  const drift = direction === "above" ? -0.5 * annualVolatility ** 2 : 0.5 * annualVolatility ** 2;
  const sigmaRootT = annualVolatility * Math.sqrt(years);
  const first = normalCdf((drift * years - distance) / sigmaRootT);
  const exponent = Math.exp((2 * drift * distance) / annualVolatility ** 2);
  const second = exponent * normalCdf((-drift * years - distance) / sigmaRootT);
  return clamp(first + second, 0.01, 0.99);
}

function extractDollarThreshold(text: string): number | undefined {
  const compactMatch = text.match(/\$\s?([0-9]+(?:\.[0-9]+)?)\s?([kKmM])\b/);
  if (compactMatch) {
    const value = Number(compactMatch[1]);
    const suffix = compactMatch[2]?.toLowerCase();
    return suffix === "m" ? value * 1_000_000 : value * 1_000;
  }
  const dollarMatch = text.match(/\$\s?([0-9][0-9,]*(?:\.[0-9]+)?)/);
  return dollarMatch ? Number(dollarMatch[1]?.replace(/,/g, "")) : undefined;
}

/** Parses a market-cap dollar threshold, understanding trillion/billion words and $NNN... */
function extractMarketCapThreshold(text: string): number | undefined {
  const scaled = text.match(/\$?\s?([0-9]+(?:\.[0-9]+)?)\s*(trillion|tn|billion|bn)\b/i);
  if (scaled) {
    const value = Number(scaled[1]);
    if (!Number.isFinite(value)) return undefined;
    return /^t/i.test(scaled[2] ?? "") ? value * 1e12 : value * 1e9;
  }
  const explicit = text.match(/\$\s?([0-9][0-9,]{9,})/);
  if (explicit) {
    const value = Number(explicit[1]?.replace(/,/g, ""));
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

/** Resolves the YES side for a market-cap threshold: reach/exceed => above, fall/under => below. */
function inferCapDirection(text: string): "above" | "below" | undefined {
  const value = text.toLowerCase();
  if (/\b(below|under|less than|lower than|drop|fall|fewer than|at most|worth less than)\b/.test(value)) return "below";
  if (/\b(reach|hit|touch|surpass|exceed|cross|above|over|more than|at least|top|higher than|greater than|first to|worth more than)\b/.test(value)) {
    return "above";
  }
  return undefined;
}

function formatUsd(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  return `$${value.toFixed(0)}`;
}

function extractNumericThreshold(text: string): number | undefined {
  const percent = text.match(/([0-9]+(?:\.[0-9]+)?)\s?%/);
  if (percent?.[1]) return Number(percent[1]);
  const number = text.match(/\b([0-9]+(?:\.[0-9]+)?)\b/);
  return number?.[1] ? Number(number[1]) : undefined;
}

function inferAboveBelow(text: string): "above" | "below" | undefined {
  const value = text.toLowerCase();
  if (/\b(above|over|exceed|exceeds|higher than|greater than|at least|or higher|more than)\b/.test(value)) return "above";
  if (/\b(below|under|less than|lower than|at most|or lower|or below|fewer than)\b/.test(value)) return "below";
  return undefined;
}

function formatMacroValue(value: number, unit: string): string {
  if (unit === "percent") return `${value.toFixed(2)}%`;
  if (unit === "thousand_jobs") return `${value.toFixed(0)}k`;
  return value.toFixed(2);
}

function extractTemperatureThreshold(text: string): number | undefined {
  // Matches "90°F", "90 degrees", "above 32C", "hit 100" near a temperature cue.
  const explicit = text.match(/(-?\d{1,3}(?:\.\d+)?)\s*(?:°|degrees?|deg)\s*[cf]?/i);
  if (explicit) return Number(explicit[1]);
  const nearCue = text.match(/(?:above|below|over|under|hit|reach|exceed|top)\s+(-?\d{1,3}(?:\.\d+)?)\b/i);
  return nearCue ? Number(nearCue[1]) : undefined;
}

function extractWeatherThreshold(text: string, metric: string, unit: string): number | undefined {
  if (metric === "high" || metric === "low") return extractTemperatureThreshold(text);
  const value = text.toLowerCase();
  if (metric === "wind" || metric === "wind_gust") {
    const explicit = value.match(/(\d{1,3}(?:\.\d+)?)\s*(?:mph|miles per hour|km\/h|kph|kmh|kilometers per hour)\b/);
    const nearCue = value.match(/(?:above|below|over|under|exceed|hit|reach|at least|less than)\s+(\d{1,3}(?:\.\d+)?)/);
    return explicit ? Number(explicit[1]) : nearCue ? Number(nearCue[1]) : undefined;
  }
  const explicit = value.match(/(\d{1,3}(?:\.\d+)?)\s*(?:inches?|in\b|mm|millimeters?|cm|centimeters?)\b/);
  if (explicit) {
    const raw = Number(explicit[1]);
    if (/\b(cm|centimeters?)\b/.test(explicit[0])) return unit === "mm" ? raw * 10 : raw / 2.54;
    if (/\b(mm|millimeters?)\b/.test(explicit[0])) return unit === "mm" ? raw : raw / 25.4;
    return unit === "mm" ? raw * 25.4 : raw;
  }
  if (/\b(no|zero|without)\s+(rain|rainfall|precip|precipitation|snow|snowfall)\b/.test(value)) {
    return unit === "mm" ? 0.25 : 0.01;
  }
  if (/\b(rain|rainfall|precipitation|precip|snow|snowfall|measurable)\b/.test(value)) {
    return unit === "mm" ? 0.25 : 0.01;
  }
  return undefined;
}

function extractWeatherRange(text: string, metric: string): { lower?: number; upper?: number } | undefined {
  if (metric !== "high" && metric !== "low") return undefined;
  const value = text.toLowerCase();
  const explicitTemp = value.match(/(-?\d{1,3}(?:\.\d+)?)\s*(?:°\s*[cf]|degrees?\s*[cf]?|deg\s*[cf]?)\b/);
  if (!explicitTemp) return undefined;
  const temperature = Number(explicitTemp[1]);
  if (!Number.isFinite(temperature)) return undefined;
  const before = value.slice(Math.max(0, explicitTemp.index! - 24), explicitTemp.index);
  const after = value.slice(explicitTemp.index! + explicitTemp[0].length, explicitTemp.index! + explicitTemp[0].length + 30);
  if (/\b(above|over|greater than|higher than|at least|exceed|exceeds|surpass)\b/.test(before)) return undefined;
  if (/\b(below|under|less than|lower than|at most|beneath)\b/.test(before)) return undefined;
  if (/\bor\s+(below|lower|less|under)\b/.test(after)) return { upper: temperature + 1 };
  if (/\bor\s+(above|higher|more|over)\b/.test(after)) return { lower: temperature };
  if (/\bbe\s*$/.test(before) || /\bbetween\s*$/.test(before) || /\btemperature\s+(?:in|at|for)\b/.test(before + after)) {
    return { lower: temperature, upper: temperature + 1 };
  }
  if (/\bwill\b.*\bbe\s+(-?\d{1,3}(?:\.\d+)?)\s*(?:°\s*[cf]|degrees?\s*[cf]?|deg\s*[cf]?)/.test(value)) {
    return { lower: temperature, upper: temperature + 1 };
  }
  return undefined;
}

function inferWeatherDirection(text: string, metric: string): "above" | "below" | undefined {
  const value = text.toLowerCase();
  if (/\b(no|zero|without)\s+(rain|rainfall|precip|precipitation|snow|snowfall)\b/.test(value)) return "below";
  const explicit = inferDirection(value);
  if (explicit) return explicit;
  if (metric === "rain" || metric === "precipitation" || metric === "snowfall" || metric === "wind" || metric === "wind_gust") {
    return "above";
  }
  return undefined;
}

function weatherForecastStd(metric: string, unit: string, forecastValue: number, leadDays: number): number {
  if (metric === "high" || metric === "low") {
    // Total uncertainty combines (a) forecast error that grows with lead time and (b) a
    // fixed "station representativeness" floor: these markets resolve on ONE specific
    // station (e.g. an airport via Wunderground), but Open-Meteo returns a grid-point
    // forecast that can sit several degrees off — coastal/desert cities like Jeddah are
    // the worst case. Combining in quadrature keeps single-degree bucket probabilities
    // realistic instead of spiking to ~1%/~99% on a point forecast.
    const isCelsius = unit === "celsius";
    const forecastError = (isCelsius ? 1.0 : 1.8) + (isCelsius ? 0.5 : 0.9) * leadDays;
    const stationError = isCelsius ? 1.8 : 3.2;
    return clamp(Math.sqrt(forecastError ** 2 + stationError ** 2), isCelsius ? 2.2 : 3.6, isCelsius ? 16 : 28);
  }
  if (metric === "wind" || metric === "wind_gust") {
    const base = unit === "kmh" ? 6.5 : 4;
    const lead = unit === "kmh" ? 2.2 : 1.4;
    return clamp(base + lead * leadDays + Math.max(0, forecastValue) * 0.08, base, unit === "kmh" ? 45 : 28);
  }
  const base = unit === "mm" ? 1.2 : 0.05;
  const lead = unit === "mm" ? 0.9 : 0.035;
  const spread = base + lead * leadDays + Math.max(0, forecastValue) * 0.35;
  return clamp(spread, base, unit === "mm" ? 60 : 2.5);
}

function weatherMetricLabel(metric: string): string {
  const labels: Record<string, string> = {
    high: "daily high temperature",
    low: "daily low temperature",
    rain: "daily rain total",
    precipitation: "daily precipitation total",
    snowfall: "daily snowfall total",
    wind: "maximum wind speed",
    wind_gust: "maximum wind gust",
  };
  return labels[metric] ?? metric;
}

function formatWeatherValue(value: number, metric: string, unit: string): string {
  if (metric === "high" || metric === "low") return `${value.toFixed(1)}°${unit === "celsius" ? "C" : "F"}`;
  if (metric === "wind" || metric === "wind_gust") return `${value.toFixed(1)} ${unit}`;
  return `${value.toFixed(unit === "mm" ? 1 : 2)} ${unit}`;
}

function formatWeatherRange(range: { lower?: number; upper?: number }, unit: string): string {
  const suffix = unit === "celsius" ? "°C" : "°F";
  if (range.lower !== undefined && range.upper !== undefined) {
    return `${range.lower.toFixed(1)}-${(range.upper - 0.1).toFixed(1)}${suffix}`;
  }
  if (range.lower !== undefined) return `${range.lower.toFixed(1)}${suffix} or higher`;
  if (range.upper !== undefined) return `${(range.upper - 0.1).toFixed(1)}${suffix} or below`;
  return "unknown";
}

function inferDirection(text: string): "above" | "below" | undefined {
  const value = text.toLowerCase();
  // Downward intent, including the Polymarket "(LOW)" qualifier. Checked first so that
  // e.g. "high temperature under 70" resolves to below.
  if (/\(\s*low\s*\)|\b(below|under|less than|lower than|at most|beneath|fall to|drop to|dip to|down to|decline to)\b/.test(value)) {
    return "below";
  }
  // Upward intent, including the "(HIGH)" qualifier.
  if (/\(\s*high\s*\)|\b(above|over|greater than|higher than|at least|exceed|exceeds|surpass)\b/.test(value)) {
    return "above";
  }
  // NOTE: bare "hit"/"reach"/"touch" are deliberately NOT treated as "above" here -- they
  // are directionally neutral. resolvePriceDirection() infers their direction from spot.
  return undefined;
}

/**
 * Resolves the barrier/threshold direction for a price market. Uses explicit wording when
 * present; otherwise, for "hit/reach/touch a level" markets, infers direction from where the
 * threshold sits relative to the current price (you can only "hit" a lower level by falling
 * to it, or a higher level by rising to it). Returns undefined when it cannot be determined,
 * so the engine skips rather than guessing a side.
 */
function resolvePriceDirection(
  text: string,
  spot: number | undefined,
  threshold: number | undefined,
): "above" | "below" | undefined {
  const explicit = inferDirection(text);
  if (explicit) return explicit;
  if (
    isPathDependent(text) &&
    spot !== undefined &&
    threshold !== undefined &&
    Number.isFinite(spot) &&
    Number.isFinite(threshold)
  ) {
    return threshold >= spot ? "above" : "below";
  }
  return undefined;
}

function isPathDependent(text: string): boolean {
  return /\b(reach|hit|touch|dip|fall to|drop to|trade at|any time|at any point|immediately resolve|final low|final high)\b/i.test(text);
}

function isSupportedThresholdContract(market: NormalizedMarket): boolean {
  const title = market.title.toLowerCase();
  const rules = (market.rules ?? "").toLowerCase();
  // Company-valuation markets ("market cap", "$X trillion", "most valuable company") are
  // handled by the dedicated market-cap model, not the share-price threshold model.
  if (/\b(market cap|market capitalization|valuation|valued at|most valuable|worth (more|less) than|biggest compan|largest compan)\b/.test(`${title} ${rules}`)) return false;
  if (/\btrillion\b/.test(`${title} ${rules}`)) return false;
  if (/\b(50[-/ ]50|split equally|half payout)\b/.test(rules)) return false;
  if (/\b(which|what)\b.+\bfirst\b/.test(title)) return false;
  if (/\bbefore\b/.test(title) && !hasCalendarDeadline(title)) return false;
  return true;
}

function hasCalendarDeadline(text: string): boolean {
  return (
    /\b20\d{2}\b/.test(text) ||
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(
      text,
    ) ||
    /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/.test(text)
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  const sign = Math.sign(x);
  const abs = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * abs);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-abs * abs);
  return sign * y;
}
