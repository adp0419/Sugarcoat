# QA: Aryan <-> Rohit call

Owner: Agent D (QA). Mock mode only (`APP_MODE=mock TTS_PROVIDER=mock`); no live Twinly/Groq/Google calls.
Status key: PLANNED / PASS / FAIL / BLOCKED. Nothing is marked PASS unless it was run (command + result in the Report section).

## Test plan

### NR: non-regression (re-run after every commit by A, B or C)
Command: `node scripts/qa-nonregression.mjs`

| ID | What | How | Pass criteria |
|---|---|---|---|
| NR-1 | Protected files untouched | `git diff main --stat -- <protected list>` | empty |
| NR-2 | Additive-only files | `git diff main --numstat -- server.mjs lib/config.mjs package.json README.md .env.example` | 0 deleted lines each |
| NR-3 | Existing tests | run `pipeline/playback/twinly` test files on branch and on a `git archive main` copy | same pass count (main = 36), 0 fail |
| NR-4 | /api/process contract | same tiny audio to main and branch servers, mock mode | same status, content-type, NDJSON event type + field sequence, same 415 error shape |
| NR-5 | `/` page | fetch `/` on both | identical element ids, scripts, links; no mention of `/call`; `/app.js`, `/healthz`, `/api/config` byte-identical |

### BE: backend black-box (`test/qa/call-backend.test.mjs`, spawned server on random port, mock mode, known CALL_TOKEN)

| ID | What | How | Pass criteria |
|---|---|---|---|
| BE-1 | Token wrong/missing/malformed (empty, array, very long, whitespace, unicode) on events, speak, clip, ack | request each | 401, no body leak |
| BE-2 | Unknown name (`as=mallory`, empty, array, `__proto__`, case variants) | request each route | 400 |
| BE-3 | Oversize audio | body > MAX_AUDIO_BYTES, with and without Content-Length | 413, server alive |
| BE-4 | Empty body | POST speak with 0 bytes | 400 |
| BE-5 | Wrong content-type | text/plain, none, json | 415 |
| BE-6 | Clip id guessing / traversal | `../`, `%2e%2e%2f`, `%00`, 10 KB id, unknown uuid, `..\\` | 404/400, never file contents, no stack trace |
| BE-7 | Clip TTL | short TTL via config if exposed, else mark BLOCKED | 404 after TTL |
| BE-8 | Burst of POSTs | 40 concurrent speak requests | some 429, no crash, server still answers /healthz |
| BE-9 | Disconnect mid-request | abort speak mid-flight; check via /healthz and a follow-up speak | follow-up works; no leaked busy slot |
| BE-10 | SSE reconnect | connect, close, connect again | fresh `hello` each time |
| BE-11 | Same name connected twice | two SSE for aryan | defined behaviour: both get events or old one closed; no crash; presence correct after one closes |
| BE-12 | Peer never connects | rohit offline, aryan speaks | clear error to sender, no clip created, mock TTS not invoked |
| BE-13 | Heartbeat | read SSE > 15 s (or config shortened) | `:ping` seen |
| BE-14 | Ordering | two utterances back to back | peer gets caption/clip in order |
| BE-15 | Long text split | >600 chars via injected Gemma | clips with seq/of ascending, in order, each <= 600 chars |
| BE-16 | Origin check | mismatched Origin -> 403; TRUST_PROXY=1 + x-forwarded-proto/host consistent -> OK; TRUST_PROXY unset + forwarded headers do not bypass | as stated |
| BE-17 | Spend cap | CALL_MAX_LINES=2, send 3 | 3rd blocked with plain message, no render |
| BE-18 | ack flow | peer acks clip id | sender gets `delivered {id}`; bogus id / own id ack harmless |
| BE-19 | Sender gets no audio | read full NDJSON of speak | types only status/preview/cleaned/done/error; no base64 audio |

### SEC: security (`test/qa/call-security.test.mjs`)

| ID | What | How | Pass criteria |
|---|---|---|---|
| SEC-1 | Token not in server logs | capture stdout/stderr of spawned server across a session | token string absent |
| SEC-2 | Token not in any response body | grep every response body/headers of all routes | absent (the page URL may carry it; response bodies/headers may not) |
| SEC-3 | .env values not in responses | start with sentinel values for TWINLY_API_KEY_*, GROQ/GOOGLE keys | sentinels absent from all bodies/headers/logs |
| SEC-4 | CSP | /call response headers; /call HTML has no inline script, no inline handlers | `script-src 'self'` header present |
| SEC-5 | No audio on disk | snapshot `cache/` and cwd mtime/listing before/after | unchanged |
| SEC-6 | Error messages | provoke failures | no stack, no `at file:`, no provider URL / supabase host |
| SEC-7 | CALL_TOKEN unset | start with none | call routes 503, not open |
| SEC-8 | Token compare | wrong token of same length / prefix | 401 (constant-time not testable black-box; reviewed by reading code) |

### FI: failure injection (`test/qa/call-failure.test.mjs`, `createApp(config,{fetchImpl,synthesize})`)

| ID | What | Pass criteria |
|---|---|---|
| FI-1 | Gemma 500 | sender gets plain `error`, stream ends, peer gets `error` or nothing misleading |
| FI-2 | Twinly twinly_offline | plain-language error, stream ends |
| FI-3 | needs_approval | plain-language error, stream ends |
| FI-4 | rate_limited | plain-language error, stream ends |
| FI-5 | job_unverified | plain-language error, exactly ONE POST to /voice/speak (never retried) |
| FI-6 | Serial rendering per key | two concurrent speaks with one key: max concurrent /voice/speak == 1 |

### BR: browser (`scripts/qa-browser.py`, scratch venv Playwright, Chrome `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --mute-audio`)

| ID | What | Pass criteria |
|---|---|---|
| BR-1 | Both join | each page shows connected + peer online |
| BR-2 | A talks -> B | B shows caption and starts a clip |
| BR-3 | B talks -> A | same, reversed |
| BR-4 | Talk disabled while a clip plays | button disabled/aria-disabled during playback |
| BR-5 | Mic denied | plain-words message, page still usable |
| BR-6 | SSE drop + recovery | restart server; page shows reconnecting then recovers |
| BR-7 | Wrong token | clear message |
| BR-8 | Keyboard only | Tab order sane, Space talks, Escape cancels |
| BR-9 | 390 px viewport | no horizontal scroll |
| BR-10 | Focus rings + contrast | visible focus outline; text contrast >= 4.5:1 |
| BR-11 | Original `/` still records and plays | mock mode: talk, get audio, no console errors |

### Go / no-go
Go for live keys only if: NR all pass, no open blocker/major bugs, FI-5 passes, SEC all pass.

## Bugs
(none filed yet)

## Report
(filled in as cases are run)
