# Agent tests (agents/tests)

This folder contains three phases of tests:

Phase 1 - Mocked RAG unit tests
- `test_orchestrator_rag.py` — pytest tests that validate orchestrator context-fetching for Jupiter and Dodo.
- Run with: `PYTHONPATH=agents pytest agents/tests/test_orchestrator_rag.py`

Phase 2 - TypeScript syntax/compilation verification
- `test_syntax_check.sh` — bash script that POSTs to `/create-bot`, writes the returned `package.json` and `src/index.ts` to a temp dir, runs `npm install` and `npx tsc --noEmit src/index.ts`, and asserts content rules (no `execSync`, no `jupiter-cli`, `axios` present, `quote-api.jup.ag` referenced).
- Run with: `bash agents/tests/test_syntax_check.sh` (ensure Meta-Agent server is running at `http://127.0.0.1:8000` or set `TARGET` env var).

Phase 3 - Semantic LLM-as-Judge
- Placeholder for Promptfoo/LLM evaluation configs and rubric scripts.

Notes
- The syntax check requires `node` and `npm` available on PATH and may take time to install dependencies for generated project.
- CI integration should run Phase 1 tests first, then Phase 2 in an isolated environment.
