// Transfer Execution
// Executes token transfers via delegation framework
// Adapted from pragma-v2-stable (H2)

import type { Address, Hex } from "viem";
import type { ExecutionResult } from "../../types/index.js";
import type { SignedDelegation } from "../delegation/types.js";

// TODO: Implement - copy and adapt from H2

export interface TransferParams {
  token: Address;
  to: Address;
  amount: bigint;
  delegation: SignedDelegation;
  sessionKey: Address;
}

export async function executeTransfer(
  params: TransferParams
): Promise<ExecutionResult> {
  throw new Error("Not implemented");
}

export function buildTransferCalldata(
  token: Address,
  to: Address,
  amount: bigint
): Hex {
  throw new Error("Not implemented");
}

export function buildNativeTransferCalldata(
  to: Address,
  amount: bigint
): Hex {
  throw new Error("Not implemented");
}
