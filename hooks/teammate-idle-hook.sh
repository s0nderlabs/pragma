#!/usr/bin/env bash
# TeammateIdle Hook — Pragma Loop Enforcement for Teammate Agents
# Mirrors subagent-stop-hook.sh but uses the TeammateIdle contract:
#   - Input: teammate_name, team_name (NOT agent_id)
#   - Block: exit 2 + stderr (NOT JSON stdout)
#   - Allow: exit 0
#
# Lookup: Scans ~/.pragma/agents/*/state.json for matching teammateName field
# (SubagentStop uses taskAgentId instead)
#
# Extra terminal status: "pending" (agent hasn't started yet, e.g., Turn 1 "READY")
#
# Fail-open: any error → non-zero exit (but not 2) → agent idles normally

set -euo pipefail

AGENTS_DIR="$HOME/.pragma/agents"

# --- Read hook input from stdin ---
INPUT=$(cat)

# --- Step 1: Extract teammate_name ---
TEAMMATE_NAME=$(echo "$INPUT" | jq -r '.teammate_name // empty')
if [ -z "$TEAMMATE_NAME" ]; then
  exit 0
fi

# --- Step 2: Find matching pragma agent by teammateName ---
PRAGMA_AGENT_DIR=""
PRAGMA_AGENT_ID=""

if [ ! -d "$AGENTS_DIR" ]; then
  exit 0
fi

for STATE_FILE in "$AGENTS_DIR"/*/state.json; do
  [ -f "$STATE_FILE" ] || continue

  STORED_NAME=$(jq -r '.teammateName // empty' "$STATE_FILE" 2>/dev/null)
  if [ "$STORED_NAME" = "$TEAMMATE_NAME" ]; then
    PRAGMA_AGENT_DIR=$(dirname "$STATE_FILE")
    PRAGMA_AGENT_ID=$(jq -r '.id // empty' "$STATE_FILE" 2>/dev/null)
    break
  fi
done

# No matching pragma agent → not our agent, allow idle
if [ -z "$PRAGMA_AGENT_DIR" ]; then
  exit 0
fi

# --- Step 3: Read loop.json ---
LOOP_FILE="$PRAGMA_AGENT_DIR/loop.json"
if [ ! -f "$LOOP_FILE" ]; then
  # No loop config → one-shot task, allow idle
  exit 0
fi

LOOP_ACTIVE=$(jq -r '.active // false' "$LOOP_FILE" 2>/dev/null)
if [ "$LOOP_ACTIVE" != "true" ]; then
  # Loop deactivated → allow idle
  exit 0
fi

LOOP_TYPE=$(jq -r '.type // "none"' "$LOOP_FILE" 2>/dev/null)
if [ "$LOOP_TYPE" = "none" ]; then
  exit 0
fi

# --- Step 4: Check termination conditions from state.json ---
STATE_FILE="$PRAGMA_AGENT_DIR/state.json"

# Check agent status
# NOTE: "pending" is included here (unlike SubagentStop) to handle the race condition
# where leader stores teammateName before the agent calls report_agent_status("running").
# A pending agent should be allowed to idle — it hasn't started its mission yet.
STATUS=$(jq -r '.status // "unknown"' "$STATE_FILE" 2>/dev/null)
if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ] || [ "$STATUS" = "revoked" ] || [ "$STATUS" = "paused" ] || [ "$STATUS" = "pending" ]; then
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

# --- Step 6: All checks pass — block idle ---

# Read mission (becomes the agent's next prompt via stderr)
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

# Block idle with mission text via stderr (TeammateIdle contract)
REASON="${MISSION}

Agent ID: ${PRAGMA_AGENT_ID}. Iteration: ${NEW_ITERATION}/${MAX_ITERATIONS:-unlimited}. Use get_sub_agent_state to check state."

echo "$REASON" >&2
exit 2
