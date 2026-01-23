import { withRetryOrThrow } from "../utils/retry.js";
import {
  PYTH_BENCHMARK_URL,
  SYMBOL_TO_PYTH,
  RESOLUTION_LABELS,
  RESOLUTION_SECONDS,
  type Resolution,
} from "./constants.js";
import type { PythBenchmarkResponse, ChartData, OHLCVCandle } from "./types.js";

/**
 * Format a USD price with appropriate precision based on magnitude
 *
 * @param price - The price value to format
 * @param includeDollarSign - Whether to prefix with $ (default: false)
 * @returns Formatted price string
 *
 * Formatting rules:
 * - >= 1000: Uses locale formatting with commas (e.g., "1,234.56")
 * - >= 1: Two decimal places (e.g., "42.50")
 * - < 1: Six decimal places (e.g., "0.000123")
 */
export function formatUsdPrice(price: number, includeDollarSign = false): string {
  let formatted: string;

  if (price >= 1000) {
    formatted = price.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  } else if (price >= 1) {
    formatted = price.toFixed(2);
  } else {
    formatted = price.toFixed(6);
  }

  return includeDollarSign ? `$${formatted}` : formatted;
}

/**
 * Resolve user-friendly symbol to Pyth Benchmark format
 *
 * Handles:
 * 1. Direct lookup in mapping (case-insensitive)
 * 2. Already in Pyth format (Crypto.X/USD, Equity.US.X/USD, etc.)
 * 3. Pair format like "BTC/USD" -> Crypto.BTC/USD
 * 4. Fallback: assume crypto namespace for unknown symbols
 */
export function resolvePythSymbol(input: string): string {
  const normalized = input.toUpperCase().trim();

  // Check direct mapping first
  if (SYMBOL_TO_PYTH[normalized]) {
    return SYMBOL_TO_PYTH[normalized];
  }

  // Already in Pyth format (contains namespace prefix)
  if (
    normalized.startsWith("CRYPTO.") ||
    normalized.startsWith("EQUITY.") ||
    normalized.startsWith("FX.") ||
    normalized.startsWith("METAL.")
  ) {
    return normalized;
  }

  // Handle X/USD format -> look up base symbol
  const pairMatch = normalized.match(/^([A-Z0-9]+)\/USD$/);
  if (pairMatch) {
    const base = pairMatch[1];
    if (SYMBOL_TO_PYTH[base]) {
      return SYMBOL_TO_PYTH[base];
    }
    // Default to Crypto namespace for unknown pairs
    return `Crypto.${base}/USD`;
  }

  // Fallback: assume crypto
  return `Crypto.${normalized}/USD`;
}

/**
 * Extract display symbol from Pyth format
 * e.g., "Crypto.BTC/USD" -> "BTC"
 */
export function extractDisplaySymbol(pythSymbol: string): string {
  // Remove namespace prefix and /USD suffix
  const match = pythSymbol.match(/(?:Crypto\.|Equity\.US\.|FX\.|Metal\.)?([A-Z0-9]+)(?:\/USD)?$/i);
  return match ? match[1].toUpperCase() : pythSymbol;
}

/**
 * Fetch OHLCV chart data from Pyth Benchmark API
 *
 * @param symbol - User-friendly symbol (e.g., "BTC", "ETH", "AAPL")
 * @param resolution - Candlestick timeframe (default: "60" for 1 hour)
 * @param bars - Number of candles to fetch (default: 100, max: 500)
 */
export async function fetchChartData(
  symbol: string,
  resolution: Resolution = "60",
  bars: number = 100
): Promise<ChartData> {
  const pythSymbol = resolvePythSymbol(symbol);
  const displaySymbol = extractDisplaySymbol(pythSymbol);

  // Calculate time range
  const now = Math.floor(Date.now() / 1000);
  const resolutionSeconds = RESOLUTION_SECONDS[resolution];
  const from = now - bars * resolutionSeconds;

  const url = new URL(`${PYTH_BENCHMARK_URL}/history`);
  url.searchParams.set("symbol", pythSymbol);
  url.searchParams.set("resolution", resolution);
  url.searchParams.set("from", String(from));
  url.searchParams.set("to", String(now));

  const response = await withRetryOrThrow(
    async () => {
      const res = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
      });

      if (!res.ok) {
        throw new Error(`Pyth API error (${res.status}): ${res.statusText}`);
      }

      return (await res.json()) as PythBenchmarkResponse;
    },
    { operationName: `pyth-chart-${symbol}`, maxRetries: 2 }
  );

  if (response.s === "error") {
    throw new Error(response.errmsg || "Pyth Benchmark API error");
  }

  if (response.s === "no_data" || !response.t || response.t.length === 0) {
    throw new Error(
      `No chart data available for ${symbol}. The symbol may not be supported or market may be closed.`
    );
  }

  // Transform to candles array
  const candles: OHLCVCandle[] = response.t.map((timestamp, i) => ({
    timestamp,
    datetime: new Date(timestamp * 1000).toISOString(),
    open: response.o![i],
    high: response.h![i],
    low: response.l![i],
    close: response.c![i],
    volume: response.v?.[i] ?? 0,
  }));

  // Calculate metrics
  const latestPrice = candles[candles.length - 1].close;
  const firstPrice = candles[0].open;
  const priceChange = latestPrice - firstPrice;
  const priceChangePercent = ((priceChange / firstPrice) * 100).toFixed(2);

  const periodHigh = Math.max(...candles.map((c) => c.high));
  const periodLow = Math.min(...candles.map((c) => c.low));

  return {
    symbol: displaySymbol,
    pythSymbol,
    resolution,
    resolutionLabel: RESOLUTION_LABELS[resolution],
    candles,
    latestPrice,
    priceChange,
    priceChangePercent: `${priceChange >= 0 ? "+" : ""}${priceChangePercent}%`,
    periodHigh,
    periodLow,
  };
}
