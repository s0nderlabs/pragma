// Explain Contract Tool
// Analyzes smart contracts and returns comprehensive information
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

const ExplainContractSchema = z.object({
  address: z
    .string()
    .describe(
      "Contract address to analyze (0x...). " +
        "Returns ABI, source code, proxy detection, and interface detection. " +
        "Use when user asks 'what does this contract do?' or before interacting with unknown contracts."
    ),
});

// ============================================================================
// Response Types
// ============================================================================

interface AbiItem {
  type: string;
  name?: string;
  inputs?: Array<{ name: string; type: string; indexed?: boolean }>;
  outputs?: Array<{ name: string; type: string }>;
  stateMutability?: string;
  anonymous?: boolean;
}

interface InterfaceInfo {
  id: string;
  name: string;
  supported: boolean;
}

interface ImplementationInfo {
  address: string;
  name: string;
  abi?: AbiItem[];
  sourceCode?: string;
  compiler?: string;
}

interface ContractExplanation {
  address: string;
  name: string;
  verified: boolean;

  // ABI
  abi?: AbiItem[];

  // Source
  sourceCode?: string;
  compiler?: string;

  // Proxy
  isProxy: boolean;
  implementation?: ImplementationInfo;

  // Interfaces (ERC-165)
  interfaces: InterfaceInfo[];

  // Metadata
  explorerUrl?: string;
  updatedAt?: string;
}

interface ApiResponse {
  success: boolean;
  contract?: {
    address: string;
    name: string;
    verified: boolean;
    abi?: AbiItem[];
    sourceCode?: string;
    compiler?: string;
    isProxy: boolean;
    implementation?: ImplementationInfo;
    interfaces?: InterfaceInfo[];
    explorerUrl?: string;
    analyzedAt?: string;
  };
  error?: string;
}

interface ExplainContractResult {
  success: boolean;
  message: string;
  contract?: ContractExplanation;
  error?: string;
}

// ============================================================================
// Registration
// ============================================================================

export function registerExplainContract(server: McpServer): void {
  server.tool(
    "explain_contract",
    `Analyze a smart contract and return comprehensive information including ABI, source code, proxy detection, and interface detection. x402 mode only.

PRESENTATION GUIDE:

## Contract: [Name]
**Address:** address | [View on MonadVision](explorerUrl)
**Verified:** ✓/✗
**Compiler:** version (if available)

---

### Detected Interfaces
List interfaces from the interfaces array (e.g., ERC-20, ERC-721, ERC-1155, ERC-4626).
Only show interfaces where supported=true.

---

### Proxy Status
- **Is Proxy:** Yes/No (from isProxy field)
- If proxy, show implementation address and name

---

### Key Functions (extract from ABI)

Categorize ABI functions by stateMutability:

**Read (view/pure):**
List functions with stateMutability "view" or "pure"
Format: \`functionName(inputTypes) → outputType\`

**Write (nonpayable/payable):**
List functions with stateMutability "nonpayable" or "payable"
Format: \`functionName(inputTypes)\`

**Events:**
List items with type "event"
Format: EventName(param1, param2, ...)

---

### Security Notes
- ⚠️ Upgradeable proxy - if isProxy is true
- ✓ Verified source code - if verified is true
- ⚠️ Unverified - if verified is false`,
    ExplainContractSchema.shape,
    async (
      params
    ): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await explainContractHandler(
        params as z.infer<typeof ExplainContractSchema>
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

async function explainContractHandler(
  params: z.infer<typeof ExplainContractSchema>
): Promise<ExplainContractResult> {
  try {
    // Step 1: Validate address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(params.address)) {
      return {
        success: false,
        message: "Invalid address",
        error:
          "Address must be 42 characters (0x + 40 hex chars). Example: 0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701",
      };
    }

    // Step 2: Check config
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
          "explain_contract requires x402 mode. Run set_mode with mode='x402' first. " +
          "This tool uses server infrastructure for contract analysis and ABI resolution.",
      };
    }

    // Step 4: Call API
    const chainId = config.network.chainId;
    const apiUrl = `${getX402BaseUrl()}/${chainId}/contract/${params.address}`;

    const response = await x402Fetch(apiUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    // Step 5: Handle response
    if (!response.ok) {
      if (response.status === 404) {
        return {
          success: false,
          message: "Contract not found",
          error: `Contract ${params.address} not found or not verified on chain ${chainId}.`,
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

    if (!apiResponse.success || !apiResponse.contract) {
      return {
        success: false,
        message: "Failed to analyze contract",
        error: apiResponse.error || "Unknown API error",
      };
    }

    // Step 7: Build contract object from nested contract data
    const contractData = apiResponse.contract;
    const contract: ContractExplanation = {
      address: contractData.address || params.address,
      name: contractData.name || "Unknown Contract",
      verified: contractData.verified ?? false,
      abi: contractData.abi,
      sourceCode: contractData.sourceCode,
      compiler: contractData.compiler,
      isProxy: contractData.isProxy ?? false,
      implementation: contractData.implementation,
      interfaces: contractData.interfaces || [],
      explorerUrl: contractData.explorerUrl,
      updatedAt: contractData.analyzedAt,
    };

    // Step 8: Build result with human-readable message
    const proxyNote = contract.isProxy
      ? ` (Proxy → ${contract.implementation?.name || "Unknown Implementation"})`
      : "";
    const verifiedNote = contract.verified ? "✓" : "⚠️ Unverified";

    return {
      success: true,
      message: `${verifiedNote} Contract analyzed: ${contract.name}${proxyNote}`,
      contract,
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
      message: "Failed to analyze contract",
      error: errorMessage,
    };
  }
}
