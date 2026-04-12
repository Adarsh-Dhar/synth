#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');
const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.css', '.html']);
const EXCLUDE_PARTS = ['node_modules', '.git', '.next', 'dist', 'out', 'build', '.pnpm', '.venv'];

function shouldSkip(p) {
  const normalized = p.replace(/\\\\/g, '/');
  for (const ex of EXCLUDE_PARTS) {
    if (normalized.includes('/' + ex + '/')) return true;
    if (normalized.endsWith('/' + ex)) return true;
  }
  return false;
}

function walk(dir, cb) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        if (shouldSkip(full)) continue;
        walk(full, cb);
      } else if (st.isFile()) {
        cb(full, st);
      }
    } catch (e) {
      // ignore
    }
  }
}

const changed = [];
walk(FRONTEND, (filePath, stat) => {
  const ext = path.extname(filePath).toLowerCase();
  if (!EXTS.has(ext)) return;
  if (shouldSkip(filePath)) return;

  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return; }

  let out = text;

  // Replace specific identifier first
  out = out.replace(/\bassembleInitiaBotFiles\b/g, 'assembleSolanaBotFiles');

  // Replace INITIA_ env tokens -> SOLANA_
  out = out.replace(/INITIA_([A-Z0-9_]+)/g, 'SOLANA_$1');

  // Replace capitalized and lowercase forms with word boundaries
  out = out.replace(/\bInitia\b/g, 'Solana');
  out = out.replace(/\binitia\b/g, 'solana');
  out = out.replace(/\bINITIA\b/g, 'SOLANA');

  // Replace network name -> use Solana-devnet naming
  out = out.replace(/initia-testnet/gi, 'solana-devnet');

  if (out !== text) {
    try {
      fs.writeFileSync(filePath, out, 'utf8');
      changed.push(path.relative(ROOT, filePath));
    } catch (e) {
      console.error('Failed to write', filePath, e.message);
    }
  }
});

console.log('Replace run complete. Files modified:');
for (const f of changed) console.log(' - ' + f);
console.log('Total files modified:', changed.length);
process.exit(0);
