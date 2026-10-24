# 14 Demo, pitch, video

## 90-second live script (finals)
0:00 Hook (10 s): "Everyone has said 'um' on a stage. What if you could say it your way — and be heard the way you meant?"
0:10 Problem/people (10 s): presenters, students, people with disfluencies who want an *optional* tool, non-native speakers. "Your voice shouldn't be the price of clarity."
0:20 Live (35 s): record the messy announcement. Stage timeline runs. Point at: verbatim with um/uh kept (CrisperWhisper), Decisions bars, Gemma edit, highlight "Friday → Monday" correction.
0:55 Safety (15 s): click "Simulate bad rewrite" → guard blocks "Friday" → fallback. "We never speak something you didn't mean."
1:10 Voice (10 s): Approve → plays in the speaker's own voice (Twinly). 
1:20 Close (10 s): "Speak naturally. Be heard clearly. Still sound like yourself." Roadmap: live mode, virtual mic.

## 3-minute video (Devpost)
Screen recording + voiceover, 1080p, captions burned in. Sections: problem 20 s · live demo 90 s · architecture diagram 30 s · tech frontier + difficulties 30 s · impact/ethics 10 s. Upload to YouTube unlisted; test link logged-out.

## Judge Q&A prep
- "Is this new?" → Prior art exists (Descript, Cleanvoice). Ours: meaning guard + transparent edit log + approval + own voice in one flow; built on tech from the last 12 months.
- "Why Decisions API vs just an LLM?" → calibrated probabilities for routing and verification; auditable thresholds; guard uses them as a second opinion, not generation.
- "Why clone the voice?" → identity: the output should be *you*; text-to-speech generic voices erase that.
- "Misuse?" → only key owner's voice via Twinly consent gate; approval step; synthetic label; no other-person cloning.
- "Is it stigmatizing for stutterers?" → Optional assist, user-controlled; Minimal mode preserves everything; we consulted no one yet — say so and list feedback from affected communities as next step. Don't claim endorsements.
- "Latency/real-time?" → async by design (~10–15 s); live mode is roadmap, measured numbers shown.
- "What was hard?" → read DIFFICULTIES.md (have 3 ready stories: fillers vanishing in Whisper, self-correction meaning drift, Mac-job async voice).
- "Open source?" → MIT; ASR weights non-commercial, not bundled.

## Fresh-off-the-frontier statement (paste to Devpost)
Table: Decisions API — public beta Oct 6 2026 (router/verifier) · Gemma 4 — Apr 2 2026 (edit engine, via Gemini API) · CrisperWhisper 2.0 — mid-2026, VERIFY exact date (verbatim ASR) · Twinly Developer API — VERIFY release date (voice). Say what each does, one difficulty each, and why recent.

## Demo-day runbook
T-60 min: charge, wifi/tether, Mac awake (`caffeinate -d`), `GET /v1/me`, warm server (run one full job), volume, Chrome only, notifications off, close other apps, `HF_HUB_OFFLINE=1`.
T-10: speak-test 1 line; confirm backup audio + video on desktop.
If live fails: say "let me show the recorded run", don't debug on stage. Rehearse the failure line.
Who: one speaker (Mac owner), one driver. Practice 3×, timed.

## Visual assets
Architecture diagram (PNG in README), 1-slide deck (problem, pipeline, results table, roadmap), screenshot set for Devpost gallery (UI, diff view, guard block).
