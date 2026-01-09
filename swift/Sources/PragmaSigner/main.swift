// pragma-signer
// Secure key management CLI for pragma
// Uses Secure Enclave (Touch ID) for passkey and Keychain for session keys

import Foundation

// TODO: Implement CLI interface
// Commands:
// - create-passkey: Create P-256 key in Secure Enclave
// - sign <hex>: Sign data with passkey (requires Touch ID)
// - get-pubkey: Get passkey public key
// - store-session <key>: Store session key in Keychain
// - get-session: Get session key from Keychain
// - delete-session: Delete session key

enum Command: String {
    case createPasskey = "create-passkey"
    case sign = "sign"
    case getPubkey = "get-pubkey"
    case storeSession = "store-session"
    case getSession = "get-session"
    case deleteSession = "delete-session"
}

func main() {
    let args = CommandLine.arguments

    guard args.count >= 2 else {
        printUsage()
        exit(1)
    }

    guard let command = Command(rawValue: args[1]) else {
        print("Unknown command: \(args[1])")
        printUsage()
        exit(1)
    }

    // TODO: Implement command handling
    print("Command '\(command.rawValue)' not yet implemented")
    exit(1)
}

func printUsage() {
    print("""
    pragma-signer - Secure key management for pragma

    Usage:
      pragma-signer create-passkey          Create P-256 key in Secure Enclave
      pragma-signer sign <hex>              Sign data with passkey (Touch ID)
      pragma-signer get-pubkey              Get passkey public key
      pragma-signer store-session <key>     Store session key in Keychain
      pragma-signer get-session             Get session key from Keychain
      pragma-signer delete-session          Delete session key
    """)
}

main()
