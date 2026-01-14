---
name: mode
description: Switch between BYOK (free, bring your own keys) and x402 (pay per API call) modes
---

# Mode Switching

Switch between BYOK and x402 modes for pragma.

## Modes

| Mode | Description | Cost |
|------|-------------|------|
| **x402** | Pay per API call with USDC. No API keys needed. | ~$0.001 per API call |
| **byok** | Bring Your Own Keys. Free, but you provide API keys. | Free (you pay providers directly) |

## Flow

### Step 1: Show Current Mode

First, read the config to check current mode:

```
Current mode: x402
```

### Step 2: Ask User Which Mode

Use AskUserQuestion to let user choose:

```
question: "Which mode would you like to use?"
header: "Mode"
options:
  - label: "x402 (Recommended)"
    description: "Pay per API call with USDC. No setup needed."
  - label: "BYOK"
    description: "Bring your own API keys. Free but requires setup."
```

### Step 3: Execute Mode Switch

Based on user selection, call `set_mode` tool:

- If x402: `set_mode({ mode: "x402" })`
- If BYOK: `set_mode({ mode: "byok" })`

### Step 4: Show Next Steps

After switching:

**For x402 mode:**
```
Switched to x402 mode!

API endpoints now point to api.pr4gma.xyz.
Your session key pays for each API call with USDC.

Next steps:
1. Check USDC balance: check_session_key_balance
2. Fund if needed: fund_session_key with token="USDC"
```

**For BYOK mode:**
```
Switched to BYOK mode!

You need to configure your own providers.

Run /pragma:providers to set up your API providers.
```

## Rules

1. Always show current mode first
2. Always use AskUserQuestion for mode selection
3. Show appropriate next steps after switching
4. For BYOK mode, remind user to configure providers
