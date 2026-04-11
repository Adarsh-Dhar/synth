import { Agent, TradeAction, TradeResult } from "./types.js";

const SOLANA_REST_URL =
  process.env.SOLANA_REST_URL ; 
const CHAIN_ID = "solana-testnet"; 

export async function executeTrade(
  agent: Agent,
  action: TradeAction,
  price: number
): Promise<TradeResult> {
  console.log(
    `⛓  Preparing ${action} tx for agent "${agent.name}" on pair ${agent.targetPair} @ $${price.toFixed(4)}`
  );

  const runtimeSolanaKey = String(process.env.SOLANA_KEY ?? "").trim();
  if (!runtimeSolanaKey) {
    const msg = `SOLANA_KEY is missing at runtime for agent ${agent.id}`;
    console.error(`❌ ${msg}`);
    return { txHash: "", success: false, error: msg };
  }

    try {
      const rest = new RESTClient(SOLANA_REST_URL, {
        chainId: CHAIN_ID,
        gasPrices: "0.15sol",
        gasAdjustment: "2.0",
      });

      // Runtime-only key source for signing.
      const key = new RawKey(Buffer.from(runtimeSolanaKey, "hex"));
      const wallet = new Wallet(rest, key);

      // Debug: log the address and check if account exists
      console.log("Sender address:", wallet.key.accAddress);
      let balanceSol = 0;
      try {
        const [balance] = await rest.bank.balance(wallet.key.accAddress);
        console.log("Balance:", balance);
        balanceSol = parseInt(balance.get("sol")?.amount ?? "0");
      } catch (err) {
        console.error("Error fetching balance (account may not exist):", err);
        return { txHash: "", success: false, error: "Could not fetch balance" };
      }

      const GAS_RESERVE = 300_000; // 0.3 SOL for gas
      if (balanceSol <= GAS_RESERVE) {
        console.warn(`⚠️ Insufficient balance for gas: ${balanceSol} sol (required > ${GAS_RESERVE} sol)`);
        return { txHash: "", success: false, error: `Insufficient balance for gas: ${balanceSol} sol (required > ${GAS_RESERVE} sol)` };
      }

      const sendAmount = String(balanceSol - GAS_RESERVE);
      const msg = new MsgSend(
        wallet.key.accAddress,
        "solana1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq9w5l5", 
        `${sendAmount}sol`
      );

      const tx = await wallet.createAndSignTx({
        msgs: [msg],
        // chain_id: "solana-testnet"
      });
      const result = await rest.tx.broadcast(tx);
      const txHash = result.txhash;
      console.log(`✅ Transaction Success! Hash: ${txHash}`);
      return { txHash, success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`❌ Trade execution failed for agent ${agent.id}: ${message}`);
      return { txHash: "", success: false, error: message };
    }
}
