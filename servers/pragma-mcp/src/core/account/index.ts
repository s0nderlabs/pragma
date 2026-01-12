// Smart Account Module
// Exports for HybridDelegator smart account operations
// Copyright (c) 2026 s0nderlabs

export {
  type HybridDelegatorHandle,
  type CreateHybridDelegatorOptions,
  createHybridDelegatorHandle,
  deriveOwnerFromPasskey,
  isSmartAccountDeployed,
  getFactoryArgs,
  getAccountNonce,
  getEntryPointAddress,
  deriveSmartAccountAddress,
} from "./hybridDelegator.js";

export {
  type DeploymentResult,
  deploySmartAccount,
} from "./deployment.js";
