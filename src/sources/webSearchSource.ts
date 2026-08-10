import type { NormalizedMarket, SourceObservation } from "../types";
import { nowIso } from "../utils";

export function getWebSearchObservation(market: NormalizedMarket): SourceObservation {
  return {
    sourceType: "web-search",
    sourceKey: `web:${market.marketId}`,
    collectedAt: nowIso(),
    payload: {},
    available: false,
    reason: "No free web-search API configured; skipped",
  };
}
