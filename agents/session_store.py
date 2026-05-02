"""
agents/session_store.py

Session persistence for CopilotState.
Primary: In-memory dict (fast, zero deps).
Optional: Redis backend (set REDIS_URL to enable).

The store serialises CopilotState to JSON so sessions survive between
gunicorn workers when Redis is available, and degrade gracefully to
per-process memory otherwise.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

_TTL_SECONDS = int(os.environ.get("SESSION_TTL_SECONDS", str(60 * 60 * 4)))  # 4 h default


# ─── In-process fallback store ─────────────────────────────────────────────

class _MemoryStore:
    """Thread-safe in-memory session store with TTL eviction."""

    def __init__(self) -> None:
        self._data: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._start_eviction_thread()

    def get(self, session_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            entry = self._data.get(session_id)
            if entry is None:
                return None
            if time.monotonic() > entry["expires_at"]:
                del self._data[session_id]
                return None
            return entry["payload"]

    def set(self, session_id: str, payload: Dict[str, Any], ttl: int = _TTL_SECONDS) -> None:
        with self._lock:
            self._data[session_id] = {
                "payload": payload,
                "expires_at": time.monotonic() + ttl,
            }

    def delete(self, session_id: str) -> None:
        with self._lock:
            self._data.pop(session_id, None)

    def _evict(self) -> None:
        while True:
            time.sleep(300)
            now = time.monotonic()
            with self._lock:
                expired = [k for k, v in self._data.items() if now > v["expires_at"]]
                for k in expired:
                    del self._data[k]
            if expired:
                logger.debug("session_store: evicted %d stale sessions", len(expired))

    def _start_eviction_thread(self) -> None:
        t = threading.Thread(target=self._evict, daemon=True, name="session-evict")
        t.start()


# ─── Optional Redis backend ────────────────────────────────────────────────

class _RedisStore:
    def __init__(self, url: str) -> None:
        import redis  # type: ignore
        self._r = redis.from_url(url, decode_responses=True)
        logger.info("session_store: using Redis backend at %s", url)

    def get(self, session_id: str) -> Optional[Dict[str, Any]]:
        raw = self._r.get(f"copilot:{session_id}")
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except Exception:
            return None

    def set(self, session_id: str, payload: Dict[str, Any], ttl: int = _TTL_SECONDS) -> None:
        self._r.setex(f"copilot:{session_id}", ttl, json.dumps(payload, default=str))

    def delete(self, session_id: str) -> None:
        self._r.delete(f"copilot:{session_id}")


# ─── Public singleton ──────────────────────────────────────────────────────

def _make_store():
    redis_url = os.environ.get("REDIS_URL", "").strip()
    if redis_url:
        try:
            return _RedisStore(redis_url)
        except Exception as exc:
            logger.warning("session_store: Redis unavailable (%s), using memory store", exc)
    return _MemoryStore()


_store = _make_store()


def save_session(session_id: str, state_dict: Dict[str, Any]) -> None:
    """Persist a CopilotState dict under session_id."""
    _store.set(session_id, state_dict)


def load_session(session_id: str) -> Optional[Dict[str, Any]]:
    """Retrieve a previously saved CopilotState dict, or None if not found/expired."""
    return _store.get(session_id)


def delete_session(session_id: str) -> None:
    """Remove a session (call after code generation completes)."""
    _store.delete(session_id)


def session_exists(session_id: str) -> bool:
    return _store.get(session_id) is not None