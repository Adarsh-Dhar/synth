export type MagicBlockTransferPayload = {
  from: string;
  to: string;
  mint: string;
  amount: string;
};

function baseUrl(): string {
  const v = String(process.env.MAGICBLOCK_PRIVATE_PAYMENTS_BASE_URL || "").trim();
  if (!v) throw new Error("MAGICBLOCK_PRIVATE_PAYMENTS_BASE_URL is required");
  return v.replace(/\/+$/, "");
}

async function post(path: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MagicBlock request failed (${res.status}): ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export function depositSPL(payload: MagicBlockTransferPayload): Promise<unknown> {
  return post("/deposit", payload);
}

export function transferSPL(payload: MagicBlockTransferPayload): Promise<unknown> {
  return post("/transfer", payload);
}

export function withdrawSPL(payload: MagicBlockTransferPayload): Promise<unknown> {
  return post("/withdraw", payload);
}
