"""decide.py against httpx.MockTransport (response shape from docs/md/05; real success shape unverified, see DIFFICULTIES)."""
import asyncio
import json

import httpx
import pytest

from backend import decide

CANON = "So, um, I just wanted to, uh, announce that we're going to meet Friday, actually Monday at 5 PM."


@pytest.fixture(autouse=True)
def enabled(monkeypatch):
    from types import SimpleNamespace

    monkeypatch.setattr(decide, "settings", SimpleNamespace(
        DECISIONS_ENABLED=True, OPENAI_API_KEY="sk-test", DECISIONS_MODEL="gpt-6-luna", MOCK=False))

    async def nosleep(_):
        return None

    monkeypatch.setattr(decide, "_sleep", nosleep)


def serve(monkeypatch, handler):
    monkeypatch.setattr(decide, "_transport", httpx.MockTransport(handler))


def answers_for(req, probs=None, choices=None):
    body = json.loads(req.content)
    probs, choices = probs or {}, choices or {}
    out = []
    for q in body["questions"]:
        if q["type"] == "predicate":
            out.append({"name": q["name"], "type": "predicate", "probability": probs.get(q["name"], 0.1)})
        else:
            c = choices.get(q["name"], q["choices"][0]["value"])
            out.append({"name": q["name"], "type": "choice", "choice": c, "confidence": 0.9})
    return httpx.Response(200, json={"answers": out, "model": "gpt-6-luna", "usage": {}})


def run(c):
    return asyncio.run(c)


def test_analyze_maps_predicates_register_mode_and_sentences(monkeypatch):
    calls = []

    def handler(req):
        body = json.loads(req.content)
        calls.append(body)
        if len(body["questions"]) == 9:
            return answers_for(req, {"has_filler": 0.99, "has_self_correction": 0.97},
                               {"register": "announcement", "recommended_mode": "presenter"})
        return answers_for(req, {"needs_edit": 0.9, "has_filler": 0.8})

    serve(monkeypatch, handler)
    d = run(decide.analyze(CANON, [CANON]))
    assert d.available and d.predicates["has_filler"] == 0.99 and d.predicates["has_self_correction"] == 0.97
    assert d.register == "announcement" and d.recommended_mode == "presenter"
    s = d.per_sentence[0]
    assert s.keep is False and s.needs_edit_prob == 0.9 and "filler" in s.issues
    assert all(c["model"] == "gpt-6-luna" and len(c["questions"]) <= 10 for c in calls)


def test_keep_when_sentence_needs_no_edit(monkeypatch):
    serve(monkeypatch, lambda r: answers_for(r, {"needs_edit": 0.05}))
    d = run(decide.analyze("Hello there. We meet Monday.", ["Hello there.", "We meet Monday."]))
    assert [s.keep for s in d.per_sentence] == [True, True]


def test_more_than_8_sentences_skips_per_sentence(monkeypatch):
    calls = []
    serve(monkeypatch, lambda r: (calls.append(1), answers_for(r))[1])
    sents = [f"Sentence {i}." for i in range(9)]
    d = run(decide.analyze(" ".join(sents), sents))
    assert len(calls) == 1 and d.available and len(d.per_sentence) == 9 and "8 sentences" in d.note


def test_refusal_on_one_answer_does_not_break_others(monkeypatch):
    def handler(req):
        body = json.loads(req.content)
        ans = [{"name": q["name"], "type": "refusal"} if q["name"] == "register" else
               ({"name": q["name"], "type": "predicate", "probability": 0.2} if q["type"] == "predicate" else
                {"name": q["name"], "type": "choice", "choice": "minimal"}) for q in body["questions"]]
        return httpx.Response(200, json={"answers": ans})

    serve(monkeypatch, handler)
    d = run(decide.analyze(CANON, [CANON]))
    assert d.available and d.register == "casual" and d.recommended_mode == "minimal"


@pytest.mark.parametrize("status,code", [(429, "credit_balance_exhausted"), (401, "invalid_api_key"),
                                         (403, "forbidden"), (404, "model_not_found")])
def test_hard_failures_return_unavailable_without_retry(monkeypatch, status, code):
    calls = []

    def handler(req):
        calls.append(1)
        return httpx.Response(status, json={"error": {"code": code, "message": "nope"}})

    serve(monkeypatch, handler)
    d = run(decide.analyze(CANON, [CANON]))
    assert d.available is False and d.recommended_mode == "natural" and "unavailable" in d.note
    assert d.predicates == {} and len(calls) == 1
    assert d.per_sentence[0].issues == ["filler", "self_correction"] and d.per_sentence[0].needs_edit_prob is None


def test_transient_500_retried_twice_then_unavailable(monkeypatch):
    calls = []

    def handler(req):
        calls.append(1)
        return httpx.Response(500, json={"error": {"code": "server_error"}})

    serve(monkeypatch, handler)
    d = run(decide.analyze(CANON, [CANON]))
    assert d.available is False and len(calls) == 3


def test_rate_limit_429_retried_then_succeeds(monkeypatch):
    n = {"i": 0}

    def handler(req):
        n["i"] += 1
        if n["i"] == 1:
            return httpx.Response(429, json={"error": {"code": "rate_limit_exceeded"}})
        return answers_for(req)

    serve(monkeypatch, handler)
    assert run(decide.analyze(CANON, [CANON])).available


def test_timeout_is_unavailable(monkeypatch):
    def handler(req):
        raise httpx.ReadTimeout("slow")

    serve(monkeypatch, handler)
    d = run(decide.analyze(CANON, [CANON]))
    assert d.available is False


def test_disabled_makes_no_call(monkeypatch):
    monkeypatch.setattr(decide.settings, "DECISIONS_ENABLED", False)
    serve(monkeypatch, lambda r: pytest.fail("no network when disabled"))
    d = run(decide.analyze(CANON, [CANON]))
    assert d.available is False and "DECISIONS_ENABLED=0" in d.note


def test_verify_pass_and_fail(monkeypatch):
    good = {"meaning_preserved": 0.97}
    serve(monkeypatch, lambda r: answers_for(r, good))
    v = run(decide.verify("meet Friday actually Monday", "Meet Monday."))
    assert v.available and v.ok and v.failures() == []
    bad = {"meaning_preserved": 0.4, "changed_number_date_or_name": 0.9}
    serve(monkeypatch, lambda r: answers_for(r, bad))
    v = run(decide.verify("a", "b"))
    assert not v.ok and set(v.failures()) == {"meaning_preserved", "changed_number_date_or_name"}


def test_verify_sends_original_and_rewrite_as_json(monkeypatch):
    seen = {}

    def handler(req):
        seen.update(json.loads(req.content))
        return answers_for(req, {"meaning_preserved": 0.9})

    serve(monkeypatch, handler)
    run(decide.verify("orig text", "new text"))
    assert json.loads(seen["input"]) == {"original": "orig text", "rewrite": "new text"}
    assert {q["name"] for q in seen["questions"]} == set(decide.VERIFY_PREDICATES)


def test_verify_unavailable_on_quota(monkeypatch):
    serve(monkeypatch, lambda r: httpx.Response(429, json={"error": {"code": "credit_balance_exhausted"}}))
    v = run(decide.verify("a", "b"))
    assert v.available is False and not v.ok


# ---- hard deadlines (round 2) ---------------------------------------------
def _slow(seconds):
    async def handler(req):
        await asyncio.sleep(seconds)
        return answers_for(req, {"meaning_preserved": 0.99})
    return handler


def test_analyze_hard_deadline_degrades(monkeypatch):
    import time

    monkeypatch.setattr(decide, "ANALYZE_DEADLINE_S", 0.2)
    serve(monkeypatch, _slow(5))
    t = time.perf_counter()
    d = run(decide.analyze(CANON, [CANON]))
    assert time.perf_counter() - t < 1.0
    assert d.available is False and "timed out" in d.note


def test_verify_hard_deadline_degrades(monkeypatch):
    import time

    monkeypatch.setattr(decide, "VERIFY_DEADLINE_S", 0.2)
    serve(monkeypatch, _slow(5))
    t = time.perf_counter()
    v = run(decide.verify("a", "b"))
    assert time.perf_counter() - t < 1.0 and v.available is False and "timed out" in v.note


def test_guard_goes_offline_when_verifier_hangs(monkeypatch):
    import time

    from backend import guard

    monkeypatch.setattr(decide, "VERIFY_DEADLINE_S", 0.2)
    serve(monkeypatch, _slow(5))
    t = time.perf_counter()
    res = run(guard.check("meet Monday at 5 pm", "Meet Monday at 5 PM."))
    assert time.perf_counter() - t < 1.5
    assert not res.pass_ and res.verifier == "offline"


def test_analyze_never_raises_on_garbage(monkeypatch):
    serve(monkeypatch, lambda r: httpx.Response(200, content=b"not json"))
    assert run(decide.analyze(CANON, [CANON])).available is False


def test_health_reports_quota_error(monkeypatch):
    monkeypatch.setattr(decide, "_health_cache", None)
    serve(monkeypatch, lambda r: httpx.Response(429, json={"error": {"code": "credit_balance_exhausted"}}))
    state, why = run(decide.health())
    assert state == "error" and "credit" in why
    monkeypatch.setattr(decide, "_health_cache", None)
    serve(monkeypatch, lambda r: answers_for(r))
    assert run(decide.health())[0] == "ok"
