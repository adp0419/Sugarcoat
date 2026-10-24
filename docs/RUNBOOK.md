# Demo-day runbook

One page. Print it. Finals: Mon Oct 26, 10:15 AM, Reitz Union. One speaker (the Mac owner, whose voice Twinly cloned) and one driver.

## What the real setup is (checked 2026-10-24)

- MacBook, Apple silicon, **macOS 26 or newer** (we run 27.0.1). On macOS 15 Twinly's voice engine fails with `Failed to load the default metallib ... language version 4.0` and every speak ends in `voice_starting`.
- Twinly app 4.2.1, signed in, voice clone built, "Let keys text, call and run tasks as you" on, API credits redeemed.
- Its local voice engine answers on **`http://127.0.0.1:4807/health`**. Good: `{"ok": true, "clone": true, ..., "fast": true, "quality": true}`.
- VoiceFlow on port 8000, real mode (`make run`). Gemma (402) and Decisions (429) have **no credits** as of 2026-10-24: `/api/health` reports `no_credits` for them and the deterministic fallback does the edit. That is expected; the demo still works. If someone adds credits, they come back without a code change.
- Backup audio: `fixtures/backup_demo.m4a` is the canonical line ("Our meeting will take place on Monday at 5 PM. Everyone should attend.") in the owner's cloned voice, 3.8 s. `make mock` plays it; it is also served at <http://localhost:8000/api/audio/backup_demo.m4a>.

## The night before
- [ ] `make warm` once (downloads the ASR weights), then `make test` (no network, should be all green).
- [ ] Copy `fixtures/backup_demo.m4a` to the desktop as `backup-voice.m4a`, next to the screen-recorded demo video.
- [ ] Optional: re-record `frontend/demo-clip.m4a` with the speaker's real voice (today it is a macOS `say` voice). It must contain the um, the repeat and "Friday, no wait, Monday". Then `make smoke` must still pass.
- [ ] Twinly: auto-update off. macOS: no pending OS update, Energy settings prevent sleep.
- [ ] Check spend: `cat logs/spend.json` (lines counted by VoiceFlow) and the Twinly usage page. One line costs about $0.10.

## T-60 minutes
1. Charger in, wifi or phone tether working, Focus mode on, other apps closed.
2. `caffeinate -d` in a terminal; leave it running.
3. **Twinly engine:** `curl -s http://127.0.0.1:4807/health`. If it fails or says `"ok": false` or `"loading": true`: quit Twinly (Cmd+Q), reopen, wait about a minute, check again. Don't debug speak before this is ok.
4. **Twinly account** (free, does not print the key):
   ```bash
   set -a; source .env; set +a
   curl -s -H "Authorization: Bearer $TWINLY_API_KEY" "$TWINLY_BASE/me" | grep -o '"online":[a-z]*\|"voice":[a-z]*'
   ```
   Want `"online":true` and `"voice":true`.
5. Start the server: `HF_HUB_OFFLINE=1 make run`. Then `curl -s localhost:8000/api/health`: want `asr_loaded:true` (a few seconds after start) and `twinly: {online:true, voice_ready:true}`. `gemma`/`decisions` = `no_credits` is fine.
6. **`make smoke`** (5 runs of the demo clip, free). Want `5/5 ok`, each run under ~4 s. Measured 2026-10-24: 2.5 s per run.
7. **One paid line:** `SPEAK=1 N=1 make smoke`, or in the page: Use demo clip, Approve, hear it. Short lines take 4-8 s to come back.
8. Open <http://localhost:8000> in **Chrome**, volume up, test the venue speakers or HDMI audio.

## T-10 minutes
- [ ] Engine health ok again (step 3). Speak-test one line.
- [ ] `backup-voice.m4a` and the demo video are on the desktop.
- [ ] Names field filled in ("Aryan Patel", "Gator Hack") so speech recognition can't mangle them.
- [ ] Mode Auto, "Simulate bad rewrite" off, page at the top.

## When something fails live
Rule: don't debug on stage. Say the line, take the way out, keep talking.

| Stage | What you see | What to do | What to say |
|---|---|---|---|
| Record | Mic blocked or silent | **Use demo clip** | "Here's the same announcement, recorded." |
| Hear (ASR) | Stuck on "hearing" > 15 s, or a "no speech" error | **Try again**; if still stuck, **Use demo clip** | — |
| Edit (Gemma) | "No credits" / "AI editor unavailable" note, or "taking longer than usual" | Nothing to do: the rule-based edit is shown. If stuck, **Use text without AI edit** | "When the AI editor is down, we fall back to rules, and we say so." |
| Check | Meaning check blocked (red) | If it's the planned demo, untick Simulate bad rewrite. Otherwise read the reason out; the text falls back to your own words | "We never speak something you didn't mean." |
| Speak | "Voice engine still starting" | Wait 30-60 s, approve again | "The voice model is waking up." |
| Speak | "Twinly took too long" | Press speak once more: the line keeps rendering and the retry plays it from cache, no extra charge | — |
| Speak | "Can't reach the Twinly app" / "clone isn't set up" / engine health not ok | Play `backup-voice.m4a` from the desktop | "Let me play the line it made earlier, in my voice." |
| Speak | "Couldn't confirm whether it spoke this line" (`job_unverified`) | **Do not press speak again** (may charge twice). Play `backup-voice.m4a` | — |
| Anything | Page error / server down | Switch to the demo video | "Let me show the recorded run." |

## Finals logistics
- [ ] One team member attends in person; named on Devpost as the finals attendee.
- [ ] Ask organizers: power at the table, HDMI or USB-C adapter, wifi, speakers for audio.
- [ ] Bring USB-C/HDMI adapter, charger, phone for tethering.
- [ ] Chrome only, zoom 100%, projector at 1280x720 works.
- [ ] 90-second script rehearsed 3x with a timer, including the failure line.

## Submission checklist (docs/md/15), status 2026-10-24 ~11:00

| Item | Status |
|---|---|
| Repo public, opened logged-out | **Not done**: repo visibility is the owner's call; flip it, then open the URL in a private window |
| LICENSE is MIT | **Done** (`LICENSE`, MIT, 2026) |
| No secrets in the tree or history (`git grep` + `git log -p` for `twk_live_…`, `sk-proj-`, `sk-…`, `AIza…`, `AQ.A`) | **Done**: the only hit is Twinly's public example mock key quoted in `docs/md/04-twinly.md` (`...NotARealKey...`). `.env` was never committed; `.env.example` has blank keys |
| No large binaries beyond demo assets | **Done**: biggest file is `docs/demo.gif` (2.1 MB), then screenshots (<0.4 MB); audio is `fixtures/backup_demo.m4a` (20 KB) and `frontend/demo-clip.m4a` (64 KB) |
| README renders, links resolve | **Done locally** (every linked file exists); check on GitHub once public. T3 is regenerating screenshots: re-check names after their commit |
| Demo video ≤3 min, unlisted link works logged-out | **Not done** |
| All teammates added on Devpost | **Not done** |
| Tracks + sponsor prizes ticked (Vobile, Twinly, MLH Gemini, MLH Open Source) | **Not done** (list and reasons in `docs/DEVPOST.md`) |
| Frontier / difficulties text pasted | **Not done**: draft ready in `docs/DEVPOST.md` |
| Screenshots uploaded to the Devpost gallery | **Not done** |
| Finals attendee named | **Not done** |
| Submit, then re-open the submission to confirm it saved | **Not done** (deadline Sun Oct 25 5 PM ET, target 4 PM) |
