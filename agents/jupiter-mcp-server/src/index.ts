import express from "express";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 5001);

function buildDocsAnswer(query: string): string {
  const q = String(query || "").toLowerCase();
  const mentionsSwap = /swap|route|trade|execute/.test(q);
  const mentionsFlashloan = /flashloan|flash loan|borrow/.test(q);
  const mentionsTrigger = /trigger api|trigger|automation|recurring/.test(q);

  const sections: string[] = [];
  sections.push("Jupiter MCP docs: prefer local docs lookups and deterministic execution paths for bots.");

  if (mentionsSwap) {
    sections.push("Swap skill: use execute_swap with input mint, output mint, amount, slippageBps, and a route or quote context.");
  }
  if (mentionsFlashloan) {
    sections.push("Flash loan skill: structure borrow, execute, and repay steps with clear risk limits and fee accounting.");
  }
  if (mentionsTrigger) {
    sections.push("Trigger API skill: use explicit schedules, conditions, or event gates before dispatching a trade action.");
  }
  if (!mentionsSwap && !mentionsFlashloan && !mentionsTrigger) {
    sections.push("Skills: execute_swap, trigger_api, flashloan orchestration, and quote-driven routing.");
  }

  sections.push("Reference: docs.jup.ag for public product guidance and API concepts.");
  return sections.join(" ");
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