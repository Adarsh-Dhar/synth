/**
 * frontend/lib/signing-relay-db.ts
 *
 * Simple file-backed signing request store for local/dev use. Exposes the
 * same API as `signing-relay-store` but persists requests to
 * `.data/signing-requests.json`. This is intentionally lightweight and is
 * used as a durable fallback until a DB-backed (Prisma) implementation is
 * added.
 */

import fs from "fs/promises";
import path from "path";
import type { SigningRequest, SigningResult } from "./signing-relay-store";

const DATA_DIR = process.env.SIGNING_RELAY_DATA_DIR || path.join(process.cwd(), ".data");
const FILE_PATH = path.join(DATA_DIR, "signing-requests.json");

async function ensureFile() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.access(FILE_PATH);
  } catch {
    await fs.writeFile(FILE_PATH, JSON.stringify({}), "utf8");
  }
}

async function readAll(): Promise<Record<string, SigningRequest>> {
  try {
    await ensureFile();
    const txt = await fs.readFile(FILE_PATH, "utf8");
    if (!txt) return {};
    return JSON.parse(txt) as Record<string, SigningRequest>;
  } catch {
    return {};
  }
}

async function writeAll(obj: Record<string, SigningRequest>) {
  const tmp = FILE_PATH + ".tmp";
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await fs.rename(tmp, FILE_PATH);
}

export async function addRequest(
  id: string,
  params: Omit<SigningRequest, "id" | "createdAt" | "status">,
): Promise<SigningRequest> {
  const store = await readAll();
  const request: SigningRequest = { id, createdAt: Date.now(), status: "pending", ...params };
  store[id] = request;
  await writeAll(store);
  return request;
}

export async function getPending(): Promise<SigningRequest[]> {
  const store = await readAll();
  const now = Date.now();
  const TTL = 60_000;

  // Cleanup/mark timeouts similar to in-memory store
  for (const [key, req] of Object.entries(store)) {
    if (now - req.createdAt > TTL * 2) {
      delete store[key];
      continue;
    }
    if (now - req.createdAt > TTL && req.status === "pending") {
      store[key] = { ...req, status: "timeout" };
    }
  }

  await writeAll(store);
  return Object.values(store).filter((r) => r.status === "pending");
}

export async function getRequest(id: string): Promise<SigningRequest | undefined> {
  const store = await readAll();
  return store[id];
}

export async function resolveRequest(id: string, result: SigningResult): Promise<boolean> {
  const store = await readAll();
  const request = store[id];
  if (!request || request.status !== "pending") return false;
  store[id] = { ...request, status: result.error ? "failed" : "signed", result };
  await writeAll(store);
  return true;
}

export default {
  addRequest,
  getPending,
  getRequest,
  resolveRequest,
};
