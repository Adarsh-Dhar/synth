import "dotenv/config";
import axios from "axios";

type Json = Record<string, unknown>;

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const META_AGENT_URL = process.env.META_AGENT_URL ?? "http://127.0.0.1:8000";
const PROMPT =
  process.env.TEST_PROMPT ??
  "Write a flash-bridge spatial arbitrage bot in TypeScript for Solana that compares two on-chain pools, bridges USDC where appropriate, and sells the spread once it is profitable. Chain: Solana. Strategy: cross_chain_arbitrage.";
const MAX_ATTEMPTS = Number(process.env.TEST_MAX_ATTEMPTS ?? "3");
const GENERATE_TIMEOUT_MS = Number(process.env.TEST_GENERATE_TIMEOUT_MS ?? "420000");

const requiredGeneratedFiles = [
  "package.json",
  "src/solana_utils.ts",
  "src/index.ts",
];

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; data: Json; text: string }> {
  try {
    const res = await axios({
      url,
      method: (init.method || 'GET') as any,
      headers: init.headers as any,
      data: init.body as any,
      timeout: timeoutMs,
      validateStatus: () => true // Accept all status codes
    } as any);
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    let data: Json = {};
    try {
      data = text ? (JSON.parse(text) as Json) : {};
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data, text };
  } catch (error: any) {
    throw new Error(`Request failed: ${error.message}`);
  }
}

async function run(): Promise<void> {
  console.log("\n=== Meta-Agent End-to-End Debug Test ===");
  console.log(`BASE_URL=${BASE_URL}`);
  console.log(`META_AGENT_URL=${META_AGENT_URL}`);
  console.log(`PROMPT=${PROMPT}`);
  console.log(`MAX_ATTEMPTS=${MAX_ATTEMPTS}\n`);

  const health = await fetchJsonWithTimeout(
    `${META_AGENT_URL}/health`,
    { method: "GET", headers: { accept: "application/json" } },
    3000,
  );

  assert(
    health.status === 200,
    `Meta-Agent health failed (${health.status}): ${health.text.slice(0, 300)}`,
  );

  console.log("[ok] Meta-Agent health:", health.data);

  const classify = await fetchJsonWithTimeout(
    `${BASE_URL}/api/classify-intent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ prompt: PROMPT }),
    },
    60000,
  );

  assert(
    classify.status === 200,
    `classify-intent failed (${classify.status}): ${classify.text.slice(0, 600)}`,
  );

  const expandedPrompt = String((classify.data.expandedPrompt as string) ?? PROMPT);
  assert(expandedPrompt.trim().length > 0, "expandedPrompt is empty");
  console.log(`[ok] classify-intent returned expanded prompt (${expandedPrompt.length} chars)`);

  let lastError = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const started = Date.now();
    console.log(`\n[attempt ${attempt}/${MAX_ATTEMPTS}] calling /api/generate-bot ...`);

    const generate = await fetchJsonWithTimeout(
      `${BASE_URL}/api/generate-bot`,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          prompt: PROMPT,
          expandedPrompt,
          envConfig: {},
        }),
      },
      GENERATE_TIMEOUT_MS,
    );

    const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);

    if (generate.status === 200) {
      const files = Array.isArray(generate.data.files) ? (generate.data.files as Array<Json>) : [];
      const filepaths = new Set(
        files
          .map((f) => f.filepath)
          .filter((p): p is string => typeof p === "string"),
      );

      const missing = requiredGeneratedFiles.filter((p) => !filepaths.has(p));
      const solanaUtils = files.find((f) => f.filepath === "src/solana_utils.ts");
      const solanaUtilsContent = typeof solanaUtils?.content === "string" ? solanaUtils.content : "";
      const indexFile = files.find((f) => f.filepath === "src/index.ts");
      const indexContent = typeof indexFile?.content === "string" ? indexFile.content : "";
      const packageFile = files.find((f) => f.filepath === "package.json");
      const packageContent = typeof packageFile?.content === "string" ? packageFile.content : "";
      const loweredIndex = indexContent.toLowerCase();

      const intent = (generate.data.intent ?? {}) as Json;
      const strategy = String(intent.strategy ?? "").toLowerCase();
      const chain = String(intent.chain ?? "").toLowerCase();

      assert(typeof generate.data.agentId === "string", "agentId missing in success response");
      assert(files.length > 0, "files list is empty in success response");
      assert(missing.length === 0, `missing required generated files: ${missing.join(", ")}`);
      assert(chain === "solana", `expected chain=solana but got ${chain || "<empty>"}`);
      assert(strategy === "cross_chain_arbitrage", `expected strategy=cross_chain_arbitrage but got ${strategy || "<empty>"}`);
      assert(/"type"\s*:\s*"module"/.test(packageContent), "package.json should use ESM modules");
      assert(/"start"\s*:\s*"tsx src\/index\.ts"/.test(packageContent), "package.json should start with tsx src/index.ts");
      assert(/"dotenv"/.test(packageContent), "package.json should include dotenv");
      assert(/"typescript"/.test(packageContent), "package.json should include typescript");
      assert(/"tsx"/.test(packageContent), "package.json should include tsx");
      assert(packageContent.includes("@solana/web3.js"), "package.json should include @solana/web3.js");
      assert(packageContent.includes("bs58"), "package.json should include bs58");

      // Ensure a Solana helper or index uses Solana SDK or helper utilities
      assert(
        /SystemProgram|getSolBalance|@solana\/web3\.js/.test(indexContent + solanaUtilsContent),
        "generated code must include Solana SDK usage or helper utilities"
      );

      console.log(`[ok] generate-bot success in ${elapsedSec}s`);
      console.log("agentId:", generate.data.agentId);
      console.log("files:", files.length);
      assert(!loweredIndex.includes("getwalletprivatekey"), "generated index must not try to extract a private key");
      assert(!loweredIndex.includes("callsigningrelay"), "generated index must not inline signing relay logic into src/index.ts");
      return;
    }

    const msg = typeof generate.data.error === "string" ? generate.data.error : generate.text;
    lastError = `status=${generate.status}; error=${msg.slice(0, 800)}`;
    console.log(`[warn] generation failed in ${elapsedSec}s -> ${lastError}`);
  }

  throw new Error(`All attempts failed. Last error: ${lastError}`);
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("\n[FAIL]", message);
  process.exit(1);
});
