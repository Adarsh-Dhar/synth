/**
 * worker/src/blockchain.ts
 *
 * Solana trade execution using:
 *  - @solana/web3.js  — connection, keypair, transaction signing
 *  - Jupiter V6 API   — swap quote + serialized transaction
 *  - Jito bundles     — MEV-protected transaction submission
 */

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { Agent, TradeAction, TradeResult } from "./types.js";

// ── Config ────────────────────────────────────────────────────────────────────

const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL ??
  "https://api.mainnet-beta.solana.com";

const JITO_BLOCK_ENGINE_URL =
  process.env.JITO_BLOCK_ENGINE_URL ??
  "https://mainnet.block-engine.jito.wtf/api/v1/bundles";

// Jupiter V6 quote + swap endpoints
const JUPITER_QUOTE_URL = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP_URL  = "https://quote-api.jup.ag/v6/swap";

// Minimum lamports kept in wallet for rent / fees
const GAS_RESERVE_LAMPORTS = 10_000_000; // 0.01 SOL

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Load keypair from hex-encoded private key stored in SOLANA_KEY env var */
function loadKeypair(): Keypair {
  const raw = String(process.env.SOLANA_KEY ?? "").trim();
  if (!raw) throw new Error("SOLANA_KEY env var is missing");

  // Accept both hex (64-byte secret key) and base58 formats
  if (raw.length === 128) {
    // Hex-encoded 64-byte secret key
    const bytes = Buffer.from(raw, "hex");
    return Keypair.fromSecretKey(bytes);
  }

  // Try base58 via Uint8Array JSON array (exported from Phantom / Solana CLI)
  if (raw.startsWith("[")) {
    const arr = JSON.parse(raw) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }

  throw new Error(
    "SOLANA_KEY must be a 128-char hex string or a JSON array of bytes"
  );
}

/** Resolve the mint address for a given token symbol or pass through an address */
function resolveMint(tokenSymbolOrAddress: string): string {
  const KNOWN: Record<string, string> = {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    WIF:  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
    JTO:  "jtojtomepa8beP8AuQc6eXt5FriJwfFMwt4EMPDSqcTi",
  };
  return KNOWN[tokenSymbolOrAddress.toUpperCase()] ?? tokenSymbolOrAddress;
}

// ── Jupiter helpers ───────────────────────────────────────────────────────────

interface JupiterQuote {
  inputMint:        string;
  outputMint:       string;
  inAmount:         string;
  outAmount:        string;
  otherAmountThreshold: string;
  swapMode:         string;
  slippageBps:      number;
  routePlan:        unknown[];
}

async function getJupiterQuote(
  inputMint:  string,
  outputMint: string,
  amountLamports: number,
  slippageBps = 50
): Promise<JupiterQuote> {
  const url = new URL(JUPITER_QUOTE_URL);
  url.searchParams.set("inputMint",   inputMint);
  url.searchParams.set("outputMint",  outputMint);
  url.searchParams.set("amount",      String(amountLamports));
  url.searchParams.set("slippageBps", String(slippageBps));

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jupiter quote failed [${res.status}]: ${body}`);
  }
  return res.json() as Promise<JupiterQuote>;
}

async function getJupiterSwapTx(
  quote:         JupiterQuote,
  walletAddress: string
): Promise<string> {
  const res = await fetch(JUPITER_SWAP_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse:            quote,
      userPublicKey:            walletAddress,
      wrapAndUnwrapSol:         true,
      computeUnitPriceMicroLamports: 200_000, // priority fee
      dynamicComputeUnitLimit:  true,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jupiter swap serialization failed [${res.status}]: ${body}`);
  }

  const data = (await res.json()) as { swapTransaction: string };
  return data.swapTransaction; // base64-encoded VersionedTransaction
}

// ── Jito bundle submission ────────────────────────────────────────────────────

async function submitJitoBundle(
  signedTxBase64: string,
  tipLamports = 10_000 // 0.00001 SOL tip
): Promise<string> {
  // Jito expects an array of base58-encoded transactions
  const signedTxBytes = Buffer.from(signedTxBase64, "base64");
  const base58Tx = bs58Encode(signedTxBytes);

  const res = await fetch(JITO_BLOCK_ENGINE_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id:      1,
      method:  "sendBundle",
      params:  [[base58Tx]],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jito bundle submission failed [${res.status}]: ${body}`);
  }

  const data = (await res.json()) as { result?: string; error?: { message: string } };
  if (data.error) throw new Error(`Jito RPC error: ${data.error.message}`);
  return data.result ?? "";
}

/** Minimal base58 encoder (avoids adding bs58 dep if not already present) */
function bs58Encode(buffer: Buffer): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let carry: number;
  const digits: number[] = [0];

  for (const byte of buffer) {
    carry = byte;
    for (let j = 0; j < digits.length; ++j) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let result = "";
  for (let k = 0; buffer[k] === 0 && k < buffer.length - 1; ++k) {
    result += "1";
  }
  for (let q = digits.length - 1; q >= 0; --q) {
    result += ALPHABET[digits[q]];
  }
  return result;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Execute a BUY or SELL trade for the given agent using Jupiter + Jito.
 *
 * BUY  → swap SOL → targetPair token
 * SELL → swap targetPair token → SOL
 */
export async function executeTrade(
  agent:  Agent,
  action: TradeAction,
  price:  number
): Promise<TradeResult> {
  console.log(
    `⛓  Preparing ${action} tx for agent "${agent.name}" ` +
    `on pair ${agent.targetPair} @ $${price.toFixed(4)}`
  );

  // ── 1. Load keypair ──────────────────────────────────────────────────────
  let keypair: Keypair;
  try {
    keypair = loadKeypair();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`❌ Keypair load failed: ${message}`);
    return { txHash: "", success: false, error: message };
  }

  const walletAddress = keypair.publicKey.toBase58();
  console.log(`  Wallet: ${walletAddress}`);

  // ── 2. Check balance ─────────────────────────────────────────────────────
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  let balanceLamports: number;
  try {
    balanceLamports = await connection.getBalance(keypair.publicKey);
    console.log(
      `  Balance: ${(balanceLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`
    );
  } catch (err) {
    const message = `Failed to fetch balance: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`❌ ${message}`);
    return { txHash: "", success: false, error: message };
  }

  if (balanceLamports <= GAS_RESERVE_LAMPORTS) {
    const message =
      `Insufficient balance: ${balanceLamports} lamports ` +
      `(need > ${GAS_RESERVE_LAMPORTS} for fees)`;
    console.warn(`⚠️  ${message}`);
    return { txHash: "", success: false, error: message };
  }

  // ── 3. Determine swap direction ──────────────────────────────────────────
  const SOL_MINT    = resolveMint("SOL");
  const TARGET_MINT = resolveMint(agent.targetPair);

  const inputMint  = action === "BUY" ? SOL_MINT    : TARGET_MINT;
  const outputMint = action === "BUY" ? TARGET_MINT : SOL_MINT;

  // For BUY: use 10% of available SOL (minus reserve). For SELL: use token balance.
  let swapAmountLamports: number;
  if (action === "BUY") {
    swapAmountLamports = Math.floor(
      (balanceLamports - GAS_RESERVE_LAMPORTS) * 0.1
    );
    if (swapAmountLamports <= 0) {
      return { txHash: "", success: false, error: "Swap amount too small after reserve" };
    }
  } else {
    // For SELL, get SPL token balance
    try {
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        keypair.publicKey,
        { mint: new PublicKey(TARGET_MINT) }
      );
      const tokenBalance =
        tokenAccounts.value[0]?.account.data.parsed.info.tokenAmount.amount ?? "0";
      swapAmountLamports = parseInt(tokenBalance, 10);
      if (swapAmountLamports <= 0) {
        return { txHash: "", success: false, error: "No token balance to sell" };
      }
    } catch (err) {
      const message = `Failed to fetch token balance: ${err instanceof Error ? err.message : String(err)}`;
      return { txHash: "", success: false, error: message };
    }
  }

  console.log(`  Swap amount: ${swapAmountLamports} (smallest unit)`);

  try {
    // ── 4. Get Jupiter quote ───────────────────────────────────────────────
    console.log(`  Fetching Jupiter quote…`);
    const quote = await getJupiterQuote(inputMint, outputMint, swapAmountLamports);
    console.log(`  Quote: ${quote.inAmount} → ${quote.outAmount}`);

    // ── 5. Get serialized swap transaction ─────────────────────────────────
    console.log(`  Serializing swap transaction…`);
    const swapTxBase64 = await getJupiterSwapTx(quote, walletAddress);

    // ── 6. Deserialize and sign ────────────────────────────────────────────
    const txBytes = Buffer.from(swapTxBase64, "base64");
    const tx = VersionedTransaction.deserialize(txBytes);

    // Refresh blockhash
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");
    tx.message.recentBlockhash = blockhash;

    tx.sign([keypair]);
    const signedTxBase64 = Buffer.from(tx.serialize()).toString("base64");

    // ── 7. Submit via Jito (MEV-protected) ────────────────────────────────
    let txHash: string;
    const useJito = process.env.USE_JITO !== "false";

    if (useJito) {
      console.log(`  Submitting via Jito bundle…`);
      const bundleId = await submitJitoBundle(signedTxBase64);
      // Jito returns bundle ID; get the actual sig from the signed tx
      txHash = bs58Encode(Buffer.from(tx.signatures[0]));
      console.log(`  Jito bundle ID: ${bundleId}`);
    } else {
      // Fallback: send directly via RPC
      console.log(`  Submitting via RPC…`);
      txHash = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight:       false,
        preflightCommitment: "confirmed",
      });
    }

    // ── 8. Confirm ─────────────────────────────────────────────────────────
    console.log(`  Confirming transaction ${txHash}…`);
    const confirmation = await connection.confirmTransaction(
      { signature: txHash, blockhash, lastValidBlockHeight },
      "confirmed"
    );

    if (confirmation.value.err) {
      throw new Error(`Transaction confirmed but failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    console.log(`✅ Trade executed! Tx: ${txHash}`);
    return { txHash, success: true };

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Trade execution failed for agent ${agent.id}: ${message}`);
    return { txHash: "", success: false, error: message };
  }
}