/**
 * frontend/lib/signing-relay-store.ts
 *
 * In-memory store for bot -> browser signing requests.
 */

export interface SigningResult {
  txHash?: string;
  error?: string;
}

export interface SigningRequest {
  id: string;
  createdAt: number;
  status: "pending" | "signed" | "failed" | "timeout";
  network: string;
  // Move-style fields (legacy)
  moduleAddress?: string;
  moduleName?: string;
  functionName?: string;
  typeArgs?: string[];
  args?: string[];
  // Solana-style fields
  programId?: string;
  instructionData?: string; // base64 or hex
  accounts?: Array<Record<string, unknown>>;
  rawTx?: string;
  result?: SigningResult;
}

const REQUEST_TTL_MS = 60_000;
const store = new Map<string, SigningRequest>();

function cleanup() {
  const now = Date.now();
  for (const [id, request] of store) {
    if (now - request.createdAt <= REQUEST_TTL_MS) continue;
    if (request.status === "pending") {
      store.set(id, { ...request, status: "timeout" });
      continue;
    }
    if (now - request.createdAt > REQUEST_TTL_MS * 2) {
      store.delete(id);
    }
  }
}

export function addRequest(
  id: string,
  params: Omit<SigningRequest, "id" | "createdAt" | "status">
): SigningRequest {
  cleanup();
  const request: SigningRequest = { id, createdAt: Date.now(), status: "pending", ...params };
  store.set(id, request);
  return request;
}

export function getPending(): SigningRequest[] {
  cleanup();
  return [...store.values()].filter((request) => request.status === "pending");
}

export function getRequest(id: string): SigningRequest | undefined {
  cleanup();
  return store.get(id);
}

export function resolveRequest(id: string, result: SigningResult): boolean {
  const request = store.get(id);
  if (!request || request.status !== "pending") return false;
  store.set(id, { ...request, status: result.error ? "failed" : "signed", result });
  return true;
}
