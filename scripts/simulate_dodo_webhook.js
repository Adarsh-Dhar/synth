#!/usr/bin/env node
// simulate_dodo_webhook.js
// Usage: DODO_WEBHOOK_SECRET=whsec_... node simulate_dodo_webhook.js <externalReference> [plan]
// Optional metadata can be supplied via USER_ID and WALLET_ADDRESS env vars.

const { createHmac } = require('crypto');
const fetch = global.fetch || require('node-fetch');

async function main() {
  const secret = process.env.DODO_WEBHOOK_SECRET;
  if (!secret) {
    console.error('Set DODO_WEBHOOK_SECRET in env');
    process.exit(1);
  }

  const externalReference = process.argv[2];
  const plan = (process.argv[3] || 'PRO').toUpperCase();
  if (!externalReference) {
    console.error('Usage: DODO_WEBHOOK_SECRET=... node simulate_dodo_webhook.js <externalReference> [plan]');
    process.exit(1);
  }

  const payload = {
    event_type: 'payment.succeeded',
    paymentId: externalReference,
    externalReference,
    plan,
    status: 'paid',
    paymentStatus: 'paid',
    validUntil: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(),
    metadata: {
      planType: plan.toLowerCase(),
      ...(process.env.USER_ID ? { userId: process.env.USER_ID } : {}),
      ...(process.env.WALLET_ADDRESS ? { walletAddress: process.env.WALLET_ADDRESS } : {}),
    },
  };

  const raw = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000).toString();
  const timestamped = `${ts}.${raw}`;
  const sig = createHmac('sha256', secret).update(timestamped).digest('hex');

  const url = process.env.WEBHOOK_URL || 'http://localhost:5000/api/internal/dodo-payments';

  console.log('Posting simulated webhook to', url);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}`,
      'x-dodo-timestamp': ts,
      'x-dodo-signature': sig,
    },
    body: raw,
  });

  console.log('Status:', res.status);
  const body = await res.text();
  console.log('Response:', body);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
