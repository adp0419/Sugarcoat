# 13 Risks & roadblocks (with pre-decided fallbacks)

| # | Risk | Likelihood | Detect | Fallback (decided now, don't deliberate later) |
|---|------|-----------|--------|---|
| 1 | Twinly Mac offline/asleep/updating | High on demo day | `/v1/me`, `409 twinly_offline` | `caffeinate -d`; disable auto-update; run /me 10 min before; play pre-rendered audio + say so |
| 2 | Voice clone not built / only owner's voice | Med | `voice_not_set_up` | Mac-owner is the demo speaker; build clone tonight (G1) |
| 3 | Twinly latency >8 s or quality poor | Med | G1 timing | Chunk, cache, show "generating" animation; sell as announcement flow, not live |
| 4 | Credits run out | Med | spend.json | cache by text hash; MOCK in dev; ≤1 real speak per test; reserve 30 lines for demo |
| 5 | Decisions API gated/schema differs/beta flaky | Med | G2 | `DECISIONS_ENABLED=0` path; deterministic guard; don't fake outputs; tell judges |
| 6 | Gemma 4 rate limit / bad JSON / drifts meaning | Med | G3 + eval | retry→31b→minimal→original; guard blocks drift |
| 7 | CrisperWhisper install/MPS slow/licence | Med | G4 | turbo/medium; mlx-whisper + initial_prompt; document |
| 8 | Wifi at venue bad | Med | — | Pre-download weights; tether phone; fixtures + backup audio; screen-recorded video as last resort |
| 9 | Mic permission / browser quirks on demo laptop | Med | rehearsal | Chrome only; "Use demo clip" button; test on the exact laptop & mic |
| 10 | Gemma/Gemini prize ruling: local vs API; Gemma counts? | Low | ask MLH | Already via Gemini API |
| 11 | Twinly prize ruling: speak alone insufficient | Med | ask rep | Add iMessage voice-note send (stretch) so a "messaging" feature is used |
| 12 | Originality challenge (Descript etc.) | High | judge Q | Acknowledge prior art; our edge = meaning guard + transparency + own-voice delivery |
| 13 | Ethics: voice cloning misuse, stuttering stigma | Med | judge Q | Own voice only, consent gate, approve step, synthetic label, optional-assist framing |
| 14 | Team merge conflicts / env mismatch | Med | — | one module per person, `requirements.txt` pinned, `make run`, `.env.example` |
| 15 | Sleep deprivation bugs on Sun | High | — | Feature freeze Sun 1 PM; no new features after |
| 16 | Submission mistakes (private repo, missing video, wrong tracks) | Med | checklist | See 15; submit by 4 PM; open the Devpost page logged-out to verify |
| 17 | Scope creep (real-time, BlackHole) | High | — | Non-goal. Mention as roadmap only |
| 18 | Secrets leaked to git | Med | `git log -p` grep | pre-commit grep for `twk_live_|sk-|AIza`; rotate if leaked |

## Pivot trigger
If by 2 AM G1 (Twinly) fails AND can't be fixed with the Twinly rep, pivot: Elder check-in. Apple-Health-style simulated data → context-aware baseline (e.g. pickleball explains elevated HR) → Decisions picks `no_action|heads_up|call_him_now|emergency` → Twinly (Mac) texts the *family member*, who then calls the relative; 911 stands in as organizer's number for the demo. Reuses Decisions + Twinly messages. Needs a fresh plan; only on trigger.

## Silent killers to check early
- ffmpeg missing on a teammate's machine · Python version mismatch (use 3.11) · torch install size/time (start download first) · HF download throttling · port 8000 in use · `.env` not loaded (use python-dotenv at import) · Twinly key pasted with trailing newline · mp4 vs webm decoding · `audio_b64` big payload logging.

## Talk to staff early (Fri night, 5 min each)
Twinly rep: speak qualifies? credits? Mac setup help. MLH: Gemma via Gemini API counts? Open-source rules. Vobile/Fresh-frontier judge: is "within 12 months" satisfied by Decisions API (Oct 2026) + Gemma 4 (Apr 2026) + CrisperWhisper 2.0?
