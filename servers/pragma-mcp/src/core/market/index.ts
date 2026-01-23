// Market Module
// Provides market data fetching (charts, prices) via Pyth Benchmark API
// Copyright (c) 2026 s0nderlabs

// Constants
export {
  PYTH_BENCHMARK_URL,
  SYMBOL_TO_PYTH,
  VALID_RESOLUTIONS,
  RESOLUTION_LABELS,
  RESOLUTION_SECONDS,
  type Resolution,
} from "./constants.js";

// Types
export type {
  PythBenchmarkResponse,
  OHLCVCandle,
  ChartData,
} from "./types.js";

// Client functions
export {
  resolvePythSymbol,
  extractDisplaySymbol,
  fetchChartData,
  formatUsdPrice,
} from "./client.js";
