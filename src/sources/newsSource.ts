import type { NormalizedMarket, SourceObservation } from "../types";
import { nowIso } from "../utils";
import { resilientFetchJson, resilientFetchText } from "../utils/fetch";

export interface NewsArticle {
  title: string;
  url?: string;
  publisher?: string;
  publishedAt?: string;
  provider: "google-news-rss" | "gdelt-doc";
}

interface GdeltResponse {
  articles?: Array<{
    title?: string;
    url?: string;
    domain?: string;
    seendate?: string;
  }>;
}

/**
 * Free news research from two discovery paths. The probability model de-duplicates
 * publishers and requires explicit confirmation/denial language; raw article count and
 * generic positive words are never treated as independent votes.
 */
export async function getNewsObservation(market: NormalizedMarket): Promise<SourceObservation> {
  const query = buildQuery(market.title);
  if (!query) return unavailable(market, "Market title produced no usable news query terms");

  const googleUrl =
    `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:3d`)}` +
    `&hl=en-US&gl=US&ceid=US:en`;
  const gdeltUrl = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  gdeltUrl.searchParams.set("query", query);
  gdeltUrl.searchParams.set("mode", "artlist");
  gdeltUrl.searchParams.set("format", "json");
  gdeltUrl.searchParams.set("sort", "hybridrel");
  gdeltUrl.searchParams.set("maxrecords", "75");
  gdeltUrl.searchParams.set("timespan", "72h");

  const headers = { "user-agent": "Mozilla/5.0 pollybot/1.2 research and paper-trading bot" };
  const [google, gdelt] = await Promise.allSettled([
    resilientFetchText(googleUrl, { timeoutMs: 12_000, headers, maxRetries: 1 }),
    resilientFetchJson<GdeltResponse>(gdeltUrl, { timeoutMs: 12_000, headers, maxRetries: 1 }),
  ]);

  const articles: NewsArticle[] = [];
  const providers: string[] = [];
  if (google.status === "fulfilled" && google.value.status >= 200 && google.value.status < 300) {
    articles.push(...parseRssArticles(google.value.text));
    providers.push("google-news-rss");
  }
  if (gdelt.status === "fulfilled") {
    for (const article of gdelt.value.data.articles ?? []) {
      const title = String(article.title ?? "").trim();
      if (!title) continue;
      articles.push({
        title,
        url: article.url,
        publisher: article.domain,
        publishedAt: parseGdeltDate(article.seendate),
        provider: "gdelt-doc",
      });
    }
    providers.push("gdelt-doc");
  }

  const deduplicated = deduplicateArticles(articles).slice(0, 60);
  if (deduplicated.length === 0) {
    const reasons = [google, gdelt]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
    return unavailable(market, reasons[0] ?? "No recent news headlines matched the query");
  }
  const publishers = new Set(
    deduplicated.map((article) => normalizePublisher(article.publisher)).filter(Boolean),
  );
  const dated = deduplicated.filter((article) => article.publishedAt && Number.isFinite(Date.parse(article.publishedAt)));
  const freshnessRatio = dated.length === 0
    ? 0.5
    : dated.filter((article) => Date.now() - Date.parse(article.publishedAt!) <= 72 * 3_600_000).length / dated.length;

  return {
    sourceType: "news",
    sourceKey: `news:${market.marketId}`,
    collectedAt: nowIso(),
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    payload: {
      providers,
      query,
      publisherCount: publishers.size,
      freshnessRatio,
      articles: deduplicated,
    },
    available: true,
    independent: true,
    quality: Math.min(0.76, 0.42 + Math.min(0.2, publishers.size * 0.025) + freshnessRatio * 0.1),
  };
}

function unavailable(market: NormalizedMarket, reason: string): SourceObservation {
  return {
    sourceType: "news",
    sourceKey: `news:${market.marketId}`,
    collectedAt: nowIso(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    payload: { articles: [] },
    available: false,
    reason,
  };
}

export function parseRssArticles(xml: string): NewsArticle[] {
  const articles: NewsArticle[] = [];
  for (const item of xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? []) {
    const title = readXmlTag(item, "title");
    if (!title) continue;
    const source = readXmlTag(item, "source") || publisherFromTitle(title);
    articles.push({
      title,
      url: readXmlTag(item, "link") || undefined,
      publisher: source || undefined,
      publishedAt: normalizeDate(readXmlTag(item, "pubDate")),
      provider: "google-news-rss",
    });
  }
  return articles;
}

/** Backwards-compatible helper retained for focused parser tests. */
export function parseRssTitles(xml: string): string[] {
  return parseRssArticles(xml).map((article) => article.title);
}

function readXmlTag(item: string, tag: string): string {
  const match = item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1] ? decodeXml(stripCdata(match[1])).trim() : "";
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
    .replace(/&#39;|&#x27;/g, "'");
}

function normalizeDate(value: string): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function parseGdeltDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/);
  return compact
    ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z`
    : normalizeDate(value);
}

function publisherFromTitle(title: string): string | undefined {
  const separator = title.lastIndexOf(" - ");
  return separator > 0 ? title.slice(separator + 3).trim() : undefined;
}

function normalizePublisher(value: string | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9.-]/g, "")
    .trim();
}

function deduplicateArticles(articles: NewsArticle[]): NewsArticle[] {
  const seen = new Set<string>();
  const result: NewsArticle[] = [];
  for (const article of articles) {
    const key = article.title.toLowerCase().replace(/\s+-\s+[^-]+$/, "").replace(/[^a-z0-9]+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(article);
  }
  return result;
}

const STOPWORDS = new Set([
  "will", "would", "could", "should", "the", "a", "an", "of", "to", "in", "on", "by", "be", "is", "are", "at", "or", "and",
  "for", "this", "that", "before", "after", "than", "with", "have", "has", "do", "does", "did",
  "end", "year", "month", "day", "hit", "reach", "above", "below", "over", "under", "market", "resolve",
]);

export function buildQuery(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9$%.\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word) && !/^\d+$/.test(word));
  const unique: string[] = [];
  for (const word of words) {
    if (!unique.includes(word)) unique.push(word);
    if (unique.length >= 8) break;
  }
  return unique.join(" ").trim();
}
