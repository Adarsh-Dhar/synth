"""
main.py — Meta-Agent API server (Solana-native, v5 Copilot Edition)
Start: uvicorn main:app --reload

New in v5:
  - /copilot/* routes via copilot_router.py (start, continue, stream, status)
  - Session state stored in session_store.py (memory or Redis)
  - Legacy /create-bot and /create-bot-chat still work unchanged
"""

import os
import json
import asyncio
import time
import traceback
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from uuid import uuid4

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from orchestrator import MetaAgent

# Import and mount the copilot router
from copilot_router import router as copilot_router

app = FastAPI(title="Agentia Solana Bot Meta-Agent", version="5.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount copilot routes at /copilot/*
app.include_router(copilot_router)

agent = MetaAgent()

CREATE_BOT_TIMEOUT = float(os.environ.get("META_AGENT_CREATE_BOT_TIMEOUT_SECONDS", "240"))
MCP_UPSTREAM_URL = os.environ.get("MCP_UPSTREAM_URL", "http://127.0.0.1:8001").rstrip("/")
MCP_UPSTREAM_TIMEOUT_SECONDS = float(os.environ.get("MCP_UPSTREAM_TIMEOUT_SECONDS", "12"))
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))


# ─── Models ───────────────────────────────────────────────────────────────────

class PromptRequest(BaseModel):
    prompt: str


class GenerateRequest(BaseModel):
    prompt: str


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: List[ChatMessage]
    request_id: Optional[str] = None


class ChatResponse(BaseModel):
    status: str
    question: Optional[str]   = None
    strategy_type: Optional[str] = None
    missing_parameters: Optional[List[str]] = None
    collected_parameters: Optional[Dict[str, str]] = None
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


# ─── Health ───────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "version": "5.0.0"}


@app.get("/health/copilot")
async def health_copilot():
    """Quick sanity check for copilot subsystem."""
    from session_store import session_exists
    return {
        "status": "ok",
        "copilot_router": "mounted",
        "session_store": "ready",
    }


@app.get("/mcp/health")
async def mcp_health():
    return {"status": "ok", "service": "solana-mcp-compat"}


@app.get("/health/dodo")
async def health_dodo():
    dodo = os.environ.get("DODO_DOCS_MCP_URL", "http://127.0.0.1:5002").rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(dodo)
            return {"status": "ok", "dodo": dodo, "upstream_status": resp.status_code}
    except Exception as exc:
        return {"status": "unavailable", "dodo": dodo, "detail": str(exc)}


# ─── MCP gateway ──────────────────────────────────────────────────────────────

@app.post("/mcp/{server}/{tool}")
async def mcp_tool(server: str, tool: str, body: dict, request: Request):
    s = server.strip().lower()
    t = tool.strip().lower()

    base_headers = {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true",
    }
    session_key = str(request.headers.get("x-session-key", "")).strip()
    if session_key:
        base_headers["x-session-key"] = session_key

    candidates = [
        f"{MCP_UPSTREAM_URL}/mcp/{s}/{t}",
        f"{MCP_UPSTREAM_URL}/{s}/{t}",
    ]

    last_error = ""
    async with httpx.AsyncClient(timeout=MCP_UPSTREAM_TIMEOUT_SECONDS) as client:
        for url in candidates:
            try:
                resp = await client.post(url, json=body, headers=base_headers)
                if resp.status_code == 404:
                    last_error = f"404 at {url}"
                    continue
                resp.raise_for_status()
                payload = resp.json()
                if isinstance(payload, dict) and isinstance(payload.get("result"), dict):
                    return payload
                return _ok({
                    "available": True,
                    "server": s,
                    "tool": t,
                    "source": "upstream",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "data": payload,
                })
            except Exception as exc:
                last_error = str(exc)

    return _ok({
        "available": False,
        "server": s,
        "tool": t,
        "message": "Tool unavailable from configured MCP upstream.",
        "upstream": MCP_UPSTREAM_URL,
        "detail": last_error,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


# ─── Legacy single-shot endpoint (unchanged) ──────────────────────────────────

@app.post("/create-bot")
async def create_bot(req: PromptRequest, request: Request):
    rid = (request.headers.get("x-request-id") or uuid4().hex[:8]).strip()[:12]
    t0  = time.monotonic()
    print(f"[create-bot] [{rid}] chars={len(req.prompt)}")
    try:
        result = await asyncio.wait_for(
            agent.build_bot(req.prompt, rid),
            timeout=CREATE_BOT_TIMEOUT,
        )
        print(f"[create-bot] [{rid}] done in {round(time.monotonic()-t0,2)}s")
        return result
    except asyncio.TimeoutError:
        raise HTTPException(504, f"Timed out after {CREATE_BOT_TIMEOUT:.0f}s")
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500 if "timeout" not in str(e).lower() else 504, str(e))


@app.post("/generate-stream")
async def generate_bot_stream(req: GenerateRequest):
    return StreamingResponse(
        agent.orchestrate_bot_creation_stream(req.prompt),
        media_type="text/event-stream",
    )


@app.post("/demo/generate")
async def demo_generate(request: Request):
    import sys
    sys.path.insert(0, str(_BASE_DIR))
    try:
        from demo.prompt_template import build_prompt
        prompt = build_prompt()
    except ImportError as e:
        raise HTTPException(500, f"Demo module not found: {e}")

    rid = uuid4().hex[:8]
    try:
        result = await asyncio.wait_for(
            agent.build_bot(prompt, rid),
            timeout=CREATE_BOT_TIMEOUT,
        )
        return result
    except asyncio.TimeoutError:
        raise HTTPException(504, f"Timed out after {CREATE_BOT_TIMEOUT:.0f}s")
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, str(e))


# ─── Legacy multi-turn endpoint (unchanged) ───────────────────────────────────

@app.post("/create-bot-chat", response_model=ChatResponse)
async def create_bot_chat(req: ChatRequest, request: Request):
    rid  = req.request_id or (request.headers.get("x-request-id") or uuid4().hex[:8]).strip()[:12]
    t0   = time.monotonic()
    hist = [{"role": m.role, "content": m.content} for m in req.messages]
    print(f"[create-bot-chat] [{rid}] turns={len(hist)}")

    try:
        raw: Dict[str, Any] = await asyncio.wait_for(
            agent.build_bot_with_history(hist, rid),
            timeout=CREATE_BOT_TIMEOUT,
        )
    except asyncio.TimeoutError:
        return ChatResponse(status="error", message=f"Timed out after {CREATE_BOT_TIMEOUT:.0f}s.")
    except Exception as exc:
        traceback.print_exc()
        return ChatResponse(status="error", message=str(exc))

    print(f"[create-bot-chat] [{rid}] status={raw.get('status')} in {round(time.monotonic()-t0,2)}s")

    if raw.get("status") == "clarification_needed":
        return ChatResponse(
            status="clarification_needed",
            question=raw.get("question", "Could you provide more details?"),
            strategy_type=raw.get("strategy_type"),
            missing_parameters=raw.get("missing_parameters", []),
            collected_parameters=raw.get("collected_parameters", {}),
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