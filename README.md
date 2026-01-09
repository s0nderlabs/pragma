# pragma

> Vibetrading for Claude Code

pragma is a Claude Code plugin that enables on-chain trading through natural conversation. Trade tokens, stake, and manage your portfolio - all from Claude Code.

**Currently available on Monad.**

## Features

- **Secure Wallet** - Passkey-based smart account with Touch ID
- **Token Swaps** - DEX aggregation for best prices
- **Transfers** - Send tokens to any address
- **Staking** - Liquid staking support

## Installation

### As Claude Code Plugin

```bash
# From GitHub
claude plugin add s0nderlabs/pragma

# Or from local directory
claude plugin add /path/to/pragma-mcp
```

### Build from Source

```bash
# Clone the repo
git clone https://github.com/s0nderlabs/pragma
cd pragma

# Build MCP server
cd servers/pragma-mcp
bun install
bun run build

# Build Swift binary (macOS only)
cd ../../swift
swift build -c release
cp .build/release/pragma-signer ../bin/
```

## Usage

### Setup

First, initialize your wallet:

```
/pragma:setup
```

This creates:
- A passkey in Secure Enclave (Touch ID)
- A smart account on the network
- A session key for gas-efficient operations

### Commands

| Command | Description |
|---------|-------------|
| `/pragma:setup` | Initialize wallet |
| `/pragma:balance` | Check token balances |
| `/pragma:swap` | Swap tokens |
| `/pragma:transfer` | Send tokens |
| `/pragma:stake` | Stake tokens |

### Examples

**Check balance:**
```
What's my balance?
```

**Swap tokens:**
```
Swap 1 MON for WMON
```

**Transfer:**
```
Send 5 MON to 0x123...
```

**Stake:**
```
Stake 10 MON
```

## Architecture

```
pragma-mcp/
├── .claude-plugin/     # Plugin manifest
├── commands/           # Slash commands
├── skills/             # Trading skill (system prompt)
├── hooks/              # Event handlers
├── servers/pragma-mcp/ # MCP server (TypeScript)
├── swift/              # Secure key management (Swift)
└── bin/                # Compiled binaries
```

## Security

- **Passkey** - P-256 key stored in Secure Enclave, requires Touch ID
- **Smart Account** - ERC-4337 account with passkey as owner
- **Ephemeral Delegations** - 5-minute single-use permissions
- **Exact Calldata Enforcement** - Only pre-approved transactions execute
- **Session Key** - Hot key for gas, cannot access funds

## Requirements

- macOS 13+ (for Secure Enclave / Touch ID)
- Claude Code CLI
- RPC endpoint for your network

## Configuration

Config stored at `~/.pragma/config.json`:

```json
{
  "mode": "diy",
  "network": {
    "chainId": 10143,
    "rpc": "https://your-rpc-endpoint"
  },
  "wallet": {
    "smartAccountAddress": "0x...",
    "sessionKeyAddress": "0x..."
  }
}
```

## Development

### Prerequisites

- Bun 1.0+
- Swift 5.9+
- Node.js 18+

### Build

```bash
# MCP Server
cd servers/pragma-mcp
bun install
bun run build
bun run typecheck

# Swift Binary
cd swift
swift build
```

### Test Locally

```bash
# Run with local plugin
claude --plugin-dir /path/to/pragma-mcp
```

## License

MIT

## Links

- [s0nderlabs](https://github.com/s0nderlabs)
- [Claude Code](https://claude.ai/claude-code)
