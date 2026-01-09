---
name: transfer
description: Transfer tokens to another address
---

# Token Transfer

Send tokens to another address.

## Flow

1. **Parse request** - Understand token, amount, and recipient
2. **Validate address** - Ensure recipient is a valid address
3. **Check balance** - Verify sufficient funds
4. **Confirm** - Show details and ask for confirmation
5. **Execute** - Use `transfer` tool
6. **Report result** - Show transaction hash

## Safety Rules

- ALWAYS verify the recipient address with the user
- ALWAYS ask for confirmation before executing
- Double-check large transfers (> 10% of balance)
- Warn about transfers to contract addresses

## Tool Usage

1. `get_balance` - Check available tokens
2. `transfer` - Execute the transfer

## Example Interaction

User: "Send 5 MON to 0x123..."

1. Validate 0x123... is a valid address
2. Check MON balance
3. Show: "Transfer 5 MON to 0x123...? Confirm?"
4. On confirmation, execute and show tx hash

## Address Validation

- Must be 42 characters (0x + 40 hex)
- Warn if address has no transaction history
- Warn if address is a known contract
