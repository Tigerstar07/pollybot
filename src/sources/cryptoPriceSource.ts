import type { Db } from "../db";
import { getCachedSource, saveSourceObservation } from "../db";
import type { NormalizedMarket, SourceObservation } from "../types";
import { nowIso } from "../utils";
import { resilientFetchJson } from "../utils/fetch";

const ASSET_MAP: Record<string, { id: string; symbol: string; annualVolatility: number }> = {
  btc: { id: "bitcoin", symbol: "BTC", annualVolatility: 0.6 },
  bitcoin: { id: "bitcoin", symbol: "BTC", annualVolatility: 0.6 },
  eth: { id: "ethereum", symbol: "ETH", annualVolatility: 0.75 },
  ethereum: { id: "ethereum", symbol: "ETH", annualVolatility: 0.75 },
  sol: { id: "solana", symbol: "SOL", annualVolatility: 1.0 },
  solana: { id: "solana", symbol: "SOL", annualVolatility: 1.0 },
  doge: { id: "dogecoin", symbol: "DOGE", annualVolatility: 1.2 },
  dogecoin: { id: "dogecoin", symbol: "DOGE", annualVolatility: 1.2 },
  xrp: { id: "ripple", symbol: "XRP", annualVolatility: 1.05 },
  ripple: { id: "ripple", symbol: "XRP", annualVolatility: 1.05 },
  bnb: { id: "binancecoin", symbol: "BNB", annualVolatility: 0.8 },
  ada: { id: "cardano", symbol: "ADA", annualVolatility: 1.0 },
  cardano: { id: "cardano", symbol: "ADA", annualVolatility: 1.0 },
  avax: { id: "avalanche-2", symbol: "AVAX", annualVolatility: 1.1 },
  avalanche: { id: "avalanche-2", symbol: "AVAX", annualVolatility: 1.1 },
  link: { id: "chainlink", symbol: "LINK", annualVolatility: 1.0 },
  chainlink: { id: "chainlink", symbol: "LINK", annualVolatility: 1.0 },
  matic: { id: "matic-network", symbol: "MATIC", annualVolatility: 1.1 },
  polygon: { id: "matic-network", symbol: "MATIC", annualVolatility: 1.1 },
  ltc: { id: "litecoin", symbol: "LTC", annualVolatility: 0.9 },
  litecoin: { id: "litecoin", symbol: "LTC", annualVolatility: 0.9 },
  trx: { id: "tron", symbol: "TRX", annualVolatility: 0.85 },
  tron: { id: "tron", symbol: "TRX", annualVolatility: 0.85 },
  dot: { id: "polkadot", symbol: "DOT", annualVolatility: 1.0 },
  polkadot: { id: "polkadot", symbol: "DOT", annualVolatility: 1.0 },
  shib: { id: "shiba-inu", symbol: "SHIB", annualVolatility: 1.4 },
  pepe: { id: "pepe", symbol: "PEPE", annualVolatility: 1.6 },
  sui: { id: "sui", symbol: "SUI", annualVolatility: 1.3 },
  ton: { id: "the-open-network", symbol: "TON", annualVolatility: 1.0 },
  near: { id: "near", symbol: "NEAR", annualVolatility: 1.1 },
  atom: { id: "cosmos", symbol: "ATOM", annualVolatility: 1.0 },
  cosmos: { id: "cosmos", symbol: "ATOM", annualVolatility: 1.0 },
  bch: { id: "bitcoin-cash", symbol: "BCH", annualVolatility: 0.95 },
};

const inFlight = new Map<string, Promise<SourceObservation>>();

export function detectCryptoAsset(market: NormalizedMarket): { id: string; symbol: string; annualVolatility: number } | undefined {
  const text = `${market.title} ${market.rules ?? ""}`.toLowerCase();
  for (const [needle, asset] of Object.entries(ASSET_MAP)) {
    if (new RegExp(`\\b${needle}\\b`, "i").test(text)) return asset;
  }
  return undefined;
}

export async function getCryptoPriceObservation(db: Db, market: NormalizedMarket): Promise<SourceObservation> {
  const asset = detectCryptoAsset(market);
  if (!asset) {
    return {
      sourceType: "crypto-price",
      sourceKey: `crypto:none:${market.marketId}`,
      collectedAt: nowIso(),
      payload: {},
      available: false,
      reason: "Market text does not reference a supported crypto asset",
    };
  }

  const cacheKey = `coingecko:${asset.id}:usd:30d`;
  const cached = getCachedSource(db, "crypto-price", cacheKey);
  if (cached) return cached;

  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const request = fetchCryptoObservation(db, asset, cacheKey);
  inFlight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    inFlight.delete(cacheKey);
  }
}

async function fetchCryptoObservation(
  db: Db,
  asset: { id: string; symbol: string; annualVolatility: number },
  cacheKey: string,
): Promise<SourceObservation> {
  try {
    const spotUrl = new URL("https://api.coingecko.com/api/v3/simple/price");
    spotUrl.searchParams.set("ids", asset.id);
    spotUrl.searchParams.set("vs_currencies", "usd");
    spotUrl.searchParams.set("include_last_updated_at", "true");
    const historyUrl = new URL(`https://api.coingecko.com/api/v3/coins/${asset.id}/market_chart`);
    historyUrl.searchParams.set("vs_currency", "usd");
    historyUrl.searchParams.set("days", "30");
    historyUrl.searchParams.set("interval", "daily");

    const headers = { "user-agent": "pollybot/1.1 research and paper-trading bot" };
    const [spotResult, historyResult] = await Promise.allSettled([
      resilientFetchJson<Record<string, { usd?: number; last_updated_at?: number }>>(spotUrl, { timeoutMs: 12_000, headers }),
      resilientFetchJson<{ prices?: Array<[number, number]> }>(historyUrl, { timeoutMs: 12_000, headers }),
    ]);
    if (spotResult.status !== "fulfilled") {
      const errorMsg = spotResult.reason instanceof Error ? spotResult.reason.message : String(spotResult.reason);
      throw new Error(`CoinGecko spot request failed: ${errorMsg}`);
    }

    const spotData = spotResult.value.data;
    const price = spotData[asset.id]?.usd;
    if (!price) throw new Error("CoinGecko response did not include USD price");

    let realizedAnnualVolatility: number | undefined;
    let historySamples = 0;
    if (historyResult.status === "fulfilled") {
      const historyData = historyResult.value.data;
      const prices = (historyData.prices ?? []).map((entry) => entry[1]).filter((value) => Number.isFinite(value) && value > 0);
      historySamples = prices.length;
      realizedAnnualVolatility = calculateAnnualizedVolatility(prices);
    }

    const hasHistory = realizedAnnualVolatility !== undefined && historySamples >= 10;
    const observation: SourceObservation = {
      sourceType: "crypto-price",
      sourceKey: cacheKey,
      collectedAt: nowIso(),
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      payload: {
        provider: "coingecko",
        assetId: asset.id,
        symbol: asset.symbol,
        usd: price,
        providerUpdatedAt: spotData[asset.id]?.last_updated_at
          ? new Date(Number(spotData[asset.id]?.last_updated_at) * 1000).toISOString()
          : undefined,
        realizedAnnualVolatility: hasHistory ? realizedAnnualVolatility : undefined,
        fallbackAnnualVolatility: asset.annualVolatility,
        historySamples,
      },
      available: true,
      independent: true,
      quality: hasHistory ? 0.78 : 0.45,
      reason: hasHistory ? undefined : "Spot is live, but 30-day volatility history was unavailable; using a conservative fallback",
    };
    saveSourceObservation(db, null, observation);
    return observation;
  } catch (error) {
    const observation: SourceObservation = {
      sourceType: "crypto-price",
      sourceKey: cacheKey,
      collectedAt: nowIso(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      payload: { provider: "coingecko", assetId: asset.id, symbol: asset.symbol },
      available: false,
      independent: true,
      quality: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
    saveSourceObservation(db, null, observation);
    return observation;
  }
}

export function calculateAnnualizedVolatility(prices: number[]): number | undefined {
  if (prices.length < 3) return undefined;
  const returns: number[] = [];
  for (let index = 1; index < prices.length; index += 1) {
    const previous = prices[index - 1];
    const current = prices[index];
    if (previous && current) returns.push(Math.log(current / previous));
  }
  if (returns.length < 2) return undefined;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance * 365);
}
