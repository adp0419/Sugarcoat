"""Accounts groundwork (AUTH_ENABLED=1 only; default off = no behaviour change). docs/md/10 "Accounts".

- verify_jwt: Supabase access token, HS256 with the project's JWT secret (SUPABASE_JWT_SECRET). Projects on
  asymmetric signing keys (ES256/RS256 via JWKS) are not supported yet and are rejected.
- Each user's Twinly key is stored only as `twinly_key_encrypted`: AES-256-GCM with ENCRYPTION_KEY (32 bytes,
  base64), random 12-byte nonce, the user id as associated data (a ciphertext copied to another user's row
  does not decrypt). The plaintext key is never returned by any endpoint and never logged.
- ProfileStore: SQLiteStore (local dev / tests) and SupabaseStore (PostgREST `profiles` table). Nothing here
  creates a Supabase project; SupabaseStore is exercised only against a fake transport in tests.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import httpx

from .errors import ApiError, api_error

LEEWAY_S = 30


# ---------------------------------------------------------------- JWT
def _b64url(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def verify_jwt(token: str, secret: str, now: float | None = None, audience: str = "authenticated") -> dict:
    """Return the claims of a valid HS256 token or raise ApiError(unauthorized). Requires `sub` and `exp`."""
    def bad(why: str) -> ApiError:
        return api_error("unauthorized", f"Sign-in token rejected ({why}).", "Sign in again.")

    if not secret:
        raise api_error("internal", "SUPABASE_JWT_SECRET is not set.", "Set it in .env or turn AUTH_ENABLED off.")
    parts = (token or "").split(".")
    if len(parts) != 3:
        raise bad("malformed")
    try:
        header, claims, sig = json.loads(_b64url(parts[0])), json.loads(_b64url(parts[1])), _b64url(parts[2])
    except (ValueError, TypeError):
        raise bad("malformed")
    if header.get("alg") != "HS256":  # also blocks alg=none
        raise bad(f"unsupported alg {header.get('alg')}")
    want = hmac.new(secret.encode(), f"{parts[0]}.{parts[1]}".encode(), hashlib.sha256).digest()
    if not hmac.compare_digest(want, sig):
        raise bad("bad signature")
    now = time.time() if now is None else now
    if not isinstance(claims.get("exp"), (int, float)) or now > claims["exp"] + LEEWAY_S:
        raise bad("expired")
    if isinstance(claims.get("nbf"), (int, float)) and now + LEEWAY_S < claims["nbf"]:
        raise bad("not yet valid")
    aud = claims.get("aud")
    if audience and aud is not None and audience not in (aud if isinstance(aud, list) else [aud]):
        raise bad("wrong audience")
    if not claims.get("sub"):
        raise bad("no subject")
    return claims


def sign_jwt(claims: dict, secret: str) -> str:
    """Test helper (and local dev): HS256 token for `claims`."""
    enc = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()  # noqa: E731
    head = enc(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = enc(json.dumps(claims).encode())
    sig = hmac.new(secret.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
    return f"{head}.{body}.{enc(sig)}"


# ---------------------------------------------------------------- encryption
def _aes(key_b64: str):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    try:
        key = base64.b64decode(key_b64, validate=True)
    except (ValueError, TypeError):
        key = b""
    if len(key) != 32:
        raise api_error("internal", "ENCRYPTION_KEY must be 32 random bytes, base64.",
                        "python -c \"import os,base64;print(base64.b64encode(os.urandom(32)).decode())\"")
    return AESGCM(key)


def encrypt(plain: str, key_b64: str, user_id: str) -> str:
    import os
    nonce = os.urandom(12)
    return "v1:" + base64.b64encode(nonce + _aes(key_b64).encrypt(nonce, plain.encode(), user_id.encode())).decode()


def decrypt(token: str, key_b64: str, user_id: str) -> str:
    from cryptography.exceptions import InvalidTag
    if not token.startswith("v1:"):
        raise api_error("internal", "Unknown key format.", "Save your Twinly key again.")
    raw = base64.b64decode(token[3:])
    try:
        return _aes(key_b64).decrypt(raw[:12], raw[12:], user_id.encode()).decode()
    except InvalidTag:
        raise api_error("internal", "Saved Twinly key could not be decrypted.",
                        "ENCRYPTION_KEY changed? Save your Twinly key again.")


# ---------------------------------------------------------------- profile store
@dataclass
class Profile:
    user_id: str
    twinly_key_encrypted: str
    label: str = ""


class ProfileStore(Protocol):
    async def get(self, user_id: str) -> Profile | None: ...
    async def put(self, profile: Profile) -> None: ...


class SQLiteStore:
    """Local dev / tests. path=":memory:" for a throwaway store."""

    def __init__(self, path: str | Path = ":memory:"):
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.lock = threading.Lock()
        self.db.execute("create table if not exists profiles (user_id text primary key, "
                        "twinly_key_encrypted text not null, label text not null default '')")

    async def get(self, user_id: str) -> Profile | None:
        with self.lock:
            row = self.db.execute("select user_id, twinly_key_encrypted, label from profiles where user_id = ?",
                                  (user_id,)).fetchone()
        return Profile(*row) if row else None

    async def put(self, profile: Profile) -> None:
        with self.lock:
            self.db.execute("insert into profiles values (?, ?, ?) on conflict(user_id) do update set "
                            "twinly_key_encrypted = excluded.twinly_key_encrypted, label = excluded.label",
                            (profile.user_id, profile.twinly_key_encrypted, profile.label))
            self.db.commit()


class SupabaseStore:
    """PostgREST `profiles(user_id uuid primary key, twinly_key_encrypted text, label text)` with the service key.
    The service key bypasses row-level security, so it stays on the backend (never sent to the browser)."""

    def __init__(self, url: str, service_key: str, transport: httpx.AsyncBaseTransport | None = None):
        self.base = url.rstrip("/") + "/rest/v1/profiles"
        self.headers = {"apikey": service_key, "Authorization": f"Bearer {service_key}"}
        self.transport = transport

    async def _req(self, method: str, **kw) -> httpx.Response:
        async with httpx.AsyncClient(transport=self.transport, timeout=10, headers=self.headers) as c:
            try:
                r = await c.request(method, self.base, **kw)
            except httpx.HTTPError as e:
                raise api_error("internal", f"Profile store unreachable ({type(e).__name__}).", "Try again.")
        if r.status_code >= 400:
            raise api_error("internal", f"Profile store error {r.status_code}.", "See the server log.")
        return r

    async def get(self, user_id: str) -> Profile | None:
        r = await self._req("GET", params={"user_id": f"eq.{user_id}",
                                           "select": "user_id,twinly_key_encrypted,label"})
        rows = r.json()
        return Profile(rows[0]["user_id"], rows[0]["twinly_key_encrypted"], rows[0].get("label") or "") if rows else None

    async def put(self, profile: Profile) -> None:
        await self._req("POST", json=[{"user_id": profile.user_id, "twinly_key_encrypted": profile.twinly_key_encrypted,
                                       "label": profile.label}],
                        headers={"Prefer": "resolution=merge-duplicates,return=minimal"})
