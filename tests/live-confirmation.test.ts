import test from "node:test";
import assert from "node:assert/strict";
import type { Trade } from "@polymarket/clob-client-v2";
import { summarizeOrderTrades } from "../src/providers/polymarket/orders";

function trade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: "trade-1",
    taker_order_id: "order-1",
    market: "market-1",
    asset_id: "asset-1",
    side: "BUY" as Trade["side"],
    size: "4",
    fee_rate_bps: "0",
    price: "0.25",
    status: "CONFIRMED",
    match_time: "1",
    last_update: "2",
    outcome: "YES",
    bucket_index: 0,
    owner: "owner",
    maker_address: "0x0000000000000000000000000000000000000000",
    maker_orders: [],
    trader_side: "TAKER",
    ...overrides,
  };
}

test("confirmed trade reconciliation records actual weighted shares and price", () => {
  const result = summarizeOrderTrades([
    trade({ id: "a", size: "4", price: "0.25" }),
    trade({ id: "b", size: "6", price: "0.5" }),
  ], "order-1");
  assert.equal(result.state, "confirmed");
  assert.equal(result.executedShares, 10);
  assert.equal(result.executedPrice, 0.4);
  assert.equal(result.executedFeeEur, 0);
});

test("matched or mined trades remain pending until terminal confirmation", () => {
  assert.equal(summarizeOrderTrades([trade({ status: "MATCHED" })], "order-1").state, "pending");
  assert.equal(summarizeOrderTrades([trade({ status: "TRADE_STATUS_MINED" })], "order-1").state, "pending");
});

test("a terminal failed trade is never recorded as an open position", () => {
  assert.equal(summarizeOrderTrades([trade({ status: "TRADE_STATUS_FAILED" })], "order-1").state, "failed");
});

test("unrelated trades cannot confirm a local reservation", () => {
  assert.equal(summarizeOrderTrades([trade({ taker_order_id: "other" })], "order-1").state, "absent");
});
