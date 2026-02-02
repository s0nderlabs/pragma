#!/usr/bin/env bash
# SubagentStop Hook — Pragma Loop Enforcement
# Adapted from Ralph Loop pattern, verified against official Anthropic hooks docs.
#
# Input (stdin): JSON with agent_id, stop_hook_active, agent_transcript_path, etc.
# Output (stdout): JSON { "decision": "block", "reason": "..." } to prevent exit
# Allow exit: exit 0 with no JSON output
#
# Fail-open: any error → non-zero exit → agent stops (never trapped)
#
# NOTE: We intentionally do NOT check stop_hook_active. That flag is set to
# true after a previous block, but our termination conditions (status, trades,
# expiry, maxIterations) already guarantee the loop will end. Checking
# stop_hook_active would limit us to 1 block per spawn. Ralph Loop (official
# Anthropic plugin) uses the same pattern — ignore the flag, rely on own logic.

set -euo pipefail

AGENTS_DIR="$HOME/.pragma/agents"

# --- Read hook input from stdin ---
INPUT=$(cat)

# --- Step 1: Extract agent_id ---
AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // empty')
if [ -z "$AGENT_ID" ]; then
  exit 0
fi

# --- Step 2: Find matching pragma agent by taskAgentId ---
PRAGMA_AGENT_DIR=""
PRAGMA_AGENT_ID=""

if [ ! -d "$AGENTS_DIR" ]; then
  exit 0
fi

for STATE_FILE in "$AGENTS_DIR"/*/state.json; do
  [ -f "$STATE_FILE" ] || continue

  TASK_AGENT_ID=$(jq -r '.taskAgentId // empty' "$STATE_FILE" 2>/dev/null)
  if [ "$TASK_AGENT_ID" = "$AGENT_ID" ]; then
    PRAGMA_AGENT_DIR=$(dirname "$STATE_FILE")
    PRAGMA_AGENT_ID=$(jq -r '.id // empty' "$STATE_FILE" 2>/dev/null)
    break
  fi
done

# No matching pragma agent → not our agent, allow stop
if [ -z "$PRAGMA_AGENT_DIR" ]; then
  exit 0
fi

# --- Step 3: Read loop.json ---
LOOP_FILE="$PRAGMA_AGENT_DIR/loop.json"
if [ ! -f "$LOOP_FILE" ]; then
  # No loop config → one-shot task, allow stop
  exit 0
fi

LOOP_ACTIVE=$(jq -r '.active // false' "$LOOP_FILE" 2>/dev/null)
if [ "$LOOP_ACTIVE" != "true" ]; then
  # Loop deactivated → allow stop
  exit 0
fi

LOOP_TYPE=$(jq -r '.type // "none"' "$LOOP_FILE" 2>/dev/null)
if [ "$LOOP_TYPE" = "none" ]; then
  exit 0
fi

# --- Step 4: Check termination conditions from state.json ---
STATE_FILE="$PRAGMA_AGENT_DIR/state.json"

# Check agent status
STATUS=$(jq -r '.status // "unknown"' "$STATE_FILE" 2>/dev/null)
if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ] || [ "$STATUS" = "revoked" ] || [ "$STATUS" = "paused" ]; then
  exit 0
fi

# Check trade count
TRADES_EXECUTED=$(jq -r '.trades.executed // 0' "$STATE_FILE" 2>/dev/null)
TRADES_MAX=$(jq -r '.trades.maxAllowed // 999999' "$STATE_FILE" 2>/dev/null)
if [ "$TRADES_EXECUTED" -ge "$TRADES_MAX" ] 2>/dev/null; then
  exit 0
fi

# Check expiry
EXPIRES_AT=$(jq -r '.expiresAt // 0' "$STATE_FILE" 2>/dev/null)
NOW_MS=$(date +%s)000
if [ "$EXPIRES_AT" -gt 0 ] && [ "$NOW_MS" -ge "$EXPIRES_AT" ] 2>/dev/null; then
  exit 0
fi

# --- Step 5: Check iteration limits ---
MAX_ITERATIONS=$(jq -r '.maxIterations // 0' "$LOOP_FILE" 2>/dev/null)
CURRENT_ITERATION=$(jq -r '.currentIteration // 0' "$LOOP_FILE" 2>/dev/null)

if [ "$MAX_ITERATIONS" -gt 0 ] 2>/dev/null && [ "$CURRENT_ITERATION" -ge "$MAX_ITERATIONS" ] 2>/dev/null; then
  exit 0
fi

# --- Step 6: All checks pass — block exit ---

# Read mission (becomes the agent's next prompt)
MISSION=$(jq -r '.mission // empty' "$LOOP_FILE" 2>/dev/null)
if [ -z "$MISSION" ]; then
  # Fallback for backward compat: try description, then generic
  MISSION=$(jq -r '.description // "Continue your mission"' "$LOOP_FILE" 2>/dev/null)
fi

# Increment currentIteration in loop.json
NEW_ITERATION=$((CURRENT_ITERATION + 1))
UPDATED=$(jq --argjson iter "$NEW_ITERATION" '.currentIteration = $iter | .lastCheckedAt = (now * 1000 | floor)' "$LOOP_FILE" 2>/dev/null)
if [ -n "$UPDATED" ]; then
  echo "$UPDATED" > "$LOOP_FILE" 2>/dev/null || true
fi

# Block exit with mission as primary text (agent sees this as its next prompt)
REASON="${MISSION}

Agent ID: ${PRAGMA_AGENT_ID}. Iteration: ${NEW_ITERATION}/${MAX_ITERATIONS:-unlimited}. Use get_sub_agent_state to check state."

# Output JSON decision per official Anthropic SubagentStop contract
jq -n --arg reason "$REASON" '{ "decision": "block", "reason": $reason }'
