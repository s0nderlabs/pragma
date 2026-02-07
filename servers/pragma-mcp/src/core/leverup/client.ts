import {
  createPublicClient,
  http,
  formatUnits,
  parseUnits,
  type Address
} from "viem";
import { loadConfig, getRpcUrl, isWalletConfigured } from "../../config/pragma-config.js";
import { buildViemChain } from "../../config/chains.js";
import { isX402Mode, x402HttpOptions } from "../x402/client.js";
import {
  LEVERUP_DIAMOND,
  READER_ABI,
  LIMIT_ORDER_READER_ABI,
  HOLDING_FEE_ABI,
  ACC_FUNDING_ABI,
  MARKET_INFO_ABI,
  SUPPORTED_PAIRS,
  LIQUIDATION_LOSS_RATE,
  DEGEN_MODE_LEVERAGE_OPTIONS,
  TP_LIMIT_LOW_LEVERAGE,
  TP_LIMIT_HIGH_LEVERAGE,
  TP_LEVERAGE_THRESHOLD
} from "./constants.js";
import type {
  LeverUpPosition,
  LeverUpLimitOrder,
  PositionAnalysis,
  LeverUpQuote,
  LimitOrderQuote,
  PairFundingData,
  PairMarketInfo,
} from "./types.js";
import { fetchPythPriceData } from "./pyth-client.js";
import { withRetryOrThrow } from "../utils/retry.js";

const MON_DENOMINATED_COLLATERAL = ["MON", "LVMON"] as const;

export function isMonDenominated(collateral: string): boolean {
  return (MON_DENOMINATED_COLLATERAL as readonly string[]).includes(collateral);
}

export function isDegenModeLeverage(leverage: number): boolean {
  return (DEGEN_MODE_LEVERAGE_OPTIONS as readonly number[]).includes(leverage);
}

export function getMaxTpPercent(leverage: number): number {
  return leverage < TP_LEVERAGE_THRESHOLD ? TP_LIMIT_LOW_LEVERAGE : TP_LIMIT_HIGH_LEVERAGE;
}

export function getCollateralDecimals(collateralToken: string): number {
  return collateralToken === "USDC" ? 6 : 18;
}

export async function createLeverUpClient(config: any) {
  const rpcUrl = await (getRpcUrl as any)(config);
  const chainId = config.network?.chainId || 143;
  const chain = (buildViemChain as any)(chainId, rpcUrl);

  const inX402 = await isX402Mode();
  if (inX402) {
    return createPublicClient({
      chain,
      transport: http(rpcUrl, x402HttpOptions(config) as any),
    });
  }

  return createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
}

export async function getUserPositions(
  userAddress: Address,
  pairs?: string[],
): Promise<Array<{ position: LeverUpPosition; analysis: PositionAnalysis }>> {
  const config = await loadConfig();
  if (!config || !isWalletConfigured(config)) {
    throw new Error("Wallet not configured.");
  }

  const client = await createLeverUpClient(config);
  const allPositions: Array<{ position: LeverUpPosition; analysis: PositionAnalysis }> = [];

  const pairsToQuery = pairs
    ? SUPPORTED_PAIRS.filter(p => pairs.includes(p.pair))
    : SUPPORTED_PAIRS;

  for (const pairMetadata of pairsToQuery) {
    const rawPositions = await withRetryOrThrow(
      async () => client.readContract({
        address: LEVERUP_DIAMOND,
        abi: READER_ABI as any,
        functionName: "getPositionsV2",
        args: [userAddress, pairMetadata.pairBase]
      }),
      { operationName: `leverup-get-positions-${pairMetadata.pair}` }
    );

    if (rawPositions && (rawPositions as any[]).length > 0) {
      const pythData = await fetchPythPriceData([pairMetadata.pythId]);
      const assetPriceData = pythData.parsed?.[0]?.price;
      if (!assetPriceData) continue;
      
      const currentPrice = BigInt(assetPriceData.price) * (10n ** BigInt(18 + assetPriceData.expo));

      for (const pos of (rawPositions as any[])) {
        const typedPos = pos as unknown as LeverUpPosition;
        const analysis = analyzePosition(typedPos, currentPrice);
        allPositions.push({
          position: typedPos,
          analysis
        });
      }
    }
  }

  return allPositions;
}

export async function getLeverUpQuote(
  symbol: string,
  isLong: boolean,
  marginAmount: string,
  leverage: number,
  collateralToken = "MON"
): Promise<LeverUpQuote> {
  const pairMetadata = SUPPORTED_PAIRS.find(p => p.pair === `${symbol}/USD` || p.pair === symbol);
  if (!pairMetadata) {
    throw new Error(`Unsupported pair: ${symbol}`);
  }

  const priceIds = [pairMetadata.pythId];
  const monMetadata = SUPPORTED_PAIRS.find(p => p.pair === "MON/USD");
  if (isMonDenominated(collateralToken) && monMetadata) {
    priceIds.push(monMetadata.pythId);
  }

  const pythData = await fetchPythPriceData(priceIds);

  const assetPriceData = pythData.parsed?.find(p => `0x${p.id}` === pairMetadata.pythId)?.price;
  if (!assetPriceData) throw new Error("Could not fetch asset price from Pyth");

  const entryPrice = BigInt(assetPriceData.price) * (10n ** BigInt(18 + assetPriceData.expo));

  let marginUsd: bigint;
  if (isMonDenominated(collateralToken)) {
    const monPriceData = pythData.parsed?.find(p => `0x${p.id}` === monMetadata?.pythId)?.price;
    if (!monPriceData) throw new Error("Could not fetch MON price from Pyth");
    const monPrice = BigInt(monPriceData.price) * (10n ** BigInt(18 + monPriceData.expo));
    const marginWei = parseUnits(marginAmount, 18);
    marginUsd = marginWei * monPrice / (10n ** 18n);
  } else {
    marginUsd = parseUnits(marginAmount, 18);
  }

  const positionValueUsd = marginUsd * BigInt(leverage);
  const qty = positionValueUsd * (10n ** 10n) / entryPrice; 

  const openFeeUsd = positionValueUsd * 45n / 100000n;

  const collateralFactor = (marginUsd * LIQUIDATION_LOSS_RATE) / 10000n;
  const buffer = collateralFactor - openFeeUsd;
  
  let liqPrice: bigint;
  if (isLong) {
    liqPrice = entryPrice - (buffer * (10n ** 10n) / qty);
  } else {
    liqPrice = entryPrice + (buffer * (10n ** 10n) / qty);
  }

  const distance = isLong 
    ? (entryPrice - liqPrice) * 10000n / entryPrice
    : (liqPrice - entryPrice) * 10000n / entryPrice;

  const marginUsdFormatted = formatUnits(marginUsd, 18);
  const positionValueFormatted = Number(formatUnits(positionValueUsd, 18));
  const marginUsdNum = Number(marginUsdFormatted);

  const MIN_NOTIONAL_USD = 200;
  const MIN_MARGIN_USD = 10;

  const warnings: string[] = [];
  let hasHardFailure = false;

  if (positionValueFormatted < MIN_NOTIONAL_USD) {
    warnings.push(`Position size is below the protocol minimum of $200.00 USD (Current: $${positionValueFormatted.toFixed(2)}). This will be rejected by the contract.`);
    hasHardFailure = true;
  }
  if (marginUsdNum < MIN_MARGIN_USD) {
    warnings.push(`Margin is below the recommended $10.00 USD (Current: $${marginUsdNum.toFixed(2)}). This may work but is not recommended.`);
  }

  if (pairMetadata.isHighLeverage && !isDegenModeLeverage(leverage)) {
    warnings.push(
      `${pairMetadata.pair} is a high-leverage (Zero-Fee) pair that ONLY supports ${DEGEN_MODE_LEVERAGE_OPTIONS.join(', ')}x leverage. ` +
      `Current leverage (${leverage}x) will be rejected by the protocol.`
    );
    hasHardFailure = true;
  }

  return {
    symbol: pairMetadata.pair,
    isLong,
    leverage,
    entryPrice: Number(formatUnits(entryPrice, 18)).toFixed(2),
    marginAmount: `${marginAmount} ${collateralToken}`,
    marginUsd: marginUsdNum.toFixed(2),
    positionSize: formatUnits(qty, 10),
    positionValueUsd: positionValueFormatted.toFixed(2),
    liqPrice: Number(formatUnits(liqPrice, 18)).toFixed(2),
    openFee: Number(formatUnits(openFeeUsd, 18)).toFixed(4),
    healthFactor: Math.max(0, Math.min(100, Number(distance))),
    distanceToLiq: `${(Number(distance) / 100).toFixed(2)}%`,
    meetsMinimums: !hasHardFailure,
    warnings,
    isHighLeveragePair: pairMetadata.isHighLeverage ?? false,
    maxTpPercent: getMaxTpPercent(leverage),
    canAddMargin: !isDegenModeLeverage(leverage),
  };
}

function analyzePosition(pos: LeverUpPosition, currentPrice: bigint): PositionAnalysis {
  const { isLong, entryPrice, qty, margin, openFee, holdingFee, fundingFee } = pos;

  const pnl = isLong
    ? (currentPrice - entryPrice) * qty / (10n ** 10n)
    : (entryPrice - currentPrice) * qty / (10n ** 10n);

  const totalFees = openFee + holdingFee + fundingFee;
  const netPnl = pnl - totalFees;

  const collateralFactor = (margin * LIQUIDATION_LOSS_RATE) / 10000n;
  const buffer = collateralFactor - totalFees;

  const liqPrice = isLong
    ? entryPrice - (buffer * (10n ** 10n) / qty)
    : entryPrice + (buffer * (10n ** 10n) / qty);

  const distance = isLong
    ? (currentPrice - liqPrice) * 10000n / currentPrice
    : (liqPrice - currentPrice) * 10000n / currentPrice;

  return {
    unrealizedPnL: `$${Number(formatUnits(netPnl, 18)).toFixed(2)}`,
    pnlPercentage: `${(Number(netPnl * 10000n / margin) / 100).toFixed(2)}%`,
    liqPrice: Number(formatUnits(liqPrice, 18)).toFixed(2),
    distanceToLiq: `${(Number(distance) / 100).toFixed(2)}%`,
    healthFactor: Math.max(0, Math.min(100, Number(distance))),
    isLiquidatable: distance <= 0,
  };
}

// MARK: - Limit Orders

/** Get all pending (unfilled) limit orders for a user across all supported pairs. */
export async function getUserLimitOrders(
  userAddress: Address
): Promise<LeverUpLimitOrder[]> {
  const config = await loadConfig();
  if (!config || !isWalletConfigured(config)) {
    throw new Error("Wallet not configured.");
  }

  const client = await createLeverUpClient(config);

  // Fetch all pairs in parallel (Monad doesn't have Multicall3)
  const results = await Promise.all(
    SUPPORTED_PAIRS.map(async (pairMetadata) => {
      try {
        const rawOrders = await withRetryOrThrow(
          async () => client.readContract({
            address: LEVERUP_DIAMOND,
            abi: LIMIT_ORDER_READER_ABI as any,
            functionName: "getLimitOrders",
            args: [userAddress, pairMetadata.pairBase]
          }),
          { operationName: `leverup-get-limit-orders-${pairMetadata.pair}` }
        );

        if (rawOrders && (rawOrders as any[]).length > 0) {
          return (rawOrders as any[]).map(order => ({
            ...order,
            pair: pairMetadata.pair,
          })) as LeverUpLimitOrder[];
        }
        return [];
      } catch {
        // If one pair fails, don't break the whole query
        return [];
      }
    })
  );

  return results.flat();
}

/** Get a quote for a limit order with trigger price validation. */
export async function getLimitOrderQuote(
  symbol: string,
  isLong: boolean,
  marginAmount: string,
  leverage: number,
  triggerPrice: string,
  collateralToken = "MON"
): Promise<LimitOrderQuote> {
  // Get base quote calculations
  const baseQuote = await getLeverUpQuote(symbol, isLong, marginAmount, leverage, collateralToken);

  const triggerPriceBigInt = parseUnits(triggerPrice, 18);
  const currentPriceBigInt = parseUnits(baseQuote.entryPrice, 18);

  let isTriggerValid: boolean;
  let triggerValidationMessage: string;

  if (isLong) {
    isTriggerValid = triggerPriceBigInt < currentPriceBigInt;
    if (isTriggerValid) {
      const diffPercent = ((currentPriceBigInt - triggerPriceBigInt) * 10000n / currentPriceBigInt);
      triggerValidationMessage = `Valid: Trigger price is ${(Number(diffPercent) / 100).toFixed(2)}% below current market.`;
    } else {
      triggerValidationMessage = `Invalid: Long limit orders require trigger price BELOW current market ($${baseQuote.entryPrice}).`;
    }
  } else {
    isTriggerValid = triggerPriceBigInt > currentPriceBigInt;
    if (isTriggerValid) {
      const diffPercent = ((triggerPriceBigInt - currentPriceBigInt) * 10000n / currentPriceBigInt);
      triggerValidationMessage = `Valid: Trigger price is ${(Number(diffPercent) / 100).toFixed(2)}% above current market.`;
    } else {
      triggerValidationMessage = `Invalid: Short limit orders require trigger price ABOVE current market ($${baseQuote.entryPrice}).`;
    }
  }

  const warnings = [...baseQuote.warnings];
  if (!isTriggerValid) {
    warnings.unshift(triggerValidationMessage);
  }

  return {
    ...baseQuote,
    triggerPrice,
    triggerPriceUsd: `$${Number(triggerPrice).toFixed(2)}`,
    currentPrice: baseQuote.entryPrice,
    isTriggerValid,
    triggerValidationMessage,
    warnings,
    meetsMinimums: baseQuote.meetsMinimums && isTriggerValid,
  };
}

// MARK: - Funding Rates

function formatHoldingFeeRate(perSecond: bigint, seconds: bigint): string {
  const periodRate = perSecond * seconds;
  return `${(Number(periodRate) / 1e10 * 100).toFixed(6)}%`;
}

function determineFundingDirection(acc: bigint): "longs pay" | "shorts pay" | "neutral" {
  if (acc > 0n) return "longs pay";
  if (acc < 0n) return "shorts pay";
  return "neutral";
}

function parseMarketInfo(raw: unknown): PairMarketInfo {
  const arr = raw as readonly [Address, bigint, bigint, bigint, bigint, bigint];
  return {
    longQty: arr[1],
    shortQty: arr[2],
    currentFundingFeePerSec: arr[5],
  };
}

function formatFundingRate(perSecond: bigint, seconds: bigint): string {
  const periodRate = perSecond * seconds;
  const abs = periodRate < 0n ? -periodRate : periodRate;
  const sign = periodRate < 0n ? "-" : "+";
  return `${sign}${(Number(abs) / 1e18 * 100).toFixed(4)}%`;
}

function formatMarketInfo(info: PairMarketInfo): NonNullable<PairFundingData["marketInfo"]> {
  const { longQty, shortQty, currentFundingFeePerSec } = info;

  const longFormatted = formatUnits(longQty, 10);
  const shortFormatted = formatUnits(shortQty, 10);

  let oiRatio: string;
  let dominantSide: "longs" | "shorts" | "balanced";

  if (longQty === 0n && shortQty === 0n) {
    oiRatio = "0:0";
    dominantSide = "balanced";
  } else if (shortQty === 0n) {
    oiRatio = "100% longs";
    dominantSide = "longs";
  } else if (longQty === 0n) {
    oiRatio = "100% shorts";
    dominantSide = "shorts";
  } else {
    const ratio = Number(longQty) / Number(shortQty);
    if (ratio > 1.1) {
      oiRatio = `${ratio.toFixed(2)}:1 long-heavy`;
      dominantSide = "longs";
    } else if (ratio < 0.9) {
      oiRatio = `1:${(1 / ratio).toFixed(2)} short-heavy`;
      dominantSide = "shorts";
    } else {
      oiRatio = `${ratio.toFixed(2)}:1 balanced`;
      dominantSide = "balanced";
    }
  }

  return {
    longQty: longFormatted,
    shortQty: shortFormatted,
    oiRatio,
    dominantSide,
    currentFundingRate8h: formatFundingRate(currentFundingFeePerSec, 28800n),
    currentFundingRate1h: formatFundingRate(currentFundingFeePerSec, 3600n),
    fundingRateDirection: determineFundingDirection(currentFundingFeePerSec),
  };
}

export async function getFundingRates(
  symbol?: string
): Promise<PairFundingData[]> {
  const config = await loadConfig();
  if (!config) {
    throw new Error("Config not loaded. Run setup_wallet first.");
  }

  const client = await createLeverUpClient(config);

  let pairs = SUPPORTED_PAIRS.filter((p) => !p.isHighLeverage);

  if (symbol) {
    const normalized = symbol.toUpperCase().trim();
    pairs = pairs.filter(
      (p) =>
        p.pair.toUpperCase().startsWith(normalized) ||
        p.pair.toUpperCase() === `${normalized}/USD` ||
        p.pair.toUpperCase().includes(normalized)
    );

    if (pairs.length === 0) {
      throw new Error(
        `No LeverUp pair found for '${symbol}'. Use leverup_list_pairs to see available markets.`
      );
    }
  }

  const settled = await Promise.all(
    pairs.map(async (pairMetadata): Promise<PairFundingData | null> => {
      try {
        const [longRate, shortRate, accFunding, marketInfoRaw] = await Promise.all([
          withRetryOrThrow(
            async () =>
              client.readContract({
                address: LEVERUP_DIAMOND,
                abi: HOLDING_FEE_ABI,
                functionName: "getPairHoldingFeeRate",
                args: [pairMetadata.pairBase as Address, true],
              }),
            { operationName: `funding-long-${pairMetadata.pair}` }
          ),
          withRetryOrThrow(
            async () =>
              client.readContract({
                address: LEVERUP_DIAMOND,
                abi: HOLDING_FEE_ABI,
                functionName: "getPairHoldingFeeRate",
                args: [pairMetadata.pairBase as Address, false],
              }),
            { operationName: `funding-short-${pairMetadata.pair}` }
          ),
          withRetryOrThrow(
            async () =>
              client.readContract({
                address: LEVERUP_DIAMOND,
                abi: ACC_FUNDING_ABI,
                functionName: "lastLongAccFundingFeePerShare",
                args: [pairMetadata.pairBase as Address],
              }),
            { operationName: `acc-funding-${pairMetadata.pair}` }
          ),
          withRetryOrThrow(
            async () =>
              client.readContract({
                address: LEVERUP_DIAMOND,
                abi: MARKET_INFO_ABI,
                functionName: "getMarketInfo",
                args: [pairMetadata.pairBase as Address],
              }),
            { operationName: `market-info-${pairMetadata.pair}` }
          ).catch(() => null),
        ]);

        const longPerSecond = longRate as bigint;
        const shortPerSecond = shortRate as bigint;
        const accFundingValue = accFunding as bigint;

        const result: PairFundingData = {
          symbol: pairMetadata.pair,
          category: pairMetadata.category,
          pairBase: pairMetadata.pairBase,
          holdingFeeRatePerSecond: {
            long: longPerSecond,
            short: shortPerSecond,
          },
          holdingFeeRate8h: {
            long: formatHoldingFeeRate(longPerSecond, 28800n),
            short: formatHoldingFeeRate(shortPerSecond, 28800n),
          },
          holdingFeeRate1h: {
            long: formatHoldingFeeRate(longPerSecond, 3600n),
            short: formatHoldingFeeRate(shortPerSecond, 3600n),
          },
          accumulatedFunding: accFundingValue,
          fundingDirection: determineFundingDirection(accFundingValue),
        };

        if (marketInfoRaw) {
          const info = parseMarketInfo(marketInfoRaw);
          result.marketInfo = formatMarketInfo(info);
        }

        return result;
      } catch {
        return null;
      }
    })
  );

  const results = settled.filter((r): r is PairFundingData => r !== null);

  results.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.symbol.localeCompare(b.symbol);
  });

  return results;
}
