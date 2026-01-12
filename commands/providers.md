---
name: providers
description: Manage API keys and provider configuration for pragma
---

# Provider Management

Manage the API keys and endpoints needed for pragma to function.

## IMPORTANT: Security First

**NEVER paste API keys or sensitive credentials in the chat.** Claude cannot and should not handle API keys directly in conversation.

Instead, this command shows your current provider status and provides terminal commands you should run yourself.

## Provider Types

| Type | Purpose | Example |
|------|---------|---------|
| `rpc` | RPC endpoint URL | `https://rpc.monad.xyz` |
| `pimlico` | Pimlico API key (bundler/paymaster) | `pim_xxx...` |
| `monorail` | Monorail API key (DEX aggregator) | `mr_xxx...` |
| `0x` | 0x API key (primary DEX aggregator) | `xxx-xxx-xxx...` |

## Flow

### Step 1: Show Current Status

Call `listProviders()` from the signer module and display status:

```
Pragma Provider Status:
├── RPC: ✅ Configured (https://rpc.monad.xyz)
├── Pimlico: ✅ Configured (pim_xxx...xxx)
├── Monorail: ❌ Not configured
└── 0x: ✅ Configured (xxx...xxx)
```

For configured providers, mask API keys (show only first/last few characters).
For RPC URLs, can show full URL.

### Step 2: Provide Commands (DO NOT Ask for Keys)

After showing status, display the terminal commands the user should run:

```
To add or update a provider, run one of these commands in your terminal:

  # Set RPC endpoint
  pragma-signer store-provider rpc "YOUR_RPC_URL"

  # Set Pimlico API key
  pragma-signer store-provider pimlico "YOUR_PIMLICO_KEY"

  # Set Monorail API key
  pragma-signer store-provider monorail "YOUR_MONORAIL_KEY"

  # Set 0x API key
  pragma-signer store-provider 0x "YOUR_0X_KEY"

To remove a provider:

  pragma-signer delete-provider <type>

Note: Values are stored encrypted in macOS Keychain.
```

## Rules

1. **NEVER ask the user to paste API keys in the chat**
2. **NEVER accept API keys provided in conversation messages**
3. If user tries to paste a key, respond:
   > "For security, please don't paste API keys in the chat. Run the command directly in your terminal instead."
4. Only show current status and provide terminal commands
5. After user runs commands, they can ask to check status again

## Security Notes

- All provider values are stored encrypted in macOS Keychain
- API keys are automatically accessible when macOS is unlocked
- No Touch ID required for provider access (only for transaction signing)
- Keychain access is per-binary (only pragma-signer can read these values)

## Output Format

When showing status:
```
Pragma Provider Status:
├── RPC: ✅ https://rpc.monad.xyz
├── Pimlico: ✅ pim_xxx...xxx
├── Monorail: ❌ Not configured
└── 0x: ✅ xxx...xxx

To add/update providers, run in your terminal:
  pragma-signer store-provider <type> "YOUR_VALUE"

Types: rpc, pimlico, monorail, 0x
```
