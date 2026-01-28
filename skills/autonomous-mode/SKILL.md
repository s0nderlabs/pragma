---
name: autonomous-mode
description: Manages autonomous trading agents. Use when user mentions autonomous, sub-agent, background trading, AFK trading, monitoring while away, spawn agent, create agent, delegate trading, or hands-free trading.
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

3. Sub-agent executes trades
   └── Passes agentId to trading tools
   └── Tool uses delegation chain (no Touch ID)
   └── User's Smart Account executes the trade
   └── Sub-agent pays gas from its wallet
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

## Sub-Agent Lifecycle

```
create_sub_agent
├── Assigns wallet from pool
├── Creates sub-delegation
├── Funds wallet with MON (default: 1 MON)
└── Returns agentId (UUID)

During operation:
├── Sub-agent passes agentId to trading tools
├── Tools execute via delegation chain
└── Gas paid from sub-agent wallet

When done:
├── close_sub_agent
├── Returns wallet to pool
└── Remaining gas stays in wallet for next agent
```

## Sub-Agent Funding

| Tool | Min | Max | Default | Purpose |
|------|-----|-----|---------|---------|
| `create_sub_agent` | 0 | 10 MON | 1 MON | Initial gas funding |
| `fund_sub_agent` | 0.001 | 10 MON | 1 MON | Top up gas |

**Gas Cost Reference:**
- Swap: ~0.14 MON
- Transfer: ~0.04 MON
- Wrap/Unwrap: ~0.04 MON

**1 MON default ≈ 7 swaps**

## Autonomous Mode Limitations

1. **Sub-agents cannot fund themselves** - Parent (session key) must call `fund_sub_agent`
2. **Budget is soft-enforced** - Agent tracks spending, contract enforces per-tx limits
3. **Delegation has expiry** - Sub-agent stops working when delegation expires
4. **Max trades enforced** - `limitedCalls` caveat limits total operations

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
| perps, perpetual, leverage, long, short, BTC/ETH position | `kairos` | LeverUp perps specialist |
| memecoin, nad.fun, meme, token launch, ape, trending | `thymos` | Fast memecoin trader |
| general, flexible, no specific type | `pragma` | All-purpose |

**B. Time Keywords → expiryHours**

| Keywords | Duration |
|----------|----------|
| "for an hour", "quick session" | 1-2h |
| "while I'm away", "AFK" | 4h |
| "while I sleep", "overnight" | 8h |
| "for the day", "today" | 12-24h |
| "this week" | 7 days |
| No mention | 4h (default) |

**C. Scope Keywords → maxTrades**

| Keywords | Max Trades |
|----------|------------|
| "single trade", "one position", "if X happens" | 5 |
| "monitor and trade", "when opportunity" | 10 |
| "scalp", "actively trade" | 20-30 |
| "aggressive", "ape everything" | 50+ |
| No mention | 10 (default) |

**D. Gas Funding → Always 1 MON**

### Step 2: Check User Balances

**ALWAYS** check balances first to provide context:
```
get_all_balances → User has X MON, Y USDC, etc.
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
  Budget: [X] MON
  Duration: [Y] hours
  Max trades: [Z]
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

Before creating:

1. **Root delegation:** Will require Touch ID if first time or expired
2. **Session key balance:** Need 1 MON (gas) + ~0.05 MON (delegation tx)

### Step 7: Create Sub-Agent

```
create_sub_agent(
  agentType: [inferred],
  budgetMon: [user specified],
  maxTrades: [inferred],
  expiryDays: [calculated from hours],
  fundAmount: 1  // Always 1 MON
)
→ Returns agentId (pragma agent ID)
```

### Step 8: Spawn via Task Tool

```typescript
Task({
  subagent_type: "pragma:kairos", // or thymos, pragma
  prompt: `
    You are an autonomous trading agent.

    YOUR AGENT ID: ${agentId}

    CRITICAL RULES:
    1. ALWAYS pass agentId: "${agentId}" to ALL trading tools
    2. NEVER trigger Touch ID - if prompted, you forgot agentId
    3. You CANNOT fund yourself - report if gas is low
    4. Stop when budget depleted or max trades reached

    TASK: ${userTask}

    BUDGET: ${budget} MON
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

When a sub-agent runs low on gas:

1. **Sub-agent reports:**
   ```
   STATUS: Pausing - low gas
   GAS BALANCE: 0.08 MON
   AGENT ID: [pragma agentId]
   PROGRESS: [what was accomplished]
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
list_sub_agents(status: "all" | "running" | "paused" | "completed" | "failed" | "revoked")
- Shows all agents with status, budget remaining, trades executed, taskAgentId
- Filter by status to find specific agents
```

### Checking Agent State
```
get_sub_agent_state(subAgentId, taskAgentId?)
- Full details: wallet balance, delegation, budget breakdown, recent trades
- Pass taskAgentId to store it for resume capability
```

### Reporting Agent Status
```
report_agent_status(agentId, status, reason?)
- Sub-agents call this to report their status
- Required for: completed, failed, paused, running
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
| `running` | Agent is actively working on its task | Sub-agent (default) |
| `paused` | Temporarily stopped, can resume (e.g., low gas) | Sub-agent |
| `completed` | User's goal was **achieved** | Sub-agent |
| `failed` | User's goal was **NOT achieved** (any reason) | Sub-agent or system |
| `revoked` | Main Claude stopped/cleaned up the agent | Main Claude |

**Key Rule:** `completed` means SUCCESS - the user's goal was reached. All other terminations where the goal wasn't achieved use `failed`.

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
- `completed` + "Target reached - opened BTC long at $95,200"
- `failed` + "Delegation expired before target was hit"
- `failed` + "Max trades reached (10/10) - target not achieved"
- `failed` + "Budget depleted"
- `paused` + "Low gas - 0.05 MON remaining"

### Lazy Expiry Detection

When any tool loads an agent's state, it automatically checks if the delegation has expired. If expired and status is still `running` or `paused`, it's auto-updated to `failed`.

### Cleanup Responsibility Matrix

| Termination Case | Who Reports | Final Status | Cleanup By |
|------------------|-------------|--------------|------------|
| Task achieved | Sub-agent | `completed` | Main Claude |
| Delegation expired | System (lazy) | `failed` | Main Claude |
| Max trades reached | Sub-agent | `failed` | Main Claude |
| Budget depleted | Sub-agent | `failed` | Main Claude |
| Low gas (recoverable) | Sub-agent | `paused` | Fund → Resume |
| User kills process | N/A | unchanged | Main Claude |

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
- "long" → kairos (perps)
- "AFK for a few hours" → 4h duration
- "if it breaks $95k" → single position → 5 max trades

**Claude:**
1. `get_all_balances` → User has 50 MON
2. `AskUserQuestion` → "How much MON?" → User: "10 MON"
3. `AskUserQuestion` → "Create kairos agent: 10 MON budget, 4h, 5 trades?" → User: "Approve"
4. `create_sub_agent(kairos, 10 MON, 5 trades, 4h)` → agentId: "xyz-123"
5. `Task(prompt: "Monitor BTC...")` → taskAgentId: "a32dec1"
6. `get_sub_agent_state(xyz-123, taskAgentId: a32dec1)` → stores for resume
7. Report: "Kairos agent monitoring BTC for breakout above $95k."

**Later (gas depleted):**

1. Agent reports: "Low gas, agentId: xyz-123"
2. `fund_sub_agent("xyz-123", 1)`
3. `get_sub_agent_state("xyz-123")` → get taskAgentId: "a32dec1"
4. `Task({ resume: "a32dec1" })` → agent continues
