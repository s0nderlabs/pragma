---
name: stake
description: Stake MON to aPriori for aprMON
---

# Stake MON

Stake MON tokens to aPriori protocol to receive aprMON (liquid staking token).

## Flow

1. **Parse request** - Understand amount to stake
2. **Check balance** - Verify sufficient MON
3. **Show details** - Explain what staking does
4. **Confirm** - Ask for confirmation
5. **Execute** - Use `stake` tool
6. **Report result** - Show transaction and aprMON received

## About aPriori Staking

- MON is staked to aPriori validators
- User receives aprMON (liquid staking token)
- aprMON accrues staking rewards over time
- aprMON can be traded or used in DeFi
- Unstaking has a waiting period

## Tool Usage

1. `get_balance` - Check MON balance
2. `stake` - Execute the stake

## Example Interaction

User: "Stake 10 MON"

1. Check MON balance (must have > 10 MON)
2. Show: "Stake 10 MON to aPriori. You'll receive ~10 aprMON. Confirm?"
3. On confirmation, execute and show result

## Safety Rules

- ALWAYS confirm before staking
- Remind user about unstaking period
- Check gas costs vs stake amount
