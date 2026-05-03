import "dotenv/config";
import axios from "axios";
import { createHmac } from "crypto";

const amount = BigInt(process.env.TRADE_AMOUNT_LAMPORTS ?? "0");

export function paymentWebhookHandler(rawBody: string, sig: string): boolean {
  const secret = String(process.env.PAYMENT_WEBHOOK_SECRET ?? "");
  if (!secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return expected === sig;
}

async function run() {
  await axios.get("https://quote-api.jup.ag/v6/quote", { params: { amount: amount.toString() } });
  console.log("/payment/webhook ready");
}
run();
