---
name: providers
description: Manage API keys and provider configuration for pragma
---

# Provider Management

Manage the API keys and endpoints needed for pragma to function.

## Provider Types

| Type | Purpose | Example |
|------|---------|---------|
| `rpc` | RPC endpoint URL | `https://rpc.monad.xyz` |
| `pimlico` | Pimlico API key (bundler/paymaster) | `pim_xxx...` |
| `monorail` | Monorail API key (DEX aggregator) | `mr_xxx...` |
| `0x` | 0x API key (primary DEX aggregator) | `xxx-xxx-xxx...` |

## Commands

### List Providers

Show which providers are configured:

1. Call `listProviders()` from the signer module
2. Display status for each provider type:
   - rpc: ✅ Configured / ❌ Not configured
   - pimlico: ✅ Configured / ❌ Not configured
   - monorail: ✅ Configured / ❌ Not configured

### Add Provider

When user wants to add or update a provider:

1. Identify which provider type they want to configure
2. Get the value (URL or API key) from the user
3. Store securely in Keychain via `storeProvider(type, value)`
4. Confirm success

Example interactions:
- "Add my RPC endpoint: https://rpc.monad.xyz" → Store as `rpc`
- "Set Pimlico key: pim_abc123" → Store as `pimlico`
- "Configure Monorail API key" → Ask for the key, then store as `monorail`

### Remove Provider

When user wants to remove a provider:

1. Confirm which provider to remove
2. Delete from Keychain via `deleteProvider(type)`
3. Confirm removal

### Check Specific Provider

When user asks about a specific provider:

1. Use `hasProvider(type)` to check if configured
2. If configured, use `getProvider(type)` to show (masked for security)
3. For RPC, can show full URL; for API keys, show only first/last few characters

## Security Notes

- All provider values are stored encrypted in macOS Keychain
- API keys are automatically accessible when macOS is unlocked
- No Touch ID required for provider access (only for transaction signing)
- Never display full API keys - mask middle characters

## Output Format

When listing providers:
```
Pragma Provider Status:
├── RPC: ✅ https://rpc.monad.xyz
├── Pimlico: ✅ pim_xxx...xxx
├── Monorail: ❌ Not configured
└── 0x: ✅ xxx...xxx
```

When adding:
```
✅ RPC endpoint saved to Keychain
```

When removing:
```
✅ Pimlico API key removed from Keychain
```
