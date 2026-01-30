// Loop Enforcement Configuration
// Dynamic loop control for autonomous mode sub-agents
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

  // The mission text — re-injected as the agent's next prompt when hook blocks exit
  mission: string;

  // Safety valve: max hook-blocked iterations (0 = unlimited)
  maxIterations: number;

  // Tracked by hook: incremented each time hook blocks exit
  currentIteration: number;

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
 * Called by the SubagentStop hook to decide whether to block stopping.
 */
export function shouldContinueLoop(agentId: string): {
  continue: boolean;
  reason?: string;
} {
  const config = loadLoopConfig(agentId);

  if (!config || !config.active) {
    return { continue: false };
  }

  if (config.maxIterations > 0 && config.currentIteration >= config.maxIterations) {
    return { continue: false, reason: "Max iterations reached" };
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
  maxIterations: number = 0
): void {
  createLoopConfig(agentId, {
    type: "continuous",
    active: true,
    mission,
    maxIterations,
    currentIteration: 0,
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
  maxIterations: number = 0
): void {
  createLoopConfig(agentId, {
    type: "condition",
    active: true,
    condition,
    mission,
    maxIterations,
    currentIteration: 0,
  });
}

/**
 * Create an interval-based loop config
 */
export function createIntervalLoop(
  agentId: string,
  intervalMinutes: number,
  mission: string,
  maxIterations: number = 0
): void {
  createLoopConfig(agentId, {
    type: "interval",
    active: true,
    intervalMinutes,
    mission,
    maxIterations,
    currentIteration: 0,
  });
}

/**
 * Check if loop exists for an agent
 */
export function hasLoopConfig(agentId: string): boolean {
  const loopPath = getLoopConfigPath(agentId);
  return existsSync(loopPath);
}
