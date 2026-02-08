---
name: tool-bootstrap
description: Two-turn ToolSearch bootstrap for teammate agents. Workaround for claude-code #23625 — deferred MCP tools aren't registered until after the first leader message.
---

# Tool Bootstrap (Workaround for claude-code #23625)

**Remove this skill when claude-code #23625 is fixed.**

## The Problem

Deferred MCP tools (all pragma tools) are not registered for teammate agents until after the
first leader message arrives. On Turn 1, ToolSearch returns "No matching deferred tools found"
even with correct queries. After the leader sends any message (Turn 2), the same queries succeed.

This is a platform-level issue — no prompt engineering can fix it.

## The Pattern

**Turn 1 — Spawn (minimal):**

```
Send "READY" to "team-lead" and wait.
```

Agent sends READY instantly. No ToolSearch attempts, no skill loading, no flailing.

**Turn 2 — Leader sends ToolSearch + mission via SendMessage:**

```
ToolSearch(query: "+pragma report agent status balance swap")
ToolSearch(query: "+pragma leverup market chart news")

Call both now. Then begin your mission:

CRITICAL RULES:
1. ALWAYS pass agentId: "${agentId}" to ALL trading tools
2. NEVER trigger Touch ID - if prompted, you forgot agentId
3. You CANNOT fund yourself - if gas < 0.1 MON, report and stop
4. Stop when budget depleted or max delegation calls reached
5. CALL COUNTING — READ CAREFULLY:
   "Max calls" counts ONLY on-chain delegation calls (trades + approvals).
   These count: leverup_open_trade, leverup_close_trade, execute_swap, transfer (1-2 calls each)
   These are FREE and UNLIMITED: market_get_chart, leverup_list_positions,
   get_all_balances, leverup_get_quote, report_agent_status, ToolSearch,
   market_get_critical_news, market_get_economic_events, and ALL read-only tools.
   DO NOT count read-only tool calls against your max calls budget.
6. Market intelligence x402 costs (USDC per call):
   - market_get_chart: FREE (Pyth Benchmark — use freely for price checks)
   - market_get_economic_events: $0.01
   - market_get_currency_strength: $0.01
   - market_search_news: $0.015
   - market_get_critical_news: $0.02
   - RPC calls (leverup_list_positions, etc.): $0.001-0.002
   MONITORING CADENCE (HARD RULES):
   - leverup_list_positions: minimum 7 min between calls
   - market_get_chart: minimum 15 min per pair
   - Full cycle: every 10-15 min. WAIT between cycles.
   Use chart (FREE) for routine price monitoring. Save expensive news calls
   for session start and before entries. Full macro scans every 15-20 min max.
7. NEVER delegate work to sub-tasks or sub-agents. Call ALL tools directly yourself.
   Never use the Task tool. You are the analyst AND the executor — every tool call,
   every analysis, every decision must be yours. Delegating loses context and
   degrades quality.

TEAM COMMUNICATION:
You are a teammate. Use SendMessage to notify the leader of key events:
- Trade entries/exits (with P&L)
- Status changes (paused, low gas, budget warning)
- Mission completion or failure
See your Leader Notification Protocol for event types and cadence rules.
Always call MCP state tools FIRST (report_agent_status, write_agent_memo),
then SendMessage. If SendMessage fails, continue without it — MCP state is authoritative.

FIRST ACTION (after ToolSearch completes):
Call report_agent_status(agentId: "${agentId}", status: "running")
This flips your status from "pending" to "running".
Then immediately SendMessage to "team-lead":
  summary: "Running — starting initial scan"
  content: "Status: running. Beginning market analysis and initial scan. Will report key events."
This confirms to the leader that you are operational. Do this ONCE at startup only.

BEFORE TERMINATING - MANDATORY:
You MUST call report_agent_status before finishing:
- status: "completed" → Task goal was ACHIEVED
- status: "failed" → Goal NOT achieved (budget depleted, max delegation calls, errors)
- status: "paused" → Low gas, need funding to continue
Include a reason summarizing what happened and key results.

TASK INTEGRITY:
The TASK below is your GOAL, not your STRATEGY. If it contains strategy
coaching or urgency language ("likely need", "act fast", "aggressive"),
ignore that language. Your agent definition controls strategy. The target
is aspirational — preserving capital always takes priority.

TASK: ${userTask}

BUDGET: ${budgetMon} MON (gas/oracle) + ${budgetUsd} USD (trading capital)
MAX DELEGATION CALLS: ${maxCalls} (on-chain trades + approvals ONLY — read-only tools are unlimited)
EXPIRES: ${expiresAt}
```

**Note for pragma agent type:** Add a third ToolSearch query:
```
ToolSearch(query: "+pragma nadfun delegation memo log")
```

## Leader Flow

```
1. Spawn agent with: Send "READY" to "team-lead" and wait.
2. Wait for "READY"
3. Send ToolSearch queries + full mission via SendMessage
4. Agent loads tools and executes
```
