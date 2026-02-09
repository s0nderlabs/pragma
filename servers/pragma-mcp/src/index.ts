#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/index.js";
import { homedir } from "os";

// Cowork detection: plugin MCP runs inside Linux VM where tools don't work
// (no Keychain, no pragma-signer, wrong HOME). DXT handles tools on the host.
const isCowork = homedir().startsWith("/sessions/");

const server = new McpServer({
  name: "pragma",
  version: "0.1.0",
});

// Register tools only outside Cowork (DXT handles them in Cowork)
if (!isCowork) {
  registerTools(server);
} else {
  console.error("[pragma] Cowork detected — skipping tool registration (DXT handles MCP tools)");
}

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`pragma MCP server running on stdio${isCowork ? " (Cowork mode — no tools)" : ""}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
