import { type Address, type Hex } from "viem";

export interface LeverUpPosition {
  positionHash: Hex;
  pair: string;
  pairBase: Address;
  tokenIn: Address;
  marginToken: Address;
  isLong: boolean;
  margin: bigint;
  qty: bigint;
  entryPrice: bigint;
  stopLoss: bigint;
  takeProfit: bigint;
  openFee: bigint;
  executionFee: bigint;
  fundingFee: bigint;
  timestamp: number;
  holdingFee: bigint;
}

export type LeverUpCategory = "Crypto" | "Indices" | "Stocks" | "Forex" | "Commodities";

export interface LeverUpPairMetadata {
  pair: string;
  pairBase: Address;
  pythId: Hex;
  category: LeverUpCategory;
  isHighLeverage?: boolean;
}

export interface PythUpdateResponse {
  binary: {
    data: Hex[];
  };
  parsed?: Array<{
    id: string;
    price: {
      price: string;
      conf: string;
      expo: number;
      publish_time: number;
    };
  }>;
}

export interface PositionAnalysis {
  unrealizedPnL: string;
  pnlPercentage: string;
  liqPrice: string;
  distanceToLiq: string;
  healthFactor: number;
  isLiquidatable: boolean;
}

export interface LeverUpQuote {
  symbol: string;
  isLong: boolean;
  leverage: number;
  entryPrice: string;
  marginAmount: string;
  marginUsd: string;
  positionSize: string;
  positionValueUsd: string;
  liqPrice: string;
  openFee: string;
  healthFactor: number;
  distanceToLiq: string;
  meetsMinimums: boolean;
  warnings: string[];
  isHighLeveragePair: boolean;
  maxTpPercent: number;
  canAddMargin: boolean;
}

// MARK: - Funding Rates

export interface PairFundingData {
  symbol: string;
  category: LeverUpCategory;
  pairBase: Address;
  holdingFeeRatePerSecond: {
    long: bigint;
    short: bigint;
  };
  holdingFeeRate8h: {
    long: string;
    short: string;
  };
  holdingFeeRate1h: {
    long: string;
    short: string;
  };
  accumulatedFunding: bigint;
  fundingDirection: "longs pay" | "shorts pay" | "neutral";
}

// MARK: - Limit Orders

export interface LeverUpLimitOrder {
  orderHash: Hex;
  pair: string;
  pairBase: Address;
  isLong: boolean;
  tokenIn: Address;
  lvToken: Address;
  amountIn: bigint;
  qty: bigint;
  limitPrice: bigint;
  stopLoss: bigint;
  takeProfit: bigint;
  broker: number;
  timestamp: number;
}

export interface LimitOrderParams {
  symbol: string;
  isLong: boolean;
  amountIn: bigint;
  leverage: number;
  qty: bigint;
  triggerPrice: bigint;
  stopLoss?: bigint;
  takeProfit?: bigint;
  collateralToken: "MON" | "USDC" | "LVUSD" | "LVMON";
}

export interface LimitOrderQuote extends LeverUpQuote {
  triggerPrice: string;
  triggerPriceUsd: string;
  currentPrice: string;
  isTriggerValid: boolean;
  triggerValidationMessage: string;
}
