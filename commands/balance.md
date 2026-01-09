---
name: balance
description: Check token balances in pragma wallet
---

# Check Balance

Retrieve token balances for the user's pragma wallet.

## Steps

1. **Check wallet exists** - Verify pragma is set up (config exists)
2. **Get balances** - Use `get_balance` tool to fetch current balances
3. **Display results** - Show balances in a clear, readable format

## Tool Usage

Use the `get_balance` tool. Optionally specify tokens to check.

## Default Tokens

Without specific tokens requested, check:
- MON (native)
- WMON (wrapped)
- aprMON (staked)
- Common trading tokens

## Output Format

Present balances clearly:
```
Your pragma Wallet Balances:
- MON: 10.5
- WMON: 2.3
- aprMON: 5.0
```
