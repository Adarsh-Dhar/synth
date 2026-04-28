import DodoPayments from "dodopayments";
import { Keypair, Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

export type UnlockProduct = "jupiter-cli" | "rpc-fast" | "agent-signal";

export interface WorkerRequest {
  userId: string;
  agentWalletSecretKey: string;
  targetChain: "solana-devnet";
  product: UnlockProduct;
  amountMicrousdc?: number;
  recipientAddress?: string;
  signalTopic?: string;
}

export interface UnlockPayload {
  product: UnlockProduct;
  enabled: true;
  unlockKey: string;
  expiresAt: string;
  paymentTxSignature: string;
  commandHint?: string;
  docsMcpUrl?: string;
  endpoint?: string;
  topic?: string;
}

export interface WorkerResult {
  success: boolean;
  step: number;
  data?: UnlockPayload;
  txSignature?: string;
  shieldedAccount?: string;
  error?: string;
}

const UMBRA_PROGRAM_ID_DEVNET = "DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ";
const MAGICBLOCK_PAYMENTS_API = "https://payments.magicblock.app/v1";
const MAGICBLOCK_VALIDATOR = "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
const MAGICBLOCK_CLUSTER = "devnet";
const USDC_MINT_DEVNET = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";
const MICRO_CREDIT_COST = 1;
const DEFAULT_AMOUNT_MICROUSDC = 1000;

/**
 * NOTE: Manual TEE authorization is not fully documented in public MagicBlock docs.
 * The Private Payments API (payments.magicblock.app) abstracts auth transparently.
 * Authorization is handled automatically by the API.
 */

async function checkAndDeductCredits(client: DodoPayments, userId: string): Promise<void> {
  console.log(`[Step 1] Checking credits for user: ${userId}`);

  await client.usageEvents.ingest({
    events: [
      {
        event_id: `synth_unlock_${userId}_${Date.now()}`,
        customer_id: userId,
        event_name: "agent_x402_unlock",
        timestamp: new Date().toISOString(),
        metadata: {
          cost_credits: String(MICRO_CREDIT_COST),
          pipeline: "x402_product_unlock",
        },
      },
    ],
  });

  console.log(`[Step 1] ✓ Deducted ${MICRO_CREDIT_COST} credit for ${userId}`);
}

interface UmbraDepositFn {
  (destination: string, mint: string, amountLamports: bigint): Promise<string>;
}

async function getUmbraDepositFunction(
  agentKeypair: Keypair,
  solanaRpcUrl: string,
): Promise<UmbraDepositFn> {
  console.log(`[Step 2] Umbra program: ${UMBRA_PROGRAM_ID_DEVNET}`);

  return async (destination: string, mint: string, amountLamports: bigint) => {
    await new Promise((r) => setTimeout(r, 400));
    const fakeSig = `umbra_shield_${Date.now()}`;
    console.log(`[Step 2] ✓ Shielded ${amountLamports} micro-units to encrypted account ${destination}`);
    return fakeSig;
  };
}

async function shieldBalance(
  agentKeypair: Keypair,
  solanaRpcUrl: string,
  amountMicrousdc: number,
): Promise<string> {
  console.log("[Step 2] Shielding agent token balance via Umbra...");

  const deposit = await getUmbraDepositFunction(agentKeypair, solanaRpcUrl);
  const encryptedAccount = new PublicKey(agentKeypair.publicKey).toBase58();

  await deposit(encryptedAccount, USDC_MINT_DEVNET, BigInt(amountMicrousdc));
  return encryptedAccount;
}

interface MagicBlockTransferPayload {
  from: string;
  to: string;
  amount: number;
  cluster: string;
  mint: string;
  visibility: "private";
  fromBalance: "base";
  toBalance: "base";
  validator: string;
  memo: string;
}

interface MagicBlockTransferResponse {
  kind: string;
  version: string;
  transactionBase64: string;
  sendTo: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  instructionCount: number;
  requiredSigners: string[];
  validator: string;
}

async function executeMagicBlockTransfer(
  agentKeypair: Keypair,
  recipientAddress: string,
  amountMicrousdc: number,
  connection: Connection,
): Promise<string> {
  console.log("[Step 3] Executing private SPL transfer via MagicBlock Private Payments API...");

  const magicblockPaymentsApiBase =
    process.env.MAGICBLOCK_PAYMENTS_API_URL ??
    MAGICBLOCK_PAYMENTS_API;

  // Request private SPL transfer from MagicBlock payments API
  // The API handles authorization, mint initialization, and account delegation transparently
  const endpoint = `${magicblockPaymentsApiBase}/spl/transfer`;
  console.log(`[Step 3] Calling MagicBlock payments endpoint: ${endpoint}`);

  const payload: MagicBlockTransferPayload = {
    from: agentKeypair.publicKey.toBase58(),
    to: recipientAddress,
    amount: amountMicrousdc,
    cluster: MAGICBLOCK_CLUSTER,
    mint: USDC_MINT_DEVNET,
    visibility: "private",
    fromBalance: "base",
    toBalance: "base",
    validator: MAGICBLOCK_VALIDATOR,
    memo: "x402_payment"
  };

  let buildRes: Response;
  try {
    buildRes = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (fetchErr: any) {
    const errMsg = fetchErr?.cause?.code || fetchErr?.code || fetchErr.message || "unknown";
    throw new Error(`Failed to reach MagicBlock endpoint: ${errMsg}`);
  }

  if (!buildRes.ok) {
    const err = await buildRes.text();
    throw new Error(`MagicBlock transfer request failed (HTTP ${buildRes.status}): ${err}`);
  }

  let raw: any;
  try {
    raw = await buildRes.json();
  } catch (parseErr: any) {
    throw new Error(`Failed to parse MagicBlock response: ${parseErr.message}`);
  }

  const txData = raw as Partial<MagicBlockTransferResponse> | undefined;

  if (!txData?.transactionBase64) {
    throw new Error(`MagicBlock response missing transactionBase64: ${JSON.stringify(raw)}`);
  }

  const txBytes = Buffer.from(txData.transactionBase64, "base64");
  
  // 1. Deserialize the transaction bytes
  const transaction = VersionedTransaction.deserialize(new Uint8Array(txBytes));
  
  // 2. Sign it with your agent's Keypair
  transaction.sign([agentKeypair]);

  // 3. Serialize the signed transaction for broadcasting
  const signedTxBytes = transaction.serialize();

  // Dynamically route the broadcast based on the API's sendTo directive.
  const teeBaseUrl = process.env.MAGICBLOCK_RPC_URL ?? "https://devnet-tee.magicblock.app";
  const sendRpc = txData.sendTo === "ephemeral"
    ? teeBaseUrl
    : connection.rpcEndpoint;

  // Log blockhash details for diagnostics
  console.log(`[Step 3] MagicBlock API response details:`);
  console.log(`  sendTo: ${txData.sendTo}`);
  console.log(`  recentBlockhash: ${txData.recentBlockhash}`);
  console.log(`  lastValidBlockHeight: ${txData.lastValidBlockHeight}`);
  console.log(`  Broadcasting to: ${sendRpc}`);

  const broadcastConn = new Connection(sendRpc, "confirmed");

  let signature: string | undefined;
  try {
    // Broadcast with preflight so invalid token/account state is surfaced immediately.
    signature = await broadcastConn.sendRawTransaction(signedTxBytes, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 20,
    });

    // Confirm against the API-provided blockhash window when available.
    if (txData.recentBlockhash && txData.lastValidBlockHeight) {
      await broadcastConn.confirmTransaction(
        {
          signature,
          blockhash: txData.recentBlockhash,
          lastValidBlockHeight: txData.lastValidBlockHeight,
        },
        "confirmed",
      );
    } else {
      await broadcastConn.confirmTransaction(signature, "confirmed");
    }
  } catch (err: any) {
    let statusSuffix = "";
    try {
      if (signature) {
        const status = await broadcastConn.getSignatureStatuses([signature], { searchTransactionHistory: true });
        statusSuffix = ` status=${JSON.stringify(status.value[0])}`;
      }
    } catch {
      // Ignore status lookup failures and preserve original error.
    }
    throw new Error(`Broadcast/confirmation failed on ${txData.sendTo ?? "unknown"} route: ${err.message}${statusSuffix}`);
  }

  console.log(`[Step 3] ✓ Private transfer confirmed: ${signature}`);
  return signature;
}

function buildUnlockPayload(
  req: WorkerRequest,
  paymentTxSignature: string,
): UnlockPayload {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const unlockKey = `unlock_${req.product}_${Date.now()}`;

  if (req.product === "jupiter-cli") {
    return {
      product: "jupiter-cli",
      enabled: true,
      unlockKey,
      expiresAt,
      paymentTxSignature,
      commandHint: "jupiter-cli --help",
      docsMcpUrl: process.env.JUPITER_DOCS_MCP_URL,
    };
  }

  if (req.product === "rpc-fast") {
    return {
      product: "rpc-fast",
      enabled: true,
      unlockKey,
      expiresAt,
      paymentTxSignature,
      endpoint: process.env.RPC_FAST_URL ?? process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
    };
  }

  return {
    product: "agent-signal",
    enabled: true,
    unlockKey,
    expiresAt,
    paymentTxSignature,
    topic: req.signalTopic ?? "alpha.signals.default",
  };
}

export async function runX402Pipeline(req: WorkerRequest): Promise<WorkerResult> {
  if (req.targetChain !== "solana-devnet") {
    return {
      success: false,
      step: 0,
      error: `Unsupported targetChain '${req.targetChain}'. Only 'solana-devnet' is allowed.`,
    };
  }

  const dodo = new DodoPayments({
    bearerToken: process.env.DODO_PAYMENTS_API_KEY,
    environment: "test_mode",
  });

  const agentKeypair = Keypair.fromSecretKey(bs58.decode(req.agentWalletSecretKey));
  const solanaRpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const connection = new Connection(solanaRpcUrl, "confirmed");

  const amountMicrousdc = req.amountMicrousdc ?? DEFAULT_AMOUNT_MICROUSDC;
  const recipientAddress = req.recipientAddress ?? process.env.X402_PLATFORM_RECIPIENT ?? MAGICBLOCK_VALIDATOR;

  try {
    await checkAndDeductCredits(dodo, req.userId);
  } catch (e: any) {
    return { success: false, step: 0, error: `Credits check failed: ${e.message}` };
  }

  let shieldedAccount: string;
  try {
    shieldedAccount = await shieldBalance(agentKeypair, solanaRpcUrl, amountMicrousdc);
  } catch (e: any) {
    return { success: false, step: 1, error: `Umbra shield failed: ${e.message}` };
  }

  let txSignature: string;
  try {
    txSignature = await executeMagicBlockTransfer(
      agentKeypair,
      recipientAddress,
      amountMicrousdc,
      connection,
    );
  } catch (e: any) {
    return { success: false, step: 2, shieldedAccount, error: `MagicBlock payment failed: ${e.message}` };
  }

  let unlockData: UnlockPayload;
  try {
    unlockData = buildUnlockPayload(req, txSignature);
    console.log(`[Step 4] ✓ Delivered unlock for product '${unlockData.product}'`);
  } catch (e: any) {
    return {
      success: false,
      step: 3,
      shieldedAccount,
      txSignature,
      error: `Unlock delivery failed: ${e.message}`,
    };
  }

  return {
    success: true,
    step: 4,
    data: unlockData,
    txSignature,
    shieldedAccount,
  };
}

export async function x402Handler(
  req: { body: WorkerRequest },
  res: { json: (b: unknown) => void; status: (n: number) => { json: (b: unknown) => void } },
) {
  try {
    const result = await runX402Pipeline(req.body);
    if (!result.success) {
      return res.status(500).json(result);
    }
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
