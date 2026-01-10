# Building pragma-signer

The `pragma-signer` binary provides secure key management using macOS Keychain with Touch ID protection.

## Requirements

- **macOS 14.0+** with Touch ID
- **Swift 5.9+** (included with Xcode Command Line Tools)

No paid Apple Developer account required.

## Building

```bash
cd swift
swift build -c release
```

The binary is at: `.build/arm64-apple-macosx/release/pragma-signer`

## Testing

```bash
# Test Keychain (session key storage)
./pragma-signer has-session
./pragma-signer store-session 0xabcdef1234567890
./pragma-signer get-session
./pragma-signer delete-session

# Test Passkey (P-256 key with Touch ID)
./pragma-signer has-passkey
./pragma-signer create-passkey           # Creates new key pair
./pragma-signer get-pubkey               # Returns public key (no Touch ID)
./pragma-signer sign 0x1234abcd...       # Signs hash (prompts Touch ID)
./pragma-signer delete-passkey
```

## Architecture

```
pragma-signer
├── Passkey (P-256 key with Touch ID)
│   ├── create-passkey  → Generates key pair, stores in Keychain
│   ├── sign            → Prompts Touch ID, then signs
│   ├── get-pubkey      → Returns public key (no Touch ID needed)
│   ├── has-passkey     → Checks if key exists
│   └── delete-passkey  → Removes key from Keychain
│
└── Session Key (simple Keychain storage)
    ├── store-session   → Stores private key hex
    ├── get-session     → Returns private key hex
    ├── has-session     → Checks if key exists
    └── delete-session  → Removes key
```

## Security Model

**Passkey (for signing transactions):**
- P-256 key pair generated in software
- Private key stored encrypted in macOS Keychain
- **Touch ID required before every signature**
- Key never leaves the device (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`)

**Session Key (for gas payments):**
- Standard EOA private key
- Stored encrypted in macOS Keychain
- No biometric required (low-value, refillable)

## Output Format

All commands output JSON to stdout:

```json
// Success
{"success": true, "data": {"publicKey": "0x04..."}}

// Error
{"success": false, "error": "Error message"}
```

## Installation

Copy the binary to a location in your PATH or set `PRAGMA_SIGNER_PATH`:

```bash
# Option 1: Copy to ~/.pragma/bin/
mkdir -p ~/.pragma/bin
cp .build/arm64-apple-macosx/release/pragma-signer ~/.pragma/bin/

# Option 2: Set environment variable
export PRAGMA_SIGNER_PATH=/path/to/pragma-signer
```

The TypeScript MCP server automatically searches for the binary in:
1. `PRAGMA_SIGNER_PATH` environment variable
2. `~/.pragma/bin/pragma-signer`
3. Plugin's bin directory
4. Swift build output (for development)
