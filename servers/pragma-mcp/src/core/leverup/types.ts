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
  // Additional info
  isHighLeveragePair: boolean;
  maxTpPercent: number; // Max take profit % (500 for <50x, 300 for >=50x)
  canAddMargin: boolean; // false for 500x/750x/1001x positions
}
