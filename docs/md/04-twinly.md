# 04 Twinly API (voice output)

Docs: https://www.twinly.tech/docs/developer-api · examples: github.com/OjasMishra32/twinly-api-examples (MIT) · OpenAPI https://www.twinly.tech/openapi.yaml (VERIFY: could not fetch; read it on your machine).

## Facts (from docs)
- Base: `https://advktwnedlgnhswpxokg.supabase.co/functions/v1/twinly-api/v1`; header `Authorization: Bearer twk_live_...`
- Mac endpoints are JOBS executed on the key owner's Mac inside the running Twinly app (≥4.1.2). Requirements: Terms accepted; "Let keys text, call and run tasks as you" ON; Mac awake (`caffeinate -d`); voice clone built (Voice screen → "Build my clone", Apple silicon).
- `GET /v1/me` — free readiness check. Run first, on startup, and show status in UI.
- `POST /v1/voice/speak` body `{"text": "<=600 chars"}` → job. Result: `{"audio_b64","mime":"audio/mp4","seconds"}`. ~3 s. $0.10/line.
- `?wait=0–25`: 200 if done else 202 → poll `GET /v1/jobs/{id}?wait=25`.
- Job status: queued/running/needs_approval/done/failed/canceled/expired.
- Errors: `voice_not_set_up`, `voice_starting`, `voice_failed`, `409 twinly_offline` (Mac silent 90 s), `403 origin_not_allowed` (browser call), `429` (30/min/key), `503 job_unverified`.
- Mac runs up to 2 jobs concurrently.
- Credits: redeem the promo code on the Mac-owner's account (Settings ▸ Developer API ▸ Redeem a code, once per account).

## voice.py design
```
async def speak(text) -> list[AudioChunk]:
    chunks = pack(text, 550)
    sem = Semaphore(2)
    for each chunk: cache hit? else POST ?wait=25 → if 202 poll until done/failed/timeout 60 s
    decode base64 → write cache/{hash}.m4a → return in order
```
- `mime` is audio/mp4: browsers play it via `<audio>` on Chrome/Safari; Firefox flaky → demo on Chrome/Safari. VERIFY playback with real output.
- Return URLs `/api/audio/{hash}.m4a`; frontend chains `ended` events for gapless-ish playback.
- Retry: 429 → sleep per Retry-After (else 3 s), max 2. 503 non-`job_unverified` → retry once. `job_unverified` → STOP, surface "unsure if it ran; check Twinly", never resend.
- `voice_starting` → wait 5 s, retry up to 3×. `voice_not_set_up` → fatal UI message with fix steps.

## Gotchas
- Free plan: 5 prompts/day shared with the app; extra usage/promo keeps working. Don't burn credits in tests: use MOCK=1 and the cache.
- Voice is only the key owner's. Demo with the Mac-owner teammate as the speaker. Pitch as "bring your own Twinly".
- Mac must stay awake, signed in, Twinly app foreground-capable, not updating. Run `GET /v1/me` 10 min before every demo.
- Stretch: iMessage voice note = speak, then `POST /v1/messages` with attachment `{name,mime,b64}`, `"text":""` ($0.05; needs Messages signed in, Full Disk Access, Automation). VERIFY exact schema.
- Prize wording mentions "computer use, voice-clone calling and iMessage. macOS only" → ask the Twinly rep whether speak (+ iMessage voice note) qualifies.
- Local dev without Mac: `node mock-api/server.js` from examples repo (key `twk_live_MockKeyForTwinlyExamplesNotARealKey00000000`, base `http://127.0.0.1:4010/v1`). VERIFY it implements voice/speak; else use our own fixture.
