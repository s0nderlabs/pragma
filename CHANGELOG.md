# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-01-11

### Added
- Transfer tool supporting both native MON and ERC20 tokens
- Wrap tool (MON → WMON)
- Unwrap tool (WMON → MON)
- Native MON transfer using `nativeTokenTransferAmount` delegation scope
- Session key balance check tool
- Session key funding tool
- 0x aggregator as primary DEX with Monorail fallback

### Changed
- Swap output now includes explorer URL, route, gas estimate, and aggregator info
- Touch ID prompts now display expected output amounts
- Improved Keychain labels for clearer access dialogs

### Fixed
- WMON balance now fetched via RPC (Monorail data was stale)

## [0.1.0] - 2026-01-10

### Added
- Initial release
- Passkey wallet setup with P-256 keys and Touch ID
- HybridDeleGator smart account deployment via Pimlico
- Swap execution with DEX aggregation
- Balance checking (single token and full portfolio)
- Ephemeral delegation framework (5-min expiry, single-use)
- Session key system for gas-efficient operations
- Provider management (RPC, Pimlico, Monorail, 0x API keys)
- Plugin structure with MCP server integration
