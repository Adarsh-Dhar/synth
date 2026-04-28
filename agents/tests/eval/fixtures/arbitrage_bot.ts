import "dotenv/config";
import axios from "axios";

const amount = BigInt(process.env.TRADE_AMOUNT_LAMPORTS ?? "0");
async function run() {
  const quote = await axios.get("https://quote-api.jup.ag/v6/quote", { params: { amount: amount.toString() } });
  console.log(quote.data);
}
run();
