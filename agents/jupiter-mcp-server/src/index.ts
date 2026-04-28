import express from "express";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

dotenv.config();

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const docsPath = path.resolve(__dirname, "../docs.json");
let rawDocs: any[] = [];
try {
  rawDocs = JSON.parse(fs.readFileSync(docsPath, "utf-8"));
} catch (err) {
  console.warn("Jupiter docs.json not found or invalid:", err);
  rawDocs = [];
}

const app = express();
const PORT = Number(process.env.PORT || 5001);

function buildDocsAnswer(query: string): string {
  const q = String(query || "").trim();
  if (!q) return "Please provide specific keywords to search the Jupiter docs.";

  const normalizedQuery = q.toLowerCase();
  const relevantDocs = rawDocs.filter((doc: any) =>
    Array.isArray(doc.keywords) && doc.keywords.some((kw: string) => normalizedQuery.includes(kw))
  );

  if (relevantDocs.length === 0) {
    return "No specific schema found for your query. Refer to Jupiter core skills: execute_swap, trigger_api, flashloan.";
  }

  let response = `=== JUPITER MCP SCHEMA ===\n`;
  relevantDocs.forEach((doc: any) => {
    response += `${doc.schema}\n\n`;
  });
  response += "// FATAL RULE: Do NOT use axios or quote-api.jup.ag manually. Use MCP bridge for execution.";
  return response;
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