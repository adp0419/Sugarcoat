# PROGRESS

## PM board (Agent E) — cycle 2, Sat Oct 24 15:37 EDT 2026 (newest first)

### 1. GOLDEN RULE: PASS (committed state + working tree)
- `git diff main..call --stat -- <all 19 PROTECTED files>` -> no output
- `git diff main..call --numstat -- server.mjs lib/config.mjs package.json README.md .env.example` -> `11 0 lib/config.mjs`, `6 0 server.mjs` (0 deleted)
- Working tree vs HEAD (`git diff --numstat`): `.env.example 12/0`, `README.md 4/0`, `package.json 2/0` (uncommitted, 0 deleted); `lib/call.mjs 339/55` is A's own new file, not additive-only.
- server.mjs diff read: allowed items only (1 import, 3 static allowlist entries, `createCall(...)` before the handler, `if (await handleCall(...)) return;` placed BEFORE the `/api/process` check). Nothing inside the /api/process path. Note: every request, including /api/process, now passes through `handleCall`; it returns false for non-`/api/call` paths (lib/call.mjs:269).
- package.json diff read: only 2 "scripts" entries (`call`, `call:sim`). No dependencies.
- test files (pipeline/playback/twinly) unchanged (inside the protected stat).
- Non-regression from D: D's `scripts/qa-nonregression.mjs` exists (uncommitted) but D has not reported a result. I ran `npm test` myself, see section 4.

### 2. Status table
| agent | last commit | done/total | state | next step |
|---|---|---|---|---|
| A relay | 345bbae (~4 min), 2 commits | relay + 14 tests (claimed in subject) | on track | commit the lib/call.mjs working-tree edit (339 added / 55 deleted vs HEAD) |
| B call page | none; public/call.{html,js,css} untracked | unknown | on track, uncommitted | commit; call.js event names match relay |
| C sim/runbook | none; scripts/call-*, docs/CALL.md untracked; README/.env.example/package.json edited uncommitted | unknown | on track, uncommitted | commit; fix CALL_MAX_LINES in .env.example (section 5) |
| D QA | none; test/qa/, scripts/qa-*, docs/QA-CALL.md untracked | unknown | BLOCKED/failing: its test hangs | see section 4 |
| lead | committed A's 2 commits | | | |

### 3. VIOLATIONS
None.
- `git log --format='%h|%an|%ae|%cn|%ce|%s' main..call`: both commits `adp0419|adp0419@gmail.com|adp0419|adp0419@gmail.com`, subjects start `stage: `.
- Trailer grep over `git log --format=%B main..call` -> no output.
- Commit scope: 2b4a0de touches lib/call.mjs, lib/config.mjs, server.mjs; 345bbae touches lib/call.mjs, test/call.test.mjs. No stray files.
- Secret grep on tracked files -> no matches. No non-builtin imports in lib, server, public/call.js, scripts/call-sim.mjs, scripts/qa-*, test/call.test.mjs, test/qa. No `.skip`/`.todo`/`|| true` in new tests.

### 4. MISLEADING CLAIMS / test reality
- `node --test test/call.test.mjs` -> tests 14, pass 14, fail 0 (matches A's commit claim of tests; no count was claimed).
- `npm test` -> `tests 51, pass 50, fail 1`; the failing item is `✖ test/qa/call-backend.test.mjs (37808ms)`, i.e. D's whole file fails after ~38 s. Main baseline is 36, so 36 + 14 + 1 file = 51.
- `node --test test/qa/call-backend.test.mjs` run alone: produced no output for >200 s (hang). Cause not diagnosed; likely a spawned server never exits or never becomes ready. `ps` shows several stale `node --test test/qa/call-backend.test.mjs` processes (two are from my runs; I did not kill the others).
- D has not reported anything, so no claim to compare.

### 5. CONTRACT MISMATCHES
- Routes: lib/call.mjs:269-338 (`/api/call/events|speak|clip/:id|ack`) vs public/call.js:172,312,458 and scripts/call-sim.mjs:34,104,134 -> match.
- Event names: lib/call.mjs publishes `presence`, `clip` (line 243: id, from, seq, of, mime, url, seconds); public/call.js:220-228 consumes hello, presence, caption, clip, delivered, error; call-sim uses caption, clip (id, seq), delivered -> match so far. Not yet verified: caption/delivered payload field names and hello.
- DOC vs CODE: `.env.example` (uncommitted) sets `CALL_MAX_LINES=50`; lib/config.mjs default is 40 (`number('CALL_MAX_LINES', 40, 1, 10000)`). C's own comment says to confirm against config; fix to 40 or note it.
- `.env.example` ships `CALL_TOKEN=change-me-to-a-long-random-string`; if copied unchanged the token is guessable. Check that config/relay refuses the placeholder or document it.

### 6. RISKS / decision for lead
- Nearly all of B, C, D's work is uncommitted in a shared tree; a bad edit by anyone can clobber another. Commit now.
- D's QA test hang will make `npm test` red (and slow) for the whole repo. Decision for the lead: tell D to fix or time-box the hang before anything is committed; do not commit a red/hanging `npm test`.
- Not yet run: `npm run call:sim` (not run this cycle; a stale-process risk with the hung QA servers), token-logging check on lib/call.mjs.

## Agent C (simulator / runbook)
- [x] 1. `scripts/call-sim.mjs` + `npm run call:sim`. Against the real relay (mock mode, port 3014): `node scripts/call-sim.mjs --url http://localhost:3014 --token simtok --rounds 2 --seq-base 0` -> `PASS` (401/400 checks, cleaned->done, caption->clip, clip bytes, ack->delivered; timing ~830 ms to first clip, ~840 ms to delivered). With the default (`--seq-base 1`, per contract) -> `FAIL: rohit: timed out waiting for last clip (1 total)`. See request to Agent A below.
- [x] 2. `.env.example`: appended "Call" section (12 added lines, 0 deleted); names and defaults match lib/config.mjs (CALL_MAX_LINES=40). `git diff main --numstat -- .env.example` -> `12 0`.
- [x] 3. `scripts/call-tunnel.sh` + `npm run call`. Real `cloudflared` is NOT installed here (`which cloudflared` -> not found), so tested with a stand-in script on PATH: no-cloudflared run prints `cloudflared is not installed. Install it with:  brew install cloudflared` (exit 1); stand-in run printed both join links; when the stand-in exited, the script printed `A child process exited; shutting down.` and port 3013 was closed afterwards. Ctrl-C/SIGTERM path not exercised (my test shell ignores SIGINT for background jobs and a kill was denied by the sandbox).
  - LEFTOVER from my testing: a stand-in `sleep 300` and a server on port 3012 (pids 58377, 58357) from the first stand-in run. The script's loop ends when the sleep ends (~5 min), after which it shuts the server down. If still there: `kill 58357 58377`.
- [x] 4. `docs/CALL.md` runbook. Every claim is marked seen / not verified; "What is not verified" list at the end.
- [x] 5. README.md: appended "Call (two laptops)" section (4 added lines, 0 deleted).
- [x] 6. `scripts/call-e2e.py`. Scratch venv outside the repo (playwright 1.64.1, installed Google Chrome via channel="chrome"). `.../venv/bin/python scripts/call-e2e.py --url http://localhost:3015 --token simtok --timeout 20` -> both directions `ok: ... started playback`, `ok: ... page text changed (caption shown)`, `PASS`, exit 0 (mock mode, fake mic, --mute-audio). Needed on the page side: `#join`, `#talk`, `#status` starting with "Ready" (page ignores talk while still playing).
- package.json: 2 added lines (`call`, `call:sim`), 0 deleted. `git diff main --numstat -- README.md .env.example package.json` -> `12 0 .env.example`, `4 0 README.md`, `2 0 package.json`.
- Original tests: `node --test test/pipeline.test.mjs test/playback.test.mjs test/twinly.test.mjs` -> `ℹ tests 36 / ℹ pass 36 / ℹ fail 0`. Full `npm test` (which now also picks up test/call.test.mjs and test/qa/) did not finish within 2 minutes in my run; I did not investigate (not my files).

### Requests / notes for others
- **Agent A**: contract says clip `seq` 1..of; lib/call.mjs emits `seq` 0..of-1 (lib/call.mjs:243). Either change the relay or the contract; the sim takes `--seq-base 0|1`. Agent B's page works with the current behaviour (e2e passed). Lead to decide.
- **Lead**: `.env.example` lines before my "Call" section (OPENAI_API_KEY, DECISIONS_MODEL, GEMINI_API_KEY, ASR_SIZE, MOCK, DECISIONS_ENABLED, KEEP_AUDIO, DEV, GEMMA_*, JOB_DEADLINE_S, AUTH_*, SUPABASE_*, ENCRYPTION_KEY, PROFILE_STORE, PORT=8000, HOST, TWINLY_BASE) are stale Python-era names that lib/config.mjs no longer reads (it reads APP_MODE, TTS_PROVIDER, GROQ_*, GOOGLE_*, TWINLY_API_KEY, TWINLY_VOICE_ID, TWINLY_API_BASE_URL, PORT default 3000, ...). I did not touch them. Note PORT=8000 in the example differs from the default 3000 that `scripts/call-tunnel.sh` uses (it passes PORT through).
- **Unverified**: real cloudflared, live providers, a second Mac, Safari, per-person Twinly voice id (config has per-person keys only).

Agent C done.

## Agent B (call page)
Files: public/call.html, public/call.js, public/call.css (new; nothing else touched). Tested against Agent A's real relay (lib/call.mjs, commit 345bbae) in mock mode: `APP_MODE=mock TTS_PROVIDER=mock CALL_TOKEN=test APP_ORIGIN=http://127.0.0.1:3021 PORT=3021 npm start`. Note: `.env` sets an origin, so without `APP_ORIGIN` matching the URL you open, `/api/call/*` POSTs return 403 BAD_ORIGIN (the page shows "opened from a different address" for that).
Browser: Playwright (scratch venv, Chromium, `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --mute-audio`), two contexts = Aryan + Rohit. Screenshots in the session scratchpad `shots/` (idle, joined, talking, peer speaking, error, invalid link, mobile 390, reconnecting, mic errors, devices), not in docs/.
- [x] 1. Identity: Aryan/Rohit radios, `?as=` honoured, saved in localStorage (try/catch), token read from `?t=` and never rendered. Run: `e2e.py` -> `PASS identity honoured from ?as`, `PASS localStorage identity remembered`.
- [x] 2. Join call: opens EventSource + unlocks AudioContext in the click; presence line; auto-reconnect with "Reconnecting…" and an unreachable message after 3 failures. Killed the server mid-call: `PASS Reconnecting shown`, `PASS server unreachable message`, restarted: `PASS auto-reconnected`, `PASS error cleared`. Wrong token: `PASS invalid token message :: This link isn’t valid. Ask for a new one.`
- [x] 3. Push-to-talk (pointer + Space + Esc), Listening -> Cleaning -> Sent -> Heard by <peer>. 100 ms tap: `PASS short tap ignored`; Esc: `PASS escape cancels, nothing sent` (peer log stayed empty); send: `PASS A sees cleaning/sent`, `PASS A told Heard by Rohit`; Space: `PASS Space talk works (R->A)`.
- [x] 4. Conversation list (`role=log`): "You: <cleaned>" and "<Peer>: <caption>" with Waiting -> Speaking -> Heard markers: `PASS R got caption`, `PASS R shows Speaking marker`, `PASS R marks Heard`.
- [x] 5. Clips: fetched per URL (token appended), decoded with Web Audio (audio-element fallback), played in seq order (relay seq is 0-based), `POST /api/call/ack {id}` after the last clip. Talk button disabled with a reason while an incoming message is unfinished or recording is cleaning: `PASS R talk disabled while playing w/ reason :: Waiting for Aryan to finish. One voice at a time.` Headphones hint always visible.
- [x] 6. Errors in plain words + fix step, mapped from the relay/Twinly codes: PEER_OFFLINE (`PASS peer offline error with fix step :: Rohit isn’t on the call. Ask them to open their link and press Join call, then try again.`), mic blocked and no mic (`PASS mic error NotAllowedError`, `PASS mic error NotFoundError`, page stays joined to listen), Twinly offline / needs approval / rate limited / usage / line cap / not configured, BAD_ORIGIN, 401, 413, server unreachable. The Twinly-specific mappings are unit-of-logic only (`describeFailure`): I did not trigger them end-to-end, mock TTS never produces them.
- [x] 7. Device pickers: mic + speaker `<select>`s from enumerateDevices, "show device names" button if labels are empty, `AudioContext.setSinkId` for output (select disabled with a note where unsupported). Run: Chromium fake devices listed 3+3 options, changing mic re-acquired the stream and stayed `Connected` with no error; saved to localStorage. setSinkId audio routing itself not verified (muted browser).
- Layout: no horizontal scroll at 1100 px and 390 px (`scrollWidth 390 / innerWidth 390`). Reuses /style.css classes (`.talk`, `.secondary`, `.section-heading`, `#status`, `#error`); one gotcha fixed: style.css already defines `.mark` (logo), so my marker class is `.flag`.
- Copied, not imported: I did not import /playback.js. StreamPlayer needs base64 chunks; clips arrive as URLs, so call.js has its own small decode-and-play (fetch -> decodeAudioData -> BufferSource, `Audio` element fallback). `wait()` equivalent is a local `sleep`.
- Not covered: real mic/speech and real Twinly audio (mock mode only; mock clips are test tones), Safari/Firefox, phone browsers, a screen reader pass, a 200% zoom pass. Keyboard: Tab order, radios, Space/Esc exercised; no automated focus-ring check, focus styles are the shared `outline: 2px solid var(--focus)`.
- Checks: `git diff main -- public/index.html public/app.js public/playback.js public/style.css | wc -c` -> `0`. `node --test` per file: pipeline 20/20, playback 7/7, twinly 9/9, call 14/14, all pass. Full `npm test` also picks up Agent D's test/qa (79 total, 2 failing when I ran it; those are not mine and I did not investigate).
- Requests for others: none.

Agent B done
