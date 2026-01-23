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
  - mcp__pragma__explain_contract
  - mcp__pragma__nadfun_status
  - mcp__pragma__nadfun_quote
  - mcp__pragma__nadfun_buy
  - mcp__pragma__nadfun_sell
  - mcp__pragma__nadfun_discover
  - mcp__pragma__nadfun_token_info
  - mcp__pragma__nadfun_positions
  - mcp__pragma__nadfun_create
  - mcp__pragma__leverup_list_pairs
  - mcp__pragma__leverup_list_positions
  - mcp__pragma__leverup_get_quote
  - mcp__pragma__leverup_open_trade
  - mcp__pragma__leverup_close_trade
  - mcp__pragma__leverup_update_margin
  - AskUserQuestion
  - Read
  - Task
---

# Pragma Core

Pragma enables on-chain trading via passkey-secured smart accounts.

## Security Model

All operations use MCP tools exclusively. MCP tools handle private keys internally and never expose them.

**CRITICAL: NEVER use Bash to call `pragma-signer` binary.** Direct CLI access exposes private keys in terminal output. The `allowed-tools` restriction enforces this automatically.

## VERBATIM OUTPUT RULE (MANDATORY)

**When subagent output starts with `[VERBATIM OUTPUT - DO NOT SUMMARIZE]`:**

1. **STOP** - Do not process, summarize, condense, or reformat
2. **COPY** - Present the ENTIRE output exactly as returned
3. **NO CHANGES** - Tables, formatting, whitespace, details must be preserved
4. **ONLY ALLOWED** - Add a brief 1-line intro like "Here's the analysis:"

This applies to: `activity-fetcher`, `transaction-explainer`, `contract-explainer`

**WHY:** Subagents format output specifically for the user. Re-summarizing:
- Loses important details
- Breaks table formatting
- Wastes the work the subagent did
- Confuses users who see different info than what was generated

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
| Activity | `explain_transaction` | Decode and explain any tx (x402 only) - **USE SUBAGENT** |
| Activity | `get_onchain_activity` | Transaction history for address (x402 only) - **USE SUBAGENT** |
| Analysis | `explain_contract` | Analyze smart contract details (x402 only) - **USE SUBAGENT** |
| nad.fun | `nadfun_status` | Check token graduation status |
| nad.fun | `nadfun_quote` | Quote for bonding curve buy/sell |
| nad.fun | `nadfun_buy` | Buy tokens on curve (Touch ID) |
| nad.fun | `nadfun_sell` | Sell tokens on curve (Touch ID) |
| nad.fun | `nadfun_discover` | Find trending/new tokens |
| nad.fun | `nadfun_token_info` | Detailed token info |
| nad.fun | `nadfun_positions` | User's holdings with PnL |
| nad.fun | `nadfun_create` | Create new token on bonding curve |
| LeverUp | `leverup_list_pairs` | List tradeable perps markets |
| LeverUp | `leverup_list_positions` | Active trades with PnL & Health |
| LeverUp | `leverup_get_quote` | High-precision risk simulation |
| LeverUp | `leverup_open_trade` | Open market order (Touch ID) |
| LeverUp | `leverup_close_trade` | Close position (Touch ID) |
| LeverUp | `leverup_update_margin` | Add/remove collateral (Touch ID) |

### Context-Optimized Operations (IMPORTANT)

**Problem:** `explain_transaction`, `get_onchain_activity`, and `explain_contract` return large responses (40K-110KB) that consume main conversation context rapidly.

**Solution:** ALWAYS delegate these operations to specialized subagents.

#### Agent Routing Rules

| User Intent | Agent to Use | Example Queries |
|-------------|--------------|-----------------|
| Transaction history, activity | `activity-fetcher` | "show my activity", "recent txs", "what did I do today" |
| Explain a specific tx | `transaction-explainer` | "explain tx 0x123...", "what happened in this tx" |
| Explain a contract | `contract-explainer` | "explain contract 0x...", "what does this contract do?", "analyze this contract" |

#### CRITICAL RULES

1. **Never mix responsibilities:**
   - `activity-fetcher` (Haiku) → ONLY for listing/formatting transaction history
   - `transaction-explainer` (Sonnet) → ONLY for explaining specific transactions
   - `contract-explainer` (Sonnet) → ONLY for analyzing smart contracts

2. **"Explain my last tx" workflow:**
   - First: Call `activity-fetcher` to get transaction history
   - Extract the latest tx hash from the response
   - Then: Call `transaction-explainer` with that specific tx hash
   - **DO NOT ask activity-fetcher to explain transactions**

3. **"Explain the contract I used" workflow:**
   - First: Call `activity-fetcher` to get transaction history
   - Extract the contract address from the transaction (look at Details column)
   - Then: Call `contract-explainer` with that contract address
   - **DO NOT ask activity-fetcher to explain contracts**

4. **VERBATIM OUTPUT:** See top-level "VERBATIM OUTPUT RULE" section above

**How it works:**
1. Subagent runs in isolated context
2. Large API response stays in subagent context
3. Formatted output returns to main conversation
4. ~95% context savings (56K → 2-3K tokens)

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

### nad.fun Trading

**CRITICAL: Always check token status first.** Tokens on nad.fun bonding curve require different tools than regular DEX tokens.

#### When to Use nad.fun Tools

| Scenario | Tools to Use |
|----------|--------------|
| Token on bonding curve (not graduated) | `nadfun_*` tools |
| Token graduated to DEX | Regular `get_swap_quote` + `execute_swap` |
| Unknown token status | `nadfun_status` first to check |

#### Status Check
1. `nadfun_status` - Check if token is on bonding curve
2. If `isGraduated: true` → Use regular swap tools instead
3. If `isLocked: true` → Cannot trade, wait for graduation

#### Buy Flow (MON → Tokens)
1. `nadfun_status` - Verify token not graduated
2. `get_balance` (MON) - Check available funds
3. `nadfun_quote` with `isBuy: true`
4. **Use `AskUserQuestion`:**
   - Header: "nad.fun Buy"
   - Question: "Buy ~X tokens for Y MON on nad.fun?"
   - Options: ["Confirm buy", "Cancel"]
   - Description: Include graduation progress
5. If confirmed: `check_session_key_balance` (operationType: "swap")
6. If needsFunding - `fund_session_key` → **WAIT**
7. `nadfun_buy`
8. Report result with tx hash and progress

#### Sell Flow (Tokens → MON)
1. `nadfun_status` - Verify token not graduated
2. `get_balance` (token) - Check holdings
3. `nadfun_quote` with `isBuy: false`
4. **Use `AskUserQuestion`:**
   - Header: "nad.fun Sell"
   - Question: "Sell X tokens for ~Y MON on nad.fun?"
   - Options: ["Confirm sell", "Cancel"]
   - Description: Include graduation progress
5. If confirmed: `check_session_key_balance` (operationType: "swap")
6. If needsFunding - `fund_session_key` → **WAIT**
7. `nadfun_sell`
8. Report result with tx hash and progress

**Note:** Sell may require multiple Touch ID prompts if token approval is needed.

#### Discovery Flow
1. `nadfun_discover` - Find tokens (sortBy: market_cap, new, or active)
2. Review tokens, pick one to trade
3. `nadfun_token_info` - Get detailed info before trading
4. Follow Buy/Sell flow above

#### Check Holdings
1. `nadfun_positions` - See all nad.fun token holdings
2. Shows PnL for each position
3. Use to decide which tokens to sell

#### Token Research
1. `nadfun_token_info` - Full metadata and market data

#### Token Creation Flow (Interactive)

When user wants to create a token, gather all options interactively using AskUserQuestion.

**Step 1: Basic Info**
Use `AskUserQuestion` with 3 questions:
```
Question 1:
  header: "Token Name"
  question: "What is your token's full name? (1-32 chars, e.g., 'Moon Cat')"
  options: [
    { label: "Enter name", description: "Type your token name" }
  ]
  (User selects "Other" to type custom name)

Question 2:
  header: "Symbol"
  question: "What is your token's ticker symbol? (1-10 alphanumeric, e.g., 'MCAT')"
  options: [
    { label: "Enter symbol", description: "Type your ticker symbol" }
  ]

Question 3:
  header: "Image"
  question: "What is the path to your token's image? (PNG/JPEG/WebP, max 5MB)"
  options: [
    { label: "Enter path", description: "Local file path like ./logo.png or /path/to/image.jpg" }
  ]
```

**Step 2: Optional Metadata**
Use `AskUserQuestion` with 2 questions:
```
Question 1:
  header: "Description"
  question: "Add a description for your token? (max 500 chars)"
  options: [
    { label: "No description", description: "Skip description" },
    { label: "Add description", description: "Enter a description for your token page" }
  ]

Question 2:
  header: "Socials"
  question: "Add social links?"
  multiSelect: true
  options: [
    { label: "Twitter/X", description: "Add X.com link" },
    { label: "Telegram", description: "Add t.me link" },
    { label: "Website", description: "Add https:// website" },
    { label: "No socials", description: "Skip social links" }
  ]
```

If user selected socials, follow up with another `AskUserQuestion` for each URL.

**Step 3: Initial Purchase**
Use `AskUserQuestion`:
```
Question 1:
  header: "Initial Buy"
  question: "Buy tokens right after creation? (You'll be the first holder)"
  options: [
    { label: "No initial buy", description: "Just create the token" },
    { label: "Buy 0.1 MON worth", description: "Small initial position" },
    { label: "Buy 1 MON worth", description: "Medium initial position" },
    { label: "Custom amount", description: "Enter your own MON amount" }
  ]
```

**Step 4: Pre-flight Checks**
1. Verify session key has ~10.5 MON (10 MON deploy fee + gas)
2. If insufficient: Tell user to `transfer 10.5 MON to <session_key_address>`
3. `check_session_key_balance` - verify funding

**Step 5: Confirmation**
Use `AskUserQuestion`:
```
header: "Create Token"
question: "Create [NAME] ([SYMBOL]) on nad.fun?"
options: ["Confirm creation (Touch ID)", "Cancel"]
description: |
  Image: [path]
  Description: [description or "None"]
  Twitter: [url or "None"]
  Telegram: [url or "None"]
  Website: [url or "None"]
  Initial buy: [amount or "None"]

  ⚠️ Requires 10 MON deploy fee + gas
```

**Step 6: Execute**
1. `nadfun_create` with all gathered parameters
2. Report result with token address and explorer link
3. If initialBuyMon was specified, prompt to run `nadfun_buy`

**Token Creation Requirements:**
| Field | Constraint |
|-------|------------|
| Image | PNG, JPEG, or WebP, max 5MB (local file path) |
| Name | 1-32 characters |
| Symbol | 1-10 alphanumeric characters |
| Description | max 500 characters (optional) |
| Twitter | Must contain "x.com" (optional) |
| Telegram | Must contain "t.me" (optional) |
| Website | Must start with "https://" (optional) |
| Deploy Fee | 10 MON (paid by session key) |

**Notes:**
- Token deploys to vanity address ending in "7777"
- Image checked for NSFW content by nad.fun API
- Session key must have 10+ MON for deploy fee (transfer from smart account first)

#### Graduation Warnings
- If progress >= 90%, warn user: "Token is near graduation. Large trades may trigger graduation."
- Once graduated, tokens trade on regular DEX with different liquidity

### LeverUp Perpetuals Trading

**CRITICAL: Always perform a risk simulation first.** Perpetual trading involves significant risk and on-chain minimums.

#### Two Trading Modes

| Feature | Normal Mode (1-100x) | Zero-Fee Mode (500x/750x/1001x) |
|---------|---------------------|--------------------------------|
| **Pairs** | All standard pairs (BTC, ETH, MON, etc.) | 500BTC/USD, 500ETH/USD only |
| **Open/Close Fees** | 0.045% | 0% if PnL < 0, profit sharing if profitable |
| **Order Types** | Market + Limit | **Market only** |
| **Add/Remove Margin** | ✅ Yes | ❌ **Not allowed** |
| **Leverage Values** | Any from 1-100 | **Exactly 500, 750, or 1001** |

**CRITICAL:** If user requests 500BTC or 500ETH, they MUST use exactly 500x, 750x, or 1001x leverage. Any other value will fail with "Below degen mode min leverage" error.

#### Minimum Trade Thresholds
LeverUp enforces the following limits. Always inform the user if their trade is near or below these thresholds.
- **HARD LIMIT - Minimum Position Size**: $200.00 USD (Margin × Leverage) - **Contract will reject trades below this**
- **Soft Guideline - Minimum Margin**: $10.00 USD (recommended but not strictly enforced)

#### Stop Loss (SL) and Take Profit (TP)

SL and TP can be set when opening a position. Both are optional (set to 0 to disable).

**TP Limits (Contract-Enforced):**
| Leverage | Max Take Profit |
|----------|-----------------|
| < 50x | 500% profit |
| ≥ 50x | 300% profit |

**SL/TP Rules:**
- Stop Loss: Must be BELOW entry price (Long) or ABOVE entry price (Short)
- Take Profit: Must be ABOVE entry price (Long) or BELOW entry price (Short)
- **Cannot be cancelled** once set, but can be edited
- Prices are in USD (e.g., "85000" for $85,000)

**Example - Long BTC at $90,000:**
- Valid SL: $85,000 (below entry)
- Valid TP: $100,000 (above entry, within 500%/300% limit)

**Example - Short BTC at $90,000:**
- Valid SL: $95,000 (above entry)
- Valid TP: $80,000 (below entry)

#### Trading Flow
1. `leverup_list_pairs` - Find the correct pair base (e.g. BTC/USD)
2. `leverup_get_quote` - **MANDATORY**: Get a precise quote to see liquidation price and health factor.
3. Review quote warnings - especially for:
   - High-leverage pairs requiring specific leverage values
   - Margin/position size below minimums
   - `canAddMargin: false` for Zero-Fee leverage
4. **Use `AskUserQuestion`:**
   - Header: "LeverUp Trade"
   - Question: "Open Xx [Long/Short] on [SYMBOL]?"
   - Options: ["Confirm trade (Touch ID)", "Cancel"]
   - Description: Include margin, position size, liq price, and warnings
5. If confirmed: `check_session_key_balance` (operationType: "swap")
6. If needsFunding - `fund_session_key` → **WAIT**
7. `leverup_open_trade` - include SL/TP if user specified
8. Report result with tx hash and explorer link

#### Collateral Options
- **MON** (native) - Default, 18 decimals
- **USDC** - Stablecoin, 6 decimals
- **LVUSD** - LeverUp vault USD token, 18 decimals
- **LVMON** - LeverUp vault MON token, 18 decimals

#### Managing Positions
1. `leverup_list_positions` - Check Health Factor of active trades.
2. If Health < 20%: Suggest `leverup_update_margin` to add collateral.
   - **NOTE:** This does NOT work for 500x/750x/1001x positions!
3. To lock in profit: Use `leverup_close_trade`.

#### Update Margin Limitations
`leverup_update_margin` only works for normal leverage (1-100x) positions.
- **Zero-Fee positions (500x/750x/1001x) CANNOT add or remove margin.**
- The tool will show a warning, and the contract will reject the transaction if attempted.

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

**Note:** For `explain_transaction` and `get_onchain_activity`, use the dedicated subagents (`transaction-explainer` and `activity-fetcher`) which handle formatting automatically. See "Context-Optimized Operations" section above.

The subagents will provide:
- Technical details (tables, token movements, gas info)
- Human explanation (what happened, security analysis, net result)
- Caveat/enforcer explanations for Pragma transactions

**CRITICAL:** Follow the "VERBATIM OUTPUT RULE" at the top of this file.

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
