// Loop Configuration
// Persists mission and scheduling config for leader-orchestrated wake cycles
// Copyright (c) 2026 s0nderlabs

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

/**
 * Loop configuration stored in ~/.pragma/agents/<id>/loop.json
 *
 * Loop types:
 * - none: One-shot task, agent stops when done
 * - condition: Monitor until condition is met (e.g., "BTC hits 95k")
 * - continuous: Keep trading until budget/time exhausted
 * - interval: Periodic wake-up for monitoring (e.g., "every hour")
 */
export interface LoopConfig {
  type: "none" | "condition" | "continuous" | "interval";
  active: boolean;

  // The mission text — sent by leader as wake message between cycles
  mission: string;

  // For condition type
  condition?: string; // Human-readable condition description

  // For continuous type
  until?: Array<"budget_exhausted" | "delegation_expired" | "user_cancelled" | "max_trades">;

  // For interval type
  intervalMinutes?: number; // e.g., 60 = check every hour

  // Metadata
  createdAt: number;
  lastCheckedAt?: number;
}

/**
 * Get the loop config file path for an agent
 */
function getLoopConfigPath(agentId: string): string {
  const agentDir = path.join(homedir(), ".pragma", "agents", agentId);
  return path.join(agentDir, "loop.json");
}

/**
 * Create or update loop configuration for an agent
 */
export function createLoopConfig(
  agentId: string,
  config: Omit<LoopConfig, "createdAt">
): void {
  const loopPath = getLoopConfigPath(agentId);
  const agentDir = path.dirname(loopPath);

  if (!existsSync(agentDir)) {
    throw new Error(`Agent directory not found: ${agentId}`);
  }

  const fullConfig: LoopConfig = {
    ...config,
    createdAt: Date.now(),
  };

  writeFileSync(loopPath, JSON.stringify(fullConfig, null, 2));
}

/**
 * Load loop configuration for an agent.
 * Returns null if no loop config exists (agent runs as one-shot).
 */
export function loadLoopConfig(agentId: string): LoopConfig | null {
  const loopPath = getLoopConfigPath(agentId);

  if (!existsSync(loopPath)) {
    return null;
  }

  try {
    const content = readFileSync(loopPath, "utf-8");
    return JSON.parse(content) as LoopConfig;
  } catch {
    return null;
  }
}

/**
 * Update loop configuration
 */
export function updateLoopConfig(
  agentId: string,
  updates: Partial<LoopConfig>
): void {
  const config = loadLoopConfig(agentId);
  if (!config) {
    throw new Error(`Loop config not found for agent: ${agentId}`);
  }

  const updatedConfig: LoopConfig = {
    ...config,
    ...updates,
    lastCheckedAt: Date.now(),
  };

  const loopPath = getLoopConfigPath(agentId);
  writeFileSync(loopPath, JSON.stringify(updatedConfig, null, 2));
}

/**
 * Deactivate loop (allows agent to stop)
 */
export function deactivateLoop(agentId: string): void {
  const config = loadLoopConfig(agentId);
  if (!config) {
    return;
  }

  updateLoopConfig(agentId, { active: false });
}

/**
 * Delete loop configuration
 */
export function deleteLoopConfig(agentId: string): void {
  const loopPath = getLoopConfigPath(agentId);

  if (existsSync(loopPath)) {
    unlinkSync(loopPath);
  }
}

/**
 * Check if loop should continue.
 * Called by the leader to decide whether to wake the agent for the next cycle.
 */
export function shouldContinueLoop(agentId: string): {
  continue: boolean;
  reason?: string;
} {
  const config = loadLoopConfig(agentId);

  if (!config || !config.active) {
    return { continue: false };
  }

  switch (config.type) {
    case "condition":
    case "continuous":
    case "interval":
      return { continue: true, reason: config.mission };

    case "none":
    default:
      return { continue: false };
  }
}

/**
 * Create a continuous trading loop config
 */
export function createContinuousLoop(
  agentId: string,
  mission: string,
): void {
  createLoopConfig(agentId, {
    type: "continuous",
    active: true,
    mission,
    until: ["budget_exhausted", "delegation_expired", "user_cancelled"],
  });
}

/**
 * Create a condition-based loop config
 */
export function createConditionLoop(
  agentId: string,
  condition: string,
  mission: string,
): void {
  createLoopConfig(agentId, {
    type: "condition",
    active: true,
    condition,
    mission,
  });
}

/**
 * Create an interval-based loop config
 */
export function createIntervalLoop(
  agentId: string,
  intervalMinutes: number,
  mission: string,
): void {
  createLoopConfig(agentId, {
    type: "interval",
    active: true,
    intervalMinutes,
    mission,
  });
}

/**
 * Check if loop exists for an agent
 */
export function hasLoopConfig(agentId: string): boolean {
  const loopPath = getLoopConfigPath(agentId);
  return existsSync(loopPath);
}
