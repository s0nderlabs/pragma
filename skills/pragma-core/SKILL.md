---
name: pragma-core
description: Operates pragma wallet for on-chain trading. Executes swaps, transfers, staking, balance checks, and wallet management. Use when user mentions pragma, wallet, balance, portfolio, swap, trade, buy, sell, transfer, send, stake, unstake, wrap, unwrap, tokens, or DeFi operations.
allowed-tools:
  - mcp__pragma__has_wallet
  - mcp__pragma__has_providers
  - mcp__pragma__get_balance
  - mcp__pragma__get_all_balances
  - mcp__pragma__get_swap_quote
  - mcp__pragma__execute_swap
  - mcp__pragma__transfer
  - mcp__pragma__wrap
  - mcp__pragma__unwrap
  - mcp__pragma__stake
  - mcp__pragma__check_session_key_balance
  - mcp__pragma__fund_session_key
  - mcp__pragma__setup_wallet
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
3. Show quote (amount, price impact, route)
4. Wait for user confirmation
5. `check_session_key_balance` (operationType: "swap")
6. If needsFunding - `fund_session_key`
7. `execute_swap`
8. Report result with tx hash

### Transfers
1. Validate address (0x, 42 chars)
2. `get_balance` (token to send)
3. Show details (amount, recipient)
4. Wait for user confirmation
5. `check_session_key_balance` (operationType: "transfer")
6. If needsFunding - `fund_session_key`
7. `transfer`
8. Report result

### Wrap/Unwrap
1. `get_balance` (source token)
2. Show details
3. Wait for confirmation
4. `check_session_key_balance` (operationType: "wrap"/"unwrap")
5. If needsFunding - `fund_session_key`
6. `wrap` or `unwrap`
7. Report result

### Stake
1. `get_balance` (native token)
2. Explain staking implications
3. Wait for confirmation
4. `check_session_key_balance` (operationType: "stake")
5. If needsFunding - `fund_session_key`
6. `stake`
7. Report result

### Relative Amounts ("all", "half", "max", percentages)
1. `get_balance` FIRST to get actual amount
2. Calculate relative value
3. Proceed with operation flow

## Confirmation Rules

**Always confirm**: Swaps, transfers, staking, wrap/unwrap

**Show before confirming**:
- Amount and token
- Recipient (transfers)
- Price impact (swaps)
- Expected output

**Warn when**:
- Price impact > 1%
- Transfer > 10% of balance
- Low remaining balance

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
