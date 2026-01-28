// Sub-Agent Module
// Exports for autonomous mode infrastructure
// Copyright (c) 2026 s0nderlabs

// Key management
export {
  type SubAgentWallet,
  generateSubAgentWallet,
  storeSubAgentWallet,
  getSubAgentWallet,
  deleteSubAgentWallet,
  hasSubAgentWallet,
  listSubAgentWalletIds,
  getSubAgentAccount,
  createAndStoreSubAgentWallet,
} from "./keys.js";

// Wallet pool
export {
  type PoolWallet,
  type WalletPool,
  loadWalletPool,
  getOrCreateWallet,
  assignWallet,
  releaseWallet,
  getPoolWallet,
  listPoolWallets,
  removeWallet,
  cleanupIdleWallets,
  syncPoolWithKeychain,
  getFullWallet,
  validateAndHealPool,
} from "./wallet-pool.js";

// Agent state
export {
  type SubAgentState,
  type TradeRecord,
  type StoredDelegation,
  type CreateAgentStateParams,
  NATIVE_TOKEN_ADDRESS,
  USDC_ADDRESS,
  createAgentState,
  loadAgentState,
  updateAgentState,
  appendTrade,
  loadTrades,
  storeDelegation,
  loadDelegation,
  addError,
  updateBudgetSpent,
  updateTokenSpent,
  getBudgetRemaining,
  getTokenBudgetRemaining,
  getAllTokenSpending,
  listAgentStates,
  deleteAgentState,
  agentExists,
} from "./state.js";

// Loop enforcement
export {
  type LoopConfig,
  createLoopConfig,
  loadLoopConfig,
  updateLoopConfig,
  deactivateLoop,
  deleteLoopConfig,
  shouldContinueLoop,
  createContinuousLoop,
  createConditionLoop,
  createIntervalLoop,
  hasLoopConfig,
} from "./loop.js";
