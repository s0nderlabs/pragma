---
name: pragma-core
description: Operates pragma wallet for on-chain trading. Executes swaps, transfers, staking, balance checks, and wallet management. Use when user mentions pragma, wallet, balance, portfolio, swap, trade, buy, sell, transfer, send, stake, unstake, wrap, unwrap, tokens, or DeFi operations.
allowed-tools:
  - mcp__pragma__has_wallet
  - mcp__pragma__has_providers
  - mcp__pragma__get_balance
  - mcp__pragma__get_all_balances
  - mcp__pragma__list_verified_tokens
  - mcp__pragma__get_swap_quote
  - mcp__pragma__execute_swap
  - mcp__pragma__transfer
  - mcp__pragma__wrap
  - mcp__pragma__unwrap
  - mcp__pragma__stake
  - mcp__pragma__check_session_key_balance
  - mcp__pragma__fund_session_key
  - mcp__pragma__setup_wallet
  - AskUserQuestion
  - Read
---

# Pragma Core

Pragma enables on-chain trading via passkey-secured smart accounts.

## Security Model

All operations use MCP tools exclusively. MCP tools handle private keys internally and never expose them.

**CRITICAL: NEVER use Bash to call `pragma-signer` binary.** Direct CLI access exposes private keys in terminal output. The `allowed-tools` restriction enforces this automatically.

## Initialization

When skill activates or user appears new:
1. `has_wallet` - Check if pragma is configured
2. If not initialized - Guide user to `/pragma:setup`

## Before Execution Operations

**MANDATORY: ALWAYS check session key balance before ANY transaction.**

For swap, transfer, stake, wrap, unwrap:

### Single Operation
1. `get_balance` - Verify user has sufficient tokens
2. **`check_session_key_balance`** with `operationType` ← MANDATORY
3. If `needsFunding`: `fund_session_key` → **WAIT for completion**
4. Execute operation (Touch ID)

### Multiple Operations (Parallel)
1. Count total operations from user intent
2. Get all quotes/balances in parallel
3. **`check_session_key_balance`** with `estimatedOperations: N` ← MANDATORY
4. If `needsFunding`: `fund_session_key` with `estimatedOperations: N`
5. **WAIT** for funding to complete
6. Execute all operations in parallel (single message, multiple tool calls)

### Multiple Operations (Sequential)
1. **`check_session_key_balance`** before first operation ← MANDATORY
2. Fund if needed → WAIT
3. Execute first operation
4. For each subsequent operation:
   - Check if more funding needed
   - Fund if needed → WAIT
   - Execute operation

## Parallel vs Sequential Execution

### When to Execute in PARALLEL

Execute multiple tool calls simultaneously when operations are **independent**:

| User Request | Execution | Why |
|--------------|-----------|-----|
| "swap 0.5 MON to USDC and 0.5 MON to AUSD" | Parallel quotes, parallel executions | No data dependency |
| "show my NFTs and token balance" | Parallel calls | Read-only, no dependency |
| "wrap 1 MON and stake 2 MON" | Parallel executions | Different operations |
| Multiple getBalance for different tokens | Parallel calls | Independent reads |

**Pattern for parallel execution:**
1. Get all quotes in parallel (single message, multiple tool calls)
2. Show combined confirmation to user
3. Check session key balance for ALL operations combined
4. Fund session key if needed (WAIT for completion)
5. Execute all operations in parallel (single message, multiple tool calls)

### When to Execute SEQUENTIALLY

Execute one at a time when output is **input for next operation**:

| User Request | Execution | Why |
|--------------|-----------|-----|
| "swap MON to USDC, then swap that USDC to DAK" | Sequential | Need first swap output amount |
| "swap all my MON to USDC" | getBalance → swap | Need exact balance first |
| "buy max NFTs I can afford" | getBalance → calculate → buy | Need balance to calculate |

**Pattern for sequential execution:**
1. Execute first operation
2. Wait for result
3. Use result to inform next operation
4. Continue chain

### CRITICAL: Session Key Funding Rule

**fundSessionKey and execution tools must be SEQUENTIAL, never parallel.**

The session key needs funds BEFORE it can pay gas for transactions.

```
✅ CORRECT:
[fundSessionKey] → wait for result → [executeSwap, executeSwap]

❌ WRONG (race condition):
[fundSessionKey, executeSwap, executeSwap] in same batch
```

**NEVER call fundSessionKey and execution tools in the same tool call batch.**

### Pre-Flight Gas Estimation

Before executing multiple operations, calculate total gas needed:

| Operation | Gas Cost (MON) |
|-----------|---------------|
| swap | 0.14 |
| transfer | 0.04 |
| wrap | 0.04 |
| unwrap | 0.04 |
| stake | 0.07 |
| unstake | 0.075 |

**Formula:** `total_gas = sum(operation_costs) + 0.02 MON buffer`

**Example:** "swap to USDC and stake 1 MON"
- Swap: 0.14 MON
- Stake: 0.07 MON
- Buffer: 0.02 MON
- **Total: 0.23 MON needed**

**Workflow:**
1. Count operations from user intent
2. `check_session_key_balance` with `estimatedOperations: N`
3. If `needsFunding`: `fund_session_key` with `estimatedOperations: N`
4. **WAIT** for funding to complete
5. Then execute operations (parallel if independent)

## Tool Reference

| Category | Tool | Purpose |
|----------|------|---------|
| Check | `has_wallet` | Verify wallet initialization |
| Check | `has_providers` | Verify provider configuration |
| Balance | `get_balance` | Single token balance |
| Balance | `get_all_balances` | Full portfolio |
| Discovery | `list_verified_tokens` | List tradeable tokens |
| Trade | `get_swap_quote` | Quote before swap |
| Trade | `execute_swap` | Execute swap (Touch ID) |
| Transfer | `transfer` | Send tokens (Touch ID) |
| Convert | `wrap` | Native to Wrapped |
| Convert | `unwrap` | Wrapped to Native |
| Stake | `stake` | Stake to liquid staking |
| Session | `check_session_key_balance` | Check gas funding |
| Session | `fund_session_key` | Fund for operations |
| Setup | `setup_wallet` | Initial creation |

## Operation Flows

### Swaps
1. `get_balance` (source token)
2. `get_swap_quote`
3. **Use `AskUserQuestion`:**
   - Header: "Swap"
   - Question: "Confirm swap of X TOKEN_A for ~Y TOKEN_B?"
   - Options: ["Confirm swap", "Cancel"]
   - Include price impact warning in description if > 1%
4. If confirmed: `check_session_key_balance` (operationType: "swap")
5. If needsFunding - `fund_session_key`
6. `execute_swap`
7. Report result with tx hash

### Transfers
1. Validate address (0x, 42 chars)
2. `get_balance` (token to send)
3. **Use `AskUserQuestion`:**
   - Header: "Transfer"
   - Question: "Send X TOKEN to 0x...recipient?"
   - Options: ["Confirm transfer", "Cancel"]
4. If confirmed: `check_session_key_balance` (operationType: "transfer")
5. If needsFunding - `fund_session_key`
6. `transfer`
7. Report result

### Wrap/Unwrap
1. `get_balance` (source token)
2. **Use `AskUserQuestion`:**
   - Header: "Wrap" / "Unwrap"
   - Question: "Convert X MON to WMON?" or "Convert X WMON to MON?"
   - Options: ["Confirm", "Cancel"]
3. If confirmed: `check_session_key_balance` (operationType: "wrap"/"unwrap")
4. If needsFunding - `fund_session_key`
5. `wrap` or `unwrap`
6. Report result

### Stake
1. `get_balance` (native token)
2. **Use `AskUserQuestion`:**
   - Header: "Stake"
   - Question: "Stake X MON to receive aprMON?"
   - Options: ["Confirm stake", "Cancel"]
   - Description: Include staking implications
3. If confirmed: `check_session_key_balance` (operationType: "stake")
4. If needsFunding - `fund_session_key`
5. `stake`
6. Report result

### Relative Amounts ("all", "half", "max", percentages)
1. `get_balance` FIRST to get actual amount
2. Calculate relative value
3. Proceed with operation flow

## Confirmation Rules

**Use `AskUserQuestion` for all execution operations:**
- Swaps, transfers, staking, wrap/unwrap
- Header: Short category (e.g., "Swap", "Transfer")
- Options: ["Confirm [action]", "Cancel"]

**Include in question/description:**
- Amount and token
- Recipient (transfers)
- Price impact (swaps)
- Expected output

**Include warnings in description when:**
- Price impact > 1%
- Unverified token (not in verified list) - **MUST show full contract address**
- Transfer > 10% of balance
- Low remaining balance after operation

**Unverified token handling:**
- If token is NOT in verified list, show FULL address in question
- Example: "Swap 1 MON for ~11,785 MOTION (0xc72B5eb3...7777)?"
- Description MUST include: "⚠️ MOTION is unverified. Verify this is the correct contract."
- This helps users avoid swapping to copycat/scam tokens with same symbol

## Response Format

**Balances**:
```
Pragma Wallet:
- Native: 10.5 ($XXX)
- Wrapped: 2.3 ($XXX)
```

**Quotes**:
```
Swap Quote:
1 TOKEN_A -> 0.999 TOKEN_B
Impact: 0.1%
Route: Direct

Confirm?
```

**Results**:
```
Success!
Tx: 0x123...
Received: 0.999 TOKEN_B
```

## Execution Examples

### Example 1: Parallel Independent Swaps
User: "swap 0.5 MON each to USDC and AUSD"

**Analysis:** Two swaps, no dependency → PARALLEL

**Execution:**
1. [get_swap_quote MON→USDC, get_swap_quote MON→AUSD] (parallel)
2. Show combined quote, get confirmation
3. check_session_key_balance(estimatedOperations: 2)
4. fund_session_key if needed → WAIT
5. [execute_swap USDC, execute_swap AUSD] (parallel)

### Example 2: Sequential Dependent Swaps
User: "swap 1 MON to USDC, then swap that USDC to DAK"

**Analysis:** Second swap depends on first output → SEQUENTIAL

**Execution:**
1. get_swap_quote MON→USDC
2. Confirm first swap
3. check_session_key_balance, fund if needed
4. execute_swap → get actual USDC output
5. get_swap_quote (using actual USDC amount)→DAK
6. Confirm second swap
7. execute_swap

### Example 3: Mixed Operations
User: "wrap 1 MON and stake 2 MON"

**Analysis:** Independent operations → PARALLEL

**Execution:**
1. get_balance (verify has 3+ MON)
2. check_session_key_balance(estimatedOperations: 2)
3. fund_session_key if needed → WAIT
4. [wrap, stake] (parallel)

### Example 4: "All" Requires Balance First
User: "swap all my CHOG to MON"

**Analysis:** Need balance before swap → SEQUENTIAL (get_balance → swap)

**Execution:**
1. get_balance CHOG → get exact amount
2. get_swap_quote with exact amount
3. Confirm swap
4. check_session_key_balance, fund if needed
5. execute_swap

## Error Handling

| Error | Action |
|-------|--------|
| Wallet not initialized | Guide to `/pragma:setup` |
| Providers not configured | Guide to `/pragma:providers` |
| Insufficient balance | Show current vs required |
| Quote expired | Get fresh quote automatically |
| Session key low | `fund_session_key` first |
| Transaction failed | Show error, suggest retry |
