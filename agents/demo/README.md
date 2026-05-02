# agents/demo — End-to-End Demo Runner

Generates and executes a real Solana yield sweeper bot using exact on-chain token mints.

## Token addresses (hardcoded, never guessed)
- USDC: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- sUSDe: `G9W2WBKV3nJULX4kz47HCJ75jnVG4RYWZj5q5U5kXfz`
- SOL: `So11111111111111111111111111111111111111112`

## Prerequisites
1. `uvicorn main:app --reload` running in `agents/`
2. `tsx src/index.ts` running in `agents/solana-mcp-server/`
3. `tsx src/index.ts` running in `agents/jupiter-mcp-server/`
4. Worker server running (`pnpm dev` in `worker/`)

## Run demo (simulation mode — safe, no real funds)
```bash
python agents/demo/run_demo.py --simulation
```

## Run demo (live mode — real swaps on local fork)
```bash
python agents/demo/run_demo.py --no-simulation
```

## Generate only (no execution)
```bash
python agents/demo/run_demo.py --dry-run
```

## What happens
1. `prompt_template.py` builds a fully-specified prompt with exact mints injected
2. Meta-Agent LLM generates `package.json` + `src/index.ts`
3. Files are written to `worker/agents/generated/<uuid>/`
4. Worker installs deps and spawns `tsx src/index.ts` in a sandbox
5. Logs stream to stdout via SSE
