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
  SUPPORTED_PAIRS,
  LIQUIDATION_LOSS_RATE,
  DEGEN_MODE_LEVERAGE_OPTIONS,
  TP_LIMIT_LOW_LEVERAGE,
  TP_LIMIT_HIGH_LEVERAGE,
  TP_LEVERAGE_THRESHOLD
} from "./constants.js";
import {
  LeverUpPosition,
  PositionAnalysis,
  LeverUpQuote
} from "./types.js";
import { fetchPythPriceData } from "./pyth-client.js";
import { withRetryOrThrow } from "../utils/retry.js";

// Collateral types that are MON-denominated (require MON/USD price conversion)
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
  const chainId = (config as any).network?.chainId || 143;
  const chain = (buildViemChain as any)(chainId);

  const inX402 = await isX402Mode();
  
  if (inX402) {
    const options = x402HttpOptions(config);
    return createPublicClient({
      chain,
      transport: http(rpcUrl, options as any),
    });
  }

  return createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
}

export async function getUserPositions(
  userAddress: Address
): Promise<Array<{ position: LeverUpPosition; analysis: PositionAnalysis }>> {
  const config = await loadConfig();
  if (!config || !isWalletConfigured(config)) {
    throw new Error("Wallet not configured.");
  }

  const client = await createLeverUpClient(config);
  const allPositions: Array<{ position: LeverUpPosition; analysis: PositionAnalysis }> = [];

  for (const pairMetadata of SUPPORTED_PAIRS) {
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
  // Hard limit: Position size must be >= $200 USD (enforced at contract level)
  // Soft guideline: Margin >= $10 USD (recommended but not strictly enforced)
  const minMarginUsd = 10; // Soft guideline
  const minNotionalUsd = 200; // Hard limit

  const warnings: string[] = [];
  if (Number(formatUnits(positionValueUsd, 18)) < minNotionalUsd) {
    warnings.push(`Position size is below the protocol minimum of $200.00 USD (Current: $${Number(formatUnits(positionValueUsd, 18)).toFixed(2)}). This will be rejected by the contract.`);
  }
  if (Number(marginUsdFormatted) < minMarginUsd) {
    warnings.push(`Margin is below the recommended $10.00 USD (Current: $${Number(marginUsdFormatted).toFixed(2)}). This may work but is not recommended.`);
  }

  if (pairMetadata.isHighLeverage && !isDegenModeLeverage(leverage)) {
    warnings.push(
      `${pairMetadata.pair} is a high-leverage (Zero-Fee) pair that ONLY supports ${DEGEN_MODE_LEVERAGE_OPTIONS.join(', ')}x leverage. ` +
      `Current leverage (${leverage}x) will be rejected by the protocol.`
    );
  }

  return {
    symbol: pairMetadata.pair,
    isLong,
    leverage,
    entryPrice: Number(formatUnits(entryPrice, 18)).toFixed(2),
    marginAmount: `${marginAmount} ${collateralToken}`,
    marginUsd: Number(marginUsdFormatted).toFixed(2),
    positionSize: formatUnits(qty, 10),
    positionValueUsd: Number(formatUnits(positionValueUsd, 18)).toFixed(2),
    liqPrice: Number(formatUnits(liqPrice, 18)).toFixed(2),
    openFee: Number(formatUnits(openFeeUsd, 18)).toFixed(4),
    healthFactor: Math.max(0, Math.min(100, Number(distance))),
    distanceToLiq: `${(Number(distance) / 100).toFixed(2)}%`,
    meetsMinimums: warnings.length === 0,
    warnings,
    isHighLeveragePair: pairMetadata.isHighLeverage ?? false,
    maxTpPercent: getMaxTpPercent(leverage),
    canAddMargin: !isDegenModeLeverage(leverage),
  };
}

function analyzePosition(pos: LeverUpPosition, currentPrice: bigint): PositionAnalysis {
  const isLong = pos.isLong;
  const entryPrice = pos.entryPrice;
  const qty = pos.qty; 
  const margin = pos.margin; 

  let pnl: bigint;
  if (isLong) {
    pnl = (currentPrice - entryPrice) * qty / (10n ** 10n);
  } else {
    pnl = (entryPrice - currentPrice) * qty / (10n ** 10n);
  }

  const totalFees = pos.openFee + pos.holdingFee + pos.fundingFee;
  const netPnl = pnl - totalFees;

  const collateralFactor = (margin * LIQUIDATION_LOSS_RATE) / 10000n;
  const buffer = collateralFactor - totalFees;
  
  let liqPrice: bigint;
  if (isLong) {
    liqPrice = entryPrice - (buffer * (10n ** 10n) / qty);
  } else {
    liqPrice = entryPrice + (buffer * (10n ** 10n) / qty);
  }

  const distance = isLong 
    ? (currentPrice - liqPrice) * 10000n / currentPrice
    : (liqPrice - currentPrice) * 10000n / currentPrice;

  return {
    unrealizedPnL: `$${Number(formatUnits(netPnl, 18)).toFixed(2)}`,
    pnlPercentage: `${(Number(netPnl * 10000n / margin) / 100).toFixed(2)}%`,
    liqPrice: Number(formatUnits(liqPrice, 18)).toFixed(2),
    distanceToLiq: `${(Number(distance) / 100).toFixed(2)}%`,
    healthFactor: Math.max(0, Math.min(100, Number(distance))),
    isLiquidatable: distance <= 0
  };
}
