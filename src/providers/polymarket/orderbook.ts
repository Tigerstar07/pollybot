import type { AppConfig } from "../../config";
import type { NormalizedMarket, TradeOutcome } from "../../types";
import { toNumber } from "../../utils";
import { clobUrl, fetchJson } from "./client";
import type { OrderBookSummary } from "./types";

export async function fetchOrderBook(config: AppConfig, tokenId: string): Promise<OrderBookSummary> {
  const url = clobUrl(config, "/book", { token_id: tokenId });
  const result = await fetchJson<OrderBookSummary>(url, 15_000);
  return result.data;
}

export async function fetchBestBidAsk(
  config: AppConfig,
  tokenId: string,
): Promise<{ bid?: number; ask?: number; spread?: number; raw?: OrderBookSummary }> {
  const raw = await fetchOrderBook(config, tokenId);
  const bids = (raw.bids ?? []).map((entry) => toNumber(entry.price)).filter((value): value is number => value !== undefined);
  const asks = (raw.asks ?? []).map((entry) => toNumber(entry.price)).filter((value): value is number => value !== undefined);
  const bid = bids.length > 0 ? Math.max(...bids) : undefined;
  const ask = asks.length > 0 ? Math.min(...asks) : undefined;
  const spread = bid !== undefined && ask !== undefined ? ask - bid : undefined;
  return { bid, ask, spread, raw };
}

export async function refreshExecutableQuotes(config: AppConfig, market: NormalizedMarket): Promise<NormalizedMarket> {
  if (!market.yesTokenId || !market.noTokenId) throw new Error("Cannot quote a market without both YES and NO token IDs");
  const [yes, no] = await Promise.all([
    fetchBestBidAsk(config, market.yesTokenId),
    fetchBestBidAsk(config, market.noTokenId),
  ]);
  if (yes.ask === undefined || no.ask === undefined || yes.bid === undefined || no.bid === undefined) {
    throw new Error("Executable two-sided order books are incomplete");
  }
  return {
    ...market,
    bestBid: yes.bid,
    bestAsk: yes.ask,
    spread: yes.spread,
    noBestBid: no.bid,
    noBestAsk: no.ask,
    noSpread: no.spread,
    yesAskDepthEur: calculateAskDepthEur(yes.raw, yes.ask),
    noAskDepthEur: calculateAskDepthEur(no.raw, no.ask),
    yesMinOrderSizeShares: toNumber(yes.raw?.min_order_size),
    noMinOrderSizeShares: toNumber(no.raw?.min_order_size),
    yesTickSize: yes.raw?.tick_size,
    noTickSize: no.raw?.tick_size,
    negRisk: Boolean(yes.raw?.neg_risk || no.raw?.neg_risk),
    quoteCapturedAt: new Date().toISOString(),
  };
}

export async function refreshExecutableQuoteForOutcome(
  config: AppConfig,
  market: NormalizedMarket,
  outcome: TradeOutcome,
): Promise<NormalizedMarket> {
  const tokenId = outcome === "YES" ? market.yesTokenId : market.noTokenId;
  if (!tokenId) throw new Error(`Cannot quote ${outcome} without a token ID`);
  const quote = await fetchBestBidAsk(config, tokenId);
  if (quote.ask === undefined) {
    throw new Error(`Executable ${outcome} ask book is incomplete`);
  }
  if (outcome === "YES") {
    return {
      ...market,
      bestBid: quote.bid,
      bestAsk: quote.ask,
      spread: quote.spread,
      yesAskDepthEur: calculateAskDepthEur(quote.raw, quote.ask),
      yesMinOrderSizeShares: toNumber(quote.raw?.min_order_size),
      yesTickSize: quote.raw?.tick_size,
      negRisk: Boolean(quote.raw?.neg_risk),
      quoteCapturedAt: new Date().toISOString(),
    };
  }
  return {
    ...market,
    noBestBid: quote.bid,
    noBestAsk: quote.ask,
    noSpread: quote.spread,
    noAskDepthEur: calculateAskDepthEur(quote.raw, quote.ask),
    noMinOrderSizeShares: toNumber(quote.raw?.min_order_size),
    noTickSize: quote.raw?.tick_size,
    negRisk: Boolean(quote.raw?.neg_risk),
    quoteCapturedAt: new Date().toISOString(),
  };
}

function calculateAskDepthEur(raw: OrderBookSummary | undefined, bestAsk: number): number {
  if (!raw) return 0;
  return (raw.asks ?? [])
    .filter((entry) => toNumber(entry.price) === bestAsk)
    .reduce((sum, entry) => sum + (toNumber(entry.price) ?? 0) * (toNumber(entry.size) ?? 0), 0);
}
