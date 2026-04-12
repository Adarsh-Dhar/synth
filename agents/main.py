"""
main.py — Meta-Agent API server (Solana-native).
Start: uvicorn main:app --reload
"""

import os
import json
import asyncio
import time
import traceback
from uuid import uuid4
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from orchestrator import MetaAgent

app = FastAPI(title="Agentia Solana Bot Meta-Agent", version="4.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

agent = MetaAgent()

CREATE_BOT_TIMEOUT = float(os.environ.get("META_AGENT_CREATE_BOT_TIMEOUT_SECONDS", "240"))


# ─── Models ───────────────────────────────────────────────────────────────────

class PromptRequest(BaseModel):
    prompt: str


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: List[ChatMessage]
    request_id: Optional[str] = None


class ChatResponse(BaseModel):
    status: str                              # "clarification_needed" | "ready" | "error"
    question: Optional[str]   = None
    agent_id: Optional[str]   = None
    bot_name: Optional[str]   = None
    files: Optional[List[Dict[str, Any]]] = None
    intent: Optional[Dict[str, Any]]      = None
    thoughts: Optional[str]   = None
    message: Optional[str]    = None


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _ok(payload: dict) -> dict:
    return {
        "result": {
            "isError": False,
            "content": [{"type": "text", "text": json.dumps(payload)}],
        }
    }


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "version": "4.0.0"}


@app.get("/mcp/health")
async def mcp_health():
    return {"status": "ok", "service": "solana-mcp-compat"}


@app.post("/mcp/{server}/{tool}")
async def mcp_tool(server: str, tool: str, body: dict, request: Request):
    """
    HTTP MCP compatibility shim.
    Real on-chain calls go to the solana-mcp-server on port 8001.
    This endpoint handles local testing and simulation.
    """
    s = server.strip().lower()
    t = tool.strip().lower()

    # ── Risk / security providers ──────────────────────────────────────────────
    if s in {"webacy", "goplus"} and t in {"getrisk", "get_token_risk", "token_risk"}:
        return _ok({
            "address": str(body.get("address", "")),
            "chain": "solana",
            "risk": "medium", "riskScore": 35,
            "available": True, "source": "mcp-compat",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    # ── Solana: SOL balance ────────────────────────────────────────────────────
    if s == "solana" and t in {"get_balance", "get_sol_balance"}:
        address = str(body.get("address", body.get("owner", ""))).strip()
        return _ok({
            "ok": True, "address": address,
            "lamports": 1_000_000_000,
            "balance": "1.0",
            "simulated": True,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    # ── Solana: SPL token balance ──────────────────────────────────────────────
    if s == "solana" and t in {"get_token_balance"}:
        return _ok({
            "ok": True,
            "owner": str(body.get("owner", body.get("address", ""))),
            "mint": str(body.get("mint", "")),
            "amount": "0",
            "decimals": 6,
            "balance": "0.0",
            "simulated": True,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    # ── Solana: account info ───────────────────────────────────────────────────
    if s == "solana" and t in {"get_account_info"}:
        return _ok({
            "ok": True,
            "address": str(body.get("address", "")),
            "exists": True,
            "lamports": 1_000_000_000,
            "simulated": True,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    # ── Solana: send transaction ───────────────────────────────────────────────
    if s == "solana" and t in {"send_raw_transaction", "send_transaction"}:
        key = (
            str(request.headers.get("x-session-key", "")).strip()
            or str(body.get("sessionKey", body.get("session_key", ""))).strip()
            or str(os.environ.get("SOLANA_KEY", "")).strip()
        )
        return _ok({
            "ok": True,
            "signature": f"sim_{uuid4().hex[:40]}",
            "simulated": True,
            "session_key_provided": bool(key),
            "source": "mcp-compat",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    # ── Solana: SNS resolution ─────────────────────────────────────────────────
    if s == "solana" and t == "resolve_sns":
        name = str(body.get("name", "")).strip().lower()
        return _ok({
            "ok": True,
            "name": name,
            "address": f"SNS_{name.replace('.', '_').upper()}",
            "simulated": True,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    # ── Fallback ───────────────────────────────────────────────────────────────
    return _ok({
        "available": False,
        "server": server, "tool": tool,
        "message": "Tool not implemented on local MCP compat endpoint.",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


# ── Single-shot endpoint ──────────────────────────────────────────────────────

@app.post("/create-bot")
async def create_bot(req: PromptRequest, request: Request):
    rid = (request.headers.get("x-request-id") or uuid4().hex[:8]).strip()[:12]
    t0  = time.monotonic()
    print(f"[create-bot] [{rid}] chars={len(req.prompt)}")
    try:
        result = await asyncio.wait_for(
            asyncio.to_thread(agent.build_bot, req.prompt, rid),
            timeout=CREATE_BOT_TIMEOUT,
        )
        print(f"[create-bot] [{rid}] done in {round(time.monotonic()-t0,2)}s")
        return result
    except asyncio.TimeoutError:
        raise HTTPException(504, f"Timed out after {CREATE_BOT_TIMEOUT:.0f}s")
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500 if "timeout" not in str(e).lower() else 504, str(e))


# ── Multi-turn endpoint ───────────────────────────────────────────────────────

@app.post("/create-bot-chat", response_model=ChatResponse)
async def create_bot_chat(req: ChatRequest, request: Request):
    rid  = req.request_id or (request.headers.get("x-request-id") or uuid4().hex[:8]).strip()[:12]
    t0   = time.monotonic()
    hist = [{"role": m.role, "content": m.content} for m in req.messages]
    print(f"[create-bot-chat] [{rid}] turns={len(hist)}")

    try:
        raw: Dict[str, Any] = await asyncio.wait_for(
            asyncio.to_thread(agent.build_bot_with_history, hist, rid),
            timeout=CREATE_BOT_TIMEOUT,
        )
    except asyncio.TimeoutError:
        return ChatResponse(
            status="error",
            message=f"Timed out after {CREATE_BOT_TIMEOUT:.0f}s.",
        )
    except Exception as exc:
        traceback.print_exc()
        return ChatResponse(status="error", message=str(exc))

    print(f"[create-bot-chat] [{rid}] status={raw.get('status')} in {round(time.monotonic()-t0,2)}s")

    if raw.get("status") == "clarification_needed":
        return ChatResponse(
            status="clarification_needed",
            question=raw.get("question", "Could you provide more details?"),
        )

    if raw.get("status") == "ready":
        out  = raw.get("output", {})
        intent = raw.get("intent", {})
        return ChatResponse(
            status="ready",
            bot_name=str(intent.get("bot_name", "Agentia Solana Bot")),
            files=out.get("files", []),
            intent=intent,
            thoughts=out.get("thoughts", ""),
        )

    return ChatResponse(status="error", message=raw.get("message", "Unknown error."))