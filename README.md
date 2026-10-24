# VoiceFlow

**Speak naturally. Be heard clearly. Still sound like yourself.**

VoiceFlow takes a messy spoken recording (ums, repeats, "Friday, no wait, Monday"), shows you exactly what you said, proposes a cleaner version, checks that the meaning did not change, and only after you approve it speaks the result in your own cloned voice.

Built at UF Gator Hack V (Oct 23-25 2026).

<!-- TODO: demo GIF (docs/demo.gif) once the real-API run is recorded -->

## Why

Most people have said "um" on a stage. Presenters, students, non-native speakers and people with disfluencies sometimes want an *optional* tool that lets them speak their way and be understood the way they meant. Existing cleanup tools (Descript, Cleanvoice and others) edit audio or text, but they do not show their edits, verify meaning, or keep the speaker's identity in the loop. VoiceFlow's focus is three things in one flow:

1. **Transparent edits.** Your verbatim words (fillers kept) sit next to the rewrite, with a word-level diff and a reason for every change.
2. **A meaning guard.** Deterministic checks (numbers, days, names, negation, hedges, quantifiers, self-corrections) plus an AI second opinion. If the rewrite changes what you meant, it is blocked and the pipeline falls back toward your original words.
3. **Your own voice, with your approval.** Nothing is spoken until you approve the final text.

## How it works

```
 browser (static HTML + vanilla JS)
   | record / demo clip                         ^ SSE stage events (polling fallback)
   v                                            |
 FastAPI  /api/process ---> job store ---------- /api/jobs/{id}/events
   |
   +-- convert   ffmpeg -> 16 kHz mono wav
   +-- hear      CrisperWhisper: verbatim transcript (fillers kept)
   +-- decide    OpenAI Decisions API: filler / repetition / self-correction
   |             probabilities, register, recommended mode
   +-- edit      Gemma 4 via the Gemini API: minimal | natural | presenter
   +-- verify    meaning guard (rules + Decisions verifier)
   |             fallback ladder: full -> retry -> minimal -> original text
   v
 you approve the text  --->  /api/speak  --->  Twinly (your voice)  --->  audio chunks played in order
```

The browser only ever talks to this server. Twinly, OpenAI and Gemini are called from the backend, and keys stay in `.env`.

## Quickstart

```bash
make setup              # venv + dependencies (installs ffmpeg hints if missing)
cp .env.example .env    # then fill in your own keys
make mock               # try everything with recorded sample data, no keys needed
make run                # real services, http://localhost:8000
```

Open <http://localhost:8000> in **Chrome on desktop**. Press **Record** (or `Space`), or use **Use demo clip**. Microphone access needs `localhost` or https.

Frontend only, no server: open the page with `?mock=1` or tick "Offline demo data" in the footer. This runs a local simulation of the whole flow.

## Requirements

- macOS for speaking: the Twinly desktop app must be running and signed in, with a built voice clone and a Developer API key. Without it VoiceFlow still gives you the cleaned-up text; speaking is switched off and the page says so.
- Python 3.11+ and `ffmpeg` on your PATH.
- Keys in `.env`: `TWINLY_API_KEY`, `OPENAI_API_KEY` (Decisions API), `GEMINI_API_KEY` (Gemma 4 is called through the Gemini API).
- A modern Chrome. Firefox and Safari record in different formats and are untested.

## Accessibility

Built with accessibility in mind: system font at 18 px or larger, light and dark themes, visible focus rings, `Space` toggles recording, stage updates are announced through `aria-live`, and edits are shown with underline and strike-through as well as colour. We have run a keyboard-only pass in Chrome; we make no WCAG conformance claim.

## Ethics

- Only the voice of the person who owns the Twinly key is ever used, behind Twinly's own consent gate. VoiceFlow cannot clone anyone else.
- Never auto-speaks: you approve the exact final text. If the meaning guard flags the text you must tick an explicit override.
- Generated audio is labelled **synthetic** in the UI.
- It is an optional assist, not a correction of how anyone should speak. Minimal mode keeps almost everything. We have not yet consulted people who stutter or other affected communities; that is a next step and we claim no endorsements.
- No medical or therapeutic claims.

## Privacy

Uploaded audio is deleted after transcription (unless the server is started with `KEEP_AUDIO=1`). Your recording in the browser stays in memory for "Play original recording" and is gone when you reload. Transcript text is sent to OpenAI (Decisions), Google (Gemini API) and Twinly (the approved text only) to do their jobs. API keys and audio payloads are never logged.

## Licence notes

VoiceFlow is MIT licensed (see `LICENSE`). **CrisperWhisper model weights are licensed non-commercially and are not bundled in this repository**; they are downloaded by the user on first run and remain under their own licence. Gemma 4 is used via the Gemini API under Google's terms. Check each dependency's licence before any commercial use.

## Limitations

- One voice (the key owner's), English only.
- Asynchronous: roughly 10-20 seconds from recording to approved text, plus voice generation time. Not live.
- Speaking needs a Mac running Twinly; Twinly output is capped at about 2400 characters per approval.
- The meaning guard is rule-based plus an AI judge. It is a safety net, not a proof; always read the text before approving.
- The "demo clip" is a computer-generated voice reading the canonical example, not a person.

## Tests and evaluation

- `make test` runs the backend unit tests (guard, sentence splitting, and more).
- Frontend checks: headless Chrome run of the full flow against the mock server, plus a keyboard-only run.
- Evaluation table on `eval/utterances.json`: TODO, to be filled from `make eval` once the real-API run is done.

## Fresh off the frontier

| Technology | Released | Role in VoiceFlow | One difficulty |
|---|---|---|---|
| OpenAI Decisions API | public beta Oct 6 2026 | routes and scores: edit predicates, mode, register; second-opinion verifier | TODO fill from DIFFICULTIES.md |
| Gemma 4 (via Gemini API) | Apr 2 2026 | the edit engine, three modes | TODO |
| CrisperWhisper | VERIFY exact date | verbatim ASR that keeps fillers | TODO |
| Twinly Developer API | VERIFY release date | speaks the approved text in your own voice | TODO |

See `DIFFICULTIES.md` for the problems we hit.

## Project layout

`backend/` FastAPI app and pipeline stages · `frontend/` static page (`index.html`, `app.js`, `style.css`, `types.ts`, `mock-job.json`) · `fixtures/` recorded responses for `MOCK=1` · `tests/` · `docs/` design notes.

## Credits

Twinly, OpenAI, Google Gemma and CrisperWhisper for the models and APIs. Built with FastAPI, uvicorn, httpx, pydantic and ffmpeg. All project code was written during the hackathon window.
