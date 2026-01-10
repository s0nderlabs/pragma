// SecureEnclave.swift
// Passkey management using Keychain with Touch ID protection
// Generates P-256 keys and stores them in Keychain (not hardware Secure Enclave)
// Touch ID is required via LAContext before key operations
// Copyright (c) 2026 s0nderlabs

import Foundation
import Security
import LocalAuthentication

enum SecureEnclaveError: Error, LocalizedError {
    case notAvailable
    case keyCreationFailed(String)
    case signingFailed(String)
    case keyNotFound
    case biometricFailed(String)
    case invalidSignature
    case invalidPublicKey
    case deleteFailed(String)
    case keychainError(OSStatus)

    var errorDescription: String? {
        switch self {
        case .notAvailable:
            return "Touch ID is not available on this device"
        case .keyCreationFailed(let msg):
            return "Failed to create passkey: \(msg)"
        case .signingFailed(let msg):
            return "Failed to sign: \(msg)"
        case .keyNotFound:
            return "Passkey not found. Run setup first."
        case .biometricFailed(let msg):
            return "Touch ID authentication failed: \(msg)"
        case .invalidSignature:
            return "Invalid signature format"
        case .invalidPublicKey:
            return "Invalid public key format"
        case .deleteFailed(let msg):
            return "Failed to delete passkey: \(msg)"
        case .keychainError(let status):
            return "Keychain error: \(status)"
        }
    }
}

struct SecureEnclave {
    // Keychain identifiers - using clear naming
    private static let service = "xyz.pragma.wallet"
    private static let privateKeyAccount = "passkey.private"
    private static let publicKeyAccount = "passkey.public"

    /// Check if Touch ID is available
    static var isAvailable: Bool {
        let context = LAContext()
        var error: NSError?
        return context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
    }

    /// Create a new P-256 key pair
    /// Requires Touch ID authentication via LAContext
    /// - Parameter message: Custom Touch ID prompt message
    /// - Returns: Public key in uncompressed format (65 bytes: 04 || X || Y)
    static func createPasskey(message: String? = nil) throws -> Data {
        guard isAvailable else {
            throw SecureEnclaveError.notAvailable
        }

        // Authenticate with Touch ID first
        let reason = message ?? "Create pragma wallet"
        try authenticateWithTouchID(reason: reason)

        // Delete existing keys if present
        deletePasskeyInternal()

        // Generate P-256 key pair
        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: false
            ]
        ]

        var error: Unmanaged<CFError>?
        guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
            let cfError = error?.takeRetainedValue()
            throw SecureEnclaveError.keyCreationFailed(cfError?.localizedDescription ?? "Key generation failed")
        }

        // Get the public key
        guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
            throw SecureEnclaveError.keyCreationFailed("Failed to extract public key")
        }

        // Export keys to data
        let publicKeyData = try exportPublicKey(publicKey)

        var privateKeyError: Unmanaged<CFError>?
        guard let privateKeyData = SecKeyCopyExternalRepresentation(privateKey, &privateKeyError) as Data? else {
            throw SecureEnclaveError.keyCreationFailed("Failed to export private key")
        }

        // Store private key in Keychain
        // Note: Cannot use biometric access control for unsigned CLI tools (-34018)
        // Touch ID is enforced via LAContext before each operation instead
        let privateKeyQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: privateKeyAccount,
            kSecAttrLabel as String: "pragma Wallet Signing Key",
            kSecAttrDescription as String: "Used to sign blockchain transactions",
            kSecValueData as String: privateKeyData,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]

        var status = SecItemAdd(privateKeyQuery as CFDictionary, nil)
        if status != errSecSuccess {
            throw SecureEnclaveError.keychainError(status)
        }

        // Store public key in Keychain (for read-only access)
        let publicKeyQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: publicKeyAccount,
            kSecAttrLabel as String: "pragma Wallet Address",
            kSecAttrDescription as String: "Public key for wallet address derivation",
            kSecValueData as String: publicKeyData,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]

        status = SecItemAdd(publicKeyQuery as CFDictionary, nil)
        if status != errSecSuccess {
            // Clean up private key if public key storage fails
            deletePasskeyInternal()
            throw SecureEnclaveError.keychainError(status)
        }

        return publicKeyData
    }

    /// Sign a 32-byte hash using the passkey
    /// Requires Touch ID authentication via LAContext
    /// - Parameter data: 32-byte hash to sign directly (no additional hashing)
    /// - Parameter message: Custom Touch ID prompt message
    /// - Returns: Signature in R || S format (64 bytes)
    static func sign(_ data: Data, message: String? = nil) throws -> Data {
        // Verify input is a 32-byte hash
        guard data.count == 32 else {
            throw SecureEnclaveError.signingFailed("Expected 32-byte hash, got \(data.count) bytes")
        }

        // First, authenticate with Touch ID
        let reason = message ?? "Sign transaction"
        try authenticateWithTouchID(reason: reason)

        // Retrieve private key from Keychain
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: privateKeyAccount,
            kSecReturnData as String: true
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        switch status {
        case errSecSuccess:
            break
        case errSecItemNotFound:
            throw SecureEnclaveError.keyNotFound
        default:
            throw SecureEnclaveError.keychainError(status)
        }

        guard let privateKeyData = result as? Data else {
            throw SecureEnclaveError.keyNotFound
        }

        // Reconstruct SecKey from data
        let keyAttributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
            kSecAttrKeySizeInBits as String: 256
        ]

        var error: Unmanaged<CFError>?
        guard let privateKey = SecKeyCreateWithData(privateKeyData as CFData, keyAttributes as CFDictionary, &error) else {
            throw SecureEnclaveError.signingFailed("Failed to reconstruct private key")
        }

        // Sign the hash directly without additional hashing
        // Using ecdsaSignatureDigestX962SHA256 to sign pre-computed 32-byte hash
        guard let signature = SecKeyCreateSignature(
            privateKey,
            .ecdsaSignatureDigestX962SHA256,
            data as CFData,
            &error
        ) else {
            let cfError = error?.takeRetainedValue()
            throw SecureEnclaveError.signingFailed(cfError?.localizedDescription ?? "Signing failed")
        }

        // Convert DER signature to raw R || S format for Ethereum
        return try derToRawSignature(signature as Data)
    }

    /// Authenticate user with Touch ID
    /// - Parameter reason: Message shown in Touch ID prompt
    private static func authenticateWithTouchID(reason: String) throws {
        let context = LAContext()

        var authError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &authError) else {
            throw SecureEnclaveError.biometricFailed(authError?.localizedDescription ?? "Touch ID not available")
        }

        // Use semaphore to wait for async authentication
        let semaphore = DispatchSemaphore(value: 0)
        var authResult: Bool = false
        var authErrorResult: Error?

        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, error in
            authResult = success
            authErrorResult = error
            semaphore.signal()
        }

        semaphore.wait()

        if !authResult {
            if let error = authErrorResult as? LAError {
                switch error.code {
                case .userCancel:
                    throw SecureEnclaveError.biometricFailed("Cancelled by user")
                case .authenticationFailed:
                    throw SecureEnclaveError.biometricFailed("Authentication failed")
                default:
                    throw SecureEnclaveError.biometricFailed(error.localizedDescription)
                }
            }
            throw SecureEnclaveError.biometricFailed("Authentication failed")
        }
    }

    /// Get the passkey public key
    /// Does NOT require Touch ID (public key is not sensitive)
    /// - Returns: Public key in uncompressed format (65 bytes: 04 || X || Y)
    static func getPublicKey() throws -> Data {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: publicKeyAccount,
            kSecReturnData as String: true
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        switch status {
        case errSecSuccess:
            guard let publicKeyData = result as? Data else {
                throw SecureEnclaveError.invalidPublicKey
            }
            return publicKeyData
        case errSecItemNotFound:
            throw SecureEnclaveError.keyNotFound
        default:
            throw SecureEnclaveError.keychainError(status)
        }
    }

    /// Get the passkey private key for EOA derivation
    /// Requires Touch ID authentication
    /// - Parameter message: Custom Touch ID prompt message
    /// - Returns: Private key data (32 bytes for P-256)
    static func getPrivateKey(message: String? = nil) throws -> Data {
        // First, authenticate with Touch ID
        let reason = message ?? "Access wallet key"
        try authenticateWithTouchID(reason: reason)

        // Retrieve private key from Keychain
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: privateKeyAccount,
            kSecReturnData as String: true
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        switch status {
        case errSecSuccess:
            guard let privateKeyData = result as? Data else {
                throw SecureEnclaveError.keyNotFound
            }
            // P-256 private key in SEC1 format is 32 bytes (just the scalar)
            // But SecKeyCopyExternalRepresentation may include extra data
            // Extract just the 32-byte private key scalar
            if privateKeyData.count == 32 {
                return privateKeyData
            } else if privateKeyData.count == 65 {
                // SEC1 format: 04 || X || Y for public, but private should be 32 bytes
                // This shouldn't happen for private key
                throw SecureEnclaveError.signingFailed("Unexpected private key format")
            } else if privateKeyData.count == 97 {
                // Some formats include: privateKey (32) + 04 + X (32) + Y (32)
                return privateKeyData.prefix(32)
            } else if privateKeyData.count > 32 {
                // Try to extract first 32 bytes as private scalar
                return privateKeyData.prefix(32)
            }
            return privateKeyData
        case errSecItemNotFound:
            throw SecureEnclaveError.keyNotFound
        default:
            throw SecureEnclaveError.keychainError(status)
        }
    }

    /// Delete the passkey from Keychain
    /// Requires Touch ID authentication
    /// - Parameter message: Custom Touch ID prompt message
    static func deletePasskey(message: String? = nil) throws {
        // Authenticate with Touch ID before deleting
        let reason = message ?? "Delete pragma wallet"
        try authenticateWithTouchID(reason: reason)

        // Delete the keys
        deletePasskeyInternal()
    }

    /// Internal delete without Touch ID (used by createPasskey after auth)
    private static func deletePasskeyInternal() {
        // Delete private key
        let privateQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: privateKeyAccount
        ]
        SecItemDelete(privateQuery as CFDictionary)

        // Delete public key
        let publicQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: publicKeyAccount
        ]
        SecItemDelete(publicQuery as CFDictionary)
    }

    /// Check if passkey exists (checks public key, no Touch ID needed)
    static func hasPasskey() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: publicKeyAccount,
            kSecReturnData as String: false
        ]

        let status = SecItemCopyMatching(query as CFDictionary, nil)
        return status == errSecSuccess
    }

    // MARK: - Private Helpers

    /// Export public key in uncompressed format (04 || X || Y)
    private static func exportPublicKey(_ publicKey: SecKey) throws -> Data {
        var error: Unmanaged<CFError>?
        guard let publicKeyData = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
            throw SecureEnclaveError.invalidPublicKey
        }

        // The key should already be in X9.63 uncompressed format (04 || X || Y)
        // Verify it starts with 0x04 and is 65 bytes
        guard publicKeyData.count == 65 && publicKeyData[0] == 0x04 else {
            throw SecureEnclaveError.invalidPublicKey
        }

        return publicKeyData
    }

    /// Convert DER-encoded ECDSA signature to raw R || S format (64 bytes)
    /// Ethereum requires raw format, not DER
    private static func derToRawSignature(_ derSignature: Data) throws -> Data {
        // DER format: 0x30 [total-length] 0x02 [r-length] [r] 0x02 [s-length] [s]
        guard derSignature.count > 8 else {
            throw SecureEnclaveError.invalidSignature
        }

        var index = 0
        let bytes = [UInt8](derSignature)

        // Check sequence tag
        guard bytes[index] == 0x30 else {
            throw SecureEnclaveError.invalidSignature
        }
        index += 1

        // Skip total length
        if bytes[index] == 0x81 {
            index += 2
        } else {
            index += 1
        }

        // Parse R
        guard bytes[index] == 0x02 else {
            throw SecureEnclaveError.invalidSignature
        }
        index += 1

        let rLength = Int(bytes[index])
        index += 1

        var r = Data(bytes[index..<(index + rLength)])
        index += rLength

        // Parse S
        guard bytes[index] == 0x02 else {
            throw SecureEnclaveError.invalidSignature
        }
        index += 1

        let sLength = Int(bytes[index])
        index += 1

        var s = Data(bytes[index..<(index + sLength)])

        // Pad or trim R and S to 32 bytes each
        r = padOrTrimTo32Bytes(r)
        s = padOrTrimTo32Bytes(s)

        // Return R || S (64 bytes)
        return r + s
    }

    private static func padOrTrimTo32Bytes(_ data: Data) -> Data {
        if data.count == 32 {
            return data
        } else if data.count > 32 {
            // Remove leading zeros
            return data.suffix(32)
        } else {
            // Pad with leading zeros
            var padded = Data(repeating: 0, count: 32 - data.count)
            padded.append(data)
            return padded
        }
    }
}
