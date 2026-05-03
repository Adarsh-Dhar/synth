from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
import json

# Lazy import MetaAgent to avoid heavy startup work at import-time
_meta_agent = None


def _get_meta_agent():
    global _meta_agent
    if _meta_agent is None:
        # Import here to ensure environment (.env) is loaded by orchestrator
        from orchestrator import MetaAgent

        _meta_agent = MetaAgent()
    return _meta_agent


app = FastAPI(title="Meta-Agent HTTP")

# Add CORS middleware to handle cross-origin requests from frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/create-bot")
async def create_bot(body: dict):
    prompt = str(body.get("prompt", "")).strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")

    agent = _get_meta_agent()
    result = await agent.build_bot(prompt)
    return JSONResponse(result)


@app.post("/create-bot-chat")
async def create_bot_chat(body: dict):
    messages = body.get("messages")
    if not isinstance(messages, list):
        raise HTTPException(status_code=400, detail="messages must be an array")

    agent = _get_meta_agent()
    result = await agent.build_bot_with_history(messages)
    return JSONResponse(result)


@app.post("/generate-stream")
async def generate_stream(request: Request):
    """Stream-based bot generation endpoint for SSE consumption"""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    
    prompt = str(body.get("prompt", "")).strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")

    agent = _get_meta_agent()
    result = await agent.build_bot(prompt)
    
    # Add status field for frontend SSE consumer
    if "status" not in result:
        result["status"] = "complete"
    
    # Generate SSE events: send result as a single "data" event
    async def event_generator():
        event_data = json.dumps(result)
        yield f"data: {event_data}\n\n"
    
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


# Mount the copilot sub-router for backwards compatibility
try:
    from copilot_router import router as copilot_router

    app.include_router(copilot_router)
except Exception:
    # Non-fatal: copilot router may be unavailable in some test contexts
    pass
