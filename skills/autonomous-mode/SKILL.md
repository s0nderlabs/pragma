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
  - mcp__pragma__get_all_balances
  - mcp__pragma__check_session_key_balance
  - mcp__pragma__fund_session_key
  - AskUserQuestion
  - Read
  - Task
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

### MON Budget (On-chain + Off-chain)

- `budgetMon` sets the total MON allocation
- On-chain enforced via `valueLte` caveat (per-tx limit × maxTrades)
- Off-chain tracked via `monSpent` and `tokenFlows`

### USD Budget (Off-chain, Ledger-based)

- `budgetUsdc` sets the USD group budget (optional)
- Tracked via `groupBudgets.USD` using canonical 6-decimal precision
- Covers both USDC (6 decimals) and LVUSD (18 decimals)
- Amounts normalized to canonical decimals before comparison

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

### Budget Enforcement

- Pre-trade: `checkGroupBudget()` validates the outflow won't exceed group budget
- Post-trade: `updateTokenFlows()` records actual flows in the ledger
- Legacy `tokenSpent` and `monSpent` still updated for backwards compatibility

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
4. **Max trades enforced** - `limitedCalls` caveat limits total operations
5. **Decimal normalization** - USD group budget uses 6-decimal canonical; LVUSD (18 dec) is normalized before comparison

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

**C. Scope Keywords → maxTrades**

| Keywords | Max Trades |
|----------|------------|
| "single trade", "one position", "if X happens" | 5 |
| "monitor and trade", "when opportunity" | 10 |
| "scalp", "actively trade" | 20-30 |
| "aggressive", "ape everything" | 50+ |
| No mention | 10 (default) |

**D. Gas Funding → Default 1 MON**

`create_sub_agent` checks the pool wallet's existing balance before funding. If the wallet already holds >= `fundAmount`, funding is skipped automatically. Set `fundAmount: 0` to explicitly skip funding.

### Step 2: Check User Balances

**ALWAYS** check balances first to provide context:
```
get_all_balances → User has X MON, Y USDC, Z LVUSD, etc.
```

### Step 3: Ask User for Budget

Use `AskUserQuestion` to get budget (user must specify):

```
Header: "Budget"
Question: "How much MON should this agent trade with?"
Options:
  - 5 MON
  - 10 MON
  - 25 MON
  - Custom amount
Description: |
  Your balance: X MON

  This is the max trading capital for the agent.
  Unused budget stays in your wallet.
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
  Max trades: [N]
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
  - Change trade limit
  - Change agent type
```

Then ask ONE follow-up for the specific value.

### Step 6: Pre-flight Checks

Before creating the sub-agent:

1. **Root delegation:** Call `check_delegation_status()` (no agentId)
   - If `valid: true` and enough `remaining` calls → proceed
   - If `valid: false`, expired, or insufficient calls → call `create_root_delegation` (requires Touch ID)
2. **Session key balance:** Need 1 MON (gas) + ~0.05 MON (delegation tx)
   - Call `check_session_key_balance` to verify
3. **x402 USDC balance (if x402 mode):** Market intelligence tools consume USDC per call
   - Call `check_session_key_balance` and check USDC balance
   - Minimum recommended: 0.50 USDC for monitoring agents, 0.20 USDC for quick trades
   - If USDC is low, warn user: "Session key has X USDC. Market intelligence tools cost $0.005-0.02 per call. Monitoring agents may exhaust this in ~Y hours."
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
  budgetUsdc: [user specified, optional],
  maxTrades: [inferred],
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

### Step 8: Spawn via Task Tool

**Note:** The `mission` (in loop.json) and the Task `prompt` serve different purposes:
- **Task prompt**: Full initial instructions with rules, agent ID, all context (seen once at spawn)
- **Mission**: Concise re-prompt fed by the SubagentStop hook each time the agent tries to exit (seen repeatedly)

The mission should be a subset of the prompt — just the core objective and key constraints.

```typescript
Task({
  subagent_type: "pragma:kairos", // or pragma:thymos, pragma:pragma
  prompt: `
    You are an autonomous trading agent.

    YOUR AGENT ID: ${agentId}

    CRITICAL RULES:
    1. ALWAYS pass agentId: "${agentId}" to ALL trading tools
    2. NEVER trigger Touch ID - if prompted, you forgot agentId
    3. You CANNOT fund yourself - if gas < 0.1 MON, report and stop
    4. Stop when budget depleted or max trades reached
    5. Market intelligence tools cost USDC via x402 (sorted by cost):
       - market_get_critical_news: $0.02
       - market_search_news: $0.015
       - market_get_currency_strength: $0.01
       - market_get_economic_events: $0.01
       - market_get_chart: $0.005
       - RPC calls: $0.001-0.002
       Be conservative with expensive calls. In monitoring loops:
       - Prefer chart ($0.005) over news ($0.02) for routine checks
       - Run full macro scans only at start and before entries, not every cycle
       - Limit full analysis cycles to every 15-20 minutes

    FIRST ACTION - MANDATORY:
    Call report_agent_status(agentId: "${agentId}", status: "running")
    This flips your status from "pending" to "running".

    BEFORE TERMINATING - MANDATORY:
    You MUST call report_agent_status before finishing:
    - status: "completed" → Task goal was ACHIEVED
    - status: "failed" → Goal NOT achieved (budget depleted, max trades, errors)
    - status: "paused" → Low gas, need funding to continue
    Include a reason summarizing what happened and key results.

    Example:
    report_agent_status(
      agentId: "${agentId}",
      status: "completed",
      reason: "Sold 5 tokens for 0.22 MON, kept pragma and WAVE as requested"
    )

    TASK: ${userTask}

    BUDGET: ${budgetMon} MON + ${budgetUsdc} USDC
    MAX TRADES: ${maxTrades}
    EXPIRES: ${expiresAt}
  `,
  run_in_background: true
})
→ Returns taskAgentId (for resume)
```

### Step 9: Store Task Agent ID

**CRITICAL:** After spawning, store the Task agent ID for resume capability:

```
get_sub_agent_state(
  subAgentId: agentId,
  taskAgentId: [taskAgentId from Task response]
)
```

This enables resuming the agent after gas top-up.

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

3. **Main Claude resumes:**
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
- Pass taskAgentId to store it for resume capability
```

### Reporting Agent Status
```
report_agent_status(agentId, status, reason?)
- Sub-agents call this to report their status
- Required statuses: running, paused, completed, failed
- "running" = flip from pending when agent starts
- "completed" = goal achieved, "failed" = goal not achieved
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
- Deletes agent state (no history kept for revoked agents)
- sweepBalance: false (default) keeps gas in wallet for reuse
             true sweeps gas back to session key
- Returns wallet to pool for reuse
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
- `failed` + "Max trades reached (10/10) - target not achieved"
- `failed` + "Budget depleted"
- `paused` + "Low gas - 0.05 MON remaining"

### Lazy Expiry Detection

When any tool loads an agent's state, it automatically checks if the delegation has expired. If expired and status is still `pending`, `running`, or `paused`, it's auto-updated to `failed`.

### Cleanup Responsibility Matrix

| Termination Case | Who Reports | Final Status | Cleanup By |
|------------------|-------------|--------------|------------|
| Task achieved | Sub-agent | `completed` | Main Claude |
| Delegation expired | System (lazy) | `failed` | Main Claude |
| Max trades reached | Sub-agent | `failed` | Main Claude |
| Budget depleted | Sub-agent | `failed` | Main Claude |
| Low gas (recoverable) | Sub-agent | `paused` | Fund → Resume |
| User kills process | N/A | unchanged | Main Claude |
| Never spawned | N/A | `pending` | Main Claude |

### Agent Cleanup Flow

When a sub-agent terminates (for any reason), Main Claude handles cleanup:

```
1. Receive Task notification that agent finished/killed

2. Check agent state (optional - for logging):
   get_sub_agent_state(subAgentId)
   → Note the final status and reason

3. Clean up resources:
   revoke_sub_agent(subAgentId, sweepBalance: false)
   → Deletes agent state
   → Releases wallet to pool
   → Keeps gas in wallet for reuse

4. Report to user:
   "Agent finished: [status] - [reason]"
```

### When User Kills Agent Process

If the user manually kills a running Task:

1. Main Claude receives kill notification
2. Main Claude cleans up:
   ```
   revoke_sub_agent(subAgentId, sweepBalance: false)
   ```

### Paused Agent → Fund → Resume

When a sub-agent pauses due to low gas:

1. **Agent reports:** `report_agent_status(..., status: "paused", reason: "Low gas")`
2. **Main Claude funds:** `fund_sub_agent(subAgentId, 1)`
3. **Main Claude updates status:** `report_agent_status(..., status: "running")`
4. **Main Claude resumes:** `Task({ resume: taskAgentId })`

---

## Example: Full Autonomous Flow

**User:** "Monitor BTC and open a long if it breaks $95k, I'll be AFK for a few hours"

**Claude analyzes:**
- "long" → kairos (perps + swap + wrap)
- "AFK for a few hours" → 1 day expiry
- "if it breaks $95k" → single position → 5 max trades

**Claude:**
1. `get_all_balances` → User has 50 MON, 10 LVUSD
2. `AskUserQuestion` → "How much MON?" → User: "10 MON"
3. `AskUserQuestion` → "USD budget for collateral?" → User: "10 USDC"
4. `AskUserQuestion` → "Create kairos agent: 10 MON + 10 USDC budget, 1 day, 5 trades?" → User: "Approve"
5. `check_delegation_status()` → valid, 80 calls remaining → proceed
6. `create_sub_agent(kairos, 10 MON, 10 USDC, 5 trades, 1 day)` → agentId: "xyz-123", status: "pending"
7. `Task(prompt: "Monitor BTC...")` → taskAgentId: "a32dec1"
8. `get_sub_agent_state(xyz-123, taskAgentId: a32dec1)` → stores for resume
9. Report: "Kairos agent monitoring BTC for breakout above $95k."

**Agent starts:**
1. `report_agent_status("xyz-123", "running")` → pending → running

**Later (gas depleted):**

1. Agent reports: "Low gas, agentId: xyz-123"
2. `fund_sub_agent("xyz-123", 1)`
3. `get_sub_agent_state("xyz-123")` → get taskAgentId: "a32dec1"
4. `Task({ resume: "a32dec1" })` → agent continues
