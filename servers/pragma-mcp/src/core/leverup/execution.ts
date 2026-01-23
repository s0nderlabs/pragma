import { 
  encodeFunctionData, 
  getAddress, 
  type Address, 
  type Hex 
} from "viem";
import {
  LEVERUP_DIAMOND,
  TRADING_PORTAL_ABI,
  LIMIT_ORDER_ABI,
  SUPPORTED_PAIRS,
  PYTH_CONTRACT,
  PYTH_ABI,
  USDC_ADDRESS,
  LVUSD_ADDRESS,
  LVMON_ADDRESS,
  WMON_ADDRESS
} from "./constants.js";
import { fetchPythPriceData } from "./pyth-client.js";
import { createLeverUpClient } from "./client.js";
import { withRetryOrThrow } from "../utils/retry.js";

export type CollateralToken = "MON" | "USDC" | "LVUSD" | "LVMON";

export interface OpenTradeParams {
  symbol: string;
  isLong: boolean;
  amountIn: bigint;
  leverage: number;
  qty: bigint;
  price: bigint;
  stopLoss?: bigint;
  takeProfit?: bigint;
  collateralToken: CollateralToken;
}

export async function executeOpenTrade(
  params: OpenTradeParams,
  config: any
) {
  const pairMetadata = SUPPORTED_PAIRS.find(p => p.pair === `${params.symbol}/USD` || p.pair === params.symbol);
  if (!pairMetadata) throw new Error(`Unsupported pair: ${params.symbol}`);

  const client = await createLeverUpClient(config);

  const priceIds = [pairMetadata.pythId];
  const monMetadata = SUPPORTED_PAIRS.find(p => p.pair === "MON/USD");
  // Fetch MON price for MON or LVMON collateral
  if ((params.collateralToken === "MON" || params.collateralToken === "LVMON") && monMetadata) {
    priceIds.push(monMetadata.pythId);
  }

  const pythUpdate = await fetchPythPriceData(priceIds);
  const priceUpdateData = pythUpdate.binary.data.map(d => d.startsWith("0x") ? d : `0x${d}` as Hex);

  const updateFee = await withRetryOrThrow(
    async () => client.readContract({
      address: PYTH_CONTRACT,
      abi: PYTH_ABI,
      functionName: "getUpdateFee",
      args: [priceUpdateData]
    }),
    { operationName: "leverup-pyth-fee" }
  );

  // Determine tokenIn and lvToken based on collateral type
  // See: https://developer-docs.leverup.xyz/guide/lv-token.html
  let tokenIn: Address;
  let lvToken: Address;

  switch (params.collateralToken) {
    case "USDC":
      tokenIn = USDC_ADDRESS;
      lvToken = LVUSD_ADDRESS;
      break;
    case "LVUSD":
      tokenIn = LVUSD_ADDRESS;
      lvToken = LVUSD_ADDRESS;
      break;
    case "LVMON":
      tokenIn = LVMON_ADDRESS;
      lvToken = LVMON_ADDRESS;
      break;
    case "MON":
    default:
      // For native MON: use WMON as tokenIn but send native MON as msg.value
      // The LeverUp contract internally wraps MON to WMON
      // Verified from frontend tx: 0x35a55ef9be400cbf6aacc3cb7154fdd1c543b714fb8721e6f52ce9ea934735b8
      tokenIn = WMON_ADDRESS;
      lvToken = LVMON_ADDRESS;
      break;
  }

  const openFeeBps = 45n;
  const openFee = (params.amountIn * BigInt(params.leverage) * openFeeBps) / 100000n;
  const totalAmountIn = params.amountIn + openFee;

  const openData = {
    pairBase: getAddress(pairMetadata.pairBase),
    isLong: params.isLong,
    tokenIn,
    lvToken,
    amountIn: totalAmountIn,
    qty: params.qty,
    price: params.price,
    stopLoss: params.stopLoss || 0n,
    takeProfit: params.takeProfit || 0n,
    broker: 0
  };

  const calldata = encodeFunctionData({
    abi: TRADING_PORTAL_ABI,
    functionName: "openMarketTradeWithPyth",
    args: [openData, priceUpdateData]
  });

  // For native MON: msg.value = Pyth fee + collateral amount (native MON is payable)
  // For ERC20 collaterals: msg.value is only the Pyth fee
  const isNativeMon = params.collateralToken === "MON";
  const msgValue = isNativeMon ? updateFee + totalAmountIn : updateFee;

  return {
    to: LEVERUP_DIAMOND,
    data: calldata,
    value: msgValue,
    tokenIn,
    amountIn: totalAmountIn
  };
}

export async function executeCloseTrade(tradeHash: Hex) {
  const calldata = encodeFunctionData({
    abi: TRADING_PORTAL_ABI,
    functionName: "closeTrade",
    args: [tradeHash]
  });

  return {
    to: LEVERUP_DIAMOND,
    data: calldata,
    value: 0n
  };
}

/**
 * Build execution data for adding margin to a position.
 * Uses addMargin(bytes32,address,uint96) - selector 0xe1379570
 *
 * NOTE: Only ADDING margin is supported. The contract does not allow margin withdrawal.
 *
 * @param tradeHash - Position hash
 * @param tokenAddress - Address of the margin token (WMON for MON collateral, USDC/LVUSD/LVMON for others)
 * @param amount - Amount to add (in token's native decimals)
 * @param isNativeMon - Whether using native MON (affects msg.value)
 */
export function executeAddMargin(
  tradeHash: Hex,
  tokenAddress: Address,
  amount: bigint,
  isNativeMon: boolean
) {
  const calldata = encodeFunctionData({
    abi: TRADING_PORTAL_ABI,
    functionName: "addMargin",
    args: [tradeHash, tokenAddress, amount]
  });

  // For native MON: send amount as msg.value
  // For ERC20: msg.value is 0 (already approved)
  return {
    to: LEVERUP_DIAMOND,
    data: calldata,
    value: isNativeMon ? amount : 0n,
    tokenIn: tokenAddress,
    amountIn: amount
  };
}

/**
 * Build execution data for updating TP/SL on a position.
 * Uses updateTradeTpAndSl(bytes32,uint128,uint128) - selector 0x2f745df6
 *
 * This is a nonpayable function - no msg.value required.
 *
 * @param tradeHash - Position hash
 * @param takeProfit - New take profit price (18 decimals, 0 to disable)
 * @param stopLoss - New stop loss price (18 decimals, 0 to disable)
 */
export function executeUpdateTpSl(
  tradeHash: Hex,
  takeProfit: bigint,
  stopLoss: bigint
) {
  const calldata = encodeFunctionData({
    abi: TRADING_PORTAL_ABI,
    functionName: "updateTradeTpAndSl",
    args: [tradeHash, takeProfit, stopLoss]
  });

  return {
    to: LEVERUP_DIAMOND,
    data: calldata,
    value: 0n
  };
}

// ========== LIMIT ORDER EXECUTION ==========

export interface OpenLimitOrderParams {
  symbol: string;
  isLong: boolean;
  amountIn: bigint;
  leverage: number;
  qty: bigint;
  triggerPrice: bigint; // Price at which order fills
  stopLoss?: bigint;
  takeProfit?: bigint;
  collateralToken: CollateralToken;
}

/**
 * Build execution data for opening a limit order.
 * Same as market order but uses triggerPrice instead of slippage protection price.
 *
 * Trigger price rules:
 * - Long orders: trigger when price drops BELOW limit price
 * - Short orders: trigger when price rises ABOVE limit price
 */
export async function executeOpenLimitOrder(
  params: OpenLimitOrderParams,
  config: any
) {
  const pairMetadata = SUPPORTED_PAIRS.find(p => p.pair === `${params.symbol}/USD` || p.pair === params.symbol);
  if (!pairMetadata) throw new Error(`Unsupported pair: ${params.symbol}`);

  const client = await createLeverUpClient(config);

  const priceIds = [pairMetadata.pythId];
  const monMetadata = SUPPORTED_PAIRS.find(p => p.pair === "MON/USD");
  // Fetch MON price for MON or LVMON collateral
  if ((params.collateralToken === "MON" || params.collateralToken === "LVMON") && monMetadata) {
    priceIds.push(monMetadata.pythId);
  }

  const pythUpdate = await fetchPythPriceData(priceIds);
  const priceUpdateData = pythUpdate.binary.data.map(d => d.startsWith("0x") ? d : `0x${d}` as Hex);

  const updateFee = await withRetryOrThrow(
    async () => client.readContract({
      address: PYTH_CONTRACT,
      abi: PYTH_ABI,
      functionName: "getUpdateFee",
      args: [priceUpdateData]
    }),
    { operationName: "leverup-limit-pyth-fee" }
  );

  // Determine tokenIn and lvToken based on collateral type
  let tokenIn: Address;
  let lvToken: Address;

  switch (params.collateralToken) {
    case "USDC":
      tokenIn = USDC_ADDRESS;
      lvToken = LVUSD_ADDRESS;
      break;
    case "LVUSD":
      tokenIn = LVUSD_ADDRESS;
      lvToken = LVUSD_ADDRESS;
      break;
    case "LVMON":
      tokenIn = LVMON_ADDRESS;
      lvToken = LVMON_ADDRESS;
      break;
    case "MON":
    default:
      // For native MON: use WMON as tokenIn but send native MON as msg.value
      // The LeverUp contract internally wraps MON to WMON
      // Verified from frontend tx: 0x35a55ef9be400cbf6aacc3cb7154fdd1c543b714fb8721e6f52ce9ea934735b8
      tokenIn = WMON_ADDRESS;
      lvToken = LVMON_ADDRESS;
      break;
  }

  const openFeeBps = 45n;
  const openFee = (params.amountIn * BigInt(params.leverage) * openFeeBps) / 100000n;
  const totalAmountIn = params.amountIn + openFee;

  const openData = {
    pairBase: getAddress(pairMetadata.pairBase),
    isLong: params.isLong,
    tokenIn,
    lvToken,
    amountIn: totalAmountIn,
    qty: params.qty,
    price: params.triggerPrice, // TRIGGER price for limit orders
    stopLoss: params.stopLoss || 0n,
    takeProfit: params.takeProfit || 0n,
    broker: 0
  };

  const calldata = encodeFunctionData({
    abi: LIMIT_ORDER_ABI,
    functionName: "openLimitOrderWithPyth",
    args: [openData, priceUpdateData]
  });

  // For native MON: msg.value = Pyth fee + collateral amount (native MON is payable)
  // For ERC20 collaterals: msg.value is only the Pyth fee
  const isNativeMon = params.collateralToken === "MON";
  const msgValue = isNativeMon ? updateFee + totalAmountIn : updateFee;

  return {
    to: LEVERUP_DIAMOND,
    data: calldata,
    value: msgValue,
    tokenIn,
    amountIn: totalAmountIn
  };
}

/**
 * Build execution data for canceling a single limit order.
 * Note: This is a nonpayable function (no value required).
 */
export function executeCancelLimitOrder(orderHash: Hex) {
  const calldata = encodeFunctionData({
    abi: LIMIT_ORDER_ABI,
    functionName: "cancelLimitOrder",
    args: [orderHash]
  });

  return {
    to: LEVERUP_DIAMOND,
    data: calldata,
    value: 0n
  };
}

/**
 * Build execution data for canceling multiple limit orders in a single transaction.
 * Note: This is a nonpayable function (no value required).
 */
export function executeBatchCancelLimitOrders(orderHashes: Hex[]) {
  const calldata = encodeFunctionData({
    abi: LIMIT_ORDER_ABI,
    functionName: "batchCancelLimitOrders",
    args: [orderHashes]
  });

  return {
    to: LEVERUP_DIAMOND,
    data: calldata,
    value: 0n
  };
}
