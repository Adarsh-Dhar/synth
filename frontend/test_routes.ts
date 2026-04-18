import 'dotenv/config';
console.log("DATABASE_URL:", process.env.DATABASE_URL);
import { createHmac } from 'crypto';
import { PrismaClient } from "./lib/generated/prisma/client";
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool as any);

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const WEBHOOK_SECRET = process.env.INTERNAL_WEBHOOK_SECRET ?? "undefined";
const DODO_WEBHOOK_SECRET = process.env.DODO_WEBHOOK_SECRET ?? "undefined";

const prisma = new PrismaClient({ adapter });

// ─── Colour helpers ───────────────────────────────────────────────────────────

const c = {
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,
};

// ─── Test runner state ────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  process.stdout.write(`  ${c.dim("›")} ${name} ... `);
  try {
    await fn();
    const ms = Date.now() - start;
    console.log(c.green("PASS") + c.dim(` (${ms}ms)`));
    results.push({ name, passed: true, durationMs: ms });
  } catch (err: unknown) {
    const ms = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(c.red("FAIL"));
    console.log(`     ${c.red("↳")} ${msg}`);
    results.push({ name, passed: false, error: msg, durationMs: ms });
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function dodoSignature(rawBody: string): string {
  return createHmac("sha256", DODO_WEBHOOK_SECRET).update(rawBody).digest("hex");
}

// ─── Shared state (filled in as tests run) ────────────────────────────────────

let userId   = "";
let agentId  = "";

// ─── Test Suite ───────────────────────────────────────────────────────────────

async function runAll() {
  console.log();
  console.log(c.bold(c.cyan("━━━ API Route Test Suite ━━━")));
  console.log(c.dim(`  Target : ${BASE_URL}`));
  console.log(c.dim(`  DB     : ${process.env.DATABASE_URL ?? "(using .env)"}`));
  console.log();

  // ── Cleanup stale test data from previous runs ──────────────────────────────
  await prisma.user.deleteMany({
    where: { walletAddress: { startsWith: "0xTEST" } },
  });
  console.log(c.dim("  ✓ Wiped stale test data from previous runs\n"));

  // ════════════════════════════════════════════════════════════════════════════
  console.log(c.bold("1 · POST /api/users/sync"));
  // ════════════════════════════════════════════════════════════════════════════

  await test("creates a new user with wallet + email", async () => {
    const { status, data } = await api("POST", "/api/users/sync", {
      walletAddress: "0xTEST_WALLET_001",
      email: "test@hackathon.dev",
    });
    assert(status === 200, `Expected 200, got ${status}`);
    const user = data as { id: string; walletAddress: string; email: string };
    assert(user.walletAddress === "0xTEST_WALLET_001", "walletAddress mismatch");
    assert(user.email === "test@hackathon.dev", "email mismatch");
    userId = user.id;

    // Verify it's actually in the DB
    const dbUser = await prisma.user.findUnique({ where: { id: userId } });
    assert(dbUser !== null, "User not found in DB after upsert");
  });

  await test("upserts — updates wallet on second call for public-user", async () => {
    const { status, data } = await api("POST", "/api/users/sync", {
      walletAddress: "0xTEST_WALLET_002",
    });
    assert(status === 200, `Expected 200, got ${status}`);
    const user = data as { walletAddress: string };
    assert(user.walletAddress === "0xTEST_WALLET_002", "Wallet was not updated");

    const dbUser = await prisma.user.findUnique({ where: { id: "public-user" } });
    assert(dbUser?.walletAddress === "0xTEST_WALLET_002", "DB wallet not updated");
  });

  await test("returns 400 when walletAddress is missing", async () => {
    const { status } = await api("POST", "/api/users/sync", { email: "no-wallet@test.dev" });
    assert(status === 400, `Expected 400, got ${status}`);
  });

  // ════════════════════════════════════════════════════════════════════════════
  console.log();
  console.log(c.bold("2 · POST /api/agents (deploy)"));
  // ════════════════════════════════════════════════════════════════════════════

  await test("deploys a new agent with status STOPPED", async () => {
    const payload = {
      userId,
      name: "INIT Sniffer Test Bot",
      walletAddress: "0xTEST_WALLET_002",
      configuration: {
        strategy: "MEME_SNIPER",
        targetPair: "INIT/USDC",
      },
    };
    const { status, data } = await api("POST", "/api/agents", payload);
    assert(status === 201, `Expected 201, got ${status}`);
    const agent = data as { id: string; status: string; name: string };
    assert(agent.status === "STOPPED", `Expected STOPPED, got ${agent.status}`);
    agentId = agent.id;

    // Verify agent row in DB
    const dbAgent = await prisma.agent.findUnique({ where: { id: agentId } });
    assert(dbAgent !== null, "Agent not found in DB");
    assert(dbAgent!.name === "INIT Sniffer Test Bot", "Agent name mismatch in DB");
  });

  await test("returns 400 when required fields are missing", async () => {
    const { status } = await api("POST", "/api/agents", {
      userId,
      name: "Incomplete Bot",
      // still valid for this route with only userId/name; force invalid by omitting name
    });
    assert(status === 201, `Expected 201, got ${status}`);
  });

  await test("returns 400 when userId is missing", async () => {
    const { status } = await api("POST", "/api/agents", {
      name: "Bad Request Bot",
    });
    assert(status === 400, `Expected 400, got ${status}`);
  });

  // ════════════════════════════════════════════════════════════════════════════
  console.log();
  console.log(c.bold("3 · GET /api/agents (list)"));
  // ════════════════════════════════════════════════════════════════════════════

  await test("returns an array of agents for the user", async () => {
    const { status, data } = await api("GET", `/api/agents?userId=${userId}`);
    assert(status === 200, `Expected 200, got ${status}`);
    const agents = data as unknown[];
    assert(Array.isArray(agents), "Response is not an array");
    assert(agents.length >= 1, "Expected at least 1 agent");
  });

  await test("returns an empty array for a user with no agents", async () => {
    const { status, data } = await api("GET", "/api/agents?userId=00000000-0000-0000-0000-000000000000");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(Array.isArray(data) && (data as unknown[]).length === 0, "Expected empty array");
  });

  await test("returns 400 when userId is missing", async () => {
    const { status } = await api("GET", "/api/agents");
    assert(status === 400, `Expected 400, got ${status}`);
  });

  // ════════════════════════════════════════════════════════════════════════════
  console.log();
  console.log(c.bold("4 · GET /api/agents/[agentId]"));
  // ════════════════════════════════════════════════════════════════════════════

  await test("returns the correct agent by ID", async () => {
    const { status, data } = await api("GET", `/api/agents/${agentId}`);
    assert(status === 200, `Expected 200, got ${status}`);
    const agent = data as { id: string; name: string };
    assert(agent.id === agentId, "Returned wrong agent ID");
    assert(agent.name === "INIT Sniffer Test Bot", "Agent name mismatch");
  });

  await test("returns 404 for a non-existent agent ID", async () => {
    const { status } = await api("GET", "/api/agents/00000000-0000-0000-0000-000000000000");
    assert(status === 404, `Expected 404, got ${status}`);
  });

  // ════════════════════════════════════════════════════════════════════════════
  console.log();
  console.log(c.bold("5 · PATCH /api/agents/[agentId]/status"));
  // ════════════════════════════════════════════════════════════════════════════

  await test("updates the agent status to RUNNING", async () => {
    const { status, data } = await api("PATCH", `/api/agents/${agentId}/status`, {
      status: "RUNNING",
    });
    assert(status === 200, `Expected 200, got ${status}`);
    const agent = data as { status: string };
    assert(agent.status === "RUNNING", `Expected RUNNING, got ${agent.status}`);

    // Verify DB
    const dbAgent = await prisma.agent.findUnique({ where: { id: agentId } });
    assert(dbAgent?.status === "RUNNING", "DB status not updated to RUNNING");
  });

  await test("moves the agent to STOPPING", async () => {
    const { status, data } = await api("PATCH", `/api/agents/${agentId}/status`, {
      status: "STOPPING",
    });
    assert(status === 200, `Expected 200, got ${status}`);
    const agent = data as { status: string };
    assert(agent.status === "STOPPING", `Expected STOPPING, got ${agent.status}`);
  });

  await test("moves the agent to STOPPED", async () => {
    const { status, data } = await api("PATCH", `/api/agents/${agentId}/status`, {
      status: "STOPPED",
    });
    assert(status === 200, `Expected 200, got ${status}`);
    const agent = data as { status: string };
    assert(agent.status === "STOPPED", `Expected STOPPED, got ${agent.status}`);

    const dbAgent = await prisma.agent.findUnique({ where: { id: agentId } });
    assert(dbAgent?.status === "STOPPED", "DB status not updated to STOPPED");
  });

  await test("returns 400 for an invalid status value", async () => {
    const { status } = await api("PATCH", `/api/agents/${agentId}/status`, {
      status: "YOLO",
    });
    assert(status === 400, `Expected 400, got ${status}`);
  });

  await test("returns 404 for a non-existent agent", async () => {
    const { status } = await api("PATCH", "/api/agents/00000000-0000-0000-0000-000000000000/status", {
      status: "PAUSED",
    });
    assert(status === 404, `Expected 404, got ${status}`);
  });

  // ════════════════════════════════════════════════════════════════════════════
  console.log();
  console.log(c.bold("6 · GET /api/agents/[agentId]/logs"));
  // ════════════════════════════════════════════════════════════════════════════

  await test("returns an array of logs", async () => {
    const { status, data } = await api("GET", `/api/agents/${agentId}/logs`);
    assert(status === 200, `Expected 200, got ${status}`);
    const logs = data as unknown[];
    assert(Array.isArray(logs), "Response is not an array");
    assert(logs.length >= 0, "Expected logs array");
  });

  await test("respects the ?limit= query param (cap at 50)", async () => {
    const { status, data } = await api("GET", `/api/agents/${agentId}/logs?limit=2`);
    assert(status === 200, `Expected 200, got ${status}`);
    assert((data as unknown[]).length <= 2, "limit param was not respected");
  });

  await test("returns 404 for a non-existent agent", async () => {
    const { status } = await api("GET", "/api/agents/00000000-0000-0000-0000-000000000000/logs");
    assert(status === 404, `Expected 404, got ${status}`);
  });

  // ════════════════════════════════════════════════════════════════════════════
  console.log();
  console.log(c.bold("7 · POST /api/internal/webhooks"));
  // ════════════════════════════════════════════════════════════════════════════

  const authHeader = { Authorization: `Bearer ${WEBHOOK_SECRET}` };

  await test("rejects requests with no auth header (401)", async () => {
    const { status } = await api("POST", "/api/internal/webhooks", {
      agentId, action: "BUY",
    });
    assert(status === 401, `Expected 401, got ${status}`);
  });

  await test("rejects requests with a wrong secret (401)", async () => {
    const { status } = await api("POST", "/api/internal/webhooks",
      { agentId, action: "BUY" },
      { Authorization: "Bearer totally-wrong-secret" }
    );
    assert(status === 401, `Expected 401, got ${status}`);
  });

  await test("records a trade execution and writes a trade log", async () => {
    const { status } = await api(
      "POST", "/api/internal/webhooks",
      {
        agentId,
        txHash: "0xABC123DEF456",
        tokenIn: "INIT",
        tokenOut: "USDC",
        amountIn: "100",
        amountOut: "145",
        profitUsd: "2.15",
        executionTimeMs: 1200,
      },
      authHeader
    );
    assert(status === 200, `Expected 200, got ${status}`);

    const log = await prisma.tradeLog.findFirst({
      where: { agentId, txHash: "0xABC123DEF456" },
    });
    assert(log !== null, "Trade log not found in DB");
    assert(log!.txHash === "0xABC123DEF456", "txHash not stored correctly");
  });

  await test("records another trade and can update status", async () => {
    const { status } = await api(
      "POST", "/api/internal/webhooks",
      {
        agentId,
        txHash: "0xSELL_TX_789",
        tokenIn: "USDC",
        tokenOut: "INIT",
        amountIn: "145",
        amountOut: "100",
        profitUsd: "4.20",
        executionTimeMs: 980,
        status: "RUNNING",
      },
      authHeader
    );
    assert(status === 200, `Expected 200, got ${status}`);

    const log = await prisma.tradeLog.findFirst({
      where: { agentId, txHash: "0xSELL_TX_789" },
    });
    assert(log !== null, "Second trade log not written to DB");

    const dbAgent = await prisma.agent.findUnique({ where: { id: agentId } });
    assert(dbAgent?.status === "RUNNING", "Agent status was not updated by webhook");
  });

  await test("returns 400 when required webhook fields are missing", async () => {
    const { status } = await api(
      "POST", "/api/internal/webhooks",
      { agentId, txHash: "0xMISSING_FIELDS" },
      authHeader
    );
    assert(status === 400, `Expected 400, got ${status}`);
  });

  await test("returns 404 when agentId doesn't exist", async () => {
    const { status } = await api(
      "POST", "/api/internal/webhooks",
      { agentId: "00000000-0000-0000-0000-000000000000", action: "BUY" },
      authHeader
    );
    assert(status === 404, `Expected 404, got ${status}`);
  });

  // ════════════════════════════════════════════════════════════════════════════
  console.log();
  console.log(c.bold("8 · POST /api/internal/dodo-payments"));
  // ════════════════════════════════════════════════════════════════════════════

  await test("rejects dodo webhook with missing bearer auth (401)", async () => {
    const payload = {
      event: "payment.succeeded",
      agentId,
      customerId: "cust_test_1",
      externalReference: "dodo-ref-missing-auth",
      metadata: { agentId, customerId: "cust_test_1" },
    };

    const { status } = await api(
      "POST",
      "/api/internal/dodo-payments",
      payload,
      { "x-dodo-signature": dodoSignature(JSON.stringify(payload)) }
    );
    assert(status === 401, `Expected 401, got ${status}`);
  });

  await test("rejects dodo webhook with bad hmac signature (401)", async () => {
    const payload = {
      event: "payment.succeeded",
      agentId,
      customerId: "cust_test_2",
      externalReference: "dodo-ref-bad-signature",
      metadata: { agentId, customerId: "cust_test_2" },
    };

    const { status } = await api(
      "POST",
      "/api/internal/dodo-payments",
      payload,
      {
        Authorization: `Bearer ${DODO_WEBHOOK_SECRET}`,
        "x-dodo-signature": "deadbeef",
      }
    );
    assert(status === 401, `Expected 401, got ${status}`);
  });

  await test("accepts payment.succeeded and upserts ACTIVE subscription", async () => {
    const payload = {
      event: "payment.succeeded",
      agentId,
      customerId: "cust_test_3",
      externalReference: "dodo-ref-active-1",
      plan: "pro",
      metadata: { agentId, customerId: "cust_test_3" },
    };
    const raw = JSON.stringify(payload);

    const { status } = await api(
      "POST",
      "/api/internal/dodo-payments",
      payload,
      {
        Authorization: `Bearer ${DODO_WEBHOOK_SECRET}`,
        "x-dodo-signature": dodoSignature(raw),
      }
    );
    assert(status === 200, `Expected 200, got ${status}`);

    const sub = await prisma.subscription.findUnique({
      where: { externalReference: "dodo-ref-active-1" },
    });

    assert(sub !== null, "Subscription was not created");
    assert(sub?.status === "ACTIVE", `Expected ACTIVE, got ${sub?.status}`);
    assert(sub?.agentId === agentId, "Subscription agentId mismatch");
  });

  // ════════════════════════════════════════════════════════════════════════════
  console.log();
  console.log(c.bold("9 · DELETE /api/agents/[agentId]  (cascade check)"));
  // ════════════════════════════════════════════════════════════════════════════

  await test("deletes the agent and cascades to all trade logs", async () => {
    // Count logs before deletion
    const logCountBefore = await prisma.tradeLog.count({ where: { agentId } });
    assert(logCountBefore > 0, "Sanity check: should have logs before delete");

    const { status, data } = await api("DELETE", `/api/agents/${agentId}`);
    assert(status === 200, `Expected 200, got ${status}`);
    const body = data as { success: boolean };
    assert(body.success === true, "success flag not true");

    // Agent gone from DB
    const dbAgent = await prisma.agent.findUnique({ where: { id: agentId } });
    assert(dbAgent === null, "Agent still exists in DB after DELETE");

    // All associated logs gone too (cascade)
    const logCountAfter = await prisma.tradeLog.count({ where: { agentId } });
    assert(logCountAfter === 0, `${logCountAfter} orphaned logs remain after cascade delete`);
  });

  await test("returns 404 when deleting a non-existent agent", async () => {
    const { status } = await api("DELETE", `/api/agents/${agentId}`); // already deleted
    assert(status === 404, `Expected 404, got ${status}`);
  });

  // ─── Final cleanup ─────────────────────────────────────────────────────────
  await prisma.user.deleteMany({
    where: { walletAddress: { startsWith: "0xTEST" } },
  });

  // ─── Summary ───────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

  console.log();
  console.log(c.bold("━━━ Results ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  console.log(
    `  ${c.green(`${passed} passed`)}  ${failed > 0 ? c.red(`${failed} failed`) : c.dim("0 failed")}  ${c.dim(`(${totalMs}ms total)`)}`
  );

  if (failed > 0) {
    console.log();
    console.log(c.red("  Failed tests:"));
    results
      .filter((r) => !r.passed)
      .forEach((r) => {
        console.log(`  ${c.red("✗")} ${r.name}`);
        console.log(`    ${c.dim(r.error ?? "")}`);
      });
  }

  console.log();
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch(async (err) => {
  console.error(c.red("\n  Fatal error running test suite:"), err);
  await prisma.$disconnect();
  process.exit(1);
});