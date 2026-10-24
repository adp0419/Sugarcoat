"""Twinly client behaviour against httpx.MockTransport. No network, no credits."""
import asyncio
import base64
import json

import httpx
import pytest

from backend import voice
from backend.errors import ApiError

AUDIO = base64.b64encode(b"fake-m4a-bytes").decode()
DONE = {"id": "job1", "status": "done", "result": {"audio_b64": AUDIO, "mime": "audio/mp4", "seconds": 2.5}}


class Fake:
    """Scriptable Twinly: each POST/GET pops the next scripted response."""

    def __init__(self, posts=(), gets=()):
        self.posts, self.gets = list(posts), list(gets)
        self.post_calls, self.get_calls, self.bodies = 0, 0, []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        if req.method == "POST":
            self.post_calls += 1
            self.bodies.append(json.loads(req.content)["text"])
            item = self.posts.pop(0) if len(self.posts) > 1 else self.posts[0]
        else:
            self.get_calls += 1
            item = self.gets.pop(0) if len(self.gets) > 1 else self.gets[0]
        status, body, *hdr = item
        return httpx.Response(status, json=body, headers=hdr[0] if hdr else {})


def make(tmp_path, fake, **kw):
    sleeps = []

    async def sleep(s):
        sleeps.append(s)

    c = voice.TwinlyClient("twk_live_test", "https://twinly.test/v1", tmp_path, transport=httpx.MockTransport(fake),
                           sleep=sleep, **kw)
    c.sleeps = sleeps
    return c


def run(coro):
    return asyncio.run(coro)


def test_200_direct_result_writes_cache(tmp_path):
    f = Fake(posts=[(200, DONE)])
    c = make(tmp_path, f)
    res = run(c.speak("Hello, this is a test."))
    assert len(res.chunks) == 1 and res.chunks[0].seconds == 2.5 and res.synthetic
    name = res.chunks[0].url.rsplit("/", 1)[1]
    assert (tmp_path / name).read_bytes() == b"fake-m4a-bytes"


def test_202_then_poll_until_done(tmp_path):
    f = Fake(posts=[(202, {"id": "job1", "status": "queued"})],
             gets=[(200, {"id": "job1", "status": "running"}), (200, DONE)])
    c = make(tmp_path, f)
    res = run(c.speak("Hello."))
    assert f.get_calls == 2 and f.post_calls == 1
    assert res.total_seconds == 2.5


def test_second_call_is_cache_hit_no_network(tmp_path):
    f = Fake(posts=[(200, DONE)])
    c = make(tmp_path, f)
    run(c.speak("Same text."))
    res = run(c.speak("Same text."))
    assert f.post_calls == 1 and res.chunks[0].cached is True and res.chunks[0].seconds == 2.5


def test_cache_key_depends_on_voice(tmp_path):
    a = make(tmp_path, Fake(posts=[(200, DONE)]))
    b = voice.TwinlyClient("twk_live_other", "https://x/v1", tmp_path)
    assert a.chunk_hash("hi") != b.chunk_hash("hi")


def test_429_retries_with_retry_after_then_succeeds(tmp_path):
    f = Fake(posts=[(429, {"error": {"code": "rate_limited"}}, {"retry-after": "7"}), (200, DONE)])
    c = make(tmp_path, f)
    run(c.speak("Hi."))
    assert f.post_calls == 2 and 7.0 in c.sleeps


def test_429_gives_up_after_two_retries(tmp_path):
    f = Fake(posts=[(429, {"error": {"code": "rate_limited"}})])
    c = make(tmp_path, f)
    with pytest.raises(ApiError) as e:
        run(c.speak("Hi."))
    assert e.value.code == "rate_limited" and f.post_calls == 3


def test_503_job_unverified_never_reposts(tmp_path):
    f = Fake(posts=[(503, {"error": {"code": "job_unverified"}}), (200, DONE)])
    c = make(tmp_path, f)
    with pytest.raises(ApiError) as e:
        run(c.speak("Hi."))
    assert e.value.code == "job_unverified" and f.post_calls == 1


def test_other_503_not_retried(tmp_path):
    f = Fake(posts=[(503, {"error": {"code": "overloaded"}}), (200, DONE)])
    with pytest.raises(ApiError):
        run(make(tmp_path, f).speak("Hi."))
    assert f.post_calls == 1
    f2 = Fake(posts=[(503, {"error": {"code": "overloaded"}})])
    with pytest.raises(ApiError):
        run(make(tmp_path / "b", f2).speak("Hi."))
    assert f2.post_calls == 1


def test_409_maps_to_twinly_offline(tmp_path):
    f = Fake(posts=[(409, {"error": {"code": "twinly_offline"}})])
    with pytest.raises(ApiError) as e:
        run(make(tmp_path, f).speak("Hi."))
    assert e.value.code == "twinly_offline" and e.value.status == 409


def test_voice_not_set_up_maps(tmp_path):
    f = Fake(posts=[(409, {"error": {"code": "voice_not_set_up"}})])
    with pytest.raises(ApiError) as e:
        run(make(tmp_path, f).speak("Hi."))
    assert e.value.code == "voice_not_set_up" and "Build my clone" in e.value.hint


def test_voice_starting_waits_and_retries(tmp_path):
    f = Fake(posts=[(409, {"error": {"code": "voice_starting"}}), (200, DONE)])
    c = make(tmp_path, f)
    run(c.speak("Hi."))
    assert 5 in c.sleeps and f.post_calls == 2


def test_network_error_not_retried(tmp_path):
    calls = []

    def boom(req):
        calls.append(1)
        raise httpx.ConnectError("down")

    c = voice.TwinlyClient("k", "https://t/v1", tmp_path, transport=httpx.MockTransport(boom))
    with pytest.raises(ApiError) as e:
        run(c.speak("Hi."))
    assert e.value.code == "job_unverified" and len(calls) == 1


def test_failed_job_raises(tmp_path):
    f = Fake(posts=[(202, {"id": "j", "status": "queued"})], gets=[(200, {"id": "j", "status": "failed"})])
    with pytest.raises(ApiError):
        run(make(tmp_path, f).speak("Hi."))


def test_chunks_ordered_and_rendered_one_at_a_time(tmp_path):
    sents = [f"Sentence number {i} " + "word " * 40 + "ends here." for i in range(10)]
    text = " ".join(sents)
    state = {"cur": 0, "max": 0}

    async def handler(req: httpx.Request) -> httpx.Response:
        state["cur"] += 1
        state["max"] = max(state["max"], state["cur"])
        await asyncio.sleep(0.01)
        state["cur"] -= 1
        body = json.loads(req.content)["text"]
        done = {"id": "j", "status": "done", "result": {"audio_b64": base64.b64encode(body.encode()).decode(), "seconds": 1}}
        return httpx.Response(200, json=done)

    c = voice.TwinlyClient("k", "https://t/v1", tmp_path, transport=httpx.MockTransport(handler))
    res = run(c.speak(text))
    assert len(res.chunks) >= 3 and state["max"] == 1 and c.max_in_flight == 1  # 2 at once crashes the engine
    heard = " ".join((tmp_path / ch.url.rsplit("/", 1)[1]).read_text() for ch in res.chunks)
    assert heard == text
    assert all(len(p) <= 550 for p in [(tmp_path / ch.url.rsplit("/", 1)[1]).read_text() for ch in res.chunks])


def test_over_2400_chars_rejected_before_network(tmp_path):
    f = Fake(posts=[(200, DONE)])
    with pytest.raises(ApiError) as e:
        run(make(tmp_path, f).speak("word " * 500))
    assert e.value.code == "too_long" and f.post_calls == 0


def test_rate_limiter_blocks_31st_request():
    now = [0.0]
    slept = []

    async def sleep(s):
        slept.append(s)
        now[0] += s

    lim = voice._RateLimiter(30, lambda: now[0], sleep)

    async def go():
        for _ in range(31):
            await lim.acquire()

    run(go())
    assert len(slept) == 1 and 59 < slept[0] < 61


def test_spend_counter_and_cap(tmp_path):
    spend = tmp_path / "logs" / "spend.json"
    f = Fake(posts=[(200, DONE)])
    c = make(tmp_path / "c", f, spend_path=spend)
    run(c.speak("One line."))
    assert json.loads(spend.read_text()) == {"lines": 1, "usd": 0.1}
    spend.write_text(json.dumps({"lines": 150, "usd": 15.0}))
    with pytest.raises(ApiError):
        run(c.speak("Another new line."))
    c2 = make(tmp_path / "d", Fake(posts=[(200, DONE)]), spend_path=spend, allow_spend=True)
    run(c2.speak("Another new line."))


def test_health_cached(tmp_path):
    f = Fake(gets=[(200, {"voice": {"status": "ready"}})])
    c = make(tmp_path, f)
    h = run(c.health())
    run(c.health())
    assert h.online and h.voice_ready and f.get_calls == 1


def test_mock_mode_speak(tmp_path, monkeypatch):
    from types import SimpleNamespace

    fake = SimpleNamespace(MOCK=True, cache_dir=tmp_path, fixtures_dir=tmp_path)
    monkeypatch.setattr(voice, "settings", fake)
    res = run(voice.speak("Hello, this is a test."))
    assert res.chunks and res.chunks[0].url.startswith("/api/audio/")


def test_real_shape_http200_failed_job_voice_not_set_up(tmp_path):
    """Captured at gate G1 (fixtures/real_twinly_speak.json): 200 + job.status=failed + error.code."""
    real = json.loads((voice.settings.fixtures_dir / "real_twinly_speak.json").read_text())["body"]
    f = Fake(posts=[(200, real)])
    with pytest.raises(ApiError) as e:
        run(make(tmp_path, f).speak("Hello, this is a test."))
    assert e.value.code == "voice_not_set_up" and f.post_calls == 1 and f.get_calls == 0


def test_voice_starting_accepted_job_not_reposted(tmp_path):
    starting = {"id": "j", "object": "job", "status": "failed", "result": None,
                "error": {"code": "voice_starting", "message": "Voice engine is starting."}}
    f = Fake(posts=[(200, starting), (200, starting), (200, DONE)])
    c = make(tmp_path, f)
    with pytest.raises(ApiError):
        run(c.speak("Hello, this is a test."))
    assert f.post_calls == 1


def test_voice_starting_job_gives_up_after_one_post(tmp_path):
    starting = {"id": "j", "status": "failed", "error": {"code": "voice_starting"}}
    f = Fake(posts=[(200, starting)])
    c = make(tmp_path, f)
    with pytest.raises(ApiError) as e:
        run(c.speak("Hi."))
    assert f.post_calls == 1 and e.value.code == "job_unverified"


def test_slow_voice_starting_does_not_repost_past_budget(tmp_path):
    """Real shape: 202 running, then the job fails with voice_starting ~43 s later. A second
    attempt would blow main.py's 60 s cap, so give up after one POST with a clear hint."""
    real = json.loads((voice.settings.fixtures_dir / "real_twinly_voice_starting.json").read_text())["exchanges"]
    post, get = real[0], real[1]
    now = [0.0]

    def handler(req):
        now[0] += 43.0 if req.method == "GET" else 0.5
        item = post if req.method == "POST" else get
        return httpx.Response(item["status"], json=item["body"])

    calls = []
    c = voice.TwinlyClient("k", "https://t/v1", tmp_path, transport=httpx.MockTransport(lambda r: (calls.append(r.method), handler(r))[1]),
                           clock=lambda: now[0])
    with pytest.raises(ApiError) as e:
        run(c.speak("Hello, this is a test."))
    assert calls.count("POST") == 1 and e.value.code == "job_unverified"


def test_other_key_never_plays_cached_audio_of_another_voice(tmp_path):
    fa, fb = Fake(posts=[(200, DONE)]), Fake(posts=[(200, DONE)])
    a = voice.TwinlyClient("twk_live_alice", "https://t/v1", tmp_path, transport=httpx.MockTransport(fa))
    b = voice.TwinlyClient("twk_live_bob", "https://t/v1", tmp_path, transport=httpx.MockTransport(fb))
    ra = run(a.speak("Same words."))
    rb = run(b.speak("Same words."))
    assert fb.post_calls == 1 and rb.chunks[0].cached is False   # B rendered its own voice
    assert ra.chunks[0].url != rb.chunks[0].url
    assert run(a.speak("Same words.")).chunks[0].url == ra.chunks[0].url  # A still hits its own cache


def test_voice_id_does_not_leak_key(tmp_path):
    c = voice.TwinlyClient("twk_live_secretsecret", "https://t/v1", tmp_path)
    assert "secret" not in c.voice_id and len(c.voice_id) < 20


def test_voice_failed_job_not_reposted(tmp_path):
    """Real 2026-10-24: two concurrent jobs crashed Twinly's MLX engine; both came back failed, the next worked."""
    failed = {"id": "j", "object": "job", "status": "failed", "result": None,
              "error": {"code": "voice_failed", "message": "The voice engine couldn't render that."}}
    f = Fake(posts=[(200, failed), (200, DONE)])
    c = make(tmp_path, f)
    with pytest.raises(ApiError):
        run(c.speak("Hi."))
    assert f.post_calls == 1


def test_voice_failed_once_gives_up(tmp_path):
    failed = {"id": "j", "status": "failed", "error": {"code": "voice_failed"}}
    f = Fake(posts=[(200, failed)])
    with pytest.raises(ApiError) as e:
        run(make(tmp_path, f).speak("Hi."))
    assert f.post_calls == 1 and e.value.code == "job_unverified"


def test_other_failed_codes_not_reposted(tmp_path):
    f = Fake(posts=[(200, {"id": "j", "status": "failed", "error": {"code": "voice_not_set_up"}})])
    with pytest.raises(ApiError):
        run(make(tmp_path, f).speak("Hi."))
    assert f.post_calls == 1


def test_identical_chunks_in_flight_share_one_render(tmp_path):
    posts = []

    async def handler(req):
        posts.append(1)
        await asyncio.sleep(0.02)
        return httpx.Response(200, json=DONE)

    c = voice.TwinlyClient("k", "https://t/v1", tmp_path, transport=httpx.MockTransport(handler))

    async def both():
        return await asyncio.gather(c.speak("Same line."), c.speak("Same line."))

    a, b = run(both())
    assert len(posts) == 1 and a.chunks[0].url == b.chunks[0].url


def test_cancelled_caller_does_not_lose_paid_render(tmp_path):
    """main.py cancels speak at 60 s; the job keeps going and the retry is a free cache hit."""
    posts = []

    async def handler(req):
        posts.append(1)
        await asyncio.sleep(0.05)
        return httpx.Response(200, json=DONE)

    c = voice.TwinlyClient("k", "https://t/v1", tmp_path, transport=httpx.MockTransport(handler))

    async def go():
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(c.speak("Slow line."), 0.01)
        await asyncio.sleep(0.1)  # the shielded render finishes in the background
        return await c.speak("Slow line.")

    res = run(go())
    assert len(posts) == 1 and res.chunks[0].cached is True


def test_render_log_redacts_audio(tmp_path):
    f = Fake(posts=[(200, DONE)])
    c = make(tmp_path / "c", f, log_dir=tmp_path / "logs")
    run(c.speak("Logged line."))
    row = json.loads((tmp_path / "logs" / "twinly_renders.jsonl").read_text().splitlines()[-1])
    assert row["posts"] == 1 and row["chars"] == len("Logged line.") and row["seconds"] == 2.5
    last = (tmp_path / "logs" / "twinly_last_ok.json").read_text()
    assert AUDIO not in last and f"<base64, {len(AUDIO)} chars>" in last


def test_real_success_shape_http200_done_job(tmp_path):
    """Captured at G1 through /api/speak (fixtures/real_twinly_speak_ok.json): 200 + finished job, result.audio_b64."""
    body = json.loads((voice.settings.fixtures_dir / "real_twinly_speak_ok.json").read_text())["twinly_job_body"]
    body = json.loads(json.dumps(body))
    body["result"]["audio_b64"] = AUDIO
    f = Fake(posts=[(200, body)])
    res = run(make(tmp_path, f).speak("And this second line has different words, so it is its own job."))
    assert f.post_calls == 1 and f.get_calls == 0 and res.chunks[0].seconds == 3.6
