#!/usr/bin/env bash
set -euo pipefail

TARGET=${TARGET:-http://127.0.0.1:8000}
TIMESTAMP=$(date +%s)
TMPDIR="/tmp/bot-test-${TIMESTAMP}"
mkdir -p "$TMPDIR/src"

PROMPT='Create a production-ready TypeScript arbitrage bot. Use axios for Jupiter HTTP API (quote-api.jup.ag/v6) with quote then swap flow, and MCP send_raw_transaction for execution.'

echo "[syntax-check] creating bot from: $TARGET/create-bot"
RESP=$(curl -sS -X POST "$TARGET/create-bot" -H "Content-Type: application/json" -d "{\"prompt\": \"${PROMPT}\"}")

# Extract files from possible shapes: .output.files or .files
FILES_JSON=$(echo "$RESP" | jq -c '(.output.files // .files) // []')
if [ "$FILES_JSON" = "[]" ]; then
  echo "[syntax-check] no files returned by create-bot endpoint"
  echo "$RESP" | jq .
  exit 2
fi

# Write files to tmp dir
echo "$FILES_JSON" | jq -r '.[] | "---FILEDELIM---\n" + .filepath + "\n" + .content' | awk '/^---FILEDELIM---$/{if (f) close(f); getline; f=$0; next} {print > ("'"$TMPDIR"'" "/" f)}'

ls -la "$TMPDIR"

# Ensure TypeScript target supports BigInt when generated code includes bridge helpers
cat > "$TMPDIR/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": false,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
JSON

# Ensure package.json exists
if [ ! -f "$TMPDIR/package.json" ]; then
  echo "[syntax-check] package.json not found in generated files"
  exit 3
fi

# Run npm install
echo "[syntax-check] running npm install in $TMPDIR (this may take a while)"
( cd "$TMPDIR" && npm install --no-audit --no-fund )

# Run TypeScript check
echo "[syntax-check] running npx tsc --noEmit -p tsconfig.json"
( cd "$TMPDIR" && npx -y tsc --noEmit -p tsconfig.json )

# Content assertions
SRC_FILE="$TMPDIR/src/index.ts"
if ! grep -q "execSync" "$SRC_FILE" 2>/dev/null; then
  echo "[assert] execSync not present - OK"
else
  echo "[assert] execSync found - FAIL"
  exit 4
fi

if ! grep -q "jupiter-cli" "$SRC_FILE" 2>/dev/null; then
  echo "[assert] jupiter-cli not present - OK"
else
  echo "[assert] jupiter-cli found - FAIL"
  exit 5
fi

if grep -q "axios" "$SRC_FILE" 2>/dev/null; then
  echo "[assert] axios import present - OK"
else
  echo "[assert] axios import missing - FAIL"
  exit 6
fi

if grep -q "quote-api.jup.ag" "$SRC_FILE" 2>/dev/null; then
  echo "[assert] quote-api.jup.ag referenced - OK"
else
  echo "[assert] quote-api.jup.ag not referenced - FAIL"
  exit 7
fi

echo "[syntax-check] all assertions passed"
exit 0
