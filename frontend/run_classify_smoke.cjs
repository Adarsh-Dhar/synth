const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

function assert(cond, msg) {
  if (!cond) {
    console.error('[FAIL]', msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
}

async function postClassify(prompt) {
  const res = await axios.post(`${BASE_URL}/api/classify-intent`, { prompt }, { timeout: 60000 });
  return res;
}

async function run() {
  console.log('Running classify-intent smoke checks against', BASE_URL);

  // Test 1: Solana prompt
  const SOLANA_PROMPT = process.env.TEST_SOLANA_PROMPT ||
    'Write a Solana Yield Sweeper bot in TypeScript: every 15s read SOL balance for USER_WALLET_ADDRESS and transfer to RECIPIENT_ADDRESS when balance > 0.1 SOL. Chain: Solana. Strategy: yield.';

  console.log('\n[1] Solana intent and MCP selection');
  const r1 = await postClassify(SOLANA_PROMPT);
  assert(r1.status === 200, `/api/classify-intent returned ${r1.status}`);
  const intent1 = (r1.data && r1.data.intent) || {};
  const chain1 = String(intent1.chain || '').toLowerCase();
  const strategy1 = String(intent1.strategy || '').toLowerCase();
  const mcps1 = (Array.isArray(intent1.mcps) ? intent1.mcps : []).map(x => String(x).toLowerCase());
  console.log('  -> chain:', chain1, 'strategy:', strategy1, 'mcps:', mcps1.join(','));
  assert(chain1 === 'solana', 'expected chain=solana');
  assert(strategy1 === 'yield', 'expected strategy=yield');
  assert(mcps1.includes('solana'), 'expected mcp list to include solana');
  console.log('[ok] Solana intent check passed');

  // Test 2: Generic prompt (should prefer Solana after migration)
  console.log('\n[2] Generic prompt should prefer solana');
  const r2 = await postClassify('Build a flash loan arbitrage bot on base');
  assert(r2.status === 200, `/api/classify-intent returned ${r2.status}`);
  const intent2 = (r2.data && r2.data.intent) || {};
  const chain2 = String(intent2.chain || '').toLowerCase();
  console.log('  -> chain:', chain2);
  assert(chain2 === 'solana', 'generic prompt expected chain=solana');
  console.log('[ok] Generic prompt check passed');

  // Test 3: Custom utility (Solana-focused)
  console.log('\n[3] Custom utility prompt prefers solana');
  const r3 = await postClassify('Intent: custom. Strategy: custom. Build a custom utility bot for Solana that polls balances and transfers SOL when thresholds are met.');
  assert(r3.status === 200, `/api/classify-intent returned ${r3.status}`);
  const intent3 = (r3.data && r3.data.intent) || {};
  const chain3 = String(intent3.chain || '').toLowerCase();
  const strategy3 = String(intent3.strategy || '').toLowerCase();
  const mcps3 = (Array.isArray(intent3.mcps) ? intent3.mcps : []).map(x => String(x).toLowerCase());
  console.log('  -> chain:', chain3, 'strategy:', strategy3, 'mcps:', mcps3.join(','));
  assert(chain3 === 'solana', 'custom utility prompt expected chain=solana');
  assert(strategy3 === 'custom_utility', 'expected strategy=custom_utility');
  assert(mcps3.length >= 1 && mcps3.includes('solana'), 'expected mcp list to include solana');
  console.log('[ok] Custom utility check passed');

  // Test 4: a couple cross-chain classification checks
  console.log('\n[4] Cross-chain classification samples');
  const cases = [
    { prompt: 'Build an omni-chain liquidation sniper for Solana that watches unhealthy lending positions and bridges USDC when health factor drops.', strategy: 'cross_chain_liquidation' },
    { prompt: 'Build a flash-bridge spatial arbitrage bot for Solana that bridges between two clusters and sells into the higher price pool.', strategy: 'cross_chain_arbitrage' },
  ];

  for (const c of cases) {
    const res = await postClassify(c.prompt);
    assert(res.status === 200, `/api/classify-intent returned ${res.status}`);
    const intent = (res.data && res.data.intent) || {};
    const chain = String(intent.chain || '').toLowerCase();
    const strat = String(intent.strategy || '').toLowerCase();
    const mcps = (Array.isArray(intent.mcps) ? intent.mcps : []).map(x => String(x).toLowerCase());
    console.log('  -> chain:', chain, 'strategy:', strat, 'mcps:', mcps.join(','));
    assert(chain === 'solana', `expected chain=solana for prompt: ${c.prompt}`);
    assert(strat === c.strategy, `expected strategy=${c.strategy}`);
    assert(mcps.includes('solana'), 'expected mcp list to include solana');
  }
  console.log('[ok] Cross-chain classification passed');

  console.log('\nAll classify-intent smoke checks passed');
}

run().catch(err => {
  console.error('\n[FAIL]', err && err.message ? err.message : err);
  process.exit(1);
});
