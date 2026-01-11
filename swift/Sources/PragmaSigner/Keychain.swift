// Keychain.swift
// Keychain operations for session key and provider storage
// Copyright (c) 2026 s0nderlabs

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
    // MARK: - Constants

    private static let sessionService = "xyz.pragma.session-key"
    private static let sessionAccount = "session-key"
    private static let providerService = "xyz.pragma.providers"

    /// Human-readable labels for Keychain access dialogs
    private static func providerLabel(for type: String) -> String {
        switch type.lowercased() {
        case "rpc":
            return "pragma RPC URL"
        case "pimlico":
            return "pragma Pimlico API Key"
        case "monorail":
            return "pragma Monorail API Key"
        case "0x":
            return "pragma 0x API Key"
        default:
            return "pragma \(type) Provider"
        }
    }

    // MARK: - Session Key Operations

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
            kSecAttrService as String: sessionService,
            kSecAttrAccount as String: sessionAccount,
            kSecAttrLabel as String: "pragma Session Key",
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
            kSecAttrService as String: sessionService,
            kSecAttrAccount as String: sessionAccount,
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
            kSecAttrService as String: sessionService,
            kSecAttrAccount as String: sessionAccount
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
            kSecAttrService as String: sessionService,
            kSecAttrAccount as String: sessionAccount,
            kSecReturnData as String: false
        ]

        let status = SecItemCopyMatching(query as CFDictionary, nil)
        return status == errSecSuccess
    }

    // MARK: - Provider Operations

    /// Store a provider value (RPC URL, API key, etc.) in Keychain
    /// - Parameters:
    ///   - type: Provider type (e.g., "rpc", "pimlico", "monorail")
    ///   - value: The value to store (URL or API key)
    static func storeProvider(_ type: String, _ value: String) throws {
        guard let data = value.data(using: .utf8) else {
            throw KeychainError.encodingError
        }

        // Delete existing provider if present
        try? deleteProvider(type)

        // Human-readable label for Keychain access dialogs
        let label = providerLabel(for: type)

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: providerService,
            kSecAttrAccount as String: type,
            kSecAttrLabel as String: label,
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

    /// Retrieve a provider value from Keychain
    /// - Parameter type: Provider type (e.g., "rpc", "pimlico", "monorail")
    /// - Returns: The stored value
    static func getProvider(_ type: String) throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: providerService,
            kSecAttrAccount as String: type,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        switch status {
        case errSecSuccess:
            guard let data = result as? Data,
                  let value = String(data: data, encoding: .utf8) else {
                throw KeychainError.invalidData
            }
            return value
        case errSecItemNotFound:
            throw KeychainError.itemNotFound
        default:
            throw KeychainError.unexpectedStatus(status)
        }
    }

    /// Delete a provider from Keychain
    /// - Parameter type: Provider type to delete
    static func deleteProvider(_ type: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: providerService,
            kSecAttrAccount as String: type
        ]

        let status = SecItemDelete(query as CFDictionary)

        switch status {
        case errSecSuccess, errSecItemNotFound:
            return
        default:
            throw KeychainError.unexpectedStatus(status)
        }
    }

    /// Check if a provider exists
    /// - Parameter type: Provider type to check
    /// - Returns: true if provider exists
    static func hasProvider(_ type: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: providerService,
            kSecAttrAccount as String: type,
            kSecReturnData as String: false
        ]

        let status = SecItemCopyMatching(query as CFDictionary, nil)
        return status == errSecSuccess
    }

    /// List all configured provider types
    /// - Returns: Array of provider type strings that exist
    static func listProviders() -> [String] {
        // Known provider types to check
        let knownTypes = ["rpc", "pimlico", "monorail", "0x"]

        return knownTypes.filter { hasProvider($0) }
    }
}
