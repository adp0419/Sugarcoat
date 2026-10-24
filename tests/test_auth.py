"""Accounts groundwork behind AUTH_ENABLED (default off). Fake store + fake Twinly client; no network."""
import asyncio
import base64
import json
import os
import time

os.environ["MOCK"] = "1"

import httpx  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend import auth, main, voice  # noqa: E402
from backend.config import settings  # noqa: E402
from backend.errors import ApiError  # noqa: E402
from backend.models import AudioChunk, SpeakResponse, TwinlyHealth  # noqa: E402

SECRET = "test-jwt-secret-at-least-32-characters-long"
ENC = base64.b64encode(b"k" * 32).decode()
KEY_A = "twk_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAA"
KEY_B = "twk_live_BBBBBBBBBBBBBBBBBBBBBBBBBBBB"


def token(sub="user-a", exp_in=3600, **extra):
    return auth.sign_jwt({"sub": sub, "aud": "authenticated", "exp": time.time() + exp_in, **extra}, SECRET)


# ---------------------------------------------------------------- JWT
def test_jwt_valid():
    assert auth.verify_jwt(token(), SECRET)["sub"] == "user-a"


@pytest.mark.parametrize("make,why", [
    (lambda: token(exp_in=-120), "expired"),
    (lambda: token()[:-3] + "AAA", "bad signature"),
    (lambda: auth.sign_jwt({"sub": "u", "exp": time.time() + 60}, "other-secret"), "bad signature"),
    (lambda: token(aud="anon"), "wrong audience"),
    (lambda: auth.sign_jwt({"aud": "authenticated", "exp": time.time() + 60}, SECRET), "no subject"),
    (lambda: "not.a.jwt", "malformed"),
])
def test_jwt_rejected(make, why):
    with pytest.raises(ApiError) as e:
        auth.verify_jwt(make(), SECRET)
    assert e.value.code == "unauthorized" and e.value.status == 401 and why in e.value.message


def test_jwt_alg_none_rejected():
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()  # noqa: E731
    t = f"{enc({'alg': 'none'})}.{enc({'sub': 'u', 'exp': time.time() + 60})}."
    with pytest.raises(ApiError):
        auth.verify_jwt(t, SECRET)


# ---------------------------------------------------------------- encryption
def test_encrypt_roundtrip_and_binding():
    c = auth.encrypt(KEY_A, ENC, "user-a")
    assert KEY_A not in c and c.startswith("v1:")
    assert auth.decrypt(c, ENC, "user-a") == KEY_A
    assert auth.encrypt(KEY_A, ENC, "user-a") != c  # random nonce
    with pytest.raises(ApiError):
        auth.decrypt(c, ENC, "user-b")  # ciphertext bound to its user
    with pytest.raises(ApiError):
        auth.decrypt(c, base64.b64encode(b"x" * 32).decode(), "user-a")
    with pytest.raises(ApiError):
        auth.encrypt(KEY_A, "short", "user-a")


# ---------------------------------------------------------------- stores
def test_sqlite_store_upsert():
    async def go():
        s = auth.SQLiteStore()
        assert await s.get("u") is None
        await s.put(auth.Profile("u", "v1:x", "Mac"))
        await s.put(auth.Profile("u", "v1:y", "Studio"))
        p = await s.get("u")
        assert (p.twinly_key_encrypted, p.label) == ("v1:y", "Studio")
    asyncio.run(go())


def test_supabase_store_against_fake_postgrest():
    rows = {}
    seen = []

    def handler(req: httpx.Request):
        seen.append(req)
        assert req.headers["apikey"] == "service" and req.url.path == "/rest/v1/profiles"
        if req.method == "POST":
            assert "merge-duplicates" in req.headers["prefer"]
            for r in json.loads(req.content):
                rows[r["user_id"]] = r
            return httpx.Response(201)
        uid = req.url.params["user_id"].removeprefix("eq.")
        return httpx.Response(200, json=[rows[uid]] if uid in rows else [])

    async def go():
        s = auth.SupabaseStore("https://proj.supabase.co", "service", transport=httpx.MockTransport(handler))
        assert await s.get("u1") is None
        await s.put(auth.Profile("u1", "v1:abc", "Mac"))
        p = await s.get("u1")
        assert p.twinly_key_encrypted == "v1:abc" and p.label == "Mac"
    asyncio.run(go())
    assert len(seen) == 3


# ---------------------------------------------------------------- endpoints
class FakeTwinly:
    def __init__(self, key):
        self.key = key
        self.spoken = []

    async def health(self):
        return TwinlyHealth(online=True, voice_ready=True)

    async def speak(self, text):
        self.spoken.append(text)
        return SpeakResponse(chunks=[AudioChunk(url="/api/audio/x.m4a", seconds=1.0)], total_seconds=1.0)


@pytest.fixture
def authed(monkeypatch):
    monkeypatch.setattr(settings, "AUTH_ENABLED", True)
    monkeypatch.setattr(settings, "SUPABASE_JWT_SECRET", SECRET)
    monkeypatch.setattr(settings, "ENCRYPTION_KEY", ENC)
    monkeypatch.setattr(main, "_store", auth.SQLiteStore())
    monkeypatch.setattr(main, "_user_clients", {})
    monkeypatch.setattr(main.status, "enable_persist", lambda: None)  # lifespan with MOCK off: no real files

    async def no_load():  # and no real model load
        return None
    monkeypatch.setattr(main.asr, "load", no_load)
    made = {}

    def make(key):
        made[key] = FakeTwinly(key)
        return made[key]
    monkeypatch.setattr(main, "_make_twinly_client", make)
    return made


def _h(sub="user-a"):
    return {"Authorization": f"Bearer {token(sub)}"}


def test_me_voice_never_returns_the_key(authed, monkeypatch):
    monkeypatch.setattr(settings, "MOCK", False)
    with TestClient(main.app) as c:
        assert c.get("/api/me/voice").status_code == 401
        assert c.get("/api/me/voice", headers=_h()).json() == {
            "has_key": False, "label": "", "online": False, "voice_ready": False}
        r = c.put("/api/me/voice", json={"twinly_key": KEY_A, "label": "Aryan's Mac"}, headers=_h())
        assert r.status_code == 200 and KEY_A not in r.text
        assert r.json() == {"has_key": True, "label": "Aryan's Mac", "online": True, "voice_ready": True}
        assert KEY_A not in c.get("/api/me/voice", headers=_h()).text
        stored = asyncio.run(main._store.get("user-a")).twinly_key_encrypted
        assert KEY_A not in stored and auth.decrypt(stored, ENC, "user-a") == KEY_A
        assert c.put("/api/me/voice", json={"twinly_key": "x"}, headers=_h()).status_code == 400


def test_speak_uses_the_signed_in_users_key(authed, monkeypatch, approved_speech):
    monkeypatch.setattr(settings, "MOCK", False)
    with TestClient(main.app) as c:
        c.put("/api/me/voice", json={"twinly_key": KEY_A}, headers=_h("user-a"))
        c.put("/api/me/voice", json={"twinly_key": KEY_B}, headers=_h("user-b"))
        assert c.post("/api/speak", json=approved_speech("Hi from A"), headers=_h("user-a")).status_code == 200
        assert c.post("/api/speak", json=approved_speech("Hi from B"), headers=_h("user-b")).status_code == 200
        assert authed[KEY_A].spoken == ["Hi from A"] and authed[KEY_B].spoken == ["Hi from B"]
        assert c.post("/api/speak", json={"job_id": "j", "text": "x", "revision": 0}).status_code == 401
        r = c.post("/api/speak", json={"job_id": "j", "text": "x", "revision": 0}, headers=_h("user-c"))  # no key saved
        assert r.status_code == 409 and r.json()["error"]["code"] == "voice_not_set_up"


def test_voice_cache_key_includes_voice_identity(tmp_path):
    """Two accounts saying the same text must never share a cached file."""
    a = voice.TwinlyClient(KEY_A, "http://x/v1", tmp_path)
    b = voice.TwinlyClient(KEY_B, "http://x/v1", tmp_path)
    a2 = voice.TwinlyClient(KEY_A, "http://x/v1", tmp_path)
    assert a.chunk_hash("Hello there.") != b.chunk_hash("Hello there.")
    assert a.chunk_hash("Hello there.") == a2.chunk_hash("Hello there.")
    a._store(a.chunk_hash("Hello there."), b"\x00" * 2000, 1.0)
    assert b._cached(b.chunk_hash("Hello there.")) is None
    assert a2._cached(a2.chunk_hash("Hello there.")) is not None


def test_auth_off_changes_nothing(monkeypatch, approved_speech):
    monkeypatch.setattr(settings, "AUTH_ENABLED", False)
    with TestClient(main.app) as c:
        assert c.get("/api/me/voice").json()["error"]["code"] == "not_found"
        assert c.put("/api/me/voice", json={"twinly_key": KEY_A}).status_code == 404
        r = c.post("/api/speak", json=approved_speech("Hello"))  # no token needed
        assert r.status_code == 200 and r.json()["chunks"][0]["seconds"] == 3.84
        assert c.post("/api/speak/async", json=approved_speech("Hello")).status_code == 202
