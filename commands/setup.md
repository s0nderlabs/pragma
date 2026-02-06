---
name: setup
description: Build pragma from source and set up wallet with Touch ID
---

# Pragma Setup

This command builds pragma from source and creates your wallet.

## Prerequisites

Pragma requires macOS with Touch ID for secure key storage.

## Important: Two-Phase Setup

Setup requires a session restart midway because MCP tools are only discovered at session start.

**Phase 1 (Steps 1-3):** Build Swift Binary
- Checks prerequisites, compiles Swift binary, installs to `~/.pragma/bin/`
- The MCP server ships pre-bundled — no TypeScript build needed
- Ends with: "Please restart and run `claude --continue`"

**Phase 2 (Steps 3.1-5):** Wallet Setup (after `claude --continue`)
- Load pragma-core skill first (activates security restrictions)
- Check existing wallet, create if needed, verify setup

This ensures the signer binary is available and MCP tools are ready for wallet operations.

## Step 1: Check Prerequisites

First, verify Swift is installed (needed to compile the signer binary).

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

## Step 2: Build Swift Binary

```bash
cd ${CLAUDE_PLUGIN_ROOT}/swift && swift package clean && swift build -c release
```

This builds `pragma-signer` which handles Touch ID and Keychain operations.

## Step 3: Install Binary

Copy the compiled binary to `~/.pragma/bin/` where it persists across plugin updates:

```bash
mkdir -p ~/.pragma/bin
cp ${CLAUDE_PLUGIN_ROOT}/swift/.build/release/pragma-signer ~/.pragma/bin/
chmod +x ~/.pragma/bin/pragma-signer
```

## STOP: Session Restart Required

**Build is complete!** But MCP tools are not available yet.

Claude Code caches available MCP tools at session start. You need to restart the session for Claude to discover the pragma tools.

**Tell the user:**
```
Setup complete! The pragma-signer binary has been built and installed.

To continue setup, please:
1. Quit this session (Ctrl+C or type "exit")
2. Run: claude --continue

This will resume setup with MCP tools available for wallet creation.
```

**STOP HERE.** Do not proceed to Step 3.1 until the user has restarted and continued.

---

## After Session Restart (claude --continue)

When the user returns via `claude --continue`, proceed with wallet setup.

## Step 3.1: Load pragma-core Skill

**IMPORTANT:** Before using any MCP tools, load the pragma-core skill first.

Use the Skill tool to load `pragma:pragma-core`:
```
Skill(pragma:pragma-core)
```

This activates the `allowed-tools` restriction which:
- Permits only pragma MCP tools
- Blocks Bash access to prevent private key exposure
- Ensures secure operation throughout setup

**Do not proceed until the skill is loaded.**

## Step 3.2: Check Existing Wallet

MCP tools are now available. Check if a wallet already exists.

Use the `has_wallet` MCP tool to check wallet status.

If `has_wallet` returns `initialized: true`:
- **Use `AskUserQuestion`:**
  - Header: "Wallet"
  - Question: "Existing pragma wallet found. Keep existing or create new?"
  - Options:
    - Label: "Keep existing wallet"
      Description: "Continue with current wallet and keys"
    - Label: "Reset and create new"
      Description: "Delete existing keys and create fresh wallet"
- If **"Keep existing wallet"** - Skip Step 4, go to Step 5 (wallet already exists)
- If **"Reset and create new"** - Continue to Step 4 (will create new wallet)

If `has_wallet` returns `initialized: false`:
- Continue to Step 4 (create new wallet)

## Step 4: Create Wallet (if needed)

Use the `setup_wallet` MCP tool to create the smart account:

1. Call `setup_wallet` with your RPC URL
2. This will prompt Touch ID to create a passkey
3. A smart account will be deployed
4. Session key will be generated and stored securely

Example:
```
User provides RPC URL -> Touch ID prompt -> Smart account deployed -> Ready to trade!
```

## Step 5: Verify Setup

Test that everything is working by checking balance:

1. Use `get_all_balances` MCP tool to fetch portfolio
2. Verify:
   - Balance is returned successfully
   - Only MCP tools are used (Bash is blocked by pragma-core skill)

Show the user their wallet address and balances to confirm setup is complete.

## Success

After completing these steps:
- `dist/index.js` exists (MCP server, pre-bundled in git)
- `~/.pragma/bin/pragma-signer` exists (compiled Swift binary, persists across updates)
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

**Swift build fails:** Make sure Xcode Command Line Tools are installed (`xcode-select --install`).

**Touch ID fails:** Ensure you have Touch ID configured in System Preferences.

**MCP tools not found:** Restart Claude Code after setup to reload MCP servers.

**Wallet already exists:** Use `has_wallet` tool to check status. Reset only if necessary.

**Signer outdated after update:** If the pragma-signer binary needs updating, re-run `/pragma:setup` to rebuild it.
