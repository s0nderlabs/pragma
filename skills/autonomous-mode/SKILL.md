---
name: autonomous-mode
description: Manages autonomous trading agents. Use when user mentions autonomous, sub-agent, background trading, AFK trading, monitoring while away, spawn agent, create agent, delegate trading, hands-free trading, while I sleep, overnight, keep running, monitor and execute, condition trigger, loop, or run until.
allowed-tools:
  - mcp__pragma__create_root_delegation
  - mcp__pragma__create_sub_agent
  - mcp__pragma__list_sub_agents
  - mcp__pragma__revoke_sub_agent
  - mcp__pragma__fund_sub_agent
  - mcp__pragma__get_sub_agent_state
  - mcp__pragma__report_agent_status
  - mcp__pragma__check_delegation_status
  - mcp__pragma__revoke_root_delegation
  - mcp__pragma__get_agent_log
  - mcp__pragma__write_agent_memo
  - mcp__pragma__list_wallet_pool
  - mcp__pragma__leverup_list_positions
  - mcp__pragma__get_all_balances
  - mcp__pragma__check_session_key_balance
  - mcp__pragma__fund_session_key
  - AskUserQuestion
  - Read
  - Task
  - TeamCreate
  - TeamDelete
  - SendMessage
---

# Autonomous Mode

Autonomous mode allows sub-agents to execute trades WITHOUT Touch ID by using pre-signed delegations.

## Two Execution Modes

| Mode | Touch ID | When to Use | How |
|------|----------|-------------|-----|
| **Assistant** | Required per action | User is present, interactive | Omit `agentId` parameter |
| **Autonomous** | Not required | Sub-agent running independently | Pass `agentId` parameter |

## How Autonomous Mode Works

```
1. User creates root delegation (Touch ID once)
   └── Grants session key permission to trade

2. Session key creates sub-agent
   └── Assigns wallet from pool
   └── Creates sub-delegation (signed by session key)
   └── Funds sub-agent wallet with MON for gas
   └── Status starts as "pending"

3. Sub-agent is spawned via Task tool
   └── Agent calls report_agent_status("running")
   └── Status flips: pending → running

4. Sub-agent executes trades
   └── Passes agentId to trading tools
   └── Tool uses delegation chain (no Touch ID)
   └── User's Smart Account executes the trade
   └── Sub-agent pays gas from its wallet
   └── Token flows recorded in ledger (in + out per token)
```

## Dual-Mode Trading Tools

These tools support both modes via the `agentId` parameter:

- `nadfun_buy`, `nadfun_sell`
- `execute_swap`
- `leverup_open_trade`, `leverup_close_trade`, `leverup_update_margin`, `leverup_update_tpsl`
- `leverup_open_limit_order`, `leverup_cancel_limit_order`
- `wrap`, `unwrap`, `transfer`

**With `agentId`:** Autonomous (no Touch ID)
**Without `agentId`:** Assistant (Touch ID required)

## Capital vs Gas

**CRITICAL:** Sub-agents hold MON **only for gas**, not trading capital.

| Wallet | Holds | Purpose |
|--------|-------|---------|
| User's Smart Account | All trading capital | Source of trade funds |
| Session Key | MON for gas | Pays gas for assistant mode |
| Sub-Agent Wallet | MON for gas only | Pays gas for autonomous mode |

The delegation allows the sub-agent to execute trades on behalf of the user's Smart Account. The trade itself is executed by the Smart Account, not the sub-agent wallet.

## Agent Type Capabilities

Each agent type has a specific delegation scope controlling which contracts/methods it can access:

| Capability | Kairos | Thymos | Pragma |
|------------|--------|--------|--------|
| LeverUp perps | YES | NO | YES |
| nad.fun memecoins | NO | YES | YES |
| DEX swaps | YES | YES | YES |
| Wrap/unwrap MON | YES | YES | YES |
| ERC20 approve | YES | YES | YES |

**Kairos:** Strategic perps trader with swap + wrap capability for collateral management.
**Thymos:** Fast memecoin trader on nad.fun with DEX swap support.
**Pragma:** General-purpose agent with full access to all protocols.

## Sub-Agent Lifecycle

```
create_sub_agent
├── Assigns wallet from pool
├── Creates sub-delegation
├── Funds wallet with MON (default: 1 MON; skipped if already funded)
├── Status: "pending"
└── Returns agentId (UUID)

Spawn via Task tool:
├── Agent calls report_agent_status("running")
├── Status: "running"
└── Agent begins executing task

During operation:
├── Sub-agent passes agentId to trading tools
├── Tools execute via delegation chain
├── Token flows recorded (outflows + inflows per token)
├── Group budgets enforced (MON group, USD group)
└── Gas paid from sub-agent wallet

When done:
├── Agent calls report_agent_status("completed" or "failed")
├── Main Claude calls revoke_sub_agent
├── Returns wallet to pool
└── Remaining gas stays in wallet for next agent
```

## Budget Tracking

Budget enforcement uses two layers: on-chain (hard) and off-chain (soft).

### Static Max Drawdown Model

Budget = maximum net loss the agent can sustain (like prop trading max drawdown).

- **budgetConsumed** = max(0, netOutflow) — only net losses count against budget
- **remaining** = budget - budgetConsumed — capped at original allocation (profits don't increase it)
- If agent profits (netOutflow < 0), full budget is still available
- If agent loses, only the net loss counts (recovered losses free up budget)

**Example:** Agent has 15 LVUSD budget. Opens 2 positions, loses $2, recovers $2. Budget consumed = 0, full 15 LVUSD still available.

### Position Tracking & Reconciliation

Positions opened via `executeAutonomousLeverUpOpen` are tracked in `tracked-positions.json`. When `leverup_list_positions` is called with `agentId`:

1. Positions not in API = keeper-triggered close (TP/SL/liquidation)
2. After 15-block delay, Transfer event logs are queried for settlement inflows
3. Inflows are recorded in the agent's token flow ledger
4. Journal entry logged for the keeper close

This ensures budget accurately reflects net losses even for externally-closed positions.

### Root Delegation = User's Consent Boundary

The root delegation captures what the user authorized via Touch ID. It is the ceiling for ALL sub-agents.

| Parameter | Root Delegation | Sub-Agent |
|-----------|----------------|-----------|
| `budgetMon` | Total MON authorized (ceiling) | This agent's MON allocation |
| `budgetUsd` | Total USD authorized (ceiling) | This agent's USD budget |
| `maxValuePerTx` | User-set per-tx MON cap | Derived: `budgetMon / maxCalls` |
| `maxCalls` | Total calls for ALL agents | This agent's call limit |

Sub-agent creation validates allocations against root:
- `sum(all active sub-agents monAllocated)` must be ≤ root `budgetMon`
- `sum(all active sub-agents usdAllocated)` must be ≤ root `budgetUsd`
- Sub-agent `valueLtePerTx` must be ≤ root `maxValuePerTx`

### On-Chain Enforcement (Hard Limits)

These caveats are embedded in the delegation and enforced by smart contracts:

| Enforcer | Root | Sub-delegation |
|----------|------|----------------|
| `TimestampEnforcer` | `expiryDays` | `expiryDays` |
| `LimitedCallsEnforcer` | `maxCalls` (all agents) | `maxCalls` (this agent) |
| `ValueLteEnforcer` | `maxValuePerTx` (user-specified) | `budgetMon / maxCalls` (derived) |
| `LogicalOrWrapperEnforcer` | All protocols | Agent-specific protocols |

`ValueLteEnforcer` checks `execution.value <= limit` per `redeemDelegations()` call — it validates the value field inside the delegation's Execution struct, not the outer tx's `msg.value`. It only affects native MON sends, not ERC-20 transfers. Setting it to 0 blocks ALL native MON transactions, including Pyth oracle fees required by LeverUp (even with ERC20 collateral like LVUSD/USDC). **Important:** `budgetMon` must be >= 1 for any sub-agent that may use LeverUp, and root `maxValuePerTx` must be > 0.

### Off-Chain Enforcement (Soft Limits)

Tracked in agent state and checked before each trade:

- **MON budget**: `monSpent` vs `monAllocated` — total native MON spent by this agent
- **USD budget**: `groupBudgets.USD` — net outflow across USDC + LVUSD
- **Token allowlist**: `allowedGroups` — restricts which token groups the agent can spend
- **Token flows**: Per-token ledger of inflows and outflows

### Token Flow Ledger

Every trade records both outflows (tokens sent) and inflows (tokens received):

```
tokenFlows: {
  "0x754704...": { out: "5000000", in: "0" },      // USDC: sent 5, received 0
  "0xfd44b3...": { out: "0", in: "4950000000..." }  // LVUSD: sent 0, received ~4.95
}
```

**Token Groups** share budgets across fungible equivalents:
- **MON group** (18 dec canonical): MON, WMON, LVMON
- **USD group** (6 dec canonical): USDC, LVUSD

Net outflow = sum(out - in) across all tokens in group, normalized to canonical decimals.

### Budget Enforcement Flow

- Pre-trade: `checkGroupBudget()` validates the outflow won't exceed group budget
- Pre-trade: `isTokenAllowed()` validates the token is in the agent's allowed groups
- Post-trade: `updateTokenFlows()` records actual flows in the ledger
- Legacy `tokenSpent` and `monSpent` still updated for backwards compatibility

### Token Allowlist (Optional)

Two levels of token restriction (more specific wins):

**Per-token (`allowedTokens`)** — most specific, takes priority:
- Restricts which specific tokens the agent can spend
- Accepts token symbols, resolved to addresses at creation time
- Example: `["LVUSD"]` allows ONLY LVUSD (blocks USDC even though both are in USD group)
- Example: `["USDC", "LVUSD"]` allows both stablecoins

**Per-group (`allowedGroups`)** — broader, used when `allowedTokens` is not set:
- Example: `["MON"]` allows MON/WMON/LVMON spending
- Example: `["USD"]` allows USDC/LVUSD spending

**Shared rules:**
- Tokens acquired during trading (prior inflows) are always sellable
- Native MON always allowed when agent has MON budget (oracle fees, gas)
- Omit both for unrestricted access (backward compatible)

## Sub-Agent Funding

| Tool | Min | Max | Default | Purpose |
|------|-----|-----|---------|---------|
| `create_sub_agent` | 0 | 10 MON | 1 MON | Initial gas funding |
| `fund_sub_agent` | 0.001 | 10 MON | 1 MON | Top up gas |

**Gas Cost Reference:**
- Swap: ~0.14 MON
- Transfer: ~0.04 MON
- Wrap/Unwrap: ~0.04 MON

**1 MON default = ~7 swaps**

## Autonomous Mode Limitations

1. **Sub-agents cannot fund themselves** - Parent (session key) must call `fund_sub_agent`
2. **Budget is soft-enforced** - Agent tracks spending, contract enforces per-tx limits
3. **Delegation has expiry** - Sub-agent stops working when delegation expires
4. **Max calls enforced** - `limitedCalls` caveat limits total delegation calls (trades + approvals)
5. **Decimal normalization** - USD group budget uses 6-decimal canonical; LVUSD (18 dec) is normalized before comparison
6. **LeverUp requires budgetMon >= 1** - All LeverUp trades (even with ERC20 collateral like LVUSD/USDC) send a Pyth oracle fee as `execution.value`. With `budgetMon: 0`, both the off-chain budget check and on-chain `ValueLteEnforcer` block the trade. Only thymos agents (no LeverUp) can use `budgetMon: 0`

## When to Use Which Mode

| Scenario | Mode | Reason |
|----------|------|--------|
| User asks to swap | Assistant | User present, confirm each action |
| Sub-agent trading autonomously | Autonomous | Pre-authorized, no user present |
| Monitoring and alerting | Autonomous | Background operation |
| One-off user request | Assistant | Interactive confirmation |

---

## Creating Sub-Agents (Intent-Based Flow)

When user requests autonomous trading, analyze their intent and propose a tailored configuration.

### Step 0: Check Existing Agents

**ALWAYS run this before creating a new agent.**

```
list_sub_agents(status: "all")
```

If any agents have status `"running"` or `"paused"`:
- These are likely **orphaned from a previous session** (terminal closed, crash, etc.)
- Present to user:

```
Header: "Existing Agent"
Question: "You have an existing [type] agent ([agentId]). It was [mission summary]. What would you like to do?"
Options:
  - Resume agent (Recommended)
  - Clean up and create new
  - Keep it and create new alongside
Description: |
  Status: [running/paused]
  Budget: [X] MON remaining
  Trades: [N] executed / [M] max
  Last active: [timestamp]
```

**If user chooses Resume:**
1. `get_sub_agent_state(subAgentId)` → get taskAgentId
2. `Task({ resume: taskAgentId })` → respawn agent with full context

**If user chooses Clean up:**
1. `revoke_sub_agent(subAgentId, sweepBalance: false)`
2. Continue to Step 1

**If user chooses Keep alongside:**
1. Continue to Step 1 (new agent created in parallel)

If no running/paused agents exist, or only `completed`/`failed`/`pending` agents, proceed to Step 1.

### Step 1: Analyze Intent

Extract configuration from user's request:

**A. Trading Type → agentType**

| Keywords | Agent | Reasoning |
|----------|-------|-----------|
| perps, perpetual, leverage, long, short, BTC/ETH position | `kairos` | LeverUp perps + swap + wrap |
| memecoin, nad.fun, meme, token launch, ape, trending | `thymos` | nad.fun + DEX swap + wrap |
| general, flexible, no specific type | `pragma` | All-purpose (perps + memecoins + swaps) |

**B. Time Keywords → expiryDays**

| Keywords | Duration |
|----------|----------|
| "for an hour", "quick session" | 1 day (minimum) |
| "while I'm away", "AFK" | 1 day |
| "while I sleep", "overnight" | 1 day |
| "for the day", "today" | 1 day |
| "this week" | 7 days |
| No mention | 1 day (default) |

Note: `expiryDays` minimum is 1, maximum is 30. The parameter is in days, not hours.

**C. Scope Keywords → maxCalls**

Each delegation call = 1 `limitedCalls` count. A trade that needs an ERC20 approval first costs 2 calls (approve + execute). First trade per new token always needs an approval call.

| Keywords | Max Calls |
|----------|-----------|
| "single trade", "one position", "if X happens" | 10 |
| "monitor and trade", "when opportunity" | 20 |
| "scalp", "actively trade" | 40-60 |
| "aggressive", "ape everything" | 100+ |
| No mention | 20 (default) |

**D. Gas Funding → Default 1 MON**

`create_sub_agent` checks the pool wallet's existing balance before funding. If the wallet already holds >= `fundAmount`, funding is skipped automatically. Set `fundAmount: 0` to explicitly skip funding.

### Step 2: Check User Balances

**ALWAYS** check balances first to provide context:
```
get_all_balances → User has X MON, Y USDC, Z LVUSD, etc.
```

### Step 3: Ask User for Budget

Use `AskUserQuestion` to get budget (user must specify). These become the root delegation's consent boundary.

```
Header: "MON Budget"
Question: "How much MON should this agent trade with?"
Options:
  - 0 MON (USD-only strategy)
  - 5 MON
  - 10 MON
  - Custom amount
Description: |
  Your balance: X MON

  This is the max MON trading capital. 0 = block all native MON trades.
  ⚠ 0 MON cannot be used with LeverUp (kairos/pragma agents) —
  LeverUp requires native MON for Pyth oracle fees even with
  ERC20 collateral (LVUSD/USDC). Use at least 1 MON for LeverUp.
```

If the user's task involves USD-denominated collateral (e.g., LeverUp with LVUSD/USDC), also ask for USDC budget:

```
Header: "USD Budget"
Question: "How much USD collateral can this agent use?"
Options:
  - 5 USDC
  - 10 USDC
  - 25 USDC
  - Custom amount
Description: |
  Your balance: X USDC + Y LVUSD

  This covers both USDC and LVUSD (they share the USD budget).
```

If the user's task targets specific protocols, also ask about token restrictions:

```
Header: "Allowed Tokens"
Question: "Which tokens can this agent spend?"
Options:
  - MON group only (MON, WMON, LVMON)
  - USD group only (USDC, LVUSD)
  - LVUSD only (blocks USDC — per-token restriction)
  - Both MON + USD groups
  - Unrestricted (Recommended)
Description: |
  Restricts which of your existing holdings the agent can touch.
  Tokens the agent buys during trading can always be sold back.
```

**Budget-Duration Guidance** (share with user during configuration):
- $20 / 24h — Conservative. May produce 0-2 trades. Good for testing agent behavior.
- $100-200 / 3-7 days — Recommended. Enough for 3-10 trades with proper selectivity.
- $500+ / 7-30 days — Ideal for kairos methodology. Full patience model.

Set expectations: Kairos is an analyst first. Some sessions produce zero trades — that's discipline, not failure.

### Step 4: Present Tailored Configuration

Show the complete config for validation:

```
Header: "Autonomous Agent"
Question: "Create agent with this configuration?"
Options:
  - Approve and start (Recommended)
  - Adjust settings
  - Cancel
Description: |
  TASK: [summarize user's task]

  Agent: [type] ([one-line description])
  Budget: [X] MON + [Y] USDC (if applicable)
  Duration: [Z] days
  Max delegation calls: [N] (on-chain trades + approvals only; read-only tools are unlimited)
  Gas: 1 MON

  Why: [brief reasoning for config choices]
```

### Step 5: Handle "Adjust settings"

If user wants to adjust:

```
Header: "Adjust"
Question: "What would you like to change?"
Options:
  - Change budget
  - Change duration
  - Change call limit
  - Change agent type
```

Then ask ONE follow-up for the specific value.

### Step 6: Pre-flight Checks

Before creating the sub-agent:

1. **Root delegation:** Call `check_delegation_status()` (no agentId)
   - If `valid: true` and enough `remaining` calls → proceed
   - If `valid: false`, expired, or insufficient calls → call `create_root_delegation` with:
     - `budgetMon`: Total MON the user authorized
     - `budgetUsd`: Total USD the user authorized (0 if MON-only)
     - `maxValuePerTx`: Per-tx MON cap (derive from budget or ask user)
     - `maxCalls`: Sum of all agents' calls + headroom for approvals
     - `expiryDays`: Based on user's time intent
     - Requires Touch ID (once for all agents)
2. **Session key balance:** Need 1 MON (gas) + ~0.05 MON (delegation tx)
   - Call `check_session_key_balance` to verify
3. **x402 USDC balance (if x402 mode):** Market intelligence tools consume USDC per call
   - Call `check_session_key_balance` and check USDC balance
   - Minimum recommended: 0.50 USDC for monitoring agents, 0.20 USDC for quick trades
   - If USDC is low, warn user: "Session key has X USDC. Market intelligence tools cost $0.01-0.02 per call (charts are free). Monitoring agents may exhaust this in ~Y hours."
   - Soft warning only, not a blocker -- user decides whether to top up

### Step 7: Create Sub-Agent

**Loop Type Inference — decide based on user intent:**

| User Intent | loopType | Example Mission |
|-------------|----------|-----------------|
| "Monitor BTC until 95k then buy" | `condition` | "Monitor BTC/USD. Open long when >= $95,000." |
| "Turn $10 into $20 or $0" | `continuous` | "Trade actively. Target: $20. Stop-loss: $0." |
| "Check portfolio every 2 min" | `interval` | "Check portfolio positions every 2 minutes." |
| "Open a BTC long and close it" | `none` | N/A (one-shot, no loop) |

**One-shot tasks do NOT get loop enforcement.** Only tasks requiring persistence get a loop.

**Mission Construction:**
- Mission is re-injected as the agent's next prompt when the SubagentStop hook blocks exit
- Must be actionable and self-contained (the agent sees ONLY this text when unblocked)
- Include: objective, key conditions, budget context
- Do NOT include generic instructions — the hook appends agent ID and iteration count automatically

```
create_sub_agent(
  agentType: [inferred],
  budgetMon: [user specified],
  budgetUsd: [user specified, optional],
  allowedGroups: [user specified, optional — e.g. ["MON"] or ["MON", "USD"]],
  allowedTokens: [user specified, optional — e.g. ["LVUSD"] or ["USDC", "WMON"]],
  maxCalls: [inferred],
  expiryDays: [calculated],
  fundAmount: 1,
  loopType: [inferred from intent — "none" for one-shot],
  loopCondition: [for condition type],
  loopIntervalMinutes: [for interval type],
  mission: [actionable task text — fed back by hook on each iteration],
  maxIterations: [safety limit, 0 = unlimited]
)
→ Returns agentId (pragma agent ID)
→ Agent status starts as "pending"
→ If loopType != "none", loop.json is created with mission text
```

### Step 8: Spawn Agent

**Note:** The `mission` (in loop.json) and the Task `prompt` serve different purposes:
- **Task prompt**: Full initial instructions with rules, agent ID, all context (seen once at spawn)
- **Mission**: Concise re-prompt fed by the SubagentStop hook each time the agent tries to exit (seen repeatedly)

The mission should be a subset of the prompt — just the core objective and key constraints.

**TASK content rules:**
- State the GOAL and CONSTRAINTS only
- DO NOT include strategy coaching, leverage suggestions, or urgency language
- DO NOT write "you'll likely need higher leverage" or "act aggressively"
- The agent definition handles strategy. Goal pressure from the spawner undermines risk discipline

**8a. Create team (once per spawn session):**

Check if `TeamCreate` tool is available. If yes, create a team:

```
TeamCreate({ team_name: "pragma-{timestamp}" })
```

For multi-agent spawns, create the team ONCE and reuse the same `team_name` for all agents.

If `TeamCreate` is NOT available (older Claude Code version), skip this step and spawn without a team in 8b.

**8b. Spawn agent:**

**With team (preferred):**

```typescript
Task({
  subagent_type: "pragma:kairos", // or pragma:thymos, pragma:pragma
  team_name: "pragma-{timestamp}",
  name: "kairos-{shortId}",       // e.g. "kairos-abc123"
  mode: "bypassPermissions",
  prompt: `... (see prompt template below)`
})
```

**Without team (fallback):**

```typescript
Task({
  subagent_type: "pragma:kairos", // or pragma:thymos, pragma:pragma
  mode: "bypassPermissions",
  run_in_background: true,
  prompt: `... (same prompt template, omit TEAM COMMUNICATION section)`
})
```

**Prompt template:**

```
You are an autonomous trading agent.

YOUR AGENT ID: ${agentId}

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

TEAM COMMUNICATION (include only if spawned with team_name):
You are a teammate. Use SendMessage to notify the leader of key events:
- Trade entries/exits (with P&L)
- Status changes (paused, low gas, budget warning)
- Mission completion or failure
See your Leader Notification Protocol for event types and cadence rules.
Always call MCP state tools FIRST (report_agent_status, write_agent_memo),
then SendMessage. If SendMessage fails, continue without it — MCP state is authoritative.

FIRST ACTION - MANDATORY:
Call report_agent_status(agentId: "${agentId}", status: "running")
This flips your status from "pending" to "running".

BEFORE TERMINATING - MANDATORY:
You MUST call report_agent_status before finishing:
- status: "completed" → Task goal was ACHIEVED
- status: "failed" → Goal NOT achieved (budget depleted, max delegation calls, errors)
- status: "paused" → Low gas, need funding to continue
Include a reason summarizing what happened and key results.

Example:
report_agent_status(
  agentId: "${agentId}",
  status: "completed",
  reason: "Sold 5 tokens for 0.22 MON, kept pragma and WAVE as requested"
)

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

→ Returns taskAgentId

### Step 9: Store Task Agent ID

**CRITICAL:** After spawning, store the Task agent ID:

```
get_sub_agent_state(
  subAgentId: agentId,
  taskAgentId: [taskAgentId from Task response]
)
```

This is needed for:
- `TaskStop(taskId)` during cleanup (both team and non-team)
- `Task({ resume: taskAgentId })` for gas top-up resume (non-team only)

With team spawn, gas resume uses `SendMessage` instead of `Task({ resume })` — teammates stay alive and just need a message to wake up.

---

## Multi-Agent Spawn (Worked Example)

When the user's task spans multiple protocols or strategies, split into specialized agents.

### Example Prompt

> "Trade perps and memecoins overnight with 50 MON and 15 USDC"

### Step 0: Check Existing Agents

Same as single-agent flow — `list_sub_agents(status: "all")`, handle orphans.

### Step 1: Analyze Intent

Two distinct strategies detected:
- **Perps** (LeverUp) → Kairos agent
- **Memecoins** (nad.fun) → Thymos agent

### Step 2: Check Balances

```
get_all_balances → User has 80 MON, 20 USDC, 5 LVUSD
```

### Step 3: Ask User for Budget Split

Use `AskUserQuestion` with multiple tabs to confirm the split:

```
Tab 1:
  Header: "Budget Split"
  Question: "How should we split your 50 MON between agents?"
  Options:
    - 30 MON Kairos / 20 MON Thymos (Recommended)
    - 25 MON / 25 MON (Equal)
    - 40 MON Kairos / 10 MON Thymos
  Description: |
    Kairos (perps) needs more MON for leverage margin.
    Thymos (memecoins) needs less — nad.fun buys are smaller.

Tab 2:
  Header: "USD Budget"
  Question: "How much USD collateral for Kairos perps?"
  Options:
    - 15 USDC (all to Kairos)
    - 10 USDC
    - 5 USDC
  Description: |
    Your balance: 20 USDC + 5 LVUSD
    Thymos trades in MON on nad.fun — doesn't need USD budget.

Tab 3:
  Header: "Allowed Tokens"
  Question: "Restrict which tokens agents can spend?"
  Options:
    - Kairos: MON+USD, Thymos: MON only (Recommended)
    - Both unrestricted
  Description: |
    Kairos needs both MON (margin) and USD (LVUSD/USDC collateral).
    Thymos only uses MON for nad.fun buys.
```

### Step 4: Present Combined Configuration

```
Header: "Multi-Agent Setup"
Question: "Create both agents with this configuration?"
Options:
  - Approve and start (Recommended)
  - Adjust settings
  - Cancel
Description: |
  TASK: Trade perps + memecoins overnight

  Agent 1: Kairos (LeverUp perps)
    Budget: 30 MON + 15 USDC
    Allowed: MON + USD groups
    Max delegation calls: 30 (on-chain trades + approvals), Duration: 1 day
    Loop: continuous

  Agent 2: Thymos (nad.fun memecoins)
    Budget: 20 MON
    Allowed: MON group only
    Max delegation calls: 50 (on-chain trades + approvals), Duration: 1 day
    Loop: continuous

  Root delegation needs:
    budgetMon: 50, budgetUsd: 15
    maxCalls: 100 (30 + 50 + headroom for approvals)
    maxValuePerTx: 5 MON
  Gas: 1 MON each (from session key)
```

### Step 5: Pre-flight — Root Delegation Sizing

**Key:** Root delegation is the user's consent boundary. `maxCalls` must cover ALL agents combined. `budgetMon` and `budgetUsd` are the ceilings for all sub-agent allocations.

```
check_delegation_status()
→ If valid and remaining >= 100 → proceed
→ If remaining < 100 or expired →
    create_root_delegation(
      budgetMon: 50,
      budgetUsd: 15,
      maxValuePerTx: 5,
      maxCalls: 100,  ← ~2x actual trades for approval calls
      expiryDays: 1
    )
    → Requires Touch ID (once for both agents)
```

**Headroom explanation:** Gas funding (`fund_sub_agent`) is a plain EOA transfer that does NOT consume delegation calls. Headroom accounts for ERC20 approval calls — each new token approval costs 1 extra call.

### Step 6: Create Team & Sequential Spawn

Create the team first (if `TeamCreate` is available), then create agents one at a time. If agent 1 fails, don't create agent 2.

```
TeamCreate({ team_name: "pragma-{timestamp}" })
```

**Agent 1 — Kairos:**
```
create_sub_agent(
  agentType: "kairos",
  budgetMon: 30,
  budgetUsd: 15,
  allowedGroups: ["MON", "USD"],
  maxCalls: 30,
  expiryDays: 1,
  fundAmount: 1,
  loopType: "continuous",
  mission: "Trade perps on LeverUp. Budget: 30 MON + 15 USDC. Goal: profit overnight.",
  maxIterations: 0
)
→ Returns kairosAgentId
```

Spawn Kairos via Task tool (Step 8 from single-agent flow, using same `team_name`).

**Agent 2 — Thymos:**
```
create_sub_agent(
  agentType: "thymos",
  budgetMon: 20,
  allowedGroups: ["MON"],
  maxCalls: 50,
  expiryDays: 1,
  fundAmount: 1,
  loopType: "continuous",
  mission: "Trade memecoins on nad.fun. Budget: 20 MON. Goal: profit overnight.",
  maxIterations: 0
)
→ Returns thymosAgentId
```

Spawn Thymos via Task tool (same `team_name` as Kairos).

### Step 7: Report to User

```
Both agents are running:

  Kairos (perps): 30 MON + 15 USDC, 30 calls, expires in 1 day
  Thymos (memecoins): 20 MON, 50 calls, expires in 1 day

  Root delegation: 80/100 calls allocated

  Use list_sub_agents to check status.
  To stop an agent: first TaskStop(taskId), then revoke_sub_agent(subAgentId).
  To stop everything: TaskStop all agents, then revoke_root_delegation.
```

### Multi-Agent Rules

1. **One root delegation, many sub-agents** — Size root `maxCalls` for the sum of all agents plus headroom for approval calls
2. **Sequential creation** — Create and spawn one agent at a time; abort remaining if one fails
3. **Independent operation with team communication** — Each agent has its own budget, strategy, and decision-making. When spawned as teammates, agents use `SendMessage` to notify the leader of key events (trades, status changes). Without a team, agents rely on MCP state tools only (`report_agent_status`, `write_agent_memo`). Agent-to-agent messages are informational only — no agent can command another agent to trade.
4. **Independent budgets** — Each agent has its own budget, allowlist, and trade limit
5. **Individual cleanup** — Revoke agents individually via `revoke_sub_agent`, or all at once via `revoke_root_delegation`

---

## Gas Depletion → Fund → Resume Flow

When a sub-agent runs low on gas (< 0.1 MON):

1. **Sub-agent reports status and stops:**
   ```
   report_agent_status(
     agentId: [agentId],
     status: "paused",
     reason: "Low gas (0.08 MON). Progress: [what was accomplished]"
   )
   ```

2. **Main Claude funds:**
   ```
   fund_sub_agent(subAgentId: [agentId], amountMon: 1)
   ```

3. **Main Claude resumes the agent:**

   **With team** (teammate is idle, waiting for a message):
   ```
   SendMessage(type: "message", recipient: agent-name, content: "Funded 1 MON. Continue your task.", summary: "Funded 1 MON gas")
   ```
   Teammates stay alive between turns. SendMessage wakes them up — no need for Task resume.

   **Without team** (background task needs Task resume):
   ```
   Task({ resume: [taskAgentId], prompt: "Continue your task" })
   ```
   The `taskAgentId` comes from `get_sub_agent_state` (stored in Step 9).

---

## Sub-Agent Management

### Listing Agents
```
list_sub_agents(status: "all" | "pending" | "running" | "paused" | "completed" | "failed" | "revoked")
- Shows all agents with status, budget remaining, trades executed, taskAgentId
- Filter by status to find specific agents
- Summary includes pending count
```

### Checking Agent State
```
get_sub_agent_state(subAgentId, taskAgentId?)
- Full details: wallet balance, delegation, budget breakdown, recent trades
- Includes tokenFlows (per-token in/out/net) and groupBudgets (per-group utilization)
- Budget display uses static max drawdown model:
  - budgetConsumed = max(0, netOutflow) — only net losses count
  - remaining = budget - budgetConsumed — capped at original budget
  - pnl = -netOutflow — positive means profit
  - trackedPositions count shown per group
- Pass taskAgentId to store it for TaskStop and resume (non-team fallback)
```

### Reporting Agent Status
```
report_agent_status(agentId, status, reason?)
- Sub-agents call this to report their status
- Required statuses: running, paused, completed, failed
- "running" = flip from pending when agent starts
- "completed" = goal achieved, "failed" = goal not achieved
- When reason is provided, it is persisted to the agent's journal:
  - status "running" → logged as "reasoning" type
  - other statuses → logged as "status" type
```

### Writing Agent Memos
```
write_agent_memo(agentId, text, tag?)
- Persists structured state to the agent's journal (type: "memo")
- Zero cost — pure file append, no delegation calls consumed
- Tags for categorization: baseline, watchlist, trade_plan, position_health, scan_result, post_trade
- Read back with get_agent_log(tag: "...") for filtered retrieval
- Survives context compaction — use for data that must persist across long sessions
```

### Viewing Agent Journal
```
get_agent_log(agentId, offset?, limit?, tag?)
- Returns paginated journal entries (newest first)
- Includes: trade events, reasoning, status changes, memos, errors
- Filter by tag to retrieve specific entry types (e.g. "baseline", "watchlist", "trade_plan")
- Default: 50 entries, max: 200 per request
- Use offset for pagination through older entries
```

### Listing Positions with Reconciliation
```
leverup_list_positions(address?, agentId?)
- When agentId is provided, reconciles tracked positions:
  - Links new positions to tradeHash
  - Detects keeper-triggered closes (TP/SL/liquidation)
  - Records settlement inflows after 15-block delay
  - Journals keeper close events automatically
- Sub-agents should pass agentId when checking positions
```

### Listing Wallet Pool
```
list_wallet_pool()
- Shows all wallets in the pool with assignment status
- Useful for debugging wallet allocation issues
```

### Checking Delegation Status
```
check_delegation_status(agentId?)
- If no agentId: checks root delegation status
- If agentId provided: checks sub-agent delegation
- Returns on-chain call count (used/remaining/exhausted)
- Returns expiry info and validity
```

### Funding More Gas
```
fund_sub_agent(subAgentId, amountMon)
- Transfers MON from session key to sub-agent wallet
- Default: 1 MON, Max: 10 MON
- Sub-agents CANNOT fund themselves
```

### Cleaning Up an Agent
```
revoke_sub_agent(subAgentId, sweepBalance?)
- Archives agent state to `~/.pragma/agents/archive/` (trade history preserved)
- sweepBalance: false (default) keeps gas in wallet for reuse
             true sweeps gas back to session key
- For on-chain invalidation, use revoke_root_delegation(revocationMode: "onchain")
  which cascades to ALL sub-delegations via NonceEnforcer nonce increment.
- Returns wallet to pool for reuse
```

### Revoking Root Delegation
```
revoke_root_delegation(confirm: true, revocationMode?)
- Revokes root delegation entirely
- revocationMode: "local" (default) deletes local delegation files only
                  "onchain" increments NonceEnforcer nonce via UserOp (Touch ID required),
                  invalidating ALL delegations on-chain, then performs local cleanup.
                  Use "onchain" if session key may be compromised or for immediate on-chain invalidation.
- Archives ALL sub-agent states
- Releases ALL wallets to pool
- Stops caffeinate
- After this, no autonomous trading until new root delegation created
```

---

## Agent Status & Lifecycle

### Status Definitions

| Status | Meaning | Who Sets It |
|--------|---------|-------------|
| `pending` | Created but not yet started (Task not spawned or agent hasn't reported running) | System (create_sub_agent) |
| `running` | Agent is actively working on its task | Sub-agent (report_agent_status) |
| `paused` | Temporarily stopped, can resume (e.g., low gas) | Sub-agent |
| `completed` | User's goal was **achieved** | Sub-agent |
| `failed` | User's goal was **NOT achieved** (any reason) | Sub-agent or system |
| `revoked` | Main Claude stopped/cleaned up the agent | Main Claude |

**Key Rules:**
- `pending` is the initial status set by `create_sub_agent`
- Agents MUST call `report_agent_status("running")` as their first action
- `completed` means SUCCESS - the user's goal was reached
- All other terminations where the goal wasn't achieved use `failed`

### Status Flow

```
create_sub_agent → "pending"
                       │
         agent starts  ▼
report_agent_status → "running"
                       │
              ┌────────┼────────┐
              ▼        ▼        ▼
         "completed" "failed" "paused"
                                │
                     fund + resume
                                │
                                ▼
                           "running"
```

### Reporting Status

Sub-agents use `report_agent_status` for ALL status updates:

```
report_agent_status(
  agentId: "xyz-123",
  status: "completed" | "failed" | "paused" | "running",
  reason: "Optional explanation"
)
```

**Examples:**
- `running` + (no reason needed, first action after spawn)
- `completed` + "Target reached - opened BTC long at $95,200"
- `failed` + "Delegation expired before target was hit"
- `failed` + "Max delegation calls reached (10/10) - target not achieved"
- `failed` + "Budget depleted"
- `paused` + "Low gas - 0.05 MON remaining"

### Lazy Expiry Detection

When any tool loads an agent's state, it automatically checks if the delegation has expired. If expired and status is still `pending`, `running`, or `paused`, it's auto-updated to `failed`.

### Cleanup Responsibility Matrix

| Termination Case | Who Reports | Final Status | Cleanup By |
|------------------|-------------|--------------|------------|
| Task achieved | Sub-agent | `completed` | Main Claude |
| Delegation expired | System (lazy) | `failed` | Main Claude |
| Max delegation calls reached | Sub-agent | `failed` | Main Claude |
| Budget depleted | Sub-agent | `failed` | Main Claude |
| Low gas (recoverable) | Sub-agent | `paused` | Fund → SendMessage (team) or Task resume (non-team) |
| User kills process | N/A | unchanged | Main Claude |
| Never spawned | N/A | `pending` | Main Claude |

### Agent Cleanup Flow

When a sub-agent terminates (for any reason), Main Claude handles cleanup:

```
1. Receive notification that agent finished/killed
   With team: teammate sends SendMessage or goes idle (auto-notification)
   Without team: Task background notification

2. Check agent state (optional - for logging):
   get_sub_agent_state(subAgentId)
   → Note the final status and reason

2b. If team context active (agent was spawned with team_name):
    SendMessage(type: "shutdown_request", recipient: agent-name)
    Wait for shutdown_response (approve)

3. Kill the Task process (MUST do before revoke):
   TaskStop(taskId)
   → The taskId is from the original Task() call that spawned the agent
   → If the agent already exited naturally, TaskStop is a no-op

4. Clean up resources:
   revoke_sub_agent(subAgentId, sweepBalance: false)
   → Archives agent state
   → Releases wallet to pool
   → Keeps gas in wallet for reuse

4b. Check for orphaned on-chain artifacts:
    leverup_list_limit_orders(address: <smart_account>)
    leverup_list_positions(address: <smart_account>)
    → If pending limit orders exist from this agent, cancel them:
      leverup_cancel_limit_order(orderHash)
    → If open positions exist, inform the user and ask whether to close or manage manually
    → This step prevents unmanaged positions/orders from lingering after agent shutdown
    IMPORTANT: Query the smart account (delegator), not the agent wallet (session key).

5. Report to user:
   "Agent finished: [status] - [reason]"

6. If this was the LAST active agent:
   list_sub_agents → check for any remaining active agents
   If none remain:
   revoke_root_delegation → clean up on-chain delegation
   → Only when ALL agents are done, never between agents

7. If team context active and ALL agents are shut down:
   TeamDelete()
   → Removes team + task directories
   → Skip if agents were spawned without a team
```

**IMPORTANT:** Always TaskStop before revoke. `revoke_sub_agent` only archives state files and releases the wallet — it does NOT kill the running Task process. Without TaskStop, the agent becomes a zombie (running but with revoked permissions).

### Agent Status Report

When the user asks for an update on running agents ("how's my agent doing?", "status update",
"check on kairos"), follow this procedure:

**Step 1: List all agents**

    list_sub_agents → identify running agents, status, budget summary

**Step 2: For each running agent, get state + journal**

    get_sub_agent_state(subAgentId, includeTrades: true)  → budget, trades, errors, timing
    get_agent_log(agentId, limit: 20)                      → recent reasoning + trade events

**Team-spawned agents:** If agents were spawned via TeammateTool, recent SendMessage notifications may already be visible in the leader's context. Cross-reference with journal for completeness — journal is authoritative, messages are informational.

**Step 3: Check on-chain exposure (agent-type dependent)**

| Agent Type | Tools to Call |
|------------|--------------|
| **Kairos** (perps) | `leverup_list_positions(address: <smart_account>)` + `leverup_list_limit_orders(address: <smart_account>)` |
| **Thymos** (memecoins) | `nadfun_positions` + `get_all_balances(address: <smart_account>)` |
| **Pragma** (general) | `get_all_balances(address: <smart_account>)` + check based on mission (perps → leverup, memecoins → nadfun) |

IMPORTANT: Query the **smart account** (delegator), not the agent wallet (session key).
Positions and orders live on the smart account.

**Step 4: Present unified summary (per agent)**

```
Agent: {type}-{shortId} | {status} | {expiresIn} remaining
Budget: {spent}/{total} {token} | {tradesExecuted}/{maxTrades} trades | {errorCount} errors

[If Kairos with position:]
Position: {pair} {side} {leverage}x
  Entry ${entry} | PnL {pnl} ({pnlPct})
  SL ${sl} | TP ${tp}
  Liq ${liq} ({liqDistance} away)

[If Kairos with pending limit:]
Pending: {pair} {side} {leverage}x @ ${trigger}
  SL ${sl} | TP ${tp}

[If Thymos with holdings:]
Holdings: {token1} ({pnl1}), {token2} ({pnl2}), ...

Recent: (last 3 journal entries)
  {time} — {summary}
```

For multiple agents, add portfolio summary:

```
Portfolio: {totalAgents} agents | {totalExposure} total exposure | {netPnl} net PnL
```

### When User Kills Agent Process

If the user manually kills a running Task:

1. Main Claude receives kill notification
2. Task is already dead — skip TaskStop
3. Main Claude cleans up:
   ```
   revoke_sub_agent(subAgentId, sweepBalance: false)
   ```

### Paused Agent → Fund → Resume

When a sub-agent pauses due to low gas:

1. **Agent reports:** `report_agent_status(..., status: "paused", reason: "Low gas")`
2. **Main Claude funds:** `fund_sub_agent(subAgentId, 1)`
3. **Main Claude updates status:** `report_agent_status(..., status: "running")`
4. **Main Claude resumes:**
   - **With team:** `SendMessage(type: "message", recipient: agent-name, content: "Funded 1 MON. Continue.", summary: "Funded gas")`
   - **Without team:** `Task({ resume: taskAgentId })`

---

## Example: Full Autonomous Flow

**User:** "Monitor BTC and open a long if it breaks $95k, I'll be AFK for a few hours"

**Claude analyzes:**
- "long" → kairos (perps + swap + wrap)
- "AFK for a few hours" → 1 day expiry
- "if it breaks $95k" → single position → 10 max calls (5 trades + approvals)

**Claude:**
1. `get_all_balances` → User has 50 MON, 10 LVUSD
2. `AskUserQuestion` → "How much MON?" → User: "10 MON"
3. `AskUserQuestion` → "USD budget for collateral?" → User: "10 USDC"
4. `AskUserQuestion` → "Create kairos agent: 10 MON + 10 USDC budget, 1 day, 10 calls?" → User: "Approve"
5. `check_delegation_status()` → valid, 80 calls remaining → proceed
6. `create_sub_agent(kairos, 10 MON, 10 USDC, 10 calls, 1 day)` → agentId: "xyz-123", status: "pending"
7. `TeamCreate({ team_name: "pragma-1738900000" })` → team created
8. `Task({ subagent_type: "pragma:kairos", team_name: "pragma-1738900000", name: "kairos-xyz123", mode: "bypassPermissions", prompt: "Monitor BTC..." })` → taskAgentId: "a32dec1"
9. `get_sub_agent_state(xyz-123, taskAgentId: a32dec1)` → stores for TaskStop
10. Report: "Kairos agent monitoring BTC for breakout above $95k."

**Agent starts:**
1. `report_agent_status("xyz-123", "running")` → pending → running

**Later (gas depleted):**

1. Agent sends: `SendMessage` → "Low gas (0.08 MON), pausing"
2. `fund_sub_agent("xyz-123", 1)`
3. `SendMessage(recipient: "kairos-xyz123", content: "Funded 1 MON. Continue.")` → agent wakes up
