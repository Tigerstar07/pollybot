import type { Db } from "../db";
import { getCachedSource, saveSourceObservation } from "../db";
import type { NormalizedMarket, SourceObservation } from "../types";
import { daysUntil, nowIso } from "../utils";
import { resilientFetchJson, resilientFetchText } from "../utils/fetch";

interface StatusIncident {
  name?: string;
  status?: string;
  impact?: string;
  created_at?: string;
  resolved_at?: string;
  incident_updates?: Array<{ body?: string; status?: string; created_at?: string }>;
}

interface StatusResponse {
  incidents?: StatusIncident[];
}

interface RssItem {
  title: string;
  pubDate?: string;
}

type TechProvider = "openai" | "anthropic";

const PROVIDERS: Record<TechProvider, { statusUrl: string; rssUrls: string[]; labels: RegExp[] }> = {
  openai: {
    statusUrl: "https://status.openai.com/api/v2/incidents.json",
    rssUrls: ["https://openai.com/news/rss.xml", "https://openai.com/blog/rss.xml"],
    labels: [/\bopenai\b/i, /\bchatgpt\b/i, /\bgpt-?\d/i, /\bcodex\b/i],
  },
  anthropic: {
    statusUrl: "https://status.anthropic.com/api/v2/incidents.json",
    rssUrls: [],
    labels: [/\banthropic\b/i, /\bclaude\b/i, /\bsonnet\b/i, /\bopus\b/i, /\bhaiku\b/i],
  },
};

export async function getTechObservation(db: Db, market: NormalizedMarket): Promise<SourceObservation> {
  const provider = detectTechProvider(market);
  if (!provider) return unavailable(market, "No supported official tech source was recognized");
  const kind = detectTechMarketKind(market);
  const cacheKey = `tech:${provider}:v2`;
  const cached = getCachedSource(db, "tech-official", cacheKey);
  if (cached) return withMarketPayload(cached, market, provider, kind);

  try {
    const statusResult = await resilientFetchJson<StatusResponse>(PROVIDERS[provider].statusUrl, {
      timeoutMs: 12_000,
      headers: { "user-agent": "pollybot/1.1 research and paper-trading bot" },
    });
    const officialPosts: RssItem[] = [];
    for (const rssUrl of PROVIDERS[provider].rssUrls) {
      const result = await resilientFetchText(rssUrl, {
        timeoutMs: 12_000,
        headers: { "user-agent": "Mozilla/5.0 pollybot/1.1 research and paper-trading bot" },
      }).catch(() => undefined);
      if (result && result.status >= 200 && result.status < 300) officialPosts.push(...parseRssItems(result.text));
    }
    const observation: SourceObservation = {
      sourceType: "tech-official",
      sourceKey: cacheKey,
      collectedAt: nowIso(),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      available: true,
      independent: true,
      quality: officialPosts.length > 0 ? 0.72 : 0.62,
      payload: {
        provider,
        statusProvider: "statuspage",
        incidents: normalizeIncidents(statusResult.data.incidents ?? []).slice(0, 30),
        officialPosts: officialPosts.slice(0, 30),
      },
    };
    saveSourceObservation(db, null, observation);
    return withMarketPayload(observation, market, provider, kind);
  } catch (error) {
    const observation: SourceObservation = {
      sourceType: "tech-official",
      sourceKey: cacheKey,
      collectedAt: nowIso(),
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      payload: { provider },
      available: false,
      independent: true,
      quality: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
    saveSourceObservation(db, null, observation);
    return withMarketPayload(observation, market, provider, kind);
  }
}

function withMarketPayload(
  observation: SourceObservation,
  market: NormalizedMarket,
  provider: TechProvider,
  kind: string,
): SourceObservation {
  if (!observation.available) return { ...observation, sourceKey: `tech:${market.marketId}` };
  const terms = importantTerms(market.title);
  const incidents = Array.isArray(observation.payload.incidents) ? observation.payload.incidents as Array<Record<string, unknown>> : [];
  const posts = Array.isArray(observation.payload.officialPosts) ? observation.payload.officialPosts as Array<Record<string, unknown>> : [];
  const matchedIncident = incidents.find((incident) => textMatchesTerms(`${incident.name ?? ""} ${incident.body ?? ""}`, terms));
  const matchedPost = posts.find((post) => textMatchesTerms(String(post.title ?? ""), terms));
  return {
    ...observation,
    sourceKey: `tech:${market.marketId}`,
    payload: {
      ...observation.payload,
      provider,
      marketKind: kind,
      terms,
      deadlineDays: daysUntil(market.endDate),
      matchedIncident,
      matchedOfficialPost: matchedPost,
    },
  };
}

function detectTechProvider(market: NormalizedMarket): TechProvider | undefined {
  const text = `${market.title} ${market.rules ?? ""}`;
  return (Object.keys(PROVIDERS) as TechProvider[]).find((provider) =>
    PROVIDERS[provider].labels.some((pattern) => pattern.test(text)),
  );
}

function detectTechMarketKind(market: NormalizedMarket): string {
  const text = `${market.title} ${market.rules ?? ""}`.toLowerCase();
  if (/\b(released?|releasing|release|launch(?:ed|ing)?|announce(?:d|ment)?|available|ship(?:ped|ping)?)\b/.test(text)) return "release";
  if (/\b(restored?|restoring|resolved?|resolving|recover(?:ed|ing)?|outage|down|incident|service|errors?)\b/.test(text)) return "status";
  return "official-event";
}

function importantTerms(title: string): string[] {
  const normalized = title.toLowerCase();
  const terms = [
    ...Array.from(normalized.matchAll(/\bgpt[- ]?\d(?:\.\d+)?\b/g)).map((m) => m[0].replace(" ", "-")),
    ...Array.from(normalized.matchAll(/\bclaude(?:\s+[a-z0-9.-]+){0,3}/g)).map((m) => m[0]),
  ];
  for (const token of ["chatgpt", "codex", "sonnet", "opus", "haiku", "openai", "anthropic", "claude"]) {
    if (normalized.includes(token)) terms.push(token);
  }
  return [...new Set(terms.map((term) => term.trim()).filter((term) => term.length > 2))];
}

function textMatchesTerms(text: string, terms: string[]): boolean {
  const normalized = text.toLowerCase().replace(/[^a-z0-9. -]+/g, " ");
  if (terms.length === 0) return false;
  return terms.some((term) => normalized.includes(term.toLowerCase().replace(/[^a-z0-9. -]+/g, " ").trim()));
}

function normalizeIncidents(incidents: StatusIncident[]): Array<Record<string, unknown>> {
  return incidents.map((incident) => ({
    name: incident.name,
    status: incident.status,
    impact: incident.impact,
    createdAt: incident.created_at,
    resolvedAt: incident.resolved_at,
    body: (incident.incident_updates ?? []).map((update) => update.body ?? "").join(" ").slice(0, 1500),
  }));
}

function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  for (const item of xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? []) {
    const title = decodeXml(stripCdata(item.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "")).trim();
    const pubDate = decodeXml(stripCdata(item.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] ?? "")).trim();
    if (title) items.push({ title, pubDate: pubDate || undefined });
  }
  return items;
}

function stripCdata(value: string): string {
  return value.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function unavailable(market: NormalizedMarket, reason: string): SourceObservation {
  return {
    sourceType: "tech-official",
    sourceKey: `tech:${market.marketId}`,
    collectedAt: nowIso(),
    payload: {},
    available: false,
    independent: true,
    quality: 0,
    reason,
  };
}
