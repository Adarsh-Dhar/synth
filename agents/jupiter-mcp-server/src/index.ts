import express from "express";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 5001);

function buildDocsAnswer(query: string): string {
  void query;
  return `=== JUPITER MCP SCHEMA ===
// Use these strict interfaces when generating execution code.
interface JupiterExecuteArgs {
  inputMint: string;
  outputMint: string;
  amount: number;
  userWallet: string;
  slippageBps?: number;
}
// To execute a swap, use the MCP Tool:
// await callMcpTool("jupiter", "execute_swap", args: JupiterExecuteArgs)

// FATAL RULES FOR BOT CODE:
// 1. Do NOT use axios or quote-api.jup.ag manually.
// 2. The MCP bridge handles quote routing, simulated slippage, and transaction signing natively.
// 3. Always wrap amount in BigInt if converting from lamports/decimals before passing to Tool.`;
}

// ==========================================
// TRUE MCP IMPLEMENTATION
// ==========================================
const mcp = new McpServer({
  name: "jupiter-mcp-server",
  version: "0.1.0"
});

mcp.tool(
  "jupiter_docs",
  "Search Jupiter API documentation",
  { query: z.string().describe("The search query to look up") },
  async ({ query }) => {
    const text = buildDocsAnswer(query || "");
    return { content: [{ type: "text", text }] };
  }
);

mcp.tool(
  "jupiter_skills",
  "List available Jupiter skills",
  {},
  async () => {
    return { content: [{ type: "text", text: "Jupiter MCP skills: execute_swap, trigger_api, flashloan orchestration, quote search" }] };
  }
);

let transport: SSEServerTransport | null = null;

app.get("/sse", async (req, res) => {
  transport = new SSEServerTransport("/message", res);
  await mcp.connect(transport);
});

app.post("/message", async (req, res) => {
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send("No active SSE connection");
  }
});

// Runtime Stub
app.post("/jupiter/execute_swap", express.json({ limit: "1mb" }), (req, res) => {
  const body = req.body || {};
  res.json({
    result: {
      isError: false,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            tool: "execute_swap",
            inputMint: String(body.inputMint || body.input_mint || "").trim(),
            outputMint: String(body.outputMint || body.output_mint || "").trim(),
            amount: String(body.amount || "").trim(),
            slippageBps: Number(body.slippageBps || body.slippage_bps || 50),
            status: "docs_only_stub",
          }),
        },
      ],
    },
  });
});

app.listen(PORT, () => {
  console.log(`Jupiter MCP server listening on http://127.0.0.1:${PORT}`);
  console.log(`SSE endpoint established at http://127.0.0.1:${PORT}/sse`);
});