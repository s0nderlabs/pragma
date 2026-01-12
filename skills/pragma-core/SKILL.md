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

For swap, transfer, stake, wrap, unwrap:
1. `get_balance` - Verify user has sufficient tokens
2. `check_session_key_balance` - Verify session key has gas
3. If session key low - `fund_session_key` (Touch ID)
4. Execute operation (Touch ID)

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

## Error Handling

| Error | Action |
|-------|--------|
| Wallet not initialized | Guide to `/pragma:setup` |
| Providers not configured | Guide to `/pragma:providers` |
| Insufficient balance | Show current vs required |
| Quote expired | Get fresh quote automatically |
| Session key low | `fund_session_key` first |
| Transaction failed | Show error, suggest retry |
