// swift-tools-version: 5.9
// pragma-signer - Secure key management for pragma

import PackageDescription

let package = Package(
    name: "PragmaSigner",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "pragma-signer", targets: ["PragmaSigner"])
    ],
    dependencies: [
        // CryptoKit is built-in for macOS 13+
    ],
    targets: [
        .executableTarget(
            name: "PragmaSigner",
            dependencies: [],
            path: "Sources/PragmaSigner"
        )
    ]
)
