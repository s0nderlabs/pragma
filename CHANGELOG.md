# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.15] - 2026-01-20

### Added
- **contract-explainer subagent**: Analyzes smart contracts with comprehensive output
  - Uses Sonnet model for deep technical analysis
  - Returns proxy status, detected interfaces, key functions, security notes
  - Provides in-depth human explanation: purpose, how it works, who uses it, key considerations
  - Includes integration code examples
  - ~95% context savings vs direct tool call (110KB → 5KB)
- Updated pragma-core skill with contract-explainer routing rules
  - Added routing for "explain contract 0x..." queries
  - Added two-step workflow for "explain the contract I used"

## [0.3.14] - 2026-01-20

### Fixed
- Fixed `explain_contract` tool returning "Unknown Contract" for all contracts
  - Root cause: ApiResponse interface mismatch - API returns data nested in `contract` object but tool was reading from top level
  - Now correctly reads `apiResponse.contract.name` instead of `apiResponse.name`
  - Tool now returns proper contract name, ABI, source code, and verification status

## [0.3.13] - 2026-01-20

### Added
- New `explain_contract` MCP tool for smart contract analysis
  - Analyzes contracts and returns ABI, source code, proxy detection, and interface detection
  - x402 mode only (uses pragma-api-x402 contract endpoint)
  - Presentation guide in tool description for Claude formatting

## [0.3.12] - 2026-01-19

### Changed
- Added `[VERBATIM OUTPUT - DO NOT SUMMARIZE]` marker to subagent output
- Strengthened verbatim output enforcement with "PROHIBITED" language
- Updated pragma-core skill to recognize marker and enforce verbatim pass-through

## [0.3.11] - 2026-01-19

### Changed
- Added verbatim output instructions to subagents
  - Agent descriptions now include "present verbatim without re-summarizing"
  - Added "Output Instructions" section to both activity-fetcher and transaction-explainer
  - Helps prevent main agent from re-summarizing detailed subagent output

## [0.3.10] - 2026-01-19

### Changed
- Improved subagent routing rules in pragma-core skill
  - Clear separation: activity-fetcher for history, transaction-explainer for tx analysis
  - Added "explain my last tx" two-step workflow
  - Subagent output now passed through without re-summarizing

## [0.3.9] - 2026-01-19

### Changed
- Enhanced transaction-explainer agent with comprehensive output format
  - Now shows Execution Target (the actual contract called through delegation)
  - Shows Action Type (swap, stake, transfer, etc.)
  - Includes full function signature
  - Token movements now show from/to addresses
  - Gas table shows used vs limit with chain-specific notes
  - Security analysis shows all 6 checks with actual values
  - Key events section for notable contract interactions
  - Complete field reference for all available API data

## [0.3.8] - 2026-01-18

### Fixed
- Fixed plugin agents not calling MCP tools (removed explicit tools field to inherit all tools)

## [0.3.7] - 2026-01-18

### Added
- **Context-optimized subagents**: Two specialized subagents for context-heavy operations
  - `activity-fetcher` (Haiku): Formats transaction history as clean markdown tables
  - `transaction-explainer` (Sonnet): Provides technical + human-readable transaction analysis
- Subagents isolate large API responses (~40K-56K tokens) from main conversation context
- ~95% context savings when using activity/explain tools

### Changed
- Updated pragma-core skill to delegate activity operations to subagents
- Simplified Human-Readable Explanations section (details now in subagent prompts)

## [0.3.6] - 2026-01-18

### Added
- **explain_transaction tool**: Decode and explain any transaction in detail. Returns transaction type, token movements, gas info, and for Pragma transactions: delegation details and security analysis. x402 mode only.
- **get_onchain_activity tool**: Fetch on-chain transaction history for any address. Returns swaps, transfers, stakes, NFT trades, and more with token movements and USD values. x402 mode only.
- Updated pragma-core skill with new activity tools

### Note
- Activity tools require x402 mode (uses indexed data and ABI resolution infrastructure)
- Pricing: `explain_transaction` costs 0.002 USDC, `get_onchain_activity` costs 0.005 USDC per call

## [0.3.5] - 2026-01-18

### Added
- **get_block tool**: Get block information by number, hash, or latest with timestamp, gas usage, and transaction count
- **get_gas_price tool**: Get current gas price in wei, Gwei, and MON with estimated costs for common operations
- Both tools work in BYOK and x402 modes (direct RPC, no API endpoint needed)

## [0.3.4] - 2026-01-16

### Added
- **EIP-7966 Support**: `eth_sendRawTransactionSync` for ~50% latency reduction on transaction confirmations
- New `src/core/rpc/` module with receipt caching, sync transport, and cache-first waiting
- `createSyncHttpTransport()` helper combining x402 + EIP-7966 support

### Changed
- All execution operations (swap, transfer, wrap, unwrap, stake, session key funding) now use sync receipts
- Receipts from EIP-7966 are cached (5-min TTL) for instant retrieval
- Graceful fallback to standard polling if RPC doesn't support sync method

## [0.3.3] - 2026-01-16

### Added
- **get_account_info tool**: View wallet configuration, addresses, mode, and network info
- **get_token_info tool**: Look up token details by symbol or address with USD price and verification status
- Updated pragma-core skill with new tools

## [0.3.2] - 2026-01-16

### Added
- **Centralized Retry System**: New shared retry utility (`src/core/utils/retry.ts`) with exponential backoff for all API operations
- Retry now integrated at core client level (quote, data, adapters, bundler operations)
- **RPC Transport Retry**: `x402Fetch` now includes `fetchWithRetry()` for all RPC calls via viem
- Transient error detection for: fetch failed, timeout, ECONNRESET, 502/503/504, rate limits

### Changed
- **batch.ts Simplified**: Removed ~65 lines of local retry logic - now handled at lower level
- Batch response no longer includes `retried` field (retry is internal)
- Bundler operations (`getGasPrice`, `estimateUserOpGas`, `sponsorUserOperation`) now retry on transient errors
- All `x402Fetch` calls now use retry-enabled fetch for both x402 and BYOK modes

### Security
- **Idempotency Safety**: `sendUserOperation` is explicitly NOT retried to prevent double-spend
- Only idempotent read operations retry automatically

## [0.3.1] - 2026-01-16

### Added
- **Batch Quote Support**: `get_swap_quote` now supports batch mode with `quotes` array parameter
- **Parallel Quote Fetching**: Up to 5 concurrent quote requests for efficient multi-swap preparation
- **Auto-Retry for Transient Failures**: Batch quotes automatically retry on network errors (max 2 retries, exponential backoff)
- New `src/core/quote/batch.ts` module for batch orchestration with retry logic

### Changed
- `get_swap_quote` schema extended to support both single and batch modes (backward compatible)
- Batch response includes `quoteIds` array ready for `execute_swap`

### Removed
- **x402 USDC Balance Pre-Checks**: Removed redundant pre-operation USDC balance checks from `get_swap_quote` and `execute_swap`
  - Reduces latency (one less RPC call per operation)
  - Prevents transient RPC failures from blocking valid operations
  - x402 proxy returns clear 402 error if USDC is insufficient
  - Use `check_session_key_balance` for explicit balance checks

## [0.3.0] - 2026-01-15

### Added
- **Atomic Batch Swaps**: Support for executing multiple trades in a single on-chain transaction.
- **Virtual Allowance Tracking**: Intelligent cache to manage token approvals across complex batches.
- **Hybrid Funding Path**: High-speed "Pull" funding via delegation for session keys with existing gas.
- **Batch-Aware Gas Estimation**: Precise calculation for multi-operation turns.

### Changed
- **execute_swap Tool**: Now accepts a `quoteIds` array for parallel/batch execution (Breaking).
- **Config-Aware Transport**: RPC client now strictly respects BYOK vs x402 mode for safety.
- **Optimized Orchestration**: Updated core skills to strictly enforce sequential "Fund-Then-Execute" rules.

### Fixed
- Improved address derivation to correctly resolve transport options from user configuration.

## [0.2.1] - 2026-01-14

### Fixed
- Optimized x402 balance thresholds for micro-transactions
- Lowered minimum USDC balance requirement to 0.05 USDC (was 0.1 USDC)
- Increased safety buffer to 0.02 USDC to guarantee complex operations (like Swaps) complete safely

## [0.2.0] - 2026-01-14

### Added
- Flexible adapter system for BYOK mode - configure any provider via JSON adapters
- x402 mode for pay-per-API-call convenience (no API keys needed)
- `set_mode` tool to switch between BYOK and x402 modes
- Path mappings support for data adapters
- Parallel vs sequential execution guidance in pragma-core skill
- Pre-flight gas estimation for batch operations

### Changed
- Removed hardcoded provider code (monorail, zerox folders deleted)
- Provider config now uses `~/.pragma/providers/` adapter files
- WMON balance now fetches from RPC (more accurate than data APIs)
- Simplified aggregator module with direct re-exports
- Tool messages use natural language instead of technical syntax

### Fixed
- Portfolio endpoint path mapping in x402 mode
- WMON balance showing stale values
- Config migration preserving providers field

## [0.1.9] - 2026-01-13

### Changed
- Simplified config structure - removed redundant URL storage
- Mode switching now only changes `config.mode` field (was rewriting all URLs)
- URLs constructed at runtime based on mode (x402: hardcoded constant, BYOK: Keychain)
- `setup_wallet` no longer requires `rpc` parameter (auto-detected from mode)

### Security
- **Fixed BYOK security flaw** - API URLs no longer stored in plain-text config
- BYOK mode now reads exclusively from Keychain with no config fallback
- Removed `passkeyPublicKey` from config (unused, was leaking cryptographic material)

### Removed
- `network.rpc` from config (constructed at runtime)
- `bundler.url` from config (constructed at runtime)
- `apis.quote` and `apis.data` from config (constructed at runtime)
- `wallet.passkeyPublicKey` from config (not used operationally)

## [0.1.8] - 2026-01-13

### Added
- **x402 Micropayment Protocol** - Pay per API call with USDC instead of managing API keys
- New `x402` module (`core/x402/`) for transparent payment handling
- USDC balance tracking in `check_session_key_balance` (auto-enabled in x402 mode)
- USDC funding support in `fund_session_key` with `token="USDC"` parameter
- Pre-operation USDC checks in swap tools with actionable error messages

### Changed
- `x402Fetch` wrapper replaces `fetch` in all API clients for automatic payment handling
- `fund_session_key` now supports both MON (gas) and USDC (x402) funding
- `check_session_key_balance` returns USDC balance info when in x402 mode
- Session key funding now supports custom executions for ERC20 transfers

### Security
- EIP-3009 `transferWithAuthorization` for USDC payments (no spending approval needed)
- Session key signs USDC payments (no Touch ID per API call)
- USDC funding requires Touch ID confirmation via passkey delegation

## [0.1.7] - 2026-01-12

### Changed
- Touch ID prompts now show descriptive messages for session key funding (amount + method)
- `/providers` command now prohibits API key entry in chat for security

### Security
- Provider management only shows status and provides terminal commands
- Users must run `pragma-signer store-provider` directly instead of pasting keys in chat

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
