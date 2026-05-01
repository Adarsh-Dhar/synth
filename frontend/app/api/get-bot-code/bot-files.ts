export interface BotFile {
  filepath: string;
  content: string;
}

export function assembleBotFiles(): BotFile[] {
  return assembleSolanaBotFiles();
}
export function assembleSolanaBotFiles(): BotFile[] {
  const files: BotFile[] = [
    { filepath: "package.json", content: SOLANA_PACKAGE_JSON },
    { filepath: "tsconfig.json", content: SOLANA_TSCONFIG },
    { filepath: ".env.example", content: SOLANA_ENV_EXAMPLE },
    { filepath: "src/solana_utils.ts", content: SOLANA_UTILS_TS },
    { filepath: "src/goldrush_mcp.ts", content: SOLANA_GOLDRUSH_MCP_TS },
    { filepath: "src/index.ts", content: SOLANA_INDEX_TS },
  ];

  // Sanitize templates: ensure no hardcoded Solana RPC endpoints remain
  // and force runtime usage of `process.env.SOLANA_RPC_URL` injected by the worker.
  const sanitize = (s: string) =>
    s.replace(/https?:\/\/[^\s"'`]+solana[^\s"'`]*/gi, 'process.env.SOLANA_RPC_URL');

  return files.map((f) => ({ filepath: f.filepath, content: sanitize(f.content) }));
}

const SOLANA_PACKAGE_JSON = JSON.stringify(
  {
    name: "solana-bot",
    version: "1.0.0",
    type: "module",
    scripts: {
      start: "tsx src/index.ts",
      dev: "tsx src/index.ts",
    },
    dependencies: {
      dotenv: "^16.4.0",
      axios: "^1.7.4",
    },
    devDependencies: {
      typescript: "^5.4.0",
      "@types/node": "^20.0.0",
      tsx: "^4.7.0",
    },
  },
  null,
  2,
);

const SOLANA_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "es2021",
      module: "esnext",
      moduleResolution: "bundler",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
    },
    include: ["src/**/*"],
  },
  null,
  2,
);

const SOLANA_ENV_EXAMPLE = `# RPC endpoint (mainnet fork)
SOLANA_RPC_URL=http://127.0.0.1:8899
# Your wallet address (base58)
USER_WALLET_ADDRESS=YourBase58AddressHere
# Optional: path to a local keypair JSON for server-side signing
KEYPAIR_PATH=./keypair.json
# Recipient address for example transfers
RECIPIENT_ADDRESS=YourRecipientBase58
# Poll interval seconds
POLL_INTERVAL=15
SIMULATION_MODE=true
GOLDRUSH_API_KEY=gr_your_api_key
GOLDRUSH_MCP_URL=https://goldrush-mcp.example.com/mcp
GOLDRUSH_STREAM_EVENTS=lp_pull,drainer_approval,phishing_airdrop
`;

const SOLANA_UTILS_TS = `import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import "dotenv/config";

const RPC = process.env.SOLANA_RPC_URL;
if (!RPC) throw new Error('SOLANA_RPC_URL must be set and provided by the runtime (injected by the worker)');

export async function getSolBalance(address: string): Promise<number> {
  const conn = new Connection(RPC, { commitment: "confirmed" });
  const pub = new PublicKey(address);
  const bal = await conn.getBalance(pub, "confirmed");
  return bal / LAMPORTS_PER_SOL;
}
`;

const SOLANA_GOLDRUSH_MCP_TS = `import axios from "axios";
import "dotenv/config";

type GoldRushMcpWalletResponse = {
  balanceSol?: number;
  priceUsd?: number;
};

export async function getWalletBalanceFromGoldRush(walletAddress: string): Promise<number> {
  const baseUrl = process.env.GOLDRUSH_MCP_URL ?? "";
  const apiKey = process.env.GOLDRUSH_API_KEY ?? "";
  if (!baseUrl) throw new Error("GOLDRUSH_MCP_URL is required");
  if (!apiKey) throw new Error("GOLDRUSH_API_KEY is required");

  const response = await axios.get<GoldRushMcpWalletResponse>(
    baseUrl.replace(/\/$/, "") + "/wallet/balance",
    {
      params: { walletAddress },
      headers: { Authorization: "Bearer " + apiKey },
      timeout: 12000,
    },
  );

  const value = Number(response.data?.balanceSol ?? 0);
  return Number.isFinite(value) ? value : 0;
}
`;

const SOLANA_INDEX_TS = `import "dotenv/config";
import { Connection, PublicKey, SystemProgram, Transaction, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getWalletBalanceFromGoldRush } from "./goldrush_mcp";
import fs from "fs";

const RPC = process.env.SOLANA_RPC_URL;
if (!RPC) throw new Error('SOLANA_RPC_URL must be set by the runtime (injected by the worker)');
const WALLET = process.env.USER_WALLET_ADDRESS ?? "";
const KEYPAIR_PATH = process.env.KEYPAIR_PATH ?? "";
const POLL_MS = (Number(process.env.POLL_INTERVAL ?? "15") || 15) * 1000;
const SIMULATION = String(process.env.SIMULATION_MODE ?? "true").toLowerCase() !== "false";

function log(level: string, msg: string) { console.log("[" + new Date().toISOString() + "] [" + level + "] " + msg); }

async function runCycle() {
  if (!WALLET) throw new Error("USER_WALLET_ADDRESS is required in .env");
  const balance = await getWalletBalanceFromGoldRush(WALLET);
  log("INFO", "Balance (" + WALLET + ") = " + balance + " SOL");

  const threshold = 0.1; // default threshold
  if (balance <= threshold) return;

  if (SIMULATION) {
    log("INFO", "SIMULATION: would transfer funds from " + WALLET + " to configured recipient.");
    return;
  }

  if (!KEYPAIR_PATH || !fs.existsSync(KEYPAIR_PATH)) {
    log("WARN", "No KEYPAIR_PATH provided or file not found — cannot perform on-chain transfers from server.");
    return;
  }

  const keypairData = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"));
  const secret = Uint8Array.from(keypairData);
  const keypair = Keypair.fromSecretKey(secret);
  const connection = new Connection(RPC, { commitment: "confirmed" });

  const recipient = process.env.RECIPIENT_ADDRESS;
  if (!recipient) {
    log("WARN", "RECIPIENT_ADDRESS not set; skipping transfer.");
    return;
  }

  const to = new PublicKey(recipient);
  const lamports = Math.floor(0.01 * LAMPORTS_PER_SOL);
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: to, lamports }));
  tx.feePayer = keypair.publicKey;
  const { blockhash } = await connection.getLatestBlockhash("finalized");
  tx.recentBlockhash = blockhash;
  tx.sign(keypair);
  const raw = tx.serialize();
  const sig = await connection.sendRawTransaction(raw);
  await connection.confirmTransaction(sig, "confirmed");
  log("INFO", "Transfer sent: " + sig);
}
`;

