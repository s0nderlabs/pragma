# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.3] - 2026-01-24

### Added
- **Universal Intelligence MCP Tools** - 7 new market intelligence tools (x402 mode):
  - `market_get_fx_reference`: ECB exchange rates with configurable base currency
  - `market_get_currency_strength`: 28-pair currency strength matrix with momentum signals
  - `market_get_economic_events`: High-impact economic events from Forex Factory
  - `market_get_weekly_calendar`: Weekly economic calendar grouped by day
  - `market_get_critical_news`: Critical news via 5-layer red detection
  - `market_search_news`: Keyword search in news (last 7 days)
  - `market_get_cb_speeches`: Central bank speeches and policy announcements

## [0.7.2] - 2026-01-24

### Changed
- **Bootstrap Registration** - Session key is now registered during wallet setup for automatic free API quota
  - Session key generated before smart account deployment
  - Bundler calls include `X-SESSION-KEY` header for bootstrap association
- **x402 Bootstrap Headers** - API requests now include wallet/session headers for free quota tracking

### Fixed
- Improved HTTP error handling in session key funding (extracts error message from response body)
- Removed unused `createPublicClient` import and `getRouteType` function

## [0.7.1] - 2026-01-24

### Added
- **LeverUp TP/SL Management** - New `leverup_update_tpsl` tool to update take profit and stop loss on existing positions
  - Update TP and/or SL prices on any position
  - Set price to '0' to disable TP or SL trigger
  - Nonpayable operation (no gas value required)

### Fixed
- **LeverUp Add Margin** - Fixed `leverup_update_margin` tool that was failing with "Diamond: Function does not exist"
  - Root cause: Using wrong function signature `updateMargin(bytes32,uint96,bool)` instead of `addMargin(bytes32,address,uint96)`
  - Now correctly passes token address parameter
  - Removed `isAdd` parameter (only adding margin is supported by contract)
  - Added ERC20 approval handling for non-MON collateral
  - Fixed nonce increment bug for multi-delegation batches
- **Session Key Funding** - Fixed funding failures when session key balance is low
  - Raised `MIN_GAS_FOR_DELEGATION` threshold (0.02 → 0.05 MON) for proper UserOp fallback
  - Added custom MON amount support in `fund_session_key` tool
  - Increased max auto-funding from 3 to 10 MON

## [0.7.0] - 2026-01-23

### Added
- **LeverUp Limit Orders** - 3 new MCP tools for limit order trading:
  - `leverup_open_limit_order`: Place limit orders at specified trigger prices with SL/TP
  - `leverup_list_limit_orders`: View all pending limit orders
  - `leverup_cancel_limit_order`: Cancel pending limit orders (single or batch)
- Trigger price validation for limit orders (Long below market, Short above market)

### Fixed
- **Native MON collateral** - Fixed trading with MON collateral by using WMON in calldata while sending native MON as msg.value (contract wraps internally)
- Balance validation now includes trading fees before transaction
- Parallel limit order fetching (20x faster)

## [0.6.1] - 2026-01-23

### Added
- **Market Intelligence Tools** - 2 new read-only MCP tools for market analysis:
  - `market_get_chart`: OHLCV candlestick data for any asset (crypto, stocks, forex, commodities) via Pyth Benchmark API
  - `leverup_get_market_stats`: Real-time Pyth oracle prices for all LeverUp trading pairs

## [0.6.0] - 2026-01-23

### Added
- **LeverUp Perpetuals Trading** - 6 new MCP tools for leveraged trading on Monad:
  - `leverup_list_pairs`: Browse 20 supported markets (Crypto, Stocks, Forex, Indices, Commodities)
  - `leverup_get_quote`: Risk simulation with liquidation price, health factor, and fee estimates
  - `leverup_open_trade`: Open market positions with optional Stop Loss and Take Profit
  - `leverup_close_trade`: Close positions to realize PnL
  - `leverup_list_positions`: View active trades with real-time PnL analysis
  - `leverup_update_margin`: Add or remove collateral (normal leverage only)
- **Zero-Fee Perpetuals** - Support for 500BTC/500ETH high-leverage pairs (500x, 750x, 1001x)
- **Stop Loss & Take Profit** - Set SL/TP when opening positions with automatic validation
- **Multi-collateral support** - Trade with MON, USDC, LVUSD, or LVMON

### Changed
- Extracted reusable helpers for leverage validation and collateral handling

## [0.5.0] - 2026-01-22

### Added
- **Atomic Token Creation** - `nadfun_create` tool for deploying new tokens on nad.fun.
  - Supports **Atomic Initial Buy** (creation + buy in one transaction).
  - Multi-step asset handling: automatic image and metadata upload to nad.fun storage.
  - Native vanity address mining (all tokens end in `7777`).
  - Optional social links (Twitter, Telegram, Website) and description.
  - Real-time quoting with slippage protection for the initial purchase.
- **Interactive Flow** - New skill-based flow for guided token creation.

## [0.4.2] - 2026-01-21

### Added
- **Token Creation** - `nadfun_create` tool for deploying new tokens on nad.fun bonding curve
  - Uploads image and metadata to nad.fun storage
  - Mines vanity address (tokens end in 7777)
  - Deploys token via BondingCurveRouter contract
  - **Atomic Initial Buy** - Supports buying tokens atomically during creation transaction
  - Supports optional socials: Twitter, Telegram, website
  - Full validation: image size/type, field lengths, URL formats
  - NSFW detection via nad.fun API
  - Works in both BYOK and x402 modes
  - **Note:** Requires 10 MON deploy fee + initial buy MON in Smart Account balance.

## [0.4.1] - 2026-01-21

### Added
- **nad.fun P2 Discovery Tools** - 3 new MCP tools for token discovery and analytics:
  - `nadfun_discover`: Find trending/new tokens sorted by market cap, newest, or most active
  - `nadfun_token_info`: Detailed token info including metadata, market data, and graduation progress
  - `nadfun_positions`: View nad.fun token holdings with PnL analysis
- All P2 tools use public nad.fun HTTP API and work in both BYOK and x402 modes

## [0.4.0] - 2026-01-21

### Added
- **nad.fun bonding curve trading** - 4 new MCP tools for trading on nad.fun
  - `nadfun_status`: Check token graduation status, progress, and trading venue
  - `nadfun_quote`: Get buy/sell quotes with slippage control (5-min expiry)
  - `nadfun_buy`: Buy tokens on bonding curve (Touch ID required)
  - `nadfun_sell`: Sell tokens on bonding curve (Touch ID required)
- **Exact output mode** - Specify desired output instead of input amount
  - `nadfun_quote` supports `exactOutput: true` parameter
  - Example: "buy me 500 tokens" calculates required MON
- Token metadata in status - Shows token name/symbol from on-chain ERC20
- Works in both BYOK and x402 modes (RPC only, no external API)

### Fixed
- Delegation routing - Uses Lens-returned router for correct contract targeting

## [0.3.16] - 2026-01-20

### Changed
- Improved VERBATIM output handling for subagents
  - Added prominent top-level rule in pragma-core skill
  - Ensures subagent output is displayed exactly as returned
- Aligned contract-explainer agent structure with other agents
  - Added role intro, Task section, Field Reference

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
