// Explain Transaction Tool
// Decodes and explains any transaction with special handling for Pragma delegations
// x402 only - requires API infrastructure
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  loadConfig,
  isWalletConfigured,
} from "../config/pragma-config.js";
import { x402Fetch, getX402BaseUrl, isX402Mode } from "../core/x402/client.js";

// ============================================================================
// Schema
// ============================================================================

const ExplainTransactionSchema = z.object({
  txHash: z
    .string()
    .describe(
      "Transaction hash to explain. Must be a valid 66-character hex string (0x + 64 hex chars). " +
        "Example: '0x1234...abcd'. Use this to get detailed explanation of any on-chain transaction."
    ),
  userAddress: z
    .string()
    .optional()
    .describe(
      "Optional user address for context. Helps determine if tokens were sent or received. " +
        "If not provided, uses the from address of the transaction."
    ),
});

// ============================================================================
// Response Types
// ============================================================================

interface AddressInfo {
  address: string;
  name?: string;
  type?: string;
  protocol?: string;
}

interface TokenInfo {
  address: string;
  symbol: string;
  amount: string;
  amountFormatted: string;
  valueUsd?: string;
}

interface TokenMovement {
  token: {
    address: string;
    symbol: string;
    decimals: number;
    priceUsd: number;
  };
  amount: string;
  amountFormatted: string;
  valueUsd?: string;
  direction: "in" | "out";
  from: string;
  to: string;
}

interface GasInfo {
  used: string;
  limit: string;
  price: string;
  priceGwei: string;
  cost: string;
  costUsd?: string;
  monadNote: string;
}

interface Caveat {
  enforcer: string;
  terms: string;
}

interface SecuritySummary {
  riskLevel: "low" | "medium" | "high";
  checks: string[];
  warnings: string[];
}

interface PragmaInfo {
  delegator: AddressInfo;
  delegate: AddressInfo;
  actionType: string;
  executionTarget: AddressInfo;
  executionValue: string;
  executionValueFormatted: string;
  caveats: Caveat[];
  security: SecuritySummary;
}

interface DecodedEvent {
  name: string;
  contract: AddressInfo;
  topics: string[];
  data: string;
}

interface TransactionExplanation {
  txHash: string;
  blockNumber: number;
  timestamp: string;
  status: "success" | "failed";

  type: string;
  typeDescription: string;
  summary: string;

  from: AddressInfo;
  to: AddressInfo | null;

  value: string;
  valueFormatted: string;

  function?: {
    name: string;
    signature: string;
    selector: string;
  };

  tokenIn?: TokenInfo;
  tokenOut?: TokenInfo;
  tokenMovements: TokenMovement[];

  events: DecodedEvent[];

  gas: GasInfo;

  protocol?: string;

  pragma?: PragmaInfo;
  isPragma: boolean;
}

interface ApiResponse {
  success: boolean;
  transaction?: TransactionExplanation;
  error?: string;
}

interface ExplainTransactionResult {
  success: boolean;
  message: string;
  transaction?: TransactionExplanation;
  error?: string;
}

// ============================================================================
// Registration
// ============================================================================

export function registerExplainTransaction(server: McpServer): void {
  server.tool(
    "explain_transaction",
    `Decode and explain any transaction in detail. Returns transaction type, token movements, gas info, and for Pragma transactions: delegation details and security analysis. x402 mode only.

PRESENTATION GUIDE - TWO SECTIONS:

## Section 1: Technical Details (FIRST)
Present all technical data in structured format:
1. Header: Status emoji (✓/✗) + summary + [View on MonadVision](explorerUrl)
2. Basic Info table: Block, Timestamp, Status, From, To
3. Token Movements table: Direction (in/out), token, amount, USD value
4. Gas table: Cost in MON and USD, gas price
5. For Pragma txs (isPragma=true):
   - Delegation Chain table: Delegator (Smart Account), Delegate (Session Key)
   - Security Analysis table: time-bounded, replay-protected, usage-limited, etc.
   - Caveats list with enforcer names and decoded parameters

## Section 2: Human Explanation (AFTER technical details)
Add a "---" separator, then provide plain English explanation:

### What Happened
One paragraph explaining the transaction in simple terms. Examples:
- Swap: "You traded your stablecoins (AUSD, USDT0, earnAUSD) for MON through the 0x exchange. Your session key executed this on your behalf using a time-limited delegation."
- Stake: "You deposited MON into aPriori's liquid staking vault. In return, you received aprMON tokens which represent your staked position and accrue rewards over time."
- Transfer: "You sent X tokens to address Y. This was a direct transfer from your smart account."

### Security (for Pragma txs only)
Explain what the caveats mean in plain terms:
- "Your session key could only execute this once (LimitedCallsEnforcer)"
- "The delegation expired 5 minutes after creation (TimestampEnforcer)"
- "Only specific contracts could be called (AllowedTargetsEnforcer)"

### Net Result
Summarize the outcome:
- What the user gained/received
- What the user spent (including gas)
- Any notable observations (e.g., "Gas cost was higher than swap value")`,
    ExplainTransactionSchema.shape,
    async (
      params
    ): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await explainTransactionHandler(
        params as z.infer<typeof ExplainTransactionSchema>
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}

// ============================================================================
// Handler
// ============================================================================

async function explainTransactionHandler(
  params: z.infer<typeof ExplainTransactionSchema>
): Promise<ExplainTransactionResult> {
  try {
    // Step 1: Validate tx hash format
    if (!/^0x[a-fA-F0-9]{64}$/.test(params.txHash)) {
      return {
        success: false,
        message: "Invalid transaction hash",
        error:
          "Transaction hash must be 66 characters (0x + 64 hex chars). Example: 0x1234...abcd",
      };
    }

    // Step 2: Check config and mode
    const config = await loadConfig();
    if (!config || !isWalletConfigured(config)) {
      return {
        success: false,
        message: "Wallet not configured",
        error: "Please run setup_wallet first to create your pragma wallet",
      };
    }

    // Step 3: Verify x402 mode
    const inX402Mode = await isX402Mode();
    if (!inX402Mode) {
      return {
        success: false,
        message: "x402 mode required",
        error:
          "explain_transaction requires x402 mode. Run set_mode with mode='x402' first. " +
          "This tool uses server infrastructure for ABI resolution and transaction decoding.",
      };
    }

    // Step 4: Build API request
    const chainId = config.network.chainId;
    const apiUrl = `${getX402BaseUrl()}/${chainId}/transaction`;

    const requestBody = {
      txHash: params.txHash,
      ...(params.userAddress && { userAddress: params.userAddress }),
    };

    // Step 5: Call API with x402 payment
    const response = await x402Fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      if (response.status === 404) {
        return {
          success: false,
          message: "Transaction not found",
          error: `Transaction ${params.txHash} not found on chain ${chainId}. It may be pending or on a different network.`,
        };
      }
      const errorText = await response.text();
      return {
        success: false,
        message: `API error (${response.status})`,
        error: errorText || `HTTP ${response.status}`,
      };
    }

    // Step 6: Parse response
    const apiResponse = (await response.json()) as ApiResponse;

    if (!apiResponse.success || !apiResponse.transaction) {
      return {
        success: false,
        message: "Failed to explain transaction",
        error: apiResponse.error || "Unknown API error",
      };
    }

    // Step 7: Build result with human-readable message
    const tx = apiResponse.transaction;
    const statusEmoji = tx.status === "success" ? "✓" : "✗";

    return {
      success: true,
      message: `${statusEmoji} ${tx.summary}`,
      transaction: tx,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    // Handle specific x402 payment errors
    if (errorMessage.includes("Payment rejected")) {
      return {
        success: false,
        message: "Payment failed",
        error:
          "x402 payment was rejected. Check your session key USDC balance with check_session_key_balance.",
      };
    }

    return {
      success: false,
      message: "Failed to explain transaction",
      error: errorMessage,
    };
  }
}
