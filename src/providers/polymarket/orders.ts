import { assertLiveTradingAllowed, type AppConfig } from "../../config";
import {
  AssetType,
  Chain,
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
  type ApiKeyCreds,
  type TickSize,
  type Trade,
} from "@polymarket/clob-client-v2";
import { setTimeout as delay } from "node:timers/promises";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { checkGeoblock } from "./geoblock";

export interface LiveMarketOrderRequest {
  tokenId: string;
  amountEur: number;
  maxPrice: number;
  tickSize: string;
  negRisk: boolean;
}

export interface LiveMarketSellRequest {
  tokenId: string;
  shares: number;
  minPrice: number;
  tickSize: string;
  negRisk: boolean;
}

export interface LiveShareBuyRequest {
  tokenId: string;
  shares: number;
  maxPrice: number;
  tickSize: string;
  negRisk: boolean;
  confirmationTimeoutMs?: number;
}

export interface LiveOrderResult {
  orderId: string;
  responseStatus: string;
  filled: boolean;
  executedShares?: number;
  executedPrice?: number;
  executedFeeEur?: number;
}

export interface LiveOrderExecution {
  state: "confirmed" | "failed" | "pending" | "absent";
  executedShares?: number;
  executedPrice?: number;
  executedFeeEur?: number;
}

export interface LiveAccountSnapshot {
  collateralBalance: number;
  minimumAllowance: number;
  closedOnly: boolean;
  openOrderCount: number;
}

export async function createAuthenticatedClobClient(config: AppConfig): Promise<ClobClient> {
  if (!config.polymarketPrivateKey) {
    throw new Error("Live trading refused: POLYMARKET_PRIVATE_KEY is not configured.");
  }
  const privateKey = config.polymarketPrivateKey.startsWith("0x")
    ? config.polymarketPrivateKey
    : `0x${config.polymarketPrivateKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("Live trading refused: POLYMARKET_PRIVATE_KEY is not a 32-byte hex key.");
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const signatureType = config.polymarketSignatureType as SignatureTypeV2;
  const funderAddress =
    signatureType === SignatureTypeV2.EOA
      ? config.polymarketFunderAddress ?? account.address
      : config.polymarketFunderAddress;
  if (!funderAddress || !/^0x[0-9a-fA-F]{40}$/.test(funderAddress)) {
    throw new Error(
      "Live trading refused: POLYMARKET_FUNDER_ADDRESS is required for the selected wallet signature type.",
    );
  }

  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });
  const host = config.polymarketClobUrl || "https://clob.polymarket.com";
  const common = {
    host,
    chain: Chain.POLYGON,
    signer: walletClient,
    signatureType,
    funderAddress,
    useServerTime: true,
    retryOnError: true,
    throwOnError: true,
  };

  const configuredCredentials = readConfiguredCredentials(config);
  const credentials =
    configuredCredentials ??
    (await createOrDeriveCredentials(new ClobClient(common)));
  return new ClobClient({ ...common, creds: credentials });
}

async function createOrDeriveCredentials(client: ClobClient): Promise<ApiKeyCreds> {
  try {
    return await client.deriveApiKey();
  } catch {
    return await client.createApiKey();
  }
}

export async function getLiveAccountSnapshot(client: ClobClient): Promise<LiveAccountSnapshot> {
  const [balance, banStatus, openOrders] = await Promise.all([
    client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }),
    client.getClosedOnlyMode(),
    client.getOpenOrders(undefined, true),
  ]);
  const allowances = Object.values(balance.allowances ?? {})
    .map(parseCollateralUnits)
    .filter(Number.isFinite);
  return {
    collateralBalance: parseCollateralUnits(balance.balance),
    minimumAllowance: allowances.length > 0 ? Math.min(...allowances) : 0,
    closedOnly: Boolean(banStatus.closed_only),
    openOrderCount: openOrders.length,
  };
}

export async function getConditionalTokenBalance(client: ClobClient, tokenId: string): Promise<number> {
  const balance = await client.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: tokenId });
  return parseCollateralUnits(balance.balance);
}

export async function placeLiveMarketOrder(
  config: AppConfig,
  client: ClobClient,
  order: LiveMarketOrderRequest,
): Promise<LiveOrderResult> {
  assertLiveTradingAllowed(config);

  const geo = await checkGeoblock(config);
  if (!geo.ok) {
    throw new Error("Live trading refused: geoblock endpoint could not be verified.");
  }
  if (geo.blocked) {
    throw new Error(
      `Live trading refused: Polymarket geoblock reports blocked for ${geo.country ?? "unknown"} ${geo.region ?? ""}.`,
    );
  }

  const response = (await client.createAndPostMarketOrder(
    {
      tokenID: order.tokenId,
      amount: order.amountEur,
      price: order.maxPrice,
      side: Side.BUY,
      orderType: OrderType.FOK,
    },
    {
      tickSize: order.tickSize as TickSize,
      negRisk: order.negRisk,
    },
    OrderType.FOK,
  )) as {
    success?: boolean;
    errorMsg?: string;
    orderID?: string;
    status?: string;
    tradeIDs?: string[];
  };

  if (!response?.success || !response.orderID) {
    throw new Error(response?.errorMsg || "Polymarket rejected the live order without an order ID.");
  }
  const responseStatus = String(response.status ?? "unknown").toLowerCase();
  if (responseStatus === "matched") {
    const execution = await waitForTerminalOrderExecution(
      client,
      response.orderID,
      response.tradeIDs ?? [],
    );
    return {
      orderId: response.orderID,
      responseStatus: execution.state === "confirmed" ? "confirmed" : execution.state === "failed" ? "failed" : "matched_unconfirmed",
      filled: execution.state === "confirmed",
      executedShares: execution.executedShares,
      executedPrice: execution.executedPrice,
      executedFeeEur: execution.executedFeeEur,
    };
  }
  return {
    orderId: response.orderID,
    responseStatus,
    filled: false,
  };
}

export async function placeLiveMarketSellOrder(
  config: AppConfig,
  client: ClobClient,
  order: LiveMarketSellRequest,
): Promise<LiveOrderResult> {
  assertLiveTradingAllowed(config);

  const geo = await checkGeoblock(config);
  if (!geo.ok) {
    throw new Error("Live close refused: geoblock endpoint could not be verified.");
  }
  if (geo.blocked) {
    throw new Error(
      `Live close refused: Polymarket geoblock reports blocked for ${geo.country ?? "unknown"} ${geo.region ?? ""}.`,
    );
  }

  const response = (await client.createAndPostMarketOrder(
    {
      tokenID: order.tokenId,
      amount: order.shares,
      price: order.minPrice,
      side: Side.SELL,
      orderType: OrderType.FOK,
    },
    {
      tickSize: order.tickSize as TickSize,
      negRisk: order.negRisk,
    },
    OrderType.FOK,
  )) as {
    success?: boolean;
    errorMsg?: string;
    orderID?: string;
    status?: string;
    tradeIDs?: string[];
  };

  if (!response?.success || !response.orderID) {
    throw new Error(response?.errorMsg || "Polymarket rejected the live close without an order ID.");
  }
  const responseStatus = String(response.status ?? "unknown").toLowerCase();
  if (responseStatus === "matched") {
    const execution = await waitForTerminalOrderExecution(
      client,
      response.orderID,
      response.tradeIDs ?? [],
    );
    return {
      orderId: response.orderID,
      responseStatus: execution.state === "confirmed" ? "confirmed" : execution.state === "failed" ? "failed" : "matched_unconfirmed",
      filled: execution.state === "confirmed",
      executedShares: execution.executedShares,
      executedPrice: execution.executedPrice,
      executedFeeEur: execution.executedFeeEur,
    };
  }
  return {
    orderId: response.orderID,
    responseStatus,
    filled: false,
  };
}

/** FOK limit buy with an exact share quantity, used by equal-share arb baskets. */
export async function placeLiveShareBuyOrder(
  config: AppConfig,
  client: ClobClient,
  order: LiveShareBuyRequest,
): Promise<LiveOrderResult> {
  assertLiveTradingAllowed(config);
  const geo = await checkGeoblock(config);
  if (!geo.ok || geo.blocked) {
    throw new Error(
      geo.ok
        ? `Live trading refused: Polymarket geoblock reports blocked for ${geo.country ?? "unknown"} ${geo.region ?? ""}.`
        : "Live trading refused: geoblock endpoint could not be verified.",
    );
  }
  if (!Number.isFinite(order.shares) || order.shares <= 0) {
    throw new Error("Live share order refused: share quantity is invalid.");
  }
  const signed = await client.createOrder(
    {
      tokenID: order.tokenId,
      price: order.maxPrice,
      size: order.shares,
      side: Side.BUY,
    },
    {
      tickSize: order.tickSize as TickSize,
      negRisk: order.negRisk,
    },
  );
  const response = await client.postOrder(signed, OrderType.FOK);
  if (!response?.success || !response.orderID) {
    throw new Error(response?.errorMsg || "Polymarket rejected the live share order without an order ID.");
  }
  const responseStatus = String(response.status ?? "unknown").toLowerCase();
  if (responseStatus !== "matched") {
    return { orderId: response.orderID, responseStatus, filled: false };
  }
  const execution = await waitForTerminalOrderExecution(
    client,
    response.orderID,
    response.tradeIDs ?? [],
    order.confirmationTimeoutMs ?? 60_000,
  );
  return {
    orderId: response.orderID,
    responseStatus: execution.state === "confirmed" ? "confirmed" : execution.state === "failed" ? "failed" : "matched_unconfirmed",
    filled: execution.state === "confirmed",
    executedShares: execution.executedShares,
    executedPrice: execution.executedPrice,
    executedFeeEur: execution.executedFeeEur,
  };
}

/** Reconcile local pending orders against terminal trade records before risking more cash. */
export async function getLiveOrderExecutions(
  client: ClobClient,
  orderIds: string[],
): Promise<Map<string, LiveOrderExecution>> {
  const trades = await client.getTrades(undefined, false);
  return new Map(orderIds.map((orderId) => [orderId, summarizeOrderTrades(trades, orderId)]));
}

export function summarizeOrderTrades(trades: Trade[], orderId: string): LiveOrderExecution {
  const matches = trades.filter(
    (trade) =>
      trade.taker_order_id === orderId ||
      (trade.maker_orders ?? []).some((maker) => maker.order_id === orderId),
  );
  if (matches.length === 0) return { state: "absent" };
  const statuses = matches.map((trade) => normalizeTradeStatus(trade.status));
  if (statuses.some((status) => status === "FAILED")) return { state: "failed" };
  if (!statuses.every((status) => status === "CONFIRMED")) return { state: "pending" };

  const fills = matches
    .map((trade) => ({
      shares: Number(trade.size),
      price: Number(trade.price),
      feeRateBps: Number(trade.fee_rate_bps),
    }))
    .filter((fill) => Number.isFinite(fill.shares) && fill.shares > 0 && Number.isFinite(fill.price));
  if (fills.length === 0) return { state: "pending" };
  const executedShares = fills.reduce((sum, fill) => sum + fill.shares, 0);
  const executedPrice = fills.reduce((sum, fill) => sum + fill.shares * fill.price, 0) / executedShares;
  const executedFeeEur = fills.reduce(
    (sum, fill) =>
      sum + fill.shares * (fill.feeRateBps / 10_000) * fill.price * (1 - fill.price),
    0,
  );
  return {
    state: "confirmed",
    executedShares,
    executedPrice,
    executedFeeEur,
  };
}

async function waitForTerminalOrderExecution(
  client: ClobClient,
  orderId: string,
  tradeIds: string[],
  timeoutMs = 30_000,
): Promise<LiveOrderExecution> {
  const deadline = Date.now() + timeoutMs;
  let latest: LiveOrderExecution = { state: "pending" };
  while (Date.now() < deadline) {
    try {
      const trades = tradeIds.length > 0
        ? (await Promise.all(tradeIds.map((id) => client.getTrades({ id }, true)))).flat()
        : await client.getTrades(undefined, false);
      latest = summarizeOrderTrades(trades, orderId);
      if (latest.state === "confirmed" || latest.state === "failed") return latest;
    } catch {
      // A just-matched trade may not be queryable immediately. Retry until the bounded
      // deadline, then leave the local reservation pending and stop further execution.
    }
    await delay(1_000);
  }
  return latest.state === "absent" ? { state: "pending" } : latest;
}

function normalizeTradeStatus(status: string): string {
  return String(status).toUpperCase().replace(/^TRADE_STATUS_/, "");
}

function readConfiguredCredentials(config: AppConfig): ApiKeyCreds | undefined {
  const values = [
    config.polymarketApiKey,
    config.polymarketApiSecret,
    config.polymarketApiPassphrase,
  ];
  const configuredCount = values.filter(Boolean).length;
  if (configuredCount === 0) return undefined;
  if (configuredCount !== values.length) {
    throw new Error(
      "Live trading refused: configure all three Polymarket API credential fields or none of them.",
    );
  }
  return {
    key: config.polymarketApiKey!,
    secret: config.polymarketApiSecret!,
    passphrase: config.polymarketApiPassphrase!,
  };
}

function parseCollateralUnits(value: string): number {
  const raw = Number(value);
  return Number.isFinite(raw) ? raw / 1_000_000 : 0;
}
