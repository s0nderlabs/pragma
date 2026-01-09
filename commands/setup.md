---
name: setup
description: Initialize pragma wallet with passkey and smart account
---

# pragma Wallet Setup

Set up a new pragma wallet for the user. This is required before any trading operations.

## Steps

1. **Get RPC endpoint** - Ask the user for their Monad RPC endpoint URL
2. **Create passkey** - Use Touch ID to create a P-256 key in Secure Enclave
3. **Deploy smart account** - Deploy a smart account with the passkey as signer
4. **Generate session key** - Create a session key for gas-efficient operations
5. **Save configuration** - Store wallet info in ~/.pragma/config.json

## Tool Usage

Use the `setup_wallet` tool with the user's RPC endpoint.

## Important

- Only run this once per device
- Requires macOS with Touch ID or biometric authentication
- The passkey cannot be exported - it's bound to this device
- Session key will be funded automatically when needed
