# Devpost draft: VoiceFlow

*Draft for the submission form. Numbers are from `eval/RESULTS.md` (2026-10-24); update them if you rerun with credits.*

**Tagline:** Speak naturally. Be heard clearly. Still sound like yourself.

## Inspiration

Everyone has said "um" on a stage, or said "Friday, no wait, Monday" in an announcement. Presenters, students, non-native speakers and people with disfluencies sometimes want an optional tool that lets them speak their way and still be understood the way they meant. Existing cleanup tools rewrite your words or swap your voice for a generic one. We wanted the cleaned-up version to stay **yours**: your meaning, checked, and your voice.

## What it does

You record a messy announcement. VoiceFlow:

1. transcribes it **verbatim** with CrisperWhisper, ums and false starts included, so you see exactly what you said;
2. scores it with the OpenAI **Decisions API** (how likely each sentence has fillers, repetition or a self-correction; what register; which edit mode);
3. edits it with **Gemma 4** through the Gemini API in one of three modes (Minimal, Natural, Presenter), with a reason for every change;
4. runs a **meaning guard**: deterministic checks for numbers, times, days, names, negations, hedges, quantifiers, self-corrections, dropped or added phrases and swapped roles, plus the Decisions API as a second-opinion verifier. If the edit changes what you meant, it is blocked and the pipeline falls back: a stricter Gemma retry, then a rule-based edit, then your exact words;
5. shows verbatim vs. edit with a word diff and plain-English reasons; you can edit the text;
6. only after you **approve**, speaks it in **your own cloned voice** through the **Twinly** API, which renders it on your own Mac. The audio is labelled synthetic.

## How we built it

- **Backend:** Python, FastAPI, one module per stage (`asr`, `decide`, `rewrite`, `guard`, `voice`), pydantic models, server-sent events for live stage progress, a JSON trace entry for every stage, and a fallback ladder that always ends at your original text.
- **ASR:** CrisperWhisper 2.0 locally on Apple silicon (MPS); weights downloaded on first run, not bundled.
- **Gemma 4** (`gemma-4-26b-a4b-it`) via `google-genai`, with a 12 s per-call and 20 s total budget.
- **Decisions API** for calibrated predicates, used for routing and verification, not generation.
- **Twinly** `POST /v1/voice/speak` from our own httpx client: text packed into ≤550-char chunks at sentence boundaries, cached by hash of text + voice, rendered one at a time, 30 req/min limiter, spend counter, never retrying `job_unverified`.
- **Frontend:** a single static page in vanilla JS, three steps (Speak, Review, Hear it), live draft transcript while recording, client-side watchdog.
- **Testing:** 274 pytest tests with no network, an 80-case labelled corpus for the meaning guard, a text eval harness, a smoke script against the live server, and Playwright end-to-end tests with a fake microphone and a deliberately misbehaving fake backend.

## Challenges we ran into

- **The voice engine needed a newer macOS.** Every speak failed with `voice_starting` after ~43 s, while Twinly's API said the voice was ready. Twinly's local engine log showed `Failed to load the default metallib. This library is using language version 4.0 which is not supported on this OS.`: its MLX 0.31.2 shaders need macOS 26+. Updating the Mac to macOS 27 fixed it.
- **Two lines at once crashed the engine.** Twinly allows 2 concurrent Mac jobs, but two parallel voice jobs crashed its MLX engine (`There is no Stream(gpu, 12) in current thread`). We render one chunk at a time now, re-post a failed render once, and keep a render alive if the HTTP request times out, so a paid line is never lost.
- **No AI credits.** Our Gemini key returned `402` (prepayment credits depleted) and our OpenAI key `429` (no credits) for most of the weekend. Instead of faking it, we made the fallback useful: a rule-based self-correction rung (so "Friday, no wait, Monday" is still fixed without an LLM), health that says "no credits" instead of "ok", and an eval that reports which rung produced every output.
- **Errors inside HTTP 200.** Twinly reports `voice_not_set_up` and `voice_starting` as failed jobs inside a 200 response, so status codes alone lied.
- **Meaning drift with no numbers in it.** "CS major, business minor" -> "business major, CS minor" changes no number or name. We added content-word rules (dropped phrase, added list item, reordered roles, dropped condition) and checked them on held-out cases written before tuning.
- **Verbatim ASR is rare.** Most ASR deletes the ums we needed to show. CrisperWhisper keeps them, but needed `transformers<5`, and misheard a name, which led to the names field and Names check.

## Accomplishments that we're proud of

- The whole real pipeline works end to end on a laptop: real audio in, verbatim transcript, guarded edit, approval, and the line spoken back in the speaker's own cloned voice (a 1,172-character text in 28.6 s, in order; a repeat costs nothing).
- The meaning guard: 0 of 44 good rewrites blocked and 1 of 36 bad rewrites let through on our labelled corpus. It is small and hand-written, so we report the held-out numbers too (0/8 and 2/5 before tuning).
- It fails honestly. With two of four AI services out of credits, every job still finished in 2-3 s, explained what was offline, and never spoke a superseded "Friday".

## What we learned

- New APIs are where the time goes: the success response shape of one of our four core services (Decisions) never arrived, and the voice service needed an OS update. Verify each one with a real call before building on it, and keep the captured responses as test fixtures.
- Read the logs of the thing below the API. Both Twinly problems were invisible in its HTTP responses and obvious in its local engine log.
- Deterministic checks and an LLM judge are complementary: rules are cheap, explainable and catch numbers and negations; some meaning changes need a model.

## What's next

- Rerun the eval with Gemma and Decisions credits, and collect teammates' "sounds like me" ratings.
- Live mode (speak, edit and play sentence by sentence) and a virtual microphone for calls.
- Talk to people who stutter and speech-language professionals before shaping it further; today it is an optional tool and we claim no endorsements.
- More languages; an iMessage voice note through Twinly.

## Built with

Python · FastAPI · uvicorn · pydantic · httpx · Gemma 4 · Gemini API (google-genai) · OpenAI Decisions API · CrisperWhisper · Hugging Face transformers · PyTorch (MPS) · Twinly Developer API · ffmpeg · JavaScript · HTML/CSS · server-sent events · pytest · Playwright · macOS

## Prizes and why

| Prize | Why VoiceFlow fits | Evidence |
|---|---|---|
| **Vobile: Fresh off the frontier** | All four core technologies are from the last 12 months and central: Decisions API (public beta Oct 6 2026), Gemma 4 (Apr 2 2026), CrisperWhisper 2.0 (2026), Twinly Developer API (2026). For each: what it does here, the real difficulty, why it's recent | README frontier table, `DIFFICULTIES.md` |
| **Best Use of Twinly API** | The output is the user's own cloned voice, from our own client: chunking, caching, rate limits, `/me` health, every documented error mapped to a fix, and two engine problems found and documented (macOS 26+, concurrency crash) | real calls in `fixtures/real_twinly_speak_ok.json`, latency in `eval/RESULTS.md` |
| **MLH Best Use of Gemini (with Gemma)** | Gemma 4 through the Gemini API is the edit engine: three modes, JSON edits with reasons, guard feedback fed into a stricter retry, model id shown in the trace. Honest note: our key ran out of credits (402) during the eval, so the measured outputs came from the fallback | `backend/rewrite.py`, trace panel |
| **MLH Best Open Source Project** | MIT licence, README with quickstart and mock mode (no keys needed), 274 tests, eval harness and corpus, documented licence caveat (CrisperWhisper weights non-commercial, not bundled) | `LICENSE`, `make mock`, `make test` |
| **Tracks:** Best AI Hack, Best Social Impact, Best Design | AI as a checked assistant with a human approval step; an optional tool for people who struggle to be heard the way they mean; a three-step UI with plain-English errors, keyboard use and a contrast/size audit | screenshots, `frontend/e2e/` |

## What was offline (say it if asked)

Gemma 4 and the Decisions API had no credits during our measured runs (402 and 429). The pipeline ran on its rule-based fallback and the deterministic guard; the numbers in our eval measure that, not Gemma. Twinly, CrisperWhisper and the guard ran for real. The "demo clip" is a computer voice reading the example; the spoken output is the team member's real cloned voice.
