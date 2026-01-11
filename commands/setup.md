---
name: setup
description: Build pragma from source and set up wallet with Touch ID
---

# Pragma Setup

This command builds pragma from source and creates your wallet.

## Prerequisites

Pragma requires macOS with Touch ID for secure key storage.

## Important: Build vs Wallet Setup

- **Steps 1-5 (Build)**: ALWAYS run - installs dependencies and builds binaries
- **Step 6 (Wallet Creation)**: Only if no wallet exists OR user wants to reset

This ensures the plugin is properly built even if you already have a wallet from a previous installation.

## Step 1: Check Prerequisites

First, verify the required tools are installed.

Check for bun:
```bash
which bun || echo "NOT_FOUND"
```

If bun is not found, install it:
```bash
curl -fsSL https://bun.sh/install | bash && source ~/.bashrc
```

Check for Swift:
```bash
which swift || echo "NOT_FOUND"
```

If Swift is not found, tell the user to install Xcode Command Line Tools:
```
Swift is required but not installed. Please run:
xcode-select --install
Then re-run /pragma:setup
```

## Step 2: Install Dependencies

```bash
cd ${CLAUDE_PLUGIN_ROOT}/servers/pragma-mcp && bun install
```

## Step 3: Build TypeScript MCP Server

```bash
cd ${CLAUDE_PLUGIN_ROOT}/servers/pragma-mcp && bun run build
```

This compiles TypeScript to `dist/index.js`.

## Step 4: Build Swift Binary

```bash
cd ${CLAUDE_PLUGIN_ROOT}/swift && swift package clean && swift build -c release
```

This builds `pragma-signer` which handles Touch ID and Keychain operations.

## Step 5: Copy Binary

```bash
mkdir -p ${CLAUDE_PLUGIN_ROOT}/bin
cp ${CLAUDE_PLUGIN_ROOT}/swift/.build/release/pragma-signer ${CLAUDE_PLUGIN_ROOT}/bin/
chmod +x ${CLAUDE_PLUGIN_ROOT}/bin/pragma-signer
```

## Step 5.1: Check Existing Wallet

Now that MCP tools are available, check if a wallet already exists.

Use the `has_wallet` MCP tool to check wallet status.

If `has_wallet` returns `initialized: true`:
- Show: "Existing pragma wallet found. Keep existing wallet or reset?"
- If user chooses **keep** - Skip Step 6, go to Step 7 (build is done, wallet already exists)
- If user chooses **reset** - Continue to Step 6 (will create new wallet, old keys removed)

If `has_wallet` returns `initialized: false`:
- Continue to Step 6 (create new wallet)

## Step 6: Create Wallet

Use the `setup_wallet` MCP tool to create the smart account:

1. Call `setup_wallet` with your RPC URL
2. This will prompt Touch ID to create a passkey
3. A smart account will be deployed
4. Session key will be generated and stored securely

Example:
```
User provides RPC URL -> Touch ID prompt -> Smart account deployed -> Ready to trade!
```

## Step 7: Verify Skill Activation

Test that pragma-core skill is active by checking balance:

1. Ask: "What's my balance?"
2. Verify:
   - pragma-core skill should activate (check tool usage)
   - `get_balance` or `get_all_balances` MCP tool should be called
   - NO Bash commands should be used

If working correctly, you'll see your wallet balance via MCP tools.

## Success

After completing these steps:
- `dist/index.js` exists (MCP server)
- `bin/pragma-signer` exists (Swift binary)
- Smart account is deployed
- pragma-core skill is active and working
- You can now use pragma tools: get_balance, get_swap_quote, execute_swap

## Security Notice

**IMPORTANT:** After setup, ALWAYS use MCP tools for pragma operations.

NEVER run these commands directly via Bash:
- `pragma-signer get-session` - Exposes private key
- `pragma-signer get-provider` - Exposes API keys

MCP tools handle secrets securely and never expose them to the terminal.

## Troubleshooting

**bun install fails:** Make sure you have bun 1.0+ installed.

**Swift build fails:** Make sure Xcode Command Line Tools are installed (`xcode-select --install`).

**Touch ID fails:** Ensure you have Touch ID configured in System Preferences.

**MCP tools not found:** Restart Claude Code after setup to reload MCP servers.

**Wallet already exists:** Use `has_wallet` tool to check status. Reset only if necessary.
