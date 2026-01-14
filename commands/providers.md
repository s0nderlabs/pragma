---
name: providers
description: Manage API providers and adapter configuration for pragma
---

# Provider Management

Configure API providers for pragma in BYOK mode using the adapter system.

## IMPORTANT: Security First

**NEVER paste API keys or sensitive credentials in the chat.** Claude cannot and should not handle API keys directly in conversation.

Instead, this command helps you:
1. Check your current provider status
2. Set up new provider adapters
3. Get terminal commands to store API keys securely

## Modes

| Mode | Provider Config |
|------|-----------------|
| **x402** | No config needed - proxy handles everything |
| **BYOK** | User configures adapters for each service |

## Service Types

| Service | Purpose | Example Providers |
|---------|---------|-------------------|
| `quote` | DEX aggregation quotes | Various aggregators |
| `bundler` | UserOp bundling | Various bundlers |
| `data` | Token/portfolio data | Various data APIs |
| `rpc` | RPC endpoint | Any EVM RPC provider |

## Flow

### Step 1: Check Provider Status

First call the `has_providers` MCP tool to get:
- Current mode (x402 or BYOK)
- Available adapters for each service
- The correct `signerPath` for terminal commands

### Step 2: Show Current Status

Display status using the data from `has_providers`:

```
Pragma Provider Status (BYOK mode):
├── RPC: ✅ Configured
├── Quote: 1 adapter (my-aggregator)
├── Bundler: ❌ Not configured
└── Data: ❌ Not configured
```

### Step 3: Set Up New Provider (if needed)

When user wants to add a provider:

1. **Ask which service they want to configure** (quote, bundler, data)

2. **Recommend known-good providers** conversationally:
   - Quote: "Popular aggregators include 0x and 1inch - which would you like?"
   - Bundler: "Pimlico and Alchemy are commonly used - which do you prefer?"
   - Data: "For token data, options include CoinGecko API or similar services"

3. **User chooses** (or specifies their own custom provider)

4. **Claude generates the adapter JSON:**
   - Read the provider's API documentation via WebFetch
   - Generate adapter JSON with correct mappings
   - Save to `~/.pragma/providers/{service}/{name}.json`

5. **User stores API key** via terminal command:
   ```
   {signerPath} store-provider {keyName} "YOUR_API_KEY"
   ```

6. **Test the adapter** with a sample request

### Adapter JSON Structure

Adapters are stored in `~/.pragma/providers/{service}/{name}.json`:

```json
{
  "name": "my-provider",
  "type": "quote",
  "version": "1.0",
  "chainIds": [143],
  "endpoint": "https://api.example.com/v1",
  "auth": {
    "type": "header",
    "header": "X-API-Key",
    "keyName": "my-provider-key"
  },
  "pathMappings": {
    "/portfolio/{address}": "/wallet/{1}/balances"
  },
  "request": {
    "sellToken": "{sellToken}",
    "buyToken": "{buyToken}",
    "sellAmount": "{sellAmount}"
  },
  "response": {
    "buyAmount": "$.buyAmount",
    "minBuyAmount": "$.minBuyAmount",
    "router": "$.transaction.to",
    "calldata": "$.transaction.data"
  }
}
```

### Path Mappings (for Data Adapters)

When a provider's API paths differ from standard paths, use `pathMappings`:

```json
"pathMappings": {
  "/portfolio/{address}": "/wallet/{1}/balances",
  "/token/{address}": "/tokens/{1}"
}
```

- Pattern: `{address}` in the key becomes `{1}` in the replacement
- Multiple captures: `{2}`, `{3}`, etc. for additional path segments

### Authentication Types

| Type | Description |
|------|-------------|
| `header` | API key in custom header |
| `bearer` | Bearer token in Authorization header |
| `query` | API key in query parameter |
| `none` | No authentication needed |

## x402 Mode Note

If user is in x402 mode:

```
You're in x402 mode - all API calls go through the proxy.
No provider configuration needed. API costs are paid with USDC.

To switch to BYOK mode (bring your own keys):
  Use set_mode with mode="byok"
```

## Rules

1. **ALWAYS call `has_providers` first** to get the correct `signerPath`
2. **NEVER ask the user to paste API keys in the chat**
3. **NEVER accept API keys provided in conversation messages**
4. If user tries to paste a key, respond:
   > "For security, please don't paste API keys in the chat. Run the command directly in your terminal instead."
5. **Recommend providers conversationally** - don't hardcode names in code
6. After user stores API key, test the adapter

## Keychain Key Naming

**For quote/data adapters:** Use any name you want - the adapter's `auth.keyName` field determines which Keychain key to look up.

```json
// Adapter references keyName
"auth": { "keyName": "my-0x-key" }

// User stores with matching name
pragma-signer store-provider my-0x-key "API_KEY"
```

**For RPC and Bundler:** These use fixed key names (no adapter needed):
- `rpc` - Store your RPC endpoint URL
- `bundler` - Store your bundler endpoint URL (full URL with API key)

```bash
# RPC (required)
pragma-signer store-provider rpc "https://your-rpc-endpoint.com"

# Bundler (required for transactions)
pragma-signer store-provider bundler "https://api.pimlico.io/v2/143/rpc?apikey=YOUR_KEY"
```

## Provider-Specific Notes

### 0x (Quote)
- Use `allowance-holder` endpoint, NOT `permit2`:
  ```
  https://api.0x.org/swap/allowance-holder/quote
  ```
- Permit2 requires additional signature handling not yet supported

### Bundlers
- Store the **full URL** including API key as query param
- Example: `https://api.pimlico.io/v2/{chainId}/rpc?apikey=YOUR_KEY`

### Monorail (Data) - Free, No API Key
Monorail provides free token data for Monad. No API key required:

```json
{
  "name": "monorail",
  "type": "data",
  "chainIds": [143],
  "endpoint": "https://api.monorail.xyz/v2",
  "auth": { "type": "none", "keyName": "" },
  "pathMappings": {
    "/portfolio/{address}": "/wallet/{1}/balances"
  },
  "request": {},
  "response": {}
}
```

Save to `~/.pragma/providers/data/monorail.json` and add to config:
```json
"providers": { "data": ["monorail"] }
```

## Security Notes

- All API keys are stored encrypted in macOS Keychain
- Keys are automatically accessible when macOS is unlocked
- No Touch ID required for provider access (only for transaction signing)
- Keychain access is per-binary (only pragma-signer can read these values)

## Example Interaction

**User:** "Set up a quote provider"

**Claude:** "I'll help you set up a quote provider. Popular options include 0x and 1inch. Which would you like to use, or do you have another provider in mind?"

**User:** "Let's use 0x"

**Claude:**
1. Fetches 0x API documentation
2. Generates adapter JSON for 0x
3. Saves to `~/.pragma/providers/quote/zerox.json`
4. Provides terminal command:
   ```
   /path/to/pragma-signer store-provider zerox-key "YOUR_0X_API_KEY"
   ```
5. Tests with a sample quote after key is stored
