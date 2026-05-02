#!/usr/bin/env node
/**
 * Jupiter MCP Server — Production
 *
 * Transport : Stdio (spawned as subprocess by the Python agent or any MCP host)
 * Purpose   : Context provider + live API bridge for Jupiter on Solana
 *
 * Tools exposed:
 *   search_docs          — Semantic search over Jupiter API documentation
 *   get_quote            — Live swap quote from Jupiter Quote API V6
 *   get_token_info       — Token metadata + safety signal from Jupiter Tokens API
 *   get_price            — Spot price for one or more tokens via Jupiter Price V2
 *   list_trigger_orders  — Fetch open trigger/limit orders for a wallet
 *   list_perp_markets    — List available Jupiter perpetual markets
 *   generate_bot_code    — Return a complete bot code template for a given strategy
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError, } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import dotenv from "dotenv";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
dotenv.config();
// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────
const API_KEY = process.env.JUPITER_API_KEY?.trim();
// Jupiter API key is optional for public endpoints but required for private ones
if (!API_KEY) {
    process.stderr.write("[jupiter-mcp] WARNING: JUPITER_API_KEY not set. Rate limits will apply to public endpoints.\n");
}
const JUPITER_BASE = (process.env.JUPITER_BASE_URL ?? "https://api.jup.ag").replace(/\/+$/, "");
const QUOTE_API = (process.env.JUPITER_QUOTE_API_URL ?? "https://quote-api.jup.ag/v6").replace(/\/+$/, "");
const TIMEOUT_MS = Number(process.env.JUPITER_TIMEOUT_MS ?? 15_000);
const MAX_RETRIES = Number(process.env.JUPITER_MAX_RETRIES ?? 3);
// ─────────────────────────────────────────────
// Load docs knowledge base
// ─────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let DOCS = [];
try {
    const docsPath = path.resolve(__dirname, "../docs.json");
    DOCS = JSON.parse(readFileSync(docsPath, "utf-8"));
    process.stderr.write(`[jupiter-mcp] Loaded ${DOCS.length} doc entries.\n`);
}
catch {
    process.stderr.write("[jupiter-mcp] WARNING: docs.json not found — search_docs will return empty.\n");
}
// ─────────────────────────────────────────────
// Zod schemas
// ─────────────────────────────────────────────
const SearchDocsSchema = z.object({
    query: z.string().min(1).max(500).describe("Natural language or keyword query"),
    include_examples: z
        .boolean()
        .optional()
        .default(true)
        .describe("Whether to include code examples in the result"),
});
const QuoteSchema = z.object({
    input_mint: z.string().min(32).max(44).describe("Input token mint address (base58)"),
    output_mint: z.string().min(32).max(44).describe("Output token mint address (base58)"),
    amount: z
        .number()
        .int()
        .positive()
        .describe("Amount in base units (lamports for SOL, smallest unit for SPL)"),
    slippage_bps: z
        .number()
        .int()
        .min(0)
        .max(10_000)
        .optional()
        .default(50)
        .describe("Slippage tolerance in basis points (50 = 0.5%)"),
    swap_mode: z
        .enum(["ExactIn", "ExactOut"])
        .optional()
        .default("ExactIn"),
});
const TokenInfoSchema = z.object({
    mint: z.string().min(32).max(44).describe("SPL token mint address (base58)"),
});
const PriceSchema = z.object({
    mints: z
        .array(z.string().min(32).max(44))
        .min(1)
        .max(100)
        .describe("Array of SPL token mint addresses to price"),
    vs_token: z
        .string()
        .optional()
        .describe("Denominator token mint (default: USDC)"),
});
const TriggerOrdersSchema = z.object({
    wallet: z.string().min(32).max(44).describe("Wallet public key (base58)"),
});
const BotCodeSchema = z.object({
    strategy: z
        .enum([
        "copy_trade",
        "safe_sniper",
        "dca",
        "arbitrage",
        "event_driven",
    ])
        .describe("Strategy template to generate"),
    params: z.record(z.string(), z.unknown())
        .optional()
        .describe("Optional strategy-specific parameters to inject into the template"),
});
// ─────────────────────────────────────────────
// HTTP helper
// ─────────────────────────────────────────────
async function fetchJupiter(url, options = {}) {
    const headers = {
        "Content-Type": "application/json",
        ...options.headers,
    };
    if (API_KEY)
        headers["Authorization"] = `Bearer ${API_KEY}`;
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                ...options,
                headers,
                signal: controller.signal,
            });
            clearTimeout(timer);
            if (res.status === 429) {
                const wait = Number(res.headers.get("Retry-After") ?? 2);
                process.stderr.write(`[jupiter-mcp] 429 rate-limited — waiting ${wait}s (attempt ${attempt}/${MAX_RETRIES})\n`);
                await sleep(wait * 1000);
                continue;
            }
            if (res.status >= 500 && attempt < MAX_RETRIES) {
                process.stderr.write(`[jupiter-mcp] HTTP ${res.status} — retrying (attempt ${attempt}/${MAX_RETRIES})\n`);
                await sleep(500 * attempt);
                continue;
            }
            if (!res.ok) {
                const body = await res.text().catch(() => "(unreadable body)");
                throw new Error(`HTTP ${res.status} ${res.statusText}: ${body}`);
            }
            return await res.json();
        }
        catch (err) {
            clearTimeout(timer);
            lastError =
                err.name === "AbortError"
                    ? new Error(`Request timed out after ${TIMEOUT_MS}ms (${url})`)
                    : err;
            if (attempt < MAX_RETRIES)
                await sleep(300 * attempt);
        }
    }
    throw lastError ?? new Error("Unknown fetch error");
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
// ─────────────────────────────────────────────
// Tool handlers
// ─────────────────────────────────────────────
async function handleSearchDocs(args) {
    const { query, include_examples } = SearchDocsSchema.parse(args);
    const q = query.toLowerCase();
    const scored = DOCS.map((doc) => {
        let score = 0;
        for (const kw of doc.keywords) {
            if (q.includes(kw))
                score += 10;
        }
        // Partial word matching
        const words = q.split(/\s+/);
        for (const word of words) {
            if (word.length < 3)
                continue;
            if (doc.title.toLowerCase().includes(word))
                score += 5;
            if (doc.schema.toLowerCase().includes(word))
                score += 2;
        }
        return { doc, score };
    })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
    if (scored.length === 0) {
        return {
            message: "No documentation found for query. Available topics: swap, trigger, tokens, lend, perps, price, copy_trade, safe_sniper.",
            hint: "Try more specific keywords like 'swap', 'limit order', 'token safety', 'leverage', or 'bot template'.",
        };
    }
    return scored.map(({ doc }) => ({
        id: doc.id,
        title: doc.title,
        schema: doc.schema,
        ...(include_examples && doc.example ? { example: doc.example } : {}),
    }));
}
async function handleGetQuote(args) {
    const { input_mint, output_mint, amount, slippage_bps, swap_mode } = QuoteSchema.parse(args);
    const url = `${QUOTE_API}/quote` +
        `?inputMint=${encodeURIComponent(input_mint)}` +
        `&outputMint=${encodeURIComponent(output_mint)}` +
        `&amount=${amount}` +
        `&slippageBps=${slippage_bps}` +
        `&swapMode=${swap_mode}`;
    const quote = await fetchJupiter(url);
    return {
        quote,
        _note: "This is the quoteResponse object. Pass it directly to POST /swap along with userPublicKey to get the transaction. You must sign and send it yourself.",
    };
}
async function handleGetTokenInfo(args) {
    const { mint } = TokenInfoSchema.parse(args);
    const data = await fetchJupiter(`https://tokens.jup.ag/token/${encodeURIComponent(mint)}`);
    const token = data;
    return {
        ...token,
        _safety_summary: {
            is_strict: Boolean(token.strict),
            daily_volume_usd: token.daily_volume ?? 0,
            recommendation: token.strict && Number(token.daily_volume ?? 0) > 50_000
                ? "SAFE — verified token with sufficient liquidity"
                : !token.strict
                    ? "CAUTION — not on Jupiter strict list"
                    : "CAUTION — low daily volume",
        },
    };
}
async function handleGetPrice(args) {
    const { mints, vs_token } = PriceSchema.parse(args);
    let url = `${JUPITER_BASE}/price/v2?ids=${mints.map(encodeURIComponent).join(",")}`;
    if (vs_token)
        url += `&vsToken=${encodeURIComponent(vs_token)}`;
    const data = await fetchJupiter(url);
    return data;
}
async function handleListTriggerOrders(args) {
    const { wallet } = TriggerOrdersSchema.parse(args);
    const data = await fetchJupiter(`${JUPITER_BASE}/trigger/v1/openOrders?userPublicKey=${encodeURIComponent(wallet)}`);
    return data;
}
async function handleListPerpMarkets() {
    const data = await fetchJupiter(`${JUPITER_BASE}/perps/v1/markets`);
    return data;
}
async function handleGenerateBotCode(args) {
    const { strategy, params } = BotCodeSchema.parse(args);
    // Find the matching bot template in docs
    const strategyKeywordMap = {
        copy_trade: "copy_trade",
        safe_sniper: "safe_sniper",
        dca: "dca",
        arbitrage: "swap",
        event_driven: "perps",
    };
    const keyword = strategyKeywordMap[strategy] ?? strategy;
    const templateDoc = DOCS.find((d) => d.id === `bot_template_${strategy}` || d.keywords.includes(keyword));
    const paramsBlock = params && Object.keys(params).length > 0
        ? `\n// ── Strategy Parameters ──\n// ${JSON.stringify(params, null, 2).replace(/\n/g, "\n// ")}\n`
        : "";
    const baseSchema = templateDoc?.schema ?? `// No template found for strategy: ${strategy}`;
    return {
        strategy,
        filename: `${strategy.replace(/_/g, "-")}-bot.ts`,
        code: `#!/usr/bin/env tsx
/**
 * Generated ${strategy.replace(/_/g, " ").toUpperCase()} Bot
 * Generated by: Jupiter MCP Server
 * 
 * REQUIRED env vars:
 *   WALLET_KEY      — JSON array of your wallet's secret key bytes
 *   RPC_URL         — Solana RPC endpoint
 *   GOLDRUSH_API_KEY — Covalent GoldRush key (for data queries)
 * 
 * Install: npm install @solana/web3.js node-cron node-fetch
 * Run:     npx tsx ${strategy.replace(/_/g, "-")}-bot.ts
 */
${paramsBlock}
${baseSchema}
`,
        _instructions: [
            "1. Set the required environment variables listed in the file header.",
            "2. Run `npm install @solana/web3.js node-cron node-fetch` in the bot directory.",
            "3. Review and test on devnet before using real funds.",
            "4. Add signing logic where marked with // TODO: sign + send.",
        ],
    };
}
// ─────────────────────────────────────────────
// Tool registry
// ─────────────────────────────────────────────
const TOOLS = [
    {
        name: "search_docs",
        description: "Search Jupiter API documentation. Use this FIRST before writing any Jupiter integration code. " +
            "Returns accurate API schemas, required parameters, and code examples.",
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Natural language query, e.g. 'how to place a limit order' or 'swap SOL to USDC'",
                },
                include_examples: {
                    type: "boolean",
                    description: "Include code examples (default: true)",
                },
            },
            required: ["query"],
        },
    },
    {
        name: "get_quote",
        description: "Fetch a live swap quote from Jupiter Quote API V6. " +
            "Returns the quoteResponse object needed to build a swap transaction. " +
            "Use this to validate routes and get expected output amounts before generating bot code.",
        inputSchema: {
            type: "object",
            properties: {
                input_mint: { type: "string", description: "Input token mint (base58)" },
                output_mint: { type: "string", description: "Output token mint (base58)" },
                amount: {
                    type: "number",
                    description: "Amount in base units (lamports for SOL)",
                },
                slippage_bps: {
                    type: "number",
                    description: "Slippage in basis points (default: 50 = 0.5%)",
                },
                swap_mode: {
                    type: "string",
                    enum: ["ExactIn", "ExactOut"],
                    description: "Swap mode (default: ExactIn)",
                },
            },
            required: ["input_mint", "output_mint", "amount"],
        },
    },
    {
        name: "get_token_info",
        description: "Fetch token metadata and a safety assessment for an SPL token mint. " +
            "Checks strict-list status, daily volume, and tags. " +
            "Always call this before generating a bot that trades an unfamiliar token.",
        inputSchema: {
            type: "object",
            properties: {
                mint: { type: "string", description: "SPL token mint address (base58)" },
            },
            required: ["mint"],
        },
    },
    {
        name: "get_price",
        description: "Fetch current spot prices for one or more SPL tokens via Jupiter Price API V2. " +
            "Use this to set entry/exit price thresholds in generated bot code.",
        inputSchema: {
            type: "object",
            properties: {
                mints: {
                    type: "array",
                    items: { type: "string" },
                    description: "Array of token mint addresses (1–100)",
                },
                vs_token: {
                    type: "string",
                    description: "Denominator token mint (default: USDC)",
                },
            },
            required: ["mints"],
        },
    },
    {
        name: "list_trigger_orders",
        description: "Fetch all open trigger (limit/stop) orders for a wallet. " +
            "Use this to check existing positions before placing new orders.",
        inputSchema: {
            type: "object",
            properties: {
                wallet: { type: "string", description: "Wallet public key (base58)" },
            },
            required: ["wallet"],
        },
    },
    {
        name: "list_perp_markets",
        description: "List all available Jupiter perpetual markets (SOL-PERP, BTC-PERP, etc.). " +
            "Use this to validate market names before generating leveraged bot code.",
        inputSchema: {
            type: "object",
            properties: {},
            required: [],
        },
    },
    {
        name: "generate_bot_code",
        description: "Generate a complete, runnable TypeScript bot for a given trading strategy. " +
            "Returns a filename and full source code ready to save and run. " +
            "Available strategies: copy_trade, safe_sniper, dca, arbitrage, event_driven.",
        inputSchema: {
            type: "object",
            properties: {
                strategy: {
                    type: "string",
                    enum: ["copy_trade", "safe_sniper", "dca", "arbitrage", "event_driven"],
                    description: "The trading strategy template to generate",
                },
                params: {
                    type: "object",
                    description: "Optional strategy parameters, e.g. { target_wallet: '7VHu...', position_size_usdc: 100 }",
                },
            },
            required: ["strategy"],
        },
    },
];
// ─────────────────────────────────────────────
// MCP Server bootstrap
// ─────────────────────────────────────────────
const server = new Server({ name: "jupiter-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    try {
        let result;
        switch (name) {
            case "search_docs":
                result = await handleSearchDocs(rawArgs);
                break;
            case "get_quote":
                result = await handleGetQuote(rawArgs);
                break;
            case "get_token_info":
                result = await handleGetTokenInfo(rawArgs);
                break;
            case "get_price":
                result = await handleGetPrice(rawArgs);
                break;
            case "list_trigger_orders":
                result = await handleListTriggerOrders(rawArgs);
                break;
            case "list_perp_markets":
                result = await handleListPerpMarkets();
                break;
            case "generate_bot_code":
                result = await handleGenerateBotCode(rawArgs);
                break;
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    }
    catch (err) {
        if (err instanceof z.ZodError) {
            throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for "${name}": ${err.issues
                .map((e) => `${e.path.join(".")}: ${e.message}`)
                .join("; ")}`);
        }
        if (err instanceof McpError)
            throw err;
        throw new McpError(ErrorCode.InternalError, `Tool "${name}" failed: ${err.message}`);
    }
});
// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write(`[jupiter-mcp] Server ready — ${TOOLS.length} tools loaded, ${DOCS.length} doc entries indexed.\n`);
}
main().catch((err) => {
    process.stderr.write(`[jupiter-mcp] Fatal startup error: ${err.message}\n`);
    process.exit(1);
});
