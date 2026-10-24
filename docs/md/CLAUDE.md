# VoiceFlow — agent brief (read first, every session)

Speak messily → verbatim ASR → Decisions API analysis → Gemma 4 edit → meaning guard → user approves → Twinly speaks it in the user's own cloned voice → playback.
Tagline: "Speak naturally. Be heard clearly. Still sound like yourself."
Event: UF Gator Hack V, Oct 23–25 2026. Submit by Sun 5 PM ET (target 4 PM). Finals Mon 10:15 AM.

## Hard rules
1. All code written during the hackathon window. No pasted project code. Copying a snippet from a lib's docs = attribute in a comment.
2. NEVER commit keys. `.env` is gitignored; commit `.env.example` only. Keys: TWINLY_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY.
3. Browser never talks to Twinly/OpenAI/Gemini (Twinly returns 403 origin_not_allowed). Backend proxies everything.
4. Gemma 4 MUST be called through the Gemini API (MLH prize). Local Ollama = offline fallback only.
5. Never auto-speak. User approves final text first. Speak only the key owner's own voice. Label audio "synthetic".
6. Never retry `POST /v1/voice/speak` after `503 job_unverified`. Max 30 req/min per Twinly key; $20 credit ≈ 200 lines — cache by text hash.
7. Every stage emits a JSON trace entry. No silent failure: fallback ladder always ends in original text.
8. Don't bundle CrisperWhisper weights (non-commercial licence). Repo is MIT; document the dependency.
9. Anything marked VERIFY is unconfirmed. Test it with a real call in docs/09-build-plan.md gates before building on it.
10. Keep DIFFICULTIES.md updated as you hit problems (judges ask).

## Stack
Python 3.11 + FastAPI + uvicorn (backend), ffmpeg, crisperwhisper[transformers], openai SDK (Decisions), google-genai (Gemma 4), httpx (Twinly), pydantic. Frontend: plain Vite + vanilla TS or single static HTML (no Next.js — speed). SSE for stage progress.

## Doc index (docs/)
01-overview · 02-architecture · 03-pipeline · 04-twinly · 05-decisions-api · 06-gemma · 07-asr · 08-meaning-guard · 09-build-plan · 10-api-contract · 11-frontend · 12-testing-eval · 13-risks · 14-demo-pitch · 15-rules-prizes · 16-env-setup

## Working style
- Build vertical slice first (ugly end-to-end), then harden. Commit every working step.
- One module per stage, pure functions, typed with pydantic, each stage independently runnable via `python -m backend.<mod> "text"`.
- Env flag `MOCK=1` stubs all network calls with fixtures so UI work never blocks on APIs.
- If blocked >20 min on a VERIFY item, take the fallback in docs/13-risks.md and move on.
