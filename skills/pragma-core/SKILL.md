---
name: pragma-core
description: Operates pragma wallet for on-chain trading. Executes swaps, transfers, staking, balance checks, and wallet management. Use when user mentions pragma, wallet, balance, portfolio, swap, trade, buy, sell, transfer, send, stake, unstake, wrap, unwrap, tokens, or DeFi operations.
allowed-tools:
  - mcp__pragma__has_wallet
  - mcp__pragma__has_providers
  - mcp__pragma__get_balance
  - mcp__pragma__get_all_balances
  - mcp__pragma__get_account_info
  - mcp__pragma__get_token_info
  - mcp__pragma__list_verified_tokens
  - mcp__pragma__get_swap_quote
  - mcp__pragma__execute_swap
  - mcp__pragma__transfer
  - mcp__pragma__wrap
  - mcp__pragma__unwrap
  - mcp__pragma__stake
  - mcp__pragma__check_session_key_balance
  - mcp__pragma__fund_session_key
  - mcp__pragma__withdraw_session_key
  - mcp__pragma__setup_wallet
  - mcp__pragma__set_mode
  - mcp__pragma__get_block
  - mcp__pragma__get_gas_price
  - mcp__pragma__explain_transaction
  - mcp__pragma__get_onchain_activity
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
5. Execute all operations in parallel (single message, multiple tool calls to execute_swap with quoteIds array)

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
| Account | `get_account_info` | Wallet addresses, mode, network |
| Balance | `get_balance` | Single token balance |
| Balance | `get_all_balances` | Full portfolio |
| Discovery | `list_verified_tokens` | List tradeable tokens |
| Discovery | `get_token_info` | Token details, price, verification |
| Trade | `get_swap_quote` | Quote before swap (single or batch) |
| Trade | `execute_swap` | Execute swap (Touch ID) |
| Transfer | `transfer` | Send tokens (Touch ID) |
| Convert | `wrap` | Native to Wrapped |
| Convert | `unwrap` | Wrapped to Native |
| Stake | `stake` | Stake to liquid staking |
| Session | `check_session_key_balance` | Check gas funding |
| Session | `fund_session_key` | Fund for operations |
| Session | `withdraw_session_key` | Withdraw MON from session key |
| Setup | `setup_wallet` | Initial creation |
| Config | `set_mode` | Switch BYOK/x402 mode |
| Chain | `get_block` | Block info by number/hash/latest |
| Chain | `get_gas_price` | Current gas price with estimates |
| Activity | `explain_transaction` | Decode and explain any tx (x402 only) |
| Activity | `get_onchain_activity` | Transaction history for address (x402 only) |

### Batch Quote Support

`get_swap_quote` supports two modes:

**Single quote (original):**
```
get_swap_quote(fromToken: "MON", toToken: "USDC", amount: "1")
```

**Batch quotes (new):**
```
get_swap_quote(quotes: [
  { fromToken: "MON", toToken: "USDC", amount: "1" },
  { fromToken: "MON", toToken: "AUSD", amount: "1" }
])
```

**Batch features:**
- Up to 10 quotes per batch
- Parallel fetching (faster than sequential)
- Auto-retry for transient failures
- Partial success (some quotes can fail without blocking others)
- Returns `quoteIds` array ready for `execute_swap`

**When to use batch mode:**
- Multiple independent swaps (e.g., "swap 1 MON to USDC and 1 MON to AUSD")
- Portfolio rebalancing
- Multi-token purchases

## Operation Flows

### Swaps (Single)
1. `get_balance` (source token)
2. `get_swap_quote` (single mode)
3. **Use `AskUserQuestion`:**
   - Header: "Swap"
   - Question: "Confirm swap of X TOKEN_A for ~Y TOKEN_B?"
   - Options: ["Confirm swap", "Cancel"]
   - Include price impact warning in description if > 1%
4. If confirmed: `check_session_key_balance` (operationType: "swap")
5. If needsFunding - `fund_session_key` → WAIT
6. `execute_swap`
7. Report result with tx hash

### Swaps (Batch)
For multiple independent swaps (e.g., "swap 1 MON to USDC and 1 MON to AUSD"):
1. `get_balance` (source token)
2. `get_swap_quote` with `quotes` array (batch mode) - fetches all in parallel
3. **Use `AskUserQuestion`:**
   - Header: "Batch Swap"
   - Question: "Confirm N swaps: X TOKEN → Y TOKEN, ...?"
   - Options: ["Confirm all", "Cancel"]
   - Show summary of all swaps in description
4. If confirmed: `check_session_key_balance` (estimatedOperations: N)
5. If needsFunding - `fund_session_key` → WAIT
6. `execute_swap` with all `quoteIds` from batch response
7. Report all results (atomic - all succeed or all fail)

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
Tx: 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
Received: 0.999 TOKEN_B
```

**IMPORTANT:** Always show FULL transaction hashes (all 66 characters). Never truncate tx hashes - users need to copy them.

## Human-Readable Explanations

When using `explain_transaction` or `get_onchain_activity`, ALWAYS add human-readable context after the technical details.

### Philosophy
- Technical data is for verification and debugging
- Human explanation is for understanding what happened and why it matters
- Users should walk away knowing: what happened, why it was secure, and the net result

### Structure for Transaction Explanations

After presenting technical tables, add:

```
---

## In Plain English

### What Happened
[One paragraph explaining the transaction simply]

### Security (Pragma txs only)
[What the caveats/enforcers protected against]

### Net Result
[What user gained, spent, and any observations]
```

### Explanation Templates by Transaction Type

**Swap:**
> You traded [input tokens] for [output token] through [protocol]. Your session key executed this swap on your behalf, with the delegation expiring after [time window].

**Stake:**
> You deposited [amount] MON into aPriori's liquid staking vault. You received [amount] aprMON in return - this is a receipt token that represents your staked position and accrues rewards over time.

**Transfer:**
> You sent [amount] [token] to [recipient address]. This was executed through your smart account via delegation.

**Wrap/Unwrap:**
> You converted [amount] MON to WMON (or vice versa). WMON is the ERC20 wrapped version of native MON, required for many DeFi protocols.

### Caveat/Enforcer Explanations

Always explain what each enforcer does in plain terms:

| Enforcer | Plain English |
|----------|---------------|
| TimestampEnforcer | "This delegation was only valid for X minutes" |
| NonceEnforcer | "Prevents replay attacks - this exact delegation can't be reused" |
| LimitedCallsEnforcer | "Your session key could only use this permission X times" |
| AllowedTargetsEnforcer | "Only specific contracts (like the DEX) could be called" |
| AllowedMethodsEnforcer | "Only specific functions (like swap) were allowed" |
| NativeTokenTransferAmountEnforcer | "Maximum MON that could be transferred was capped at X" |

### Gas Context (Monad-specific)

Always mention:
> On Monad, you're charged for the gas *limit*, not gas *used*. This means the actual cost is based on the maximum gas allocated, even if less was consumed.

### When to Highlight Concerns

Flag these observations naturally:
- "Gas cost (0.28 MON) exceeded the swap value (~$0.01) - this happens with small trades"
- "This was a multi-token swap consolidating 3 stablecoins into MON"
- "The delegation expired 5 minutes after creation, limiting the window for potential misuse"

## Execution Examples

### Example 1: Batch Independent Swaps
User: "swap 0.5 MON each to USDC and AUSD"

**Analysis:** Two swaps, no dependency → USE BATCH QUOTE

**Execution:**
1. `get_swap_quote` with batch `quotes` array (both swaps)
2. Show combined summary, confirm via AskUserQuestion
3. `check_session_key_balance(estimatedOperations: 2)`
4. `fund_session_key` if needed → WAIT
5. `execute_swap` with all quoteIds (atomic batch)

### Example 2: Sequential Dependent Swaps
User: "swap 1 MON to USDC, then swap that USDC to DAK"

**Analysis:** Second swap depends on first output → SEQUENTIAL

**Execution:**
1. `get_swap_quote` MON→USDC, confirm, fund if needed, execute
2. Use actual USDC output for second swap
3. `get_swap_quote` USDC→DAK, confirm, execute

### Example 3: Mixed Operations
User: "wrap 1 MON and stake 2 MON"

**Analysis:** Independent operations → PARALLEL

**Execution:**
1. `get_balance` (verify 3+ MON available)
2. `check_session_key_balance(estimatedOperations: 2)`, fund if needed → WAIT
3. Execute `wrap` and `stake` in parallel

### Example 4: Relative Amount ("all", "half", "max")
User: "swap all my CHOG to MON"

**Analysis:** Need balance first → SEQUENTIAL

**Execution:**
1. `get_balance` CHOG → get exact amount
2. `get_swap_quote` with that amount, confirm, fund if needed, execute

## Error Handling

| Error | Action |
|-------|--------|
| Wallet not initialized | Guide to `/pragma:setup` |
| Providers not configured | Guide to `/pragma:providers` |
| Insufficient balance | Show current vs required |
| Quote expired | Get fresh quote automatically |
| Session key low | `fund_session_key` first |
| Transaction failed | Show error, suggest retry |
