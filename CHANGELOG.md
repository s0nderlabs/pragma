# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.6] - 2026-01-12

### Added
- Slippage control at quote time via `slippageBps` parameter in `get_swap_quote`
- MOTION, LV (LeverUp), ALLOCA tokens to verified list (now 25 tokens)
- Token search for unverified tokens via Monorail `/tokens?find=` endpoint

### Fixed
- **Critical**: 0x v2 API slippage now works correctly (was using deprecated v1 parameter)
- earnAUSD decimals corrected from 18 to 6
- ALLOCA and LV tokens now include "verified" category

## [0.1.5] - 2026-01-12

### Added
- `list_verified_tokens` tool - Discover tradeable tokens (23+ verified tokens)
- Static verified token list with 23 curated tokens (H2's 19 + 4 from monad-contracts.json)
- Token categories: native, stablecoins, LST, bridged, synthetic, meme

### Changed
- Token resolution now checks static list first (fast, no network call)
- `pragma-core` skill now uses `AskUserQuestion` for all execution confirmations
- Setup command Step 5.2 now uses `AskUserQuestion` for wallet decisions
- Confirmations now use structured UI instead of text-based prompts

## [0.1.4] - 2026-01-11

### Changed
- Setup command now explicitly loads pragma-core skill after session restart (Step 5.1)
- Ensures `allowed-tools` security restriction is active before any MCP tool usage

## [0.1.3] - 2026-01-11

### Changed
- Setup command now uses two-phase flow with session restart
- Phase 1 builds MCP server and Swift binary, then prompts user to restart
- Phase 2 (after `claude --continue`) handles wallet setup with MCP tools available
- Fixes issue where MCP tools weren't available immediately after fresh install build

## [0.1.2] - 2026-01-11

### Added
- `has_wallet` tool - Safe check for wallet initialization status
- `has_providers` tool - Safe check for provider configuration
- `pragma-core` skill with `allowed-tools` enforcement

### Changed
- Setup command now checks for existing wallet before creating new one
- Setup command includes security notice about direct CLI access
- Language made chain-agnostic (removed Monad-specific references)

### Security
- **CRITICAL:** Implemented `allowed-tools` restriction in pragma-core skill
- Claude is now restricted to MCP tools only when pragma-core skill is active
- Bash access blocked to prevent private key exposure via `pragma-signer get-session`
- Bash access blocked to prevent API key exposure via `pragma-signer get-provider`

### Removed
- `trading` skill (merged into `pragma-core`)

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
