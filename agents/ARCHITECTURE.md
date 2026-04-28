# Agentia Agents Architecture

This document briefly describes the RAG pipeline, MCP servers, and context injection strategy used by the Meta-Agent.

Overview
- The Meta-Agent (FastAPI server in `agents/main.py`) drives bot generation via `MetaAgent` in `agents/orchestrator.py`.
- The Planner (`agents/planner.py`) produces a `PlannerState` with verification steps which the orchestrator executes via `SolanaMCPClient`.
- RAG contexts: Jupiter docs and Dodo docs are fetched from MCP-compatible doc servers (`JUPITER_DOCS_MCP_URL`, `DODO_DOCS_MCP_URL`).

Context injection
- Keywords are extracted (LLM-based) before performing MCP docs searches to avoid sending large prompts to doc servers.
- Combined injected context (Jupiter + Dodo) is capped by `CONTEXT_INJECTION_MAX_CHARS` to avoid "lost-in-the-middle" syndrome.
- Dodo context is fetched only when payment/metering keywords appear in the prompt.

Security and rules
- Generator system prompt forbids use of `child_process`, `execSync`, and executing local CLIs.
- Jupiter swaps must use the Jupiter V6 HTTP API and send the serialized transactions via the MCP `send_raw_transaction` tool.
- Dodo integration includes webhook handling and metering endpoints exposed by a Dodo MCP server.

MCP servers
- Local MCP servers should expose compatible endpoints under `/mcp/<server>/<tool>` or direct paths like `/solana/get_balance`.
- The orchestrator and planner expect the MCP gateway at `MCP_UPSTREAM_URL` and docs MCPs at `JUPITER_DOCS_MCP_URL` and `DODO_DOCS_MCP_URL`.
