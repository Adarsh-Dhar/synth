# Agentia Agents Architecture

This document briefly describes the RAG pipeline, MCP servers, and context injection strategy used by the Meta-Agent.

Overview
- The Meta-Agent (FastAPI server in `agents/main.py`) drives bot generation via `MetaAgent` in `agents/orchestrator.py`.
- The Planner (`agents/planner.py`) produces a `PlannerState` with verification steps which the orchestrator executes via `SolanaMCPClient`.
- RAG contexts: Jupiter docs are fetched from the MCP-compatible doc server (`JUPITER_DOCS_MCP_URL`).

Context injection
- Keywords are extracted (LLM-based) before performing MCP docs searches to avoid sending large prompts to doc servers.
- Combined injected context is capped by `CONTEXT_INJECTION_MAX_CHARS` to avoid "lost-in-the-middle" syndrome.

Security and rules
- Generator system prompt forbids use of `child_process`, `execSync`, and executing local CLIs.
- Jupiter swaps must use the Jupiter V6 HTTP API and send the serialized transactions via the MCP `send_raw_transaction` tool.
- Generated bots should model payment-specific flows as generic utility code.

MCP servers
- Local MCP servers should expose compatible endpoints under `/mcp/<server>/<tool>` or direct paths like `/solana/get_balance`.
- The orchestrator and planner expect the MCP gateway at `MCP_UPSTREAM_URL` and the Jupiter docs MCP at `JUPITER_DOCS_MCP_URL`.
