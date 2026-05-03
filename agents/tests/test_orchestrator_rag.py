import json
import asyncio
import pytest

import orchestrator
from orchestrator import MetaAgent
from planner import PlannerState


class DummyPlannerState(PlannerState):
    class Config:
        arbitrary_types_allowed = True


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    # Prevent any real HTTP/LLM calls by default; tests will patch what they need
    monkeypatch.setattr(MetaAgent, "_llm", lambda self, s, u, **kw: json.dumps({"thoughts":"ok","files":[{"filepath":"package.json","content":"{}"},{"filepath":"src/index.ts","content":"console.log('hi')"}]}))


def _make_plan():
    return DummyPlannerState(
        strategy_type="arbitrage",
        collected_parameters={"SOLANA_NETWORK": "mainnet-beta", "USER_WALLET_ADDRESS": "FAKE"},
        missing_parameters=[],
        verification_step=None,
        is_ready_for_code_generation=True,
        enriched_prompt="",
    )


def test_user_msg_contains_both_contexts_when_both_available(monkeypatch):
    agent = MetaAgent()
    plan = _make_plan()
    prompt = "profit split and payments via webhook"

    captured = {"user": None}
    calls = []

    class FakeMCP:
        async def connect_default_sessions(self):
            return None

        async def call_tool(self, server, tool, args):
            calls.append((server, tool, args.get("query", "")))
            if server == "jupiter":
                return "JUPITER docs here"
            return ""

        async def shutdown(self):
            return None

    def cap_llm(self, system, user, **kw):
        captured["user"] = user
        return json.dumps({"thoughts":"ok","files":[{"filepath":"package.json","content":"{}"}]})

    monkeypatch.setattr(orchestrator, "MultiMCPClient", FakeMCP)
    monkeypatch.setattr(MetaAgent, "_llm", cap_llm)

    plan.enriched_prompt = prompt
    asyncio.run(agent._generate_code_with_plan(plan, prompt, trace_id="test1"))

    assert any(c[0] == "jupiter" and c[1] == "jupiter_docs" for c in calls)
    assert captured["user"] is not None
    assert "JUPITER DOCS CONTEXT" in captured["user"]


def test_jupiter_context_absent_when_unreachable(monkeypatch):
    agent = MetaAgent()
    plan = _make_plan()
    prompt = "split profits"

    class FakeMCP:
        async def connect_default_sessions(self):
            return None

        async def call_tool(self, server, tool, args):
            if server == "jupiter":
                raise RuntimeError("unreachable")
            return ""

        async def shutdown(self):
            return None

    captured = {"user": None}

    def cap_llm(self, system, user, **kw):
        captured["user"] = user
        return json.dumps({"thoughts":"ok","files":[{"filepath":"package.json","content":"{}"}]})

    monkeypatch.setattr(orchestrator, "MultiMCPClient", FakeMCP)
    monkeypatch.setattr(MetaAgent, "_llm", cap_llm)
    plan.enriched_prompt = prompt
    asyncio.run(agent._generate_code_with_plan(plan, prompt, trace_id="test2"))

    assert captured["user"] is not None
    assert "JUPITER DOCS CONTEXT (live MCP)" not in captured["user"]


def test_fallback_context_when_both_unavailable(monkeypatch):
    agent = MetaAgent()
    plan = _make_plan()
    prompt = "monitor yields"

    captured = {"user": None}

    class FakeMCP:
        async def connect_default_sessions(self):
            return None

        async def call_tool(self, server, tool, args):
            raise RuntimeError("down")

        async def shutdown(self):
            return None

    def cap_llm(self, system, user, **kw):
        captured["user"] = user
        return json.dumps({"thoughts":"ok","files":[{"filepath":"package.json","content":"{}"}]})

    monkeypatch.setattr(orchestrator, "MultiMCPClient", FakeMCP)
    monkeypatch.setattr(MetaAgent, "_llm", cap_llm)
    plan.enriched_prompt = prompt
    asyncio.run(agent._generate_code_with_plan(plan, prompt, trace_id="test3"))

    assert captured["user"] is not None
    assert "JUPITER DOCS CONTEXT: unavailable" in captured["user"]


def test_generate_code_returns_ready(monkeypatch):
    agent = MetaAgent()
    plan = _make_plan()
    prompt = "arbitrage strategy"

    class FakeMCP:
        async def connect_default_sessions(self):
            return None

        async def call_tool(self, server, tool, args):
            return ""

        async def shutdown(self):
            return None

    monkeypatch.setattr(orchestrator, "MultiMCPClient", FakeMCP)
    monkeypatch.setattr(
        MetaAgent,
        "_llm",
        lambda self, s, user, **kw: json.dumps({
            "thoughts": "ok",
            "files": [
                {"filepath": "package.json", "content": "{}"},
                {"filepath": "src/index.ts", "content": "console.log('ok')"},
            ],
        }),
    )

    plan.enriched_prompt = prompt
    result = asyncio.run(agent._generate_code_with_plan(plan, prompt, trace_id="test4"))

    assert result["status"] == "ready"
    assert "files" in result
