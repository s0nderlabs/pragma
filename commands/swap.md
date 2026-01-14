---
name: swap
description: Swap tokens using DEX aggregator
---

# Token Swap

Execute a token swap through DEX aggregator.

## Flow

1. **Parse request** - Understand what the user wants to swap
2. **Check balance** - Verify user has sufficient tokens
3. **Get quote** - Use `get_swap_quote` to get current pricing
4. **Show quote** - Display the quote with price impact and route
5. **Confirm** - Ask user to confirm the swap
6. **Execute** - Use `execute_swap` with the quote ID
7. **Report result** - Show transaction hash and result

## Safety Rules

- ALWAYS show the quote before executing
- ALWAYS ask for confirmation
- Warn if price impact > 1%
- Refuse if price impact > 5% without explicit override
- Check balance before getting quote

## Tool Usage

1. `get_balance` - Check available tokens
2. `get_swap_quote` - Get swap quote
3. `execute_swap` - Execute after confirmation

## Example Interaction

User: "Swap 1 MON for WMON"

1. Check MON balance
2. Get quote for 1 MON -> WMON
3. Show: "Quote: 1 MON -> 0.999 WMON (0.1% impact). Confirm?"
4. On confirmation, execute and show tx hash
