// Caffeinate Management
// Prevents macOS idle sleep while autonomous agents are running.
// Caffeinate runs as a child of the MCP server process — NOT detached.
// When MCP dies (session ends, pkill, etc.), caffeinate dies with it.
// No PID file, no orphans, no zombies.
// Copyright (c) 2026 s0nderlabs

import { spawn, type ChildProcess } from "node:child_process";

let caffeinateChild: ChildProcess | null = null;

/**
 * Start caffeinate -i if not already running.
 * Runs as a child process — auto-dies when MCP server exits.
 */
export function startCaffeinate(): void {
  // Already running — verify it's still alive
  if (caffeinateChild !== null) {
    if (caffeinateChild.exitCode === null && !caffeinateChild.killed) {
      return; // Still alive
    }
    // Dead reference — clean up
    caffeinateChild = null;
  }

  try {
    const child = spawn("caffeinate", ["-i", "-s", "-w", `${process.pid}`], {
      stdio: "ignore",
    });

    // Reap zombie on exit
    child.on("exit", () => {
      caffeinateChild = null;
    });

    child.on("error", () => {
      caffeinateChild = null;
    });

    caffeinateChild = child;
  } catch {
    // Non-critical — agent still works, Mac might just sleep
  }
}

/**
 * Stop caffeinate if running.
 */
export function stopCaffeinate(): void {
  if (caffeinateChild === null) {
    return;
  }

  try {
    caffeinateChild.kill("SIGTERM");
  } catch {
    // Already dead
  }

  caffeinateChild = null;
}

/**
 * Check if caffeinate is currently running.
 */
export function isCaffeinateRunning(): boolean {
  if (caffeinateChild === null) {
    return false;
  }
  return caffeinateChild.exitCode === null && !caffeinateChild.killed;
}
