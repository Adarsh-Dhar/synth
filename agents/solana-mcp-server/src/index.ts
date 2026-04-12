import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env') });

const app = express();
app.use(express.json());
app.use(cors());

const PORT = Number(process.env.PORT ?? 8001);
const HOST = process.env.HOST ?? '127.0.0.1';
const RPC_URL = String(
  process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com'
).trim();

const connection = new Connection(RPC_URL, { commitment: 'confirmed' });

// ── Optional server keypair for send_raw_transaction ─────────────────────────
let serverKeypair: Keypair | null = null;
const keypairPath = String(process.env.SOLANA_KEYPAIR_PATH ?? '').trim();
if (keypairPath && fs.existsSync(keypairPath)) {
  try {
    const raw = JSON.parse(fs.readFileSync(keypairPath, 'utf8'));
    serverKeypair = Keypair.fromSecretKey(Uint8Array.from(Array.isArray(raw) ? raw : raw.result ?? raw));
    log('INFO', `Loaded keypair from ${keypairPath}`);
  } catch (e) {
    log('WARN', 'Failed to load keypair', e instanceof Error ? e.message : String(e));
  }
}

function log(level: string, msg: string, data?: unknown): void {
  const ts = new Date().toISOString();
  const extra = data ? ' ' + JSON.stringify(data).slice(0, 400) : '';
  console.log(`[${ts}] [MCP-${level}] ${msg}${extra}`);
}

function errorResponse(res: express.Response, status: number, msg: string) {
  return res.status(status).json({
    ok: false,
    result: { isError: true, content: [{ text: msg }] },
  });
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', rpc: RPC_URL, timestamp: new Date().toISOString() });
});

// ── GET SOL BALANCE ───────────────────────────────────────────────────────────
app.post('/solana/get_balance', async (req, res) => {
  try {
    const address = String(req.body.address ?? req.body.owner ?? '').trim();
    if (!address) return errorResponse(res, 400, 'address required');

    const lamports = await connection.getBalance(new PublicKey(address), 'confirmed');
    const sol = lamports / LAMPORTS_PER_SOL;
    log('INFO', 'get_balance', { address, lamports, sol });
    return res.json({ ok: true, address, lamports, balance: sol.toString() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('ERROR', 'get_balance failed', msg);
    return errorResponse(res, 500, `get_balance error: ${msg}`);
  }
});

// ── GET SPL TOKEN BALANCE ─────────────────────────────────────────────────────
app.post('/solana/get_token_balance', async (req, res) => {
  try {
    const owner = String(req.body.owner ?? req.body.address ?? '').trim();
    const mint  = String(req.body.mint ?? req.body.token ?? '').trim();
    if (!owner || !mint) return errorResponse(res, 400, 'owner and mint required');

    const accounts = await connection.getTokenAccountsByOwner(
      new PublicKey(owner),
      { mint: new PublicKey(mint) },
      'confirmed',
    );

    let totalRaw = BigInt(0);
    let decimals = 0;
    for (const acc of accounts.value) {
      const bal = await connection.getTokenAccountBalance(acc.pubkey, 'confirmed');
      totalRaw += BigInt(bal.value.amount);
      decimals = bal.value.decimals;
    }

    log('INFO', 'get_token_balance', { owner, mint, amount: totalRaw.toString(), decimals });
    return res.json({
      ok: true,
      owner,
      mint,
      amount: totalRaw.toString(),
      decimals,
      balance: (Number(totalRaw) / Math.pow(10, decimals)).toString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('ERROR', 'get_token_balance failed', msg);
    return errorResponse(res, 500, `get_token_balance error: ${msg}`);
  }
});

// ── GET ACCOUNT INFO ──────────────────────────────────────────────────────────
app.post('/solana/get_account_info', async (req, res) => {
  try {
    const address = String(req.body.address ?? '').trim();
    if (!address) return errorResponse(res, 400, 'address required');

    const info = await connection.getAccountInfo(new PublicKey(address), 'confirmed');
    log('INFO', 'get_account_info', { address, exists: info !== null });
    return res.json({
      ok: true,
      address,
      exists: info !== null,
      lamports: info?.lamports ?? 0,
      owner: info?.owner?.toString() ?? null,
      executable: info?.executable ?? false,
      data_length: info?.data.length ?? 0,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('ERROR', 'get_account_info failed', msg);
    return errorResponse(res, 500, `get_account_info error: ${msg}`);
  }
});

// ── SEND RAW TRANSACTION ──────────────────────────────────────────────────────
app.post('/solana/send_raw_transaction', async (req, res) => {
  try {
    const raw = String(req.body.raw ?? req.body.transaction ?? req.body.raw_tx ?? '').trim();
    if (!raw) return errorResponse(res, 400, 'raw transaction (base64) required');

    if (!serverKeypair) {
      // Simulation mode — no keypair loaded
      log('WARN', 'send_raw_transaction: no keypair, returning simulated sig');
      return res.json({
        ok: true,
        simulated: true,
        signature: `sim_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`,
      });
    }

    const bytes = Buffer.from(raw, 'base64');
    const sig   = await connection.sendRawTransaction(bytes, { skipPreflight: false });
    await connection.confirmTransaction(sig, 'confirmed');
    log('INFO', 'send_raw_transaction confirmed', { sig });
    return res.json({ ok: true, simulated: false, signature: sig });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('ERROR', 'send_raw_transaction failed', msg);
    return errorResponse(res, 500, `send_raw_transaction error: ${msg}`);
  }
});

// ── RESOLVE SNS DOMAIN ────────────────────────────────────────────────────────
// Returns a simulated address for devnet; wire up @bonfida/spl-name-service for mainnet.
app.post('/solana/resolve_sns', async (req, res) => {
  try {
    const name = String(req.body.name ?? '').trim().toLowerCase();
    if (!name) return errorResponse(res, 400, 'name required (e.g. "alice.sol")');

    // Simulated resolution — replace with real Bonfida lookup on mainnet
    const simulated = `SNS_${name.replace(/[^a-z0-9]/g, '_').toUpperCase()}`;
    log('INFO', 'resolve_sns (simulated)', { name, simulated });
    return res.json({ ok: true, name, address: simulated, resolved: true, simulated: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('ERROR', 'resolve_sns failed', msg);
    return errorResponse(res, 500, `resolve_sns error: ${msg}`);
  }
});

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Not found: ${req.method} ${req.path}` });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  log('INFO', `Solana MCP Server → http://${HOST}:${PORT}`);
  log('INFO', `RPC: ${RPC_URL}`);
  log('INFO', 'Routes: /health /solana/get_balance /solana/get_token_balance /solana/get_account_info /solana/send_raw_transaction /solana/resolve_sns');
});