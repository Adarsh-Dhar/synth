import { WebhookPayload } from "./types.js";

const SECRET = process.env.INTERNAL_WEBHOOK_SECRET ?? "dev-secret";
console.log("Sending with secret:", SECRET);
const NEXT_APP_URL = process.env.NEXT_APP_URL ?? "http://localhost:3000";
const WEBHOOK_URL = `${NEXT_APP_URL}/api/internal/webhooks`;

/**
 * Notifies the Next.js frontend about a completed trade.
 * The frontend uses this to update PnL, TradeLog, and agent status.
 */
export async function notifyWebhook(payload: WebhookPayload): Promise<void> {
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `❌ Webhook rejected [${response.status}]: ${errorText}`
      );
      return;
    }

    console.log(
      `✅ Webhook delivered for agent ${payload.agentId} — ${payload.action} @ $${payload.price.toFixed(4)}`
    );
  } catch (error) {
    console.error("❌ Failed to send webhook:", error);
  }
}