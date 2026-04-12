#!/usr/bin/env node
/*
 * Sweep non-.env source files and add SOLANA_* fallbacks for INITIA_* env/config references.
 * - Runs recursively from repository root
 * - Skips common build/artifact dirs and any file path containing '/.env'
 * - Operates on .ts/.tsx/.js/.jsx/.py files
 * Usage: node scripts/sweep-initia-to-solana.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".py"]);
const EXCLUDE_PARTS = ["node_modules", ".git", ".next", "dist", "out", "build", ".pnpm", ".venv", "frontend/.next", "worker/dist"];
const MAX_SIZE = 200 * 1024; // skip very large files

const REPLACEMENTS = [
  // Make SOLANA_* canonical (remove INITIA_* fallbacks)
  { re: /process\.env\.INITIA_([A-Z0-9_]+)/g, to: "process.env.SOLANA_$1" },
  { re: /process\.env\.DEFAULT_INITIA_NETWORK/g, to: "process.env.DEFAULT_SOLANA_NETWORK" },
  { re: /\bconfig\.INITIA_([A-Z0-9_]+)/g, to: "config.SOLANA_$1" },
  // Catch direct constant usages like SOLANA_RPC_URL, SOLANA_KEY, etc.
  { re: /\bINITIA_([A-Z0-9_]+)\b/g, to: "SOLANA_$1" },
];

function shouldSkip(filePath) {
  const low = filePath.replace(/\\\\/g, "/");
  if (low.includes("/.env")) return true;
  for (const ex of EXCLUDE_PARTS) if (low.includes("/" + ex + "/") || low.endsWith("/" + ex)) return true;
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
walk(ROOT, (filePath, stat) => {
  if (stat.size > MAX_SIZE) return;
  if (shouldSkip(filePath)) return;
  const ext = path.extname(filePath).toLowerCase();
  if (!EXTS.has(ext)) return;

  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return;
  }

  let out = text;
  for (const { re, to } of REPLACEMENTS) {
    out = out.replace(re, to);
  }

  if (out !== text) {
    try {
      fs.writeFileSync(filePath, out, "utf8");
      changed.push(filePath.replace(ROOT + path.sep, ""));
    } catch (e) {
      console.error("Failed to write:", filePath, e);
    }
  }
});

console.log("Sweep complete. Files modified:");
for (const f of changed) console.log(" - " + f);
console.log(`Total files modified: ${changed.length}`);

if (changed.length === 0) process.exit(0);
process.exit(0);
