// pragma-signer
// Secure key management CLI for pragma
// Uses Secure Enclave (Touch ID) for passkey and Keychain for session keys
// Copyright (c) 2026 s0nderlabs

import Foundation

// MARK: - JSON Output

struct JSONResponse: Encodable {
    let success: Bool
    let data: [String: String]?
    let error: String?

    init(success: Bool, data: [String: String]? = nil, error: String? = nil) {
        self.success = success
        self.data = data
        self.error = error
    }

    static func success(_ data: [String: String] = [:]) -> JSONResponse {
        JSONResponse(success: true, data: data.isEmpty ? nil : data)
    }

    static func failure(_ error: String) -> JSONResponse {
        JSONResponse(success: false, error: error)
    }
}

func output(_ response: JSONResponse) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys

    do {
        let data = try encoder.encode(response)
        if let json = String(data: data, encoding: .utf8) {
            print(json)
        }
    } catch {
        // Fallback if encoding fails
        print("{\"success\":false,\"error\":\"JSON encoding failed\"}")
    }
}

// MARK: - Commands

enum Command: String {
    case createPasskey = "create-passkey"
    case sign = "sign"
    case getPubkey = "get-pubkey"
    case getPrivate = "get-private"
    case hasPasskey = "has-passkey"
    case deletePasskey = "delete-passkey"
    case storeSession = "store-session"
    case getSession = "get-session"
    case deleteSession = "delete-session"
    case hasSession = "has-session"
    // Provider commands
    case storeProvider = "store-provider"
    case getProvider = "get-provider"
    case deleteProvider = "delete-provider"
    case hasProvider = "has-provider"
    case listProviders = "list-providers"
}

// MARK: - Command Handlers

func handleCreatePasskey(message: String?) {
    do {
        let publicKey = try SecureEnclave.createPasskey(message: message)
        let hexKey = "0x" + publicKey.map { String(format: "%02x", $0) }.joined()
        output(.success(["publicKey": hexKey]))
    } catch {
        output(.failure(error.localizedDescription))
    }
}

func handleSign(_ hexData: String, message: String?) {
    // Parse hex string (remove 0x prefix if present)
    let cleanHex = hexData.hasPrefix("0x") ? String(hexData.dropFirst(2)) : hexData

    guard let data = Data(hexString: cleanHex) else {
        output(.failure("Invalid hex data"))
        return
    }

    do {
        let signature = try SecureEnclave.sign(data, message: message)
        let hexSig = "0x" + signature.map { String(format: "%02x", $0) }.joined()
        output(.success(["signature": hexSig]))
    } catch {
        output(.failure(error.localizedDescription))
    }
}

func handleGetPubkey() {
    do {
        let publicKey = try SecureEnclave.getPublicKey()
        let hexKey = "0x" + publicKey.map { String(format: "%02x", $0) }.joined()
        output(.success(["publicKey": hexKey]))
    } catch {
        output(.failure(error.localizedDescription))
    }
}

func handleGetPrivate(message: String?) {
    // DEPRECATED: This command is deprecated for security reasons.
    // Private keys should never leave the Keychain.
    // Use 'sign' command instead for P-256 signing.
    output(.failure("DEPRECATED: get-private is disabled for security. Use 'sign' command for P-256 signing."))
}

func handleHasPasskey() {
    let exists = SecureEnclave.hasPasskey()
    output(.success(["exists": exists ? "true" : "false"]))
}

func handleDeletePasskey(message: String?) {
    do {
        try SecureEnclave.deletePasskey(message: message)
        output(.success())
    } catch {
        output(.failure(error.localizedDescription))
    }
}

func handleStoreSession(_ privateKeyHex: String) {
    do {
        try Keychain.storeSessionKey(privateKeyHex)
        output(.success())
    } catch {
        output(.failure(error.localizedDescription))
    }
}

func handleGetSession() {
    do {
        let privateKey = try Keychain.getSessionKey()
        // Return with 0x prefix for consistency
        let hexKey = privateKey.hasPrefix("0x") ? privateKey : "0x" + privateKey
        output(.success(["privateKey": hexKey]))
    } catch {
        output(.failure(error.localizedDescription))
    }
}

func handleDeleteSession() {
    do {
        try Keychain.deleteSessionKey()
        output(.success())
    } catch {
        output(.failure(error.localizedDescription))
    }
}

func handleHasSession() {
    let exists = Keychain.hasSessionKey()
    output(.success(["exists": exists ? "true" : "false"]))
}

// MARK: - Provider Handlers

func handleStoreProvider(_ type: String, _ value: String) {
    do {
        try Keychain.storeProvider(type, value)
        output(.success())
    } catch {
        output(.failure(error.localizedDescription))
    }
}

func handleGetProvider(_ type: String) {
    do {
        let value = try Keychain.getProvider(type)
        output(.success(["value": value]))
    } catch {
        output(.failure(error.localizedDescription))
    }
}

func handleDeleteProvider(_ type: String) {
    do {
        try Keychain.deleteProvider(type)
        output(.success())
    } catch {
        output(.failure(error.localizedDescription))
    }
}

func handleHasProvider(_ type: String) {
    let exists = Keychain.hasProvider(type)
    output(.success(["exists": exists ? "true" : "false"]))
}

func handleListProviders() {
    let providers = Keychain.listProviders()
    // Return as comma-separated list for easy parsing
    output(.success(["providers": providers.joined(separator: ",")]))
}

// MARK: - Hex String Extension

extension Data {
    init?(hexString: String) {
        let len = hexString.count / 2
        var data = Data(capacity: len)
        var index = hexString.startIndex

        for _ in 0..<len {
            let nextIndex = hexString.index(index, offsetBy: 2)
            guard let byte = UInt8(hexString[index..<nextIndex], radix: 16) else {
                return nil
            }
            data.append(byte)
            index = nextIndex
        }

        self = data
    }
}

// MARK: - Main

func printUsage() {
    let usage = """
    pragma-signer - Secure key management for pragma

    Usage:
      Passkey Commands (P-256, Touch ID):
        pragma-signer create-passkey [-m <msg>]     Create P-256 key (Touch ID)
        pragma-signer sign <hash> [-m <msg>]        Sign 32-byte hash with P-256 (Touch ID)
        pragma-signer get-pubkey                    Get passkey public key (X,Y coords)
        pragma-signer has-passkey                   Check if passkey exists
        pragma-signer delete-passkey [-m <msg>]     Delete passkey (Touch ID)

      Session Key Commands (Keychain):
        pragma-signer store-session <hex>           Store session key in Keychain
        pragma-signer get-session                   Get session key from Keychain
        pragma-signer delete-session                Delete session key from Keychain
        pragma-signer has-session                   Check if session key exists

      Provider Commands (Keychain, API keys):
        pragma-signer store-provider <type> <value> Store provider (rpc/pimlico/monorail)
        pragma-signer get-provider <type>           Get provider value
        pragma-signer delete-provider <type>        Delete provider
        pragma-signer has-provider <type>           Check if provider exists
        pragma-signer list-providers                List configured providers

    Options:
      -m, --message <msg>   Custom Touch ID prompt message

    Security:
      Private keys NEVER leave the Keychain. Only signatures are returned.
      All signing operations require Touch ID authentication.
      Provider values (API keys) are stored encrypted in Keychain.

    Output:
      All commands output JSON to stdout:
      {"success": true, "data": {...}}
      {"success": false, "error": "..."}

    Provider Types:
      rpc       - RPC endpoint URL (e.g., https://rpc.monad.xyz)
      pimlico   - Pimlico API key for bundler/paymaster
      monorail  - Monorail API key for DEX aggregator

    Examples:
      pragma-signer create-passkey
      pragma-signer create-passkey -m "Create wallet for trading"
      pragma-signer sign 0x<32-byte-hash> -m "Approve swap: 1 ETH -> 2000 USDC"
      pragma-signer store-provider rpc https://rpc.monad.xyz
      pragma-signer store-provider pimlico pim_xxx123
      pragma-signer list-providers
    """
    print(usage)
}

/// Parse -m or --message flag from arguments
func parseMessage(from args: [String], startingAt index: Int) -> String? {
    var i = index
    while i < args.count - 1 {
        if args[i] == "-m" || args[i] == "--message" {
            return args[i + 1]
        }
        i += 1
    }
    return nil
}

func main() {
    let args = CommandLine.arguments

    guard args.count >= 2 else {
        printUsage()
        exit(1)
    }

    // Handle help flag
    if args[1] == "-h" || args[1] == "--help" || args[1] == "help" {
        printUsage()
        exit(0)
    }

    guard let command = Command(rawValue: args[1]) else {
        output(.failure("Unknown command: \(args[1])"))
        exit(1)
    }

    switch command {
    case .createPasskey:
        let message = parseMessage(from: args, startingAt: 2)
        handleCreatePasskey(message: message)

    case .sign:
        guard args.count >= 3 else {
            output(.failure("Missing hex data argument for sign command"))
            exit(1)
        }
        let message = parseMessage(from: args, startingAt: 3)
        handleSign(args[2], message: message)

    case .getPubkey:
        handleGetPubkey()

    case .getPrivate:
        let message = parseMessage(from: args, startingAt: 2)
        handleGetPrivate(message: message)

    case .hasPasskey:
        handleHasPasskey()

    case .deletePasskey:
        let message = parseMessage(from: args, startingAt: 2)
        handleDeletePasskey(message: message)

    case .storeSession:
        guard args.count >= 3 else {
            output(.failure("Missing private key argument for store-session command"))
            exit(1)
        }
        handleStoreSession(args[2])

    case .getSession:
        handleGetSession()

    case .deleteSession:
        handleDeleteSession()

    case .hasSession:
        handleHasSession()

    // Provider commands
    case .storeProvider:
        guard args.count >= 4 else {
            output(.failure("Usage: store-provider <type> <value>"))
            exit(1)
        }
        handleStoreProvider(args[2], args[3])

    case .getProvider:
        guard args.count >= 3 else {
            output(.failure("Usage: get-provider <type>"))
            exit(1)
        }
        handleGetProvider(args[2])

    case .deleteProvider:
        guard args.count >= 3 else {
            output(.failure("Usage: delete-provider <type>"))
            exit(1)
        }
        handleDeleteProvider(args[2])

    case .hasProvider:
        guard args.count >= 3 else {
            output(.failure("Usage: has-provider <type>"))
            exit(1)
        }
        handleHasProvider(args[2])

    case .listProviders:
        handleListProviders()
    }
}

main()
