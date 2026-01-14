// x402 Module
// Exports for x402 micropayment protocol support
// Copyright (c) 2026 s0nderlabs

// Types
export type {
  X402PaymentRequired,
  X402PaymentRequirements,
  X402PaymentPayload,
  X402PaymentResponse,
  EIP3009Authorization,
  SessionKeyUsdcBalance,
  X402OperationType,
  UsdcBalanceCheck,
  X402Config,
} from "./types.js";

export { X402_API_PATTERNS } from "./types.js";

// Payment signing
export {
  signPaymentAuthorization,
  createPaymentHeader,
  decodePaymentResponse,
} from "./payment.js";

// USDC helpers
export {
  USDC_ADDRESS,
  USDC_DECIMALS,
  MIN_USDC_BALANCE,
  LOW_BALANCE_WARNING,
  RECOMMENDED_USDC_FUNDING,
  USDC_COST_PER_OPERATION,
  getUsdcBalance,
  checkUsdcBalanceForOperations,
  estimateSwapCost,
  calculateUsdcFundingAmount,
  buildUsdcTransferCalldata,
  formatUsdcBalance,
  parseUsdcAmount,
  isUsdcConfigured,
  getUsdcAddress,
} from "./usdc.js";

// Client
export {
  x402Fetch,
  isX402Endpoint,
  isX402Mode,
  createX402Fetch,
} from "./client.js";
