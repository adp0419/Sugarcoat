# 01 Overview

## Product
User records a messy spoken announcement. VoiceFlow shows verbatim transcript, what it will change and why, a cleaned version, and (after approval) plays it back in the user's own cloned voice (via Twinly).
Not a replacement for natural speech; an optional layer. Never frame stuttering as a defect (Samsung Impulse / SPACE backlash). Lead with "say it your way, deliver it your way."

## Canonical demo utterance
IN : "So, um, I just wanted to, uh, announce that we're going to have our meeting on Friday—actually, sorry, Monday, at 5 PM, and, um, everyone should be there."
OUT: "Our meeting will take place on Monday at 5 PM. Everyone should attend."
Must-hold facts: Monday (NOT Friday), 5 PM, everyone.

## MVP scope (tonight)
- Record in browser (MediaRecorder) → upload → ASR verbatim
- Decisions API: pick mode + per-sentence "leave unchanged?"
- Gemma 4 rewrite, modes Minimal / Natural / Presenter
- Meaning guard (deterministic + Decisions) with fallback ladder
- Twinly speak, chunked ≤600 chars, ordered playback
- UI: side-by-side transcripts, highlighted edits with reasons, decisions panel, stage timeline
- Pre-rendered fallback audio for the demo utterance

## Explicit non-goals
Real-time/live mode, virtual mic/BlackHole, multi-user accounts, mobile app, calls, training any model, cloning other people's voices.

## Differentiation (be honest, prior art exists)
Prior art: Descript Overdub+filler removal, Cleanvoice, STEAMROLLER paper, FluentSpeech. Don't claim "first".
Our novelty: (1) meaning guard that blocks changed dates/numbers/negations/hedges, (2) Decisions API as routing + verifier (not a gimmick), (3) transparent edit log the user approves, (4) output in the speaker's own voice via Twinly.

## Success criteria
- Demo utterance end-to-end < 20 s, works 5/5 times.
- Guard catches a deliberately-bad rewrite (Friday instead of Monday) live.
- Judges can see Decisions API, Gemma 4, CrisperWhisper 2.0, Twinly each doing real work.
- Repo public, MIT, README with setup + diagram, ≤3 min video.

## Audience framing
People who want clearer delivery: public speaking anxiety, students, professionals, optional speech assistance for people with disfluencies, non-native speakers. Voice identity preserved.
