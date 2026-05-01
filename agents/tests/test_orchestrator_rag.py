import json
import re
import pytest

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


def test_fetch_dodo_called_for_payment_keywords(monkeypatch):
    agent = MetaAgent()
    plan = _make_plan()
    prompt = "Build a bot that splits profits and pays contributors"

    called = {"dodo": False, "llm_user": None}

    def fake_fetch_dodo(self, p, trace_id=None):
        called["dodo"] = True
        return "DODO DOCS: webhook example"

    def capture_llm(self, system, user, **kw):
        called["llm_user"] = user
        return json.dumps({"thoughts":"ok","files":[{"filepath":"package.json","content":"{}"},{"filepath":"src/index.ts","content":"console.log('hi')"}]})

    monkeypatch.setattr(MetaAgent, "_fetch_dodo_context", fake_fetch_dodo)
    monkeypatch.setattr(MetaAgent, "_fetch_jupiter_docs_context", lambda self, p, trace_id=None: "JUPITER DOCS: quote API" )
    monkeypatch.setattr(MetaAgent, "_llm", capture_llm)

    plan.enriched_prompt = prompt
    agent._generate_code_with_plan(plan, prompt, trace_id="test1")

    assert called["dodo"] is True
    assert isinstance(called["llm_user"], str)
    assert "DODO DOCS CONTEXT" in called["llm_user"] or "DODO DOCS" in called["llm_user"]


def test_fetch_dodo_not_called_for_no_payment_keywords(monkeypatch):
    agent = MetaAgent()
    plan = _make_plan()
    prompt = "Monitor price spreads across pools only"

    called = {"dodo": False}

    def fake_fetch_dodo(self, p, trace_id=None):
        called["dodo"] = True
        return "DODO DOCS: webhook example"

    monkeypatch.setattr(MetaAgent, "_fetch_dodo_context", fake_fetch_dodo)
    monkeypatch.setattr(MetaAgent, "_fetch_jupiter_docs_context", lambda self, p, trace_id=None: "JUPITER DOCS: quote API" )
    monkeypatch.setattr(MetaAgent, "_llm", lambda self, s, u, **kw: json.dumps({"thoughts":"ok","files":[]}))

    plan.enriched_prompt = prompt
    agent._generate_code_with_plan(plan, prompt, trace_id="test2")

    assert called["dodo"] is False


def test_user_msg_contains_both_contexts_when_both_available(monkeypatch):
    agent = MetaAgent()
    plan = _make_plan()
    prompt = "profit split and payments via webhook"

    captured = {"user": None}

    monkeypatch.setattr(MetaAgent, "_fetch_dodo_context", lambda self, p, trace_id=None: "DODO docs here")
    monkeypatch.setattr(MetaAgent, "_fetch_jupiter_docs_context", lambda self, p, trace_id=None: "JUPITER docs here")

    def cap_llm(self, system, user, **kw):
        captured["user"] = user
        return json.dumps({"thoughts":"ok","files":[{"filepath":"package.json","content":"{}"}]})

    monkeypatch.setattr(MetaAgent, "_llm", cap_llm)
    plan.enriched_prompt = prompt
    agent._generate_code_with_plan(plan, prompt, trace_id="test3")

    assert captured["user"] is not None
    assert "JUPITER DOCS" in captured["user"]
    assert "DODO DOCS" in captured["user"]


def test_jupiter_context_absent_when_unreachable(monkeypatch):
    agent = MetaAgent()
    plan = _make_plan()
    prompt = "split profits"

    monkeypatch.setattr(MetaAgent, "_fetch_dodo_context", lambda self, p, trace_id=None: "DODO docs here")
    monkeypatch.setattr(MetaAgent, "_fetch_jupiter_docs_context", lambda self, p, trace_id=None: "")

    captured = {"user": None}
    monkeypatch.setattr(MetaAgent, "_llm", lambda self, s, user, **kw: json.dumps({"thoughts":"ok","files":[]}))

    # Monkeypatch _llm to capture user param via wrapper
    def cap_llm(self, system, user, **kw):
        captured["user"] = user
        return json.dumps({"thoughts":"ok","files":[{"filepath":"package.json","content":"{}"}]})

    monkeypatch.setattr(MetaAgent, "_llm", cap_llm)
    plan.enriched_prompt = prompt
    agent._generate_code_with_plan(plan, prompt, trace_id="test4")

    assert captured["user"] is not None
    assert "JUPITER DOCS CONTEXT (live MCP)" not in captured["user"]
    assert "DODO DOCS CONTEXT" in captured["user"]
