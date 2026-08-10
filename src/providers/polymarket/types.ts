export interface GammaEvent {
  id?: string;
  slug?: string;
  title?: string;
  description?: string;
  resolutionSource?: string;
  startDate?: string;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  liquidity?: number | string;
  liquidityClob?: number | string;
  volume?: number | string;
  volume24hr?: number | string;
  tags?: unknown[];
  markets?: GammaMarket[];
  [key: string]: unknown;
}

export interface GammaMarket {
  id?: string;
  question?: string;
  conditionId?: string;
  slug?: string;
  resolutionSource?: string;
  endDate?: string;
  startDate?: string;
  description?: string;
  outcomes?: string;
  outcomePrices?: string;
  volume?: string | number;
  volumeNum?: string | number;
  liquidity?: string | number;
  liquidityClob?: string | number;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  enableOrderBook?: boolean;
  acceptingOrders?: boolean;
  umaResolutionStatus?: string;
  clobTokenIds?: string;
  spread?: string | number;
  oneDayPriceChange?: string | number;
  oneWeekPriceChange?: string | number;
  lastTradePrice?: string | number;
  bestAsk?: string | number;
  negRisk?: boolean;
  ready?: boolean;
  funded?: boolean;
  restricted?: boolean;
  orderPriceMinTickSize?: string | number;
  orderMinSize?: string | number;
  feesEnabled?: boolean;
  feeSchedule?: {
    exponent?: string | number;
    rate?: string | number;
    takerOnly?: boolean;
    rebateRate?: string | number;
  };
  [key: string]: unknown;
}

export interface GeoblockResponse {
  blocked: boolean;
  ip?: string;
  country?: string;
  region?: string;
}

export interface OrderBookEntry {
  price: string;
  size: string;
}

export interface OrderBookSummary {
  market: string;
  asset_id: string;
  timestamp: string;
  hash?: string;
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
  min_order_size?: string;
  tick_size?: string;
  neg_risk?: boolean;
}
