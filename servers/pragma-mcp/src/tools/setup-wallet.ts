// Setup Wallet Tool
// Creates passkey + smart account for the user

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const SetupWalletSchema = z.object({
  rpc: z.string().url().describe("RPC endpoint URL for Monad network"),
});

export function registerSetupWallet(server: McpServer): void {
  server.tool(
    "setup_wallet",
    "Initialize a new pragma wallet with passkey and smart account. This creates a P-256 key in Secure Enclave (via Touch ID) and deploys a smart account. Required before any trading operations.",
    SetupWalletSchema.shape,
    async (params) => {
      // TODO: Implement
      // 1. Call pragma-signer to create passkey
      // 2. Get public key from passkey
      // 3. Deploy smart account with passkey as signer
      // 4. Generate session key
      // 5. Save config to ~/.pragma/config.json
      throw new Error("Not implemented");
    }
  );
}
