# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.51] - 2026-02-12

### Added
- Social Intelligence tools — 5 new x402 MCP tools for X/Twitter data:
  - `x_search` — search recent tweets with sort by recency or relevancy ($0.007/tweet)
  - `x_get_tweet` — tweet lookup by ID with conversation context and referenced tweets ($0.007)
  - `x_get_user` — user profile lookup with pinned tweet ($0.014)
  - `x_get_replies` — get replies to any tweet with referenced tweet context ($0.007/reply)
  - `x_get_user_tweets` — get a user's timeline, exclude replies or retweets ($0.007/tweet)

## [0.8.50] - 2026-02-11

### Added
- Headless execution module (`src/core/execution/headless.ts`) for OpenClaw/Linux where Touch ID is unavailable
- Headless execution path in all 12 write tools: wrap, unwrap, transfer, execute-swap, nadfun-buy, nadfun-sell, leverup-open-trade, leverup-close-trade, leverup-update-tpsl, leverup-update-margin, leverup-cancel-limit-order, leverup-open-limit-order
- ERC20 approval handling in headless mode with MaxUint256 + spender whitelist
- OpenClaw section in README with platform comparison table and install instructions

## [0.8.49] - 2026-02-10

### Fixed
- Agent misidentifying forex market hours — added Quick Check with boolean day-of-week rules to eliminate cross-midnight time arithmetic

## [0.8.48] - 2026-02-09

### Added
- Desktop Extension (DXT) packaging for Claude Desktop and Cowork — `dxt/manifest.json` manifest + `scripts/build-mcpb.sh` build script
- Cowork detection — plugin MCP server skips tool registration inside Cowork VM so DXT handles tools on the macOS host
- TeammateIdle hook for autonomous agent loop enforcement with teammate agents

### Fixed
- `console.log` corrupting MCP stdio protocol — 18 statements wrote to stdout (JSON-RPC channel), causing server restarts and quote cache loss; all changed to `console.error`

## [0.8.47] - 2026-02-09

### Fixed
- Ship correct esbuild distribution bundle (1.8MB) — previous commits shipped tsc output (659 bytes) causing plugin load failure

## [0.8.46] - 2026-02-09

### Fixed
- Restore spawn-time reinforcement for SendMessage notifications and wallet architecture removed in v0.8.44 — agents were skipping Leader Notification Protocol without it

## [0.8.45] - 2026-02-09

### Fixed
- Clarify Pyth oracle fee is 1 wei per trade in budget configuration guidance
- Update MON budget AskUserQuestion to recommend 1 MON as safety floor for ERC20 strategies

## [0.8.44] - 2026-02-09

### Changed
- **Inline spawn template** — Deleted `tool-bootstrap/SKILL.md`. Turn 2 template now lives directly in autonomous-mode Step 8b with only per-spawn variables (agentId, TASK, BUDGET, MAX CALLS, CURRENT TIME, EXPIRES). All behavioral rules were redundant with agent definitions — agents figure out call counting from `get_sub_agent_state` response.

## [0.8.43] - 2026-02-09

### Added
- **Time accuracy rule** — All agent definitions (kairos, thymos, pragma) now require `Bash('date -u')` before time-sensitive decisions. Spawn prompt includes `CURRENT TIME:` field
- **Long-wait sleep pattern** — Background sleep + TaskOutput pattern documented in all agent definitions for waits >10 min (Bash tool has a 10-min timeout cap)
- **Sleep enforcement for thymos/pragma** — Thymos gains `sleep 120` between monitoring cycles, Pragma gains condition-dependent sleep enforcement (previously only kairos had `sleep 600`)

## [0.8.42] - 2026-02-09

### Added
- **TeammateIdle hook** — Loop enforcement now works for teammate agents (not just background subagents). New `teammate-idle-hook.sh` mirrors `subagent-stop-hook.sh` with the TeammateIdle contract (exit code 2 + stderr)
- **teammateName field** — `get_sub_agent_state` accepts `teammateName` parameter for hook lookup; stored in agent state.json

### Fixed
- **Autonomous agent loops broken for teammates** — Since v0.8.24, agents spawned as teammates would run one turn and go idle forever because SubagentStop only fires for background subagents. TeammateIdle hook now catches teammate idle events and re-injects the mission

## [0.8.41] - 2026-02-08

### Security
- **agentId path traversal fix** — Added UUID format validation and path containment check to prevent directory traversal via crafted agent IDs
- **imagePath file exfiltration fix** — Token creation now validates image file extension (PNG/JPEG/WebP only) before upload

### Fixed
- **Mermaid diagrams rendering `\n` literally** — Replaced `\n` with `<br/>` in README diagrams for proper GitHub rendering

## [0.8.40] - 2026-02-08

### Added
- **README rewrite** — Complete overhaul with hero GIF, YouTube demo link, version badge, x402 explainer, requirements checklist, support section, and compact production runs summary table
- **Production runs documentation** — Full trade logs extracted to `docs/production-runs.md` with margin data
- **Agent leader notifications** — Kairos agents now notify the team lead at every phase boundary via SendMessage; leader enrichment protocol pulls journal data for rich user-facing summaries
- **Media assets** — Demo GIFs, hero image, and live trading screenshots in `assets/`
- **Skill loader hook** — Auto-loads `pragma-core` skill on tool calls

### Changed
- **Autonomous mode skill** — Expanded with leader enrichment protocol, agent status report procedure, and on-chain exposure pre-flight checks
- **Pragma-core skill** — Refined tool groupings and descriptions

### Removed
- **Legacy slash commands** — Deleted `commands/balance.md`, `commands/stake.md`, `commands/swap.md`, `commands/transfer.md` (superseded by `pragma-core` skill)
- **Dead code** — Removed `stake.ts` tool (was never registered in MCP server)

## [0.8.39] - 2026-02-07

### Changed
- **Setup command simplified** — removed non-functional "Reset and create new" wallet option; existing wallet now skips to verification
- **Autonomous mode skill loaded during setup** — `/pragma:setup` now loads `pragma:autonomous-mode` skill alongside `pragma:pragma-core` after session restart

## [0.8.38] - 2026-02-07

### Fixed
- **`setup_wallet` failing in x402 mode** — viem's `toSmartAccount` internally calls `eth_getCode` via the public client during `getFactoryArgs`, but the x402 proxy returns 402 and the payment handler can't resolve (config not on disk yet, no session key). Setup now uses a free public RPC (`rpc.monad.xyz`) with plain HTTP transport for handle creation, bypassing the x402 proxy chicken-and-egg entirely

## [0.8.37] - 2026-02-07

### Changed
- **`setup_wallet` RPC parameter now optional** — x402 mode (default) auto-configures RPC and bundler; no parameters needed. BYOK mode still accepts `rpc` for custom endpoints
- **Faster fresh wallet setup** — New passkeys skip redundant deployment check and nonce fetch (both are known values for undeployed accounts)
- **Setup command updated** — Step 4 documents parameterless `setup_wallet()` for x402 and `setup_wallet({ rpc })` for BYOK

## [0.8.36] - 2026-02-07

### Added
- **Open interest + real-time funding rates** (#56) — `leverup_get_funding_rates` now returns long/short OI quantities, OI ratio (squeeze detection), and real-time directional funding rate from `getMarketInfo` Diamond Proxy contract. Two fee systems clearly separated: holding fees (flat carry cost) and funding fees (directional, OI-based). Unblocks #31 (squeeze detection)
- **Market hours awareness** (#57) — New "Market Hours Awareness" section in `kairos.md` with trading hours for all asset classes (crypto 24/7, FX Sun-Fri, commodities, indices, stocks). Includes mandatory pre-weekend close rule for non-crypto positions, oracle staleness warning, delegation expiry check, and market hours kill switch item

### Changed
- **Kill switch expanded** — 11-point checklist (was 10). New check: market hours for non-crypto pairs
- **Risk rule #16** — Non-crypto positions must close 1h before Friday market close. Pyth oracles stop updating when underlying market closes — SL/TP unexecutable on stale data
- **Phase 2 pair selection** — Now includes `leverup_get_funding_rates` for OI analysis. Market hours filter skips non-crypto pairs approaching close
- **Phase 3 pre-trade validation** — References total carry cost (holding + funding) and OI crowding risk
- **Phase 5 monitoring** — New step 19: pre-close exit check for non-crypto positions
- **`leverup_get_market_stats`** — Updated description: removed "Global OI not yet available" (now available via `leverup_get_funding_rates`)

## [0.8.35] - 2026-02-06

### Fixed
- **Teammate agent MCP tool loading** ([claude-code#23625](https://github.com/anthropics/claude-code/issues/23625)) — Root cause identified after 12+ test iterations across v0.8.30-v0.8.34: deferred MCP tools are not registered for teammate agents until after the first leader message arrives. ToolSearch returns empty on Turn 1 regardless of prompt wording. Fix: minimal spawn prompt (`Send "READY" to "team-lead" and wait`), leader sends ToolSearch + mission on Turn 2. Removed all previous workarounds (FAIL+STOP, cognitive overrides, skill-based bootstrap) from agent definitions. Simplified `tool-bootstrap` skill to document the pattern

## [0.8.29] - 2026-02-06

### Fixed
- **Prevent teammate agents from delegating to sub-tasks** — All agent definitions (kairos, thymos, pragma) and spawn prompt now explicitly prohibit using the Task tool. Teammates are full Claude Code sessions with access to all tools including Task, which caused Opus to delegate analysis and execution to Haiku sub-tasks, losing cumulative context and degrading trade quality

## [0.8.28] - 2026-02-06

### Changed
- **Revocation mode user prompt** — Cleanup flow now asks user via AskUserQuestion whether to revoke locally or on-chain before calling revoke_root_delegation

## [0.8.27] - 2026-02-06

### Changed
- **Autonomous mode teammate integration** — Agent spawn uses `TeamCreate` + `SendMessage` when available, enabling real-time bidirectional communication with sub-agents. Graceful fallback to background Task when TeammateTool is not enabled
- **Dual-path resume flows** — Gas depletion and paused agent resume use `SendMessage` (team) or `Task({ resume })` (non-team)
- **Removed dead Team-Aware Spawn section** — Replaced obsolete `Teammate` API with current `TeamCreate`/`SendMessage` API

## [0.8.26] - 2026-02-06

### Fixed
- **Production plugin signer resolution** — Fixed `__dirname` undefined crash in ESM that broke ALL signer-dependent tools (balances, swaps, transfers, delegation, x402 payments) when running the plugin from outside the development repo. Added ESM-compatible path derivation via `import.meta.url`

## [0.8.25] - 2026-02-06

### Added
- **`leverup_get_funding_rates` tool** — New MCP tool reads holding fee rates from LeverUp Diamond Proxy. Shows per-second rate, 1h/8h percentages, accumulated funding, and funding direction (longs pay / shorts pay / neutral) per pair. Filters synthetic high-leverage pairs. Registered in kairos.md (34 tools) and pragma.md (47 tools)
- **On-chain delegation revocation** — `revoke_root_delegation` gains `revocationMode: "local" | "onchain"`. On-chain mode: `incrementNonceViaUserOp()` invalidates ALL delegations (root + sub) via UserOp (Touch ID). Cascades to sub-delegations via authority chain — no per-sub-agent on-chain revocation needed. New file: `src/core/delegation/revocation.ts`
- **Plugin distribution via esbuild bundle** — Single-file ESM bundle (`dist/index.js`, 1.8MB minified) committed to git. Users no longer need `bun install` or `tsc` build. Signer binary persists at `~/.pragma/bin/` across plugin updates

### Changed
- **Setup simplified** — `/pragma:setup` reduced from 7 steps to 5. Phase 1 only builds Swift binary (MCP server ships pre-bundled). No `bun install` or TypeScript compilation required
- **`.mcp.json` production entry** — Removed `PRAGMA_SIGNER_PATH` env var (signer resolves naturally via `~/.pragma/bin/`)
- **`.gitignore`** — Allows `servers/pragma-mcp/dist/index.js` for distribution while ignoring other build artifacts
- **Revocation docs updated** — `skills/autonomous-mode/SKILL.md` updated: `revoke_root_delegation` gains `revocationMode` docs, `revoke_sub_agent` simplified (removed on-chain path, root cascade is sufficient)
- **Tool Implementation Bible** — Added checklist items for updating skills (pragma-core, autonomous-mode) and agent definitions when implementing new tools

### Fixed
- **Type safety in LeverUp** — `BigInt(x as any)` casts replaced with `x as bigint` in funding rate code. `PairFundingData.pairBase` typed as `Address` (was `string`), `category` typed as `LeverUpCategory` (was `string`)
- **Code cleanup** — Section headers use `// MARK: -` style, extracted module-level helper functions, removed redundant comments across delegation and LeverUp modules

## [0.8.24] - 2026-02-06

### Added
- **Leader Notification Protocol** — All agent definitions (kairos, thymos, pragma) gain real-time leader notification via `SendMessage` when running as TeammateTool teammates. 9 event types: started, trade_opened, trade_closed, error, budget_warning, gas_low, status_changed, market_alert, shutdown_ready. Fully backward-compatible — agents work without TeammateTool, SendMessage is additive
- **Team-Aware Spawn** — SKILL.md auto-detects TeammateTool availability. If `Teammate` + `SendMessage` tools exist, agents spawn as team members with real-time notifications. Otherwise falls back to traditional background spawn unchanged

### Changed
- **Multi-Agent Rule #3** — Updated from "no TeammateTool yet" to "agents notify leader only via SendMessage, no agent-to-agent messaging"
- **Gas Depletion Protocol** — All agents now send leader notification after `report_agent_status("paused")`
- **Agent Cleanup Flow** — Team-spawned agents get TT shutdown protocol (shutdown_request → shutdown_response → cleanup)

## [0.8.23] - 2026-02-04

### Added
- **Limit order budget reconciliation** — Limit orders now tracked with `pending_fill` status. Reconciliation handles fill detection (`pending_fill` → `"open"`) and stale limit cleanup (>2h without fill). Fixes budget desync where TP/SL settlements from limit-filled positions were invisible to budget ledger
- **SL directional validation** — Pre-validates stop-loss direction before sending to LeverUp. Rejects SL in wrong direction (LONG: SL >= entry, SHORT: SL <= entry) with helpful error message and suggested valid SL. Prevents wasted tx fees on invalid requests
- **LeverUp Platform Constraints section** — kairos.md gains dedicated section documenting SL directional constraint and LeverUp-compatible profit protection strategies

### Changed
- **Profit protection rules** — Rules #8 and #13 rewritten for LeverUp compatibility. "Move SL to breakeven" → "Tighten SL toward entry (cannot reach exact breakeven)". Profit locking now uses TP adjustment or manual close
- **Phase 5 behavioral rules** — Added REPOSITION MEMO RULE (write trade_plan before repositioning), STALE LIMIT RULE (6+ cycles + >1.5% away → Phase 2), REPOSITION CAP (one adjustment then mandatory Phase 2 return), macro baseline refresh (every 12th cycle + pre-event)

## [0.8.22] - 2026-02-03

### Added
- **Pre-flight Keychain access** — `create_sub_agent` verifies wallet pool Keychain access during setup, forcing macOS password prompt while user is present. Prevents agent stall during autonomous execution when user is AFK

### Changed
- **Tiered R:R minimum** — Risk:reward minimum now scales with delegation duration: 1.5:1 for 1-3 day delegations, 2:1 for 3-30 day delegations. New TP realism check prevents stretching take-profit to force R:R compliance on short-duration runs

## [0.8.21] - 2026-02-03

### Fixed
- Broad sweep price baseline — sweep now persists all pair prices via `scan_result` memo, subsequent sweeps read previous baseline and flag >3% movers. Replaces aspirational volume/OI language with functional price-diff workflow

## [0.8.20] - 2026-02-03

### Added
- **Agent journal memory (`write_agent_memo`)** — New MCP tool for agents to persist structured state (macro baselines, watchlists, trade reasoning, position health) to their journal. Zero cost — pure file append, no delegation calls. Read back with `get_agent_log(tag: "...")` for context compaction recovery and Phase 6 macro delta comparison
- **Journal tag filtering (`get_agent_log`)** — New `tag` parameter filters entries by category. Tags: baseline, watchlist, trade_plan, position_health, scan_result, post_trade. Pagination applies to filtered results
- **Multi-pair watchlist** — Phase 2 now requires a ranked watchlist output: primary pair + 1-3 secondary setups with trigger levels. Persists into Phase 5 monitoring
- **Opportunity scan** — Phase 5 gains periodic watchlist scanning: chart checks every 3rd cycle (FREE), broad market stats sweep every 6th cycle (1 tool call, all pairs). Anomalous volume/OI triggers watchlist updates
- **Agent status report format** — SKILL.md gains structured procedure for agent status checks. Agent-type dependent tools: kairos=leverup, thymos=nadfun, pragma=mission-based. Unified summary format with position details, PnL, budget
- **Orphan cleanup on agent expiry** — Agent Cleanup Flow gains step 4b: check smart account for lingering limit orders and positions after agent shutdown. Cancel orphaned orders, inform user about open positions
- **Budget-duration guidance** — SKILL.md Step 3 budget configuration gains calibration note: $20/24h conservative, $100-200/3-7d recommended, $500+/7-30d ideal

### Changed
- **Pending limit rule** — Unfilled limit orders are explicitly treated as passive entries. Agent continues scanning watchlist and can cancel/reposition if a better setup emerges on another pair
- **Phase 6 macro delta check** — Post-trade restart now reads Phase 1 baseline from journal, runs quick macro check, and fast-restarts only if no significant new events. Major events trigger full Phase 1 redo
- **Context compaction recovery** — Now reads journal memos (baseline, watchlist, trade_plan, position_health) for structured state recovery instead of relying solely on tool re-reads
- **Phase 7 session summary** — Agent writes comprehensive session summary to journal before final status report. Replaces need for transcript parsing in post-run analysis

## [0.8.19] - 2026-02-02

### Added
- **Per-token allowlist (`allowedTokens`)** — New parameter on `create_sub_agent` accepts token symbols (e.g. `["LVUSD"]`). Two-tier resolution: `KNOWN_TOKEN_SYMBOLS` (5 core tokens) then verified registry. When set, takes priority over `allowedGroups`. Self-acquired tokens and native MON exemptions still apply
- **Adversarial self-review** — Phase 3 now requires mandatory bear case before kill switch: argue against your own trade, compare TP to prior rejections. Only proceed if bull case survives
- **Position health re-checks** — Phase 5 monitoring gains liq distance degradation check, pre-event exit planning, manual close levels, bounce quality comparison

### Changed
- **Analyst-first temperament** — Kairos identity reframed: "analyst with execution capability, not trader with analysis tools." Analysis is the product, trades are a side effect
- **Sleep-based monitoring cadence** — Agents must call `Bash("sleep 600")` between monitoring cycles. Writing "I'll wait" does not pause execution
- **SL-Liq buffer percentage-based** — Changed from fixed $9 to 0.4% of entry price. $9 was 0.4% on ETH but 0.012% on BTC and 9% on SOL

## [0.8.18] - 2026-02-02

### Fixed
- **RPC timeout state recovery** — When `waitForReceiptSync` times out, the catch block now detects the timeout, waits 10s, and retries `getTransactionReceipt`. If the tx was mined on-chain, all state updates (trades, token flows, tracked positions) are performed. Previously, a timeout left the agent with trades=0 and empty token flows despite the tx succeeding on-chain

### Changed
- **Kill switch mandatory output** — New MANDATORY section requires agents to print a 10-point KILL SWITCH CHECK before every trade entry. Each item requires a concrete value (not just PASS/FAIL). Any failure aborts execution and returns to Phase 2. Skipping the checklist makes the trade procedurally invalid
- **Monitoring cadence hardened** — Phase 5 monitoring loop changed from soft guidance to HARD CADENCE RULES: `leverup_list_positions` minimum 7 min, `market_get_chart` minimum 15 min per pair, full cycle 10-15 min. Two compactions in one session = failed cadence discipline
- **Urgency bias removal** — Spawn prompt now includes TASK INTEGRITY rule telling agents to ignore strategy coaching or urgency language in their TASK. New SKILL.md TASK content rules prevent main agent from injecting leverage suggestions. New kairos risk rule #15: ignore spawn-prompt urgency
- **Compaction recovery** — Added explicit note: compaction means context was burned too fast, resume at 10-min cycles minimum

## [0.8.17] - 2026-02-02

### Changed
- **Kairos entry discipline** - Phase 2 now has explicit no-trade outcome (stay and re-check every 15-30 min). Phase 3 requires higher-timeframe alignment (4H/Daily/Weekly) and entry-type decision rule (limit order default, market entry only within 0.3% of level). Phase 4 reframed: limit orders as default, market entry as documented exception requiring 3 conditions
- **Kairos sanity checks expanded** - 3 new Phase 3 checks: mid-range detection (no trade), 4H+ alignment verification, chasing detection
- **Pre-Trade Kill Switch** - Replaced passive "What Professional Traders NEVER Do" list with active 10-point checklist that blocks entry if any condition is true
- **Budget-tier position sizing** - Replaced flat 5% rule: budgets < $200 use 100% per single position (SL as risk control), budgets >= $200 use 10% per trade with multiple concurrent positions
- **No chasing rule** - Risk rule 7 replaced "Scale into positions" with explicit anti-chasing rule (3%+ move = missed, wait for pullback)
- **Spawn prompt call-counting fix** - Distinguishes on-chain delegation calls (counted) from read-only tool calls (unlimited). Fixed chart pricing to FREE. Renamed "max calls" to "max delegation calls" throughout SKILL.md

## [0.8.16] - 2026-02-02

### Fixed
- **False liquidation from RPC block range limit** - `getSettlementLogs` now chunks requests into 200-block windows. Ankr RPC rejects ranges > ~200 blocks, causing the 2000-block lookback to fail deterministically on all 3 retries
- **Native MON blocked by allowedGroups** - `isTokenAllowed` now exempts native MON when agent has MON budget (`monAllocated > 0`), allowing Pyth oracle fee payments regardless of group allowlist
- **Misleading journal on TP-only close** - `formatInflowNote` now checks both `takeProfit` and `stopLoss` fields, and mentions liquidation as a possibility alongside query miss

### Changed
- **Pair-filtered position queries** - `getUserPositions` accepts optional `pairs` parameter. Agent polling queries only tracked pairs instead of all 20, reducing RPC cost from ~$0.02 to ~$0.001-0.003 per call
- **Kairos cost table corrected** - `market_get_chart` is FREE (Pyth Benchmark), `leverup_list_positions` reflects optimized per-tracked-pair cost
- **Kairos behavioral rules** - Added 4 risk rules from production analysis: $200 minimum position size, direction diversity, profit protection (trail SL at 50%+ TP), chart frequency cap (15 min per pair)
- **Multi-timeframe analysis** - Kairos Phase 2 now requires top-down technical analysis (Weekly → Daily → 4H → 1H → 15m) using FREE Pyth Benchmark charts across all timeframes
- **Context compaction recovery** - New section in kairos.md with full macro recovery protocol: all 7 macro tools required after compaction since agent retains NOTHING from prior context
- **Phase 1 macro completeness** - Added rule requiring ALL macro tools in Phase 1 (~$0.06 total cost, cheap insurance against blind spots)
- **Root delegation cleanup** - SKILL.md cleanup flow step 6: revoke root delegation after last agent terminates

## [0.8.15] - 2026-02-01

### Fixed
- **False liquidation signal** - Settlement inflow query now scans 2000 blocks (~27 min) backwards from detection block, capturing Transfer events that happened before the agent noticed the position was gone
- **Double-counted inflows** - Reconciliation refactored to batch-settle all pending positions with a single query and single ledger update, preventing double-counting when multiple positions close in the same block range
- **Silent RPC failures treated as liquidation** - `querySettlementInflows` now retries 3x with backoff instead of returning empty array on transient RPC errors
- **Zombie agent after revoke** - SKILL.md cleanup flow updated to require TaskStop before revoke_sub_agent, preventing agents from running with revoked permissions

### Changed
- **Journal close types** - Settlement journal entries now distinguish `settled` (inflows found), `no_inflow_suspicious` (SL was set but no inflows — possible query miss), and `no_inflow` (liquidation or expired)
- **Caffeinate flags** - Added `-s` flag to also prevent system sleep on AC power (previously only prevented idle sleep with `-i`)

## [0.8.14] - 2026-02-01

### Added
- **`get_agent_log` tool** - Read agent journal entries with pagination (offset/limit). Returns newest-first with metadata
- **Persistent agent journal** (`journal.jsonl`) - JSONL activity log auto-appended on all autonomous trades: open, close, buy, sell, swap, limit order, cancel. Entry types: `trade_open`, `trade_close`, `trade_buy`, `trade_sell`, `swap`, `reasoning`, `status`, `limit_order`, `cancel_order`
- **Position tracking** (`tracked-positions.json`) - Per-agent LeverUp position tracking with pair, side, margin, tradeHash, and status lifecycle (`open` → `pending_settlement` → `settled`)
- **Two-phase position reconciliation** in `leverup_list_positions` - New `agentId` parameter triggers reconciliation: Phase 1 links unlinked positions by pair+side+margin match (5% tolerance), Phase 2 detects keeper-triggered closes (TP/SL/liquidation) and queries settlement inflows
- **`querySettlementInflows()`** - Single non-blocking `getLogs` for reconciliation of past keeper-triggered closes (complements `pollForSettlementInflows` for agent-initiated closes)
- **Journal persistence in `report_agent_status`** - When reason is provided, appended to journal (`running` → type `reasoning`, others → type `status`)

### Changed
- **Static max drawdown budget model** - `checkGroupBudget()` rewritten: `budgetConsumed = max(0, netOutflow)`. Only net losses count against budget; profits don't increase budget beyond original allocation
- **`get_sub_agent_state` budget display** - Group budgets now show tracked position count and use max drawdown model

### Fixed
- **Position linking race condition** - `executeAutonomousLeverUpOpen` stored `tradeHash: undefined` because API hadn't indexed the position yet. Reconciliation Phase 1 now matches unlinked positions to API positions by pair+side+margin proximity, resolving the race

## [0.8.13] - 2026-01-31

### Added
- **`list_wallet_pool` tool** - View all wallets in the sub-agent wallet pool with status (idle/active), assigned agent, and filter support
- **TP/SL in `leverup_list_positions`** - Active positions now show take profit and stop loss levels (previously only shown for limit orders)

## [0.8.12] - 2026-01-31

### Fixed
- **LeverUp Pyth oracle fee requires budgetMon >= 1** - LeverUp trades send a Pyth oracle fee as `execution.value` even for ERC20 collateral (LVUSD/USDC). With `budgetMon: 0`, both the off-chain budget check and on-chain `ValueLteEnforcer` blocked these trades. Now enforced at sub-agent creation: kairos/pragma agents require `budgetMon >= 1`, thymos agents can still use 0 for ERC20-only strategies
- **ValueLteEnforcer documentation corrected** - Enforcer checks `execution.value` (the value field inside the delegation's Execution struct), not the outer tx's `msg.value`. Fixed comments across `root.ts`, `subagent.ts`, `constants.ts`, `create-root-delegation.ts`, and `SKILL.md`
- **Improved MON budget error message** - When off-chain budget check rejects a trade, error now explains that LeverUp needs native MON for Pyth oracle fees

## [0.8.11] - 2026-01-31

### Added
- **Root delegation as consent boundary** - Root delegation now stores the user's full authorization: `budgetMon` (total MON ceiling), `budgetUsd` (total USD ceiling), `maxValuePerTx` (per-tx MON cap), `maxCalls` (total delegation calls). Sub-agents validate allocations against root at creation time
- **Root budget validation** - `create_sub_agent` now enforces that sum of all active sub-agent allocations stays within root delegation limits (MON, USD, and per-tx value)
- **`budgetMon: 0` for USD-only strategies** - Sub-agents can now be created with zero MON budget. `ValueLteEnforcer` with limit=0 blocks native MON transactions while allowing all ERC-20 operations

### Fixed
- **ValueLteEnforcer re-enabled** - On-chain per-transaction native MON cap restored on both root and sub-delegations. Previously filtered out (dead code), now correctly enforces user-specified limits via `encodeAbiParameters`
- **`maxTrades` renamed to `maxCalls`** - Clarifies that each `redeemDelegations()` call (including ERC20 approvals) consumes one count. Renamed across all code, types, and documentation
- **ERC20 `transfer` selector missing from autonomous scope** - Added `ERC20_SELECTORS` group with `transfer(address,uint256)` (`0xa9059cbb`) to all agent scopes and root delegation. Previously, autonomous sub-agents could not execute ERC20 transfers despite the tool accepting `agentId`

### Changed
- **`create_root_delegation` schema** - New parameters: `budgetUsd` (USD ceiling), `maxValuePerTx` (explicit per-tx cap). Removed derived `valueLtePerTx = budgetMon / maxTrades` computation
- **SKILL.md budget documentation** - Rewritten with two-layer enforcement model (on-chain hard limits + off-chain soft tracking), root vs sub-agent parameter comparison table, and corrected multi-agent example

## [0.8.10] - 2026-01-31

### Added
- **Multi-agent spawn worked example** - Full walkthrough in SKILL.md: budget split AskUserQuestion, root delegation sizing, sequential Kairos + Thymos spawn, and multi-agent rules

## [0.8.9] - 2026-01-31

### Added
- **`revoke_root_delegation` tool** - Revoke all autonomous permissions in one call. Cascades cleanup to all sub-agents, archives states, releases wallets, and stops caffeinate. Requires `confirm: true` safety check
- **Token group allowlist** - Optional `allowedGroups` parameter on `create_sub_agent` restricts which token groups (MON, USD) an agent can spend from user's holdings. Tokens acquired during trading are always sellable. Enforced in `executeWithDelegationChain` before execution
- **Agent YAML frontmatter** - Added `name` and `description` fields to Kairos, Thymos, and Pragma agent definitions for Claude Code plugin agent discovery

### Fixed
- **Caffeinate orphan processes** - Added `-w` flag so caffeinate auto-exits when MCP server dies, preventing zombie processes on user's machine

## [0.8.8] - 2026-01-31

### Added
- **Agent state archival** - Revoked agents are now archived to `~/.pragma/agents/archive/` instead of deleted. Trade history, token flows, and lifecycle data preserved for future review
- **Pre-trade balance check rule** - All agent definitions (Kairos, Thymos, Pragma) now require calling `get_all_balances` before any trade execution to verify sufficient balance + fees

### Changed
- **`budgetUsdc` renamed to `budgetUsd`** - The `create_sub_agent` parameter now accurately reflects that it covers the entire USD group (USDC + LVUSD), not just USDC. Updated schema, type definition, response format, and skill documentation

## [0.8.7] - 2026-01-31

### Added
- **LeverUp close trade inflow tracking** - Autonomous agents now track collateral returned from closing positions. Uses oracle settlement polling (`pollForSettlementInflows`) since LeverUp settles asynchronously via `BatchRequestPriceCallback` (~4 blocks after close tx). Polls for ERC20 Transfer events from LeverUp diamond to user's smart account (8 attempts, 2s interval)
- **LeverUp cancel limit order inflow tracking** - Tracks collateral returned from canceling limit orders via transaction receipt parsing (`parseErc20Inflows`). Cancel returns collateral directly in the same transaction
- **Receipt in `AutonomousExecutionResult`** - Optional `receipt` field enables post-execution analysis for any autonomous operation

### Fixed
- **Agent budget showing pure losses for round-trip trades** - Close trade and cancel limit order now record inflows. Budget utilization reflects actual net position (e.g., 1.4% instead of 89% for a round-trip with small loss)
- **Balance validation for LeverUp opens** - Both `leverup_open_trade` and `leverup_open_limit_order` now validate `balance >= margin + fee` before submitting, preventing confusing "ERC20: transfer amount exceeds balance" reverts

## [0.8.6] - 2026-01-30

### Fixed
- **SubagentStop hook now blocks multiple iterations** - Removed `stop_hook_active` early exit that limited the hook to 1 block per spawn. Termination is guaranteed by existing conditions (status, trades, expiry, maxIterations)

## [0.8.5] - 2026-01-30

### Added
- **SubagentStop hook** - Shell script loop enforcement that blocks autonomous agents from exiting before their mission completes. 7-step decision algorithm checks loop config, agent status, trade limits, expiry, and iteration caps. Fail-open design (errors allow exit, never trap agents)
- **Mission-based loop system** - `loop.json` stores mission text, maxIterations, and currentIteration. Hook re-injects mission as agent's next prompt on each iteration. Supports continuous, condition, and interval loop types
- **Caffeinate management** - Prevents macOS idle sleep while autonomous agents run. Starts on agent creation, stops when last agent is revoked. Child process design (auto-dies with MCP server, no orphans)

### Changed
- **Loop functions sync** - All `loop.ts` functions converted from async to sync (they only use synchronous fs operations)

## [0.8.4] - 2026-01-30

### Added
- **Ledger-based ERC-20 budget tracking** - Token flow ledger records outflows and inflows per token. Token Groups (MON, USD) enable net-outflow budget enforcement across fungible tokens (e.g. USDC and LVUSD share a USD budget)
- **Agent definition overhaul** - Kairos (32 tools, 7-phase institutional workflow), Thymos (23 tools, 5-phase momentum workflow), Pragma (46 tools, conditional execution framework)
- **Autonomous detection matrix** - pragma-core skill routes requests to assistant or autonomous mode based on signal analysis
- **x402 cost awareness** - Agent spawn prompts include per-tool USDC costs and conservation rules for monitoring loops

### Fixed
- **USD group budget decimal mismatch** - LVUSD (18 decimals) now normalized to canonical 6-decimal precision before budget comparison
- **Kairos missing DEX + WMON targets** - Added dexAggregator and WMON to Kairos delegation scope for swap and wrap operations
- **Agent status lifecycle** - `create_sub_agent` sets initial status to `pending`; agents report `running` on start

## [0.8.3] - 2026-01-28

### Added
- **Wallet balance in `create_sub_agent` response** - Shows existing balance and funding decision (skipped/partial/full/none)
- **Mandatory status reporting** - Spawn prompt now instructs sub-agents to call `report_agent_status` before terminating

### Fixed
- **Wallet pool self-healing** - `validateAndHealPool()` auto-fixes inconsistent and orphaned wallets
- **Cascade cleanup on root revocation** - `revokeRootDelegation()` now cleans up all sub-agents and releases wallets
- **Wallet orphaned on revoke** - `revoke_sub_agent` now releases wallet even when Keychain entry missing

## [0.8.2] - 2026-01-28

### Added
- **LogicalOrWrapperEnforcer** - Enables autonomous mode to approve arbitrary ERC20 tokens:
  - Two-group delegation structure: approve group (any token) + trading group (whitelisted protocols)
  - Dynamic group selection at execution time
  - Unlocks nad.fun sell operations (which require token approval)

- **`check_delegation_status` tool** - Check validity of root or sub-agent delegations:
  - On-chain call count verification via LimitedCallsEnforcer
  - Returns used/remaining/exhausted call counts
  - Expiry info and validity status

- **`report_agent_status` tool** - Unified status reporting for sub-agents:
  - Statuses: `running`, `paused`, `completed`, `failed`
  - Key rule: `completed` = user's goal achieved, `failed` = goal NOT achieved

- **Agent Lifecycle Management**:
  - Lazy expiry detection in `loadAgentState()` - auto-marks expired agents as failed
  - `list_sub_agents` now includes `paused` status filter and count
  - `revoke_sub_agent` now deletes agent state (no stale agents accumulate)
  - `create_sub_agent` checks existing wallet balance before funding

- **Separate Autonomous Mode Skill** - `skills/autonomous-mode/SKILL.md`:
  - Dedicated skill for autonomous trading configuration
  - Intent-based sub-agent creation flow
  - Gas depletion → fund → resume flow documentation

- **Gas Depletion Protocol** in agent prompts for graceful pause handling

### Changed
- `skills/pragma-core/SKILL.md` - Autonomous mode content moved to dedicated skill
- `create_sub_agent` - Max funding increased from 1 to 10 MON, default from 0.1 to 1 MON
- `revoke_sub_agent` - `sweepBalance` default changed to `false` (keep gas for wallet reuse)

### Fixed
- **Sub-agent delegation `InvalidDelegate()` error** - Sub-agents can now execute autonomous trades
- **On-chain call count in `check_delegation_status`** - Now correctly returns used/remaining calls
- Added `withRetry` to all read-only RPC calls per Tool Implementation Bible

## [0.8.1] - 2026-01-26

### Added
- **Autonomous Execution (Phase B)** - Dual-mode support for trading tools:
  - 11 tools now accept optional `agentId` parameter for autonomous execution
  - Supported tools: `execute_swap`, `transfer`, `wrap`, `unwrap`, `nadfun_buy`, `nadfun_sell`, `leverup_open_trade`, `leverup_close_trade`, `leverup_open_limit_order`, `leverup_cancel_limit_order`, `leverup_update_tpsl`, `leverup_update_margin`
  - New `autonomous.ts` module with delegation chain execution
  - Sub-agents can now trade without Touch ID using pre-signed delegations

- `get_sub_agent_state` now returns `walletBalance` field showing actual MON balance for gas monitoring

### Changed
- Agent definitions moved from `pragma/agents/` to `agents/` (follows Claude Code plugin conventions)
- `TradeRecord.details` extended with index signature for flexible trade logging

## [0.8.0] - 2026-01-26

### Added
- **Autonomous Mode Foundation (Phase A)** - Multi-agent sub-delegation infrastructure:
  - Wallet pool for sub-agent key management (macOS Keychain)
  - Persistent sub-delegation with DTK redelegation support
  - Agent state management (`~/.pragma/agents/`)
  - `create_sub_agent` - Create specialized trading sub-agents (kairos, thymos, pragma)
  - `fund_sub_agent` - Fund sub-agent with gas from session key
  - `list_sub_agents` - List active sub-agents and status
  - `revoke_sub_agent` - Revoke delegation, sweep balance, cleanup
  - `get_sub_agent_state` - Read detailed sub-agent state

- **Root Delegation (Phase A.1)** - Touch-ID-once authorization for autonomous mode:
  - `create_root_delegation` - Create persistent root delegation (User → Main Agent)
  - Root delegation stored at `~/.pragma/root-delegation.json`
  - Scope includes all trading contracts (LeverUp, nad.fun, DEX, WMON)
  - Time-bound (1-30 days) and trade-count limited
  - Sub-agents now require valid root delegation before creation
  - Delegation chain stored in sub-agent for execution

- **Swift Binary Extensions** - Sub-agent Keychain commands:
  - `store-subagent` - Store sub-agent private key
  - `get-subagent` - Retrieve sub-agent private key
  - `delete-subagent` - Delete sub-agent key
  - `has-subagent` - Check if sub-agent key exists
  - `list-subagents` - List all sub-agent UUIDs

- **Agent Definitions** - Markdown personality profiles:
  - Kairos: Strategic macro trader for perpetuals
  - Thymos: Momentum trader for memecoins
  - Pragma: General-purpose flexible agent

- **Core Modules**:
  - `src/core/subagent/keys.ts` - Sub-agent key generation
  - `src/core/subagent/wallet-pool.ts` - Wallet pool management with file locking
  - `src/core/subagent/state.ts` - File-based state management with flexible token tracking
  - `src/core/subagent/loop.ts` - Loop enforcement configuration
  - `src/core/delegation/subagent.ts` - Persistent delegation builder
  - `src/core/delegation/root.ts` - Root delegation builder and storage

### Fixed
- Type safety in `StoredDelegation` (uses `SignedDelegation` type instead of `unknown`)
- Race condition in wallet pool operations (added file locking for concurrent access)
- ERC-20 budget tracking now supports all tokens by address (not just MON/USDC)

### Changed
- `releaseWallet()` is now async
- Budget structure uses `tokenSpent` map for flexible token tracking

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
