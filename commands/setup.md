---
name: setup
description: Build pragma from source and set up wallet with Touch ID
---

# Pragma Setup

This command builds pragma from source and creates your wallet.

## Prerequisites

Pragma requires macOS with Touch ID for secure key storage.

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
cd ${CLAUDE_PLUGIN_ROOT}/swift && swift build -c release
```

This builds `pragma-signer` which handles Touch ID and Keychain operations.

## Step 5: Copy Binary

```bash
mkdir -p ${CLAUDE_PLUGIN_ROOT}/bin
cp ${CLAUDE_PLUGIN_ROOT}/swift/.build/release/pragma-signer ${CLAUDE_PLUGIN_ROOT}/bin/
chmod +x ${CLAUDE_PLUGIN_ROOT}/bin/pragma-signer
```

## Step 6: Create Wallet

Now use the `setup_wallet` MCP tool to create the smart account:

1. Call `pragma__setup_wallet` with your Monad RPC URL
2. This will prompt Touch ID to create a passkey
3. A smart account will be deployed on Monad

Example:
```
User provides RPC URL → Touch ID prompt → Smart account deployed → Ready to trade!
```

## Success

After completing these steps:
- `dist/index.js` exists (MCP server)
- `bin/pragma-signer` exists (Swift binary)
- Smart account is deployed on Monad
- You can now use pragma tools: get_balance, get_swap_quote, execute_swap

## Troubleshooting

**bun install fails:** Make sure you have bun 1.0+ installed.

**Swift build fails:** Make sure Xcode Command Line Tools are installed (`xcode-select --install`).

**Touch ID fails:** Ensure you have Touch ID configured in System Preferences.

**MCP tools not found:** Restart Claude Code after setup to reload MCP servers.
