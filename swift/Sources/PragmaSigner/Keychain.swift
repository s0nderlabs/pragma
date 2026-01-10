// Keychain.swift
// Keychain operations for session key storage

import Foundation
import Security

enum KeychainError: Error, LocalizedError {
    case duplicateItem
    case itemNotFound
    case unexpectedStatus(OSStatus)
    case invalidData
    case encodingError

    var errorDescription: String? {
        switch self {
        case .duplicateItem:
            return "Item already exists in Keychain"
        case .itemNotFound:
            return "Item not found in Keychain"
        case .unexpectedStatus(let status):
            return "Keychain error: \(status)"
        case .invalidData:
            return "Invalid data format"
        case .encodingError:
            return "Failed to encode/decode data"
        }
    }
}

struct Keychain {
    private static let service = "xyz.pragma.session-key"
    private static let account = "session-key"

    /// Store session key (hex string) in Keychain
    /// - Parameter privateKeyHex: Private key as hex string (with or without 0x prefix)
    static func storeSessionKey(_ privateKeyHex: String) throws {
        // Normalize hex string (remove 0x prefix if present)
        let normalized = privateKeyHex.hasPrefix("0x")
            ? String(privateKeyHex.dropFirst(2))
            : privateKeyHex

        guard let data = normalized.data(using: .utf8) else {
            throw KeychainError.encodingError
        }

        // Delete existing key if present
        try? deleteSessionKey()

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]

        let status = SecItemAdd(query as CFDictionary, nil)

        switch status {
        case errSecSuccess:
            return
        case errSecDuplicateItem:
            throw KeychainError.duplicateItem
        default:
            throw KeychainError.unexpectedStatus(status)
        }
    }

    /// Retrieve session key from Keychain
    /// - Returns: Private key as hex string (without 0x prefix)
    static func getSessionKey() throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        switch status {
        case errSecSuccess:
            guard let data = result as? Data,
                  let hexString = String(data: data, encoding: .utf8) else {
                throw KeychainError.invalidData
            }
            return hexString
        case errSecItemNotFound:
            throw KeychainError.itemNotFound
        default:
            throw KeychainError.unexpectedStatus(status)
        }
    }

    /// Delete session key from Keychain
    static func deleteSessionKey() throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]

        let status = SecItemDelete(query as CFDictionary)

        switch status {
        case errSecSuccess, errSecItemNotFound:
            // Success or already deleted
            return
        default:
            throw KeychainError.unexpectedStatus(status)
        }
    }

    /// Check if session key exists
    static func hasSessionKey() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: false
        ]

        let status = SecItemCopyMatching(query as CFDictionary, nil)
        return status == errSecSuccess
    }
}
