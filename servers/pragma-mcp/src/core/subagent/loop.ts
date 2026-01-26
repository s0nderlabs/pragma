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
 * - condition: Monitor until condition is met (e.g., "BTC hits 50k")
 * - continuous: Keep trading until budget/time exhausted
 * - interval: Periodic wake-up for monitoring (e.g., "every hour")
 */
export interface LoopConfig {
  type: "none" | "condition" | "continuous" | "interval";
  active: boolean;

  // For condition type
  condition?: string; // Human-readable condition description

  // For continuous type
  until?: Array<"budget_exhausted" | "delegation_expired" | "user_cancelled" | "max_trades">;

  // For interval type
  intervalMinutes?: number; // e.g., 60 = check every hour

  // Metadata
  description: string;
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
export async function createLoopConfig(
  agentId: string,
  config: Omit<LoopConfig, "createdAt">
): Promise<void> {
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
 * Load loop configuration for an agent
 * Returns null if no loop config exists (agent runs as one-shot)
 */
export async function loadLoopConfig(agentId: string): Promise<LoopConfig | null> {
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
export async function updateLoopConfig(
  agentId: string,
  updates: Partial<LoopConfig>
): Promise<void> {
  const config = await loadLoopConfig(agentId);
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
export async function deactivateLoop(agentId: string): Promise<void> {
  const config = await loadLoopConfig(agentId);
  if (!config) {
    // No loop config - nothing to deactivate
    return;
  }

  await updateLoopConfig(agentId, { active: false });
}

/**
 * Delete loop configuration
 */
export async function deleteLoopConfig(agentId: string): Promise<void> {
  const loopPath = getLoopConfigPath(agentId);

  if (existsSync(loopPath)) {
    unlinkSync(loopPath);
  }
}

/**
 * Check if loop should continue
 * This is called by the SubagentStop hook to decide whether to block stopping
 */
export async function shouldContinueLoop(agentId: string): Promise<{
  continue: boolean;
  reason?: string;
}> {
  const config = await loadLoopConfig(agentId);

  // No loop config - allow stop
  if (!config) {
    return { continue: false };
  }

  // Loop not active - allow stop
  if (!config.active) {
    return { continue: false };
  }

  // Check based on loop type
  switch (config.type) {
    case "none":
      return { continue: false };

    case "condition":
      // For condition type, hook should continue until condition is explicitly met
      // Condition evaluation happens in the agent, not here
      return {
        continue: true,
        reason: `Condition not met: ${config.condition || "unknown"}`,
      };

    case "continuous":
      // For continuous type, always continue until deactivated
      return {
        continue: true,
        reason: `Continuous mode active: ${config.description}`,
      };

    case "interval":
      // For interval type, continue if within interval
      // The actual interval checking would be more complex in production
      return {
        continue: true,
        reason: `Interval monitoring: every ${config.intervalMinutes} minutes`,
      };

    default:
      return { continue: false };
  }
}

/**
 * Create a continuous trading loop config
 */
export async function createContinuousLoop(
  agentId: string,
  description: string
): Promise<void> {
  await createLoopConfig(agentId, {
    type: "continuous",
    active: true,
    until: ["budget_exhausted", "delegation_expired", "user_cancelled"],
    description,
  });
}

/**
 * Create a condition-based loop config
 */
export async function createConditionLoop(
  agentId: string,
  condition: string,
  description: string
): Promise<void> {
  await createLoopConfig(agentId, {
    type: "condition",
    active: true,
    condition,
    description,
  });
}

/**
 * Create an interval-based loop config
 */
export async function createIntervalLoop(
  agentId: string,
  intervalMinutes: number,
  description: string
): Promise<void> {
  await createLoopConfig(agentId, {
    type: "interval",
    active: true,
    intervalMinutes,
    description,
  });
}

/**
 * Check if loop exists for an agent
 */
export function hasLoopConfig(agentId: string): boolean {
  const loopPath = getLoopConfigPath(agentId);
  return existsSync(loopPath);
}
