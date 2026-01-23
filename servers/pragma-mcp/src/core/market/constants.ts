// Pyth Benchmark API constants and symbol mappings

export const PYTH_BENCHMARK_URL = "https://benchmarks.pyth.network/v1/shims/tradingview";

/**
 * User-friendly symbol to Pyth Benchmark format mapping
 * Pyth uses namespace prefixes: Crypto., Equity.US., FX., Metal.
 */
export const SYMBOL_TO_PYTH: Record<string, string> = {
  // Crypto - aligned with LeverUp SUPPORTED_PAIRS
  "BTC": "Crypto.BTC/USD",
  "ETH": "Crypto.ETH/USD",
  "MON": "Crypto.MON/USD",
  "SOL": "Crypto.SOL/USD",
  "XRP": "Crypto.XRP/USD",
  "DOGE": "Crypto.DOGE/USD",
  "ADA": "Crypto.ADA/USD",
  "AVAX": "Crypto.AVAX/USD",
  "DOT": "Crypto.DOT/USD",
  "LINK": "Crypto.LINK/USD",
  "ATOM": "Crypto.ATOM/USD",
  "NEAR": "Crypto.NEAR/USD",
  "APT": "Crypto.APT/USD",
  "SUI": "Crypto.SUI/USD",
  "ARB": "Crypto.ARB/USD",
  "OP": "Crypto.OP/USD",

  // Equity Indices
  "QQQ": "Equity.US.QQQ/USD",
  "SPY": "Equity.US.SPY/USD",
  "DIA": "Equity.US.DIA/USD",
  "IWM": "Equity.US.IWM/USD",

  // Stocks - aligned with LeverUp SUPPORTED_PAIRS
  "AAPL": "Equity.US.AAPL/USD",
  "AMZN": "Equity.US.AMZN/USD",
  "TSLA": "Equity.US.TSLA/USD",
  "NVDA": "Equity.US.NVDA/USD",
  "META": "Equity.US.META/USD",
  "MSFT": "Equity.US.MSFT/USD",
  "GOOG": "Equity.US.GOOG/USD",
  "GOOGL": "Equity.US.GOOGL/USD",
  "AMD": "Equity.US.AMD/USD",
  "NFLX": "Equity.US.NFLX/USD",

  // Forex
  "EUR": "FX.EUR/USD",
  "GBP": "FX.GBP/USD",
  "JPY": "FX.USD/JPY",
  "CHF": "FX.USD/CHF",
  "AUD": "FX.AUD/USD",
  "CAD": "FX.USD/CAD",
  "EUR/USD": "FX.EUR/USD",
  "GBP/USD": "FX.GBP/USD",
  "USD/JPY": "FX.USD/JPY",
  "USD/CHF": "FX.USD/CHF",
  "AUD/USD": "FX.AUD/USD",
  "USD/CAD": "FX.USD/CAD",

  // Commodities / Metals
  "XAU": "Metal.XAU/USD",
  "XAG": "Metal.XAG/USD",
  "GOLD": "Metal.XAU/USD",
  "SILVER": "Metal.XAG/USD",
};

/**
 * Valid resolutions for Pyth Benchmark TradingView endpoint
 * Maps to TradingView UDF spec
 */
export const VALID_RESOLUTIONS = ["1", "5", "15", "30", "60", "240", "D", "1W", "1M"] as const;
export type Resolution = typeof VALID_RESOLUTIONS[number];

/**
 * Human-readable resolution labels for display
 */
export const RESOLUTION_LABELS: Record<Resolution, string> = {
  "1": "1 minute",
  "5": "5 minutes",
  "15": "15 minutes",
  "30": "30 minutes",
  "60": "1 hour",
  "240": "4 hours",
  "D": "Daily",
  "1W": "Weekly",
  "1M": "Monthly",
};

/**
 * Resolution to seconds mapping for time range calculations
 */
export const RESOLUTION_SECONDS: Record<Resolution, number> = {
  "1": 60,
  "5": 300,
  "15": 900,
  "30": 1800,
  "60": 3600,
  "240": 14400,
  "D": 86400,
  "1W": 604800,
  "1M": 2592000,
};
