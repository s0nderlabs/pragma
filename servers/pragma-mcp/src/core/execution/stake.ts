// Stake Execution
// Executes aPriori staking via delegation framework
// Adapted from pragma-v2-stable (H2)

import type { Address, Hex } from "viem";
import type { ExecutionResult } from "../../types/index.js";
import type { SignedDelegation } from "../delegation/types.js";

// TODO: Implement - copy and adapt from H2

export interface StakeParams {
  amount: bigint;
  delegation: SignedDelegation;
  sessionKey: Address;
}

export interface UnstakeParams {
  amount: bigint;
  delegation: SignedDelegation;
  sessionKey: Address;
}

export async function executeStake(
  params: StakeParams
): Promise<ExecutionResult> {
  throw new Error("Not implemented");
}

export async function executeUnstake(
  params: UnstakeParams
): Promise<ExecutionResult> {
  throw new Error("Not implemented");
}

export function buildStakeCalldata(amount: bigint): Hex {
  throw new Error("Not implemented");
}

export function buildUnstakeCalldata(amount: bigint): Hex {
  throw new Error("Not implemented");
}
