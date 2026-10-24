# 11 Frontend & UX

Stack: single `index.html` + `app.ts` (Vite optional) + CSS. No framework needed; ≤400 lines JS. Served by FastAPI at `/`.
Design brief: calm, accessible, confident — not "fix your speech". Large type, high contrast, dark/light via `prefers-color-scheme`, visible focus rings, `aria-live` for stage updates, keyboard-operable (Space = record toggle), captions for all audio.

## Layout (single page, top → bottom)
1. Header: name + tagline + status dots (ASR, Decisions, Gemma, Twinly voice) from `/api/health`.
2. Controls: big Record button (timer, 45 s cap, waveform via AnalyserNode), Mode segmented control (Auto/Minimal/Natural/Presenter), "Protected terms" input.
3. Stage timeline: convert → hear → decide → edit → verify → ready; each shows ms + state; fallback rung badge.
4. Two columns: LEFT "What you said" (verbatim, fillers underlined); RIGHT "What will be spoken" (editable textarea, edits highlighted green/strike red via diff; hover chip shows reason).
5. Decisions panel: probability bars for predicates, recommended mode chip, register chip. Guard panel: ✓/✗ per rule with plain-English violations.
6. Actions: **Approve & speak in my voice** (disabled until guard pass or explicit override checkbox), "Play original recording", "Try another mode", "Simulate bad rewrite" (dev toggle).
7. Output: audio player with synthetic-audio label "Generated in your voice with Twinly", download button, seconds.
8. Footer: licenses, "Your audio is deleted after transcription", GitHub link.

## States to implement (each needs UI)
idle · recording · uploading · processing(stage n) · ready · guard-failed(fallback shown) · speaking · playing · error(with hint) · twinly-offline (record disabled, text-only mode) · mic-denied (instructions) · unsupported-browser (Firefox/Safari quirks).

## Mic specifics
`getUserMedia` requires https or localhost. Request permission on first click, not on load. Handle `NotAllowedError`. Pick `MediaRecorder.isTypeSupported` mime in order: webm;opus, mp4. Stop tracks after recording. Chrome desktop is the supported demo browser.

## Playback
Chain chunk `<audio>` elements via `ended`; preload next. Show karaoke-style highlight per chunk (optional). Autoplay blocked? Playback begins from the user's Approve click — a user gesture, so fine; call `audio.play()` inside that handler chain (prime a silent play on click).

## Diff rendering
Token diff using `diff` lib from CDN (pin version) or own LCS on words. Highlight uses color + underline/strike (not color alone — accessibility).

## Demo polish (cheap wins)
Pre-fill a "Use demo clip" button (loads fixtures audio so no live mic risk). Animated stage progress. Copy-to-clipboard of the cleaned text. Favicon + title. Responsive to projector 1280×720; font ≥18 px.

## Don'ts
No localStorage-required logic; no external fonts that block offline demo (use system stack); no calls to third-party APIs from browser; no autoplay on load.

## Accessibility claim
Don't claim WCAG compliance; say "built with accessibility in mind" and actually test: keyboard-only run, contrast check, screen-reader labels on buttons.
