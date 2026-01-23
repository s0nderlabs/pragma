/**
 * Pyth Benchmark API TradingView response format
 * Follows TradingView UDF spec for /history endpoint
 */
export interface PythBenchmarkResponse {
  /** Status: "ok", "error", or "no_data" */
  s: "ok" | "error" | "no_data";
  /** Unix timestamps (UTC) for each candle */
  t?: number[];
  /** Open prices */
  o?: number[];
  /** High prices */
  h?: number[];
  /** Low prices */
  l?: number[];
  /** Close prices */
  c?: number[];
  /** Volumes (may be 0 for some assets) */
  v?: number[];
  /** Error message if s === "error" */
  errmsg?: string;
  /** Next available bar timestamp if s === "no_data" */
  nextTime?: number;
}

/**
 * Single OHLCV candlestick
 */
export interface OHLCVCandle {
  /** Unix timestamp */
  timestamp: number;
  /** ISO 8601 formatted datetime */
  datetime: string;
  /** Open price */
  open: number;
  /** High price */
  high: number;
  /** Low price */
  low: number;
  /** Close price */
  close: number;
  /** Volume (may be 0) */
  volume: number;
}

/**
 * Processed chart data with computed metrics
 */
export interface ChartData {
  /** User-friendly symbol (e.g., "BTC") */
  symbol: string;
  /** Pyth Benchmark symbol (e.g., "Crypto.BTC/USD") */
  pythSymbol: string;
  /** Resolution code (e.g., "60") */
  resolution: string;
  /** Human-readable resolution (e.g., "1 hour") */
  resolutionLabel: string;
  /** Array of OHLCV candles */
  candles: OHLCVCandle[];
  /** Latest close price */
  latestPrice: number;
  /** Price change from first candle open to latest close */
  priceChange: number;
  /** Price change as formatted percentage string */
  priceChangePercent: string;
  /** Highest price in the candle range */
  periodHigh: number;
  /** Lowest price in the candle range */
  periodLow: number;
}
