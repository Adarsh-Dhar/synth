import { Keypair, Connection, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

// Use Node's native env loader (same as your test-pipeline)
if (typeof process.loadEnvFile === "function") {
  process.loadEnvFile();
}

const CUSTOM_MINT = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";
const MAGICBLOCK_VALIDATOR = "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
const CLUSTER = "devnet";

function normalizeEnvSecret(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function initializeMint() {
  console.log(`🚀 Initializing MagicBlock queue for Mint: ${CUSTOM_MINT}`);

  // 1. Load your Agent Wallet
  const secretKeyString = normalizeEnvSecret(process.env.PRIVATE_KEY) ?? normalizeEnvSecret(process.env.UMBRA_PRIVATE_KEY);
  if (!secretKeyString) {
    throw new Error("No PRIVATE_KEY found in .env");
  }
  
  const agentKeypair = Keypair.fromSecretKey(bs58.decode(secretKeyString));
  const walletAddress = agentKeypair.publicKey.toBase58();
  console.log(`🔑 Using Agent Wallet: ${walletAddress}`);

  // 2. Fetch the setup transaction from MagicBlock
  console.log(`\n⏳ Fetching initialization transaction from MagicBlock API...`);
  const endpoint = "https://payments.magicblock.app/v1/spl/initialize-mint";
  
  const payload = {
    payer: walletAddress,
    owner: walletAddress,
    mint: CUSTOM_MINT,
    cluster: CLUSTER,
    validator: MAGICBLOCK_VALIDATOR
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    throw new Error(`API Error: ${res.status} ${await res.text()}`);
  }

  const txData = await res.json();
  
  if (!txData.transactionBase64) {
      throw new Error(`Invalid response format: ${JSON.stringify(txData)}`);
  }

  // 3. Deserialize and Sign the transaction
  console.log(`📝 Deserializing and signing transaction...`);
  const txBytes = Buffer.from(txData.transactionBase64, "base64");
  const transaction = VersionedTransaction.deserialize(new Uint8Array(txBytes));
  
  transaction.sign([agentKeypair]);
  const signedTxBytes = transaction.serialize();

  // 4. Broadcast to Devnet base chain
  console.log(`\n📡 Broadcasting to Devnet (sendTo: ${txData.sendTo})...`);
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  
  const signature = await connection.sendRawTransaction(signedTxBytes, {
    skipPreflight: false,
    maxRetries: 5
  });

  console.log(`⏳ Waiting for confirmation...`);
  await connection.confirmTransaction({
    signature: signature,
    blockhash: txData.recentBlockhash,
    lastValidBlockHeight: txData.lastValidBlockHeight
  }, "confirmed");

  console.log(`\n✅ Success! The mint is now registered with MagicBlock.`);
  console.log(`🔗 Transaction Signature: ${signature}`);
  console.log(`You can now use ${CUSTOM_MINT} in your worker.ts!`);
}

initializeMint().catch(err => {
  console.error(`\n❌ Initialization failed:`, err.message);
});