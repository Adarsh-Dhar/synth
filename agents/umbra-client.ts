export type UmbraShieldPayload = {
  wallet: string;
  mint: string;
  amount: string;
  network?: string;
};

export type UmbraTransferPayload = {
  sender: string;
  recipient: string;
  mint: string;
  amount: string;
  network?: string;
};

function umbraBaseUrl(): string {
  const v = String(process.env.UMBRA_API_BASE_URL || "").trim();
  if (!v) throw new Error("UMBRA_API_BASE_URL is required");
  return v.replace(/\/+$/, "");
}

async function post(path: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${umbraBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Umbra request failed (${res.status}): ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export function shieldBalance(payload: UmbraShieldPayload): Promise<unknown> {
  return post("/shield", payload);
}

export function unshieldBalance(payload: UmbraShieldPayload): Promise<unknown> {
  return post("/unshield", payload);
}

export function transferAnonymously(payload: UmbraTransferPayload): Promise<unknown> {
  return post("/transfer", payload);
}

export function grantViewingAccess(args: {
  wallet: string;
  viewer: string;
  scope?: string;
}): Promise<unknown> {
  return post("/viewing-key", args);
}
