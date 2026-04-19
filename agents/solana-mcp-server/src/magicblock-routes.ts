import { Router } from "express";

export function createMagicBlockRouter(baseUrl: string): Router {
  const router = Router();

  async function proxy(path: string, body: Record<string, unknown>) {
    const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text };
  }

  for (const endpoint of ["deposit", "transfer", "withdraw"]) {
    router.post(`/${endpoint}`, async (req, res) => {
      try {
        if (!baseUrl) {
          return res.status(500).json({ ok: false, error: "MAGICBLOCK_PRIVATE_PAYMENTS_BASE_URL missing" });
        }
        const out = await proxy(`/${endpoint}`, req.body || {});
        return res.status(out.status).type("application/json").send(out.text);
      } catch (err) {
        return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  return router;
}
