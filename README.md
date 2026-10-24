# VoiceFlow Lite

Hold to record, release to clean your transcript, then hear it in your existing Twinly voice clone. The **Voice Output** player keeps the latest generated clip available for replay, pause, seeking, and volume adjustment without another provider request.

One Node.js server, vanilla JavaScript, no runtime dependencies, framework, database, accounts, or build step. Source recordings are processed in memory. The browser retains only the current generated output until the next recording or page close.

## Run

Requires Node.js 22+; tested on Node 24.8.

```sh
cd /Users/rohit/Projects/VoiceFlowLite
npm start
```

Open [localhost:3000](http://127.0.0.1:3000), allow microphone access, and hold **Hold to Talk**. Release to process. If you released during the first microphone permission request, hold again once permission is granted. Keyboard: focus the button and hold Space. **Cancel / Stop** and Escape cancel pending work or stop playback. A new recording replaces the previous output.

The user's local `.env` is configured for live Groq → Gemma → Twinly. On a fresh checkout, no `.env` means mock mode. To configure another installation:

```sh
cp .env.example .env
```

```dotenv
APP_MODE=live
GROQ_API_KEY=your-groq-key
GOOGLE_API_KEY=your-google-ai-studio-key
GOOGLE_MODEL=gemma-4-26b-a4b-it
GOOGLE_THINKING_CONFIG={"thinkingLevel":"minimal"}
GOOGLE_STREAM=false
TTS_PROVIDER=twinly
TWINLY_API_KEY=your-twinly-key
```

Restart after changing `.env`; reload after frontend changes. `npm run dev` watches source files. Keys stay server-side. Do not put keys in `public/` or commit `.env`.

## Twinly setup

The built-in adapter implements the API in the supplied `twinly_documentation.pdf` (October 23, 2026), also identified as [Twinly Developer API](https://www.twinly.tech/docs/developer-api):

- Base URL: `https://advktwnedlgnhswpxokg.supabase.co/functions/v1/twinly-api/v1`.
- Authentication: server-side `Authorization: Bearer <TWINLY_API_KEY>`.
- `POST /voice/speak?wait=0` with `{ "text": "final cleaned transcript" }` creates a voice job and obtains its ID promptly for cancellation.
- `GET /jobs/{id}?wait=25` waits for status changes or the completed result.
- A completed job returns `result.audio_b64`, `result.mime` (normally `audio/mp4`) and `result.seconds`.
- The API key selects its owner's existing voice clone. **No voice ID is required or sent.**

Keep Twinly open on the key owner's awake Mac, signed in, with its Terms accepted and **Settings → Developer API → Jobs on this Mac** enabled. Build your clone on Twinly's Voice screen and enable the key's `voice` scope. Missing setup, offline Mac, usage limits, and approval requirements produce visible status/error messages. The app does not change Twinly's permissions or approval policy.

The documented voice API is a job API returning a **complete encoded clip**, not streaming synthesis. The adapter passes the original MP4 through without transcoding. The browser decodes it once for immediate automatic playback and exposes the same bytes in the output player for replay. There is no speculative voice generation or replacement voice.

Twinly accepts at most **600 characters per voice line**. Longer cleaned text is shown in full, with an actionable error asking for a shorter recording; it is never truncated or silently split into additional paid jobs. Successful voice lines consume Twinly usage. Check your plan and caps in Twinly.

`TWINLY_API_BASE_URL` optionally changes the documented base endpoint; HTTPS is required except for local test servers. `TTS_ADAPTER_MODULE` is an optional custom module override; leave it blank for the built-in integration. `TWINLY_VOICE_ID` is retained only for custom adapters and is unused by built-in Twinly.

## Pipeline

```mermaid
flowchart LR
  A[Hold: MediaRecorder] -->|Release: one compressed upload| B[Node server]
  B --> C[Groq transcription]
  C --> D[Conservative rule pass]
  D --> E[Gemma final cleanup]
  E -->|Final text only| F[Twinly voice job]
  E --> G[One NDJSON response]
  F -->|Completed MP4 bytes| G
  G --> H[Browser playback and replay player]
```

Browser capture prefers WebM/Opus at 32 kbps mono, then Ogg/Opus, then MP4. Groq uses its documented multipart [transcription endpoint](https://console.groq.com/docs/speech-to-text), `whisper-large-v3-turbo`, JSON output and an optional language hint (`STT_LANGUAGE=en`; blank enables detection). The original recording is uploaded without re-encoding. MediaRecorder chunks are not presented as streaming STT: Groq receives one complete file.

The tiny rule pass handles whitespace, exact silence markers, narrowly punctuated fillers and short hyphenated stutters. Quoted fillers, deliberate repetition, grammatical “that that”, and ambiguous changes go to Google. Cleanup always sees the complete transcript. No speculative skip bypasses revision handling.

Google's [Gemma documentation](https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api) lists `gemma-4-26b-a4b-it` and documents minimal thinking. **Live testing found `generateContent` working while `streamGenerateContent` returned HTTP 500.** This app therefore defaults to `GOOGLE_STREAM=false`. The selected model is preserved; there is no silent model fallback. Non-streaming requests have no claimed first-token measurement. `GOOGLE_STREAM=true` is available if you independently verify streaming for your configured model/account. Partial streamed text is displayed only in that mode.

Only a successful `STOP` completion starts TTS. Truncated, blocked or interrupted generations cannot be spoken. Sentence-level speculative synthesis would risk speaking abandoned wording; waiting for final cleanup avoids that error. Native Node fetch reuses connection pools. The page loads the same server that handles processing, warming it before the first recording.

`POST /api/process` accepts raw audio with its MIME type and returns newline-delimited JSON events: `status`, `preview`, `cleaned`, `format`, `audio`, `done`, or `error`. Base64 audio chunks add approximately 33% transfer overhead but avoid an extra browser request or server-side stored audio URL. Backpressure reaches the adapter. Custom adapters can supply mono `pcm_s16le` at 8–48 kHz for incremental WebAudio playback; encoded formats are decoded after the complete clip arrives.

## Cancellation and playback

Cancel aborts browser fetch, provider requests and bounded retry waits, stops scheduled audio, and prevents obsolete responses from playing. For a known Twinly job, the backend also makes one best-effort `POST /jobs/{id}/cancel` request with its own three-second deadline. Queued voice jobs can be canceled. **Twinly cannot cancel a running voice job**; it may finish and be charged even though this app suppresses its playback. If the creation request is interrupted before its ID arrives, the app cannot identify that job to cancel it. Check Twinly before resubmitting an ambiguous job.

Automatic playback adds no artificial review delay and offers no guaranteed cancellation window. Cancel works while processing; Stop works during initial playback and native replay. If autoplay is blocked, **Enable playback** appears and Cancel remains available. An AudioContext is unlocked during the original hold gesture and reused. Native replay stops any remaining initial playback so the two cannot overlap. Already-buffered device audio cannot always be retracted instantly.

Replay is local to the current browser tab and does not call Groq, Google or Twinly. A new recording revokes the previous output's Blob URL. Hiding the tab stops active processing/playback. Source audio is never saved by the server. Provider-side retention is governed by those services.

## Capture and latency

Manual release is the default endpoint. No intentional silence wait or encoding conversion is added. Compressed recordings cannot be safely trimmed by dropping arbitrary container chunks, so the app does not claim sample-level silence removal. Speak promptly and release at speech end.

Optional energy VAD: `VAD_SILENCE_MS=700` auto-finishes after roughly 700 ms of silence following at least 150 ms of detected voice. `VAD_RMS_THRESHOLD` adjusts sensitivity. This adds its silence interval to latency and can cut off quiet speech or pauses, so it is disabled by default. No VAD library is downloaded.

Measured **live end-to-end backend test** on October 24, 2026, using a 5.7-second synthetic speech fixture:

| Stage | Measured |
| --- | ---: |
| Request body receipt | 0.6 ms |
| Groq STT | 500 ms |
| Rule pass | 0.8 ms |
| Gemma completion | 1,872 ms |
| Twinly first/complete audio bytes | 4,403 ms |
| Total server pipeline | **6,778 ms** |

The fixture said Tuesday, then “actually, scratch that”, then Wednesday. Final output: **“Let us meet Wednesday at 3.”** Twinly returned 13,452 bytes of MP4/AAC audio. This is an observed result, not a guaranteed response time or a physical first-sound measurement. Google returned intermittent 500s in other live attempts; the app handles them with one bounded retry.

Initial targets for a warm server: capture finalization 0–50 ms, upload/STT 300–1,200 ms, rules <1–2 ms, Google completion 200–2,000 ms, Twinly job/audio 3–6 seconds, and decode/output buffering 25–150 ms. With this Twinly job API, a practical initial total target is approximately **4–9 seconds** for a short utterance. Provider queueing, cold starts and approval waits can exceed it. Twinly dominates the measured path; subsecond cloned playback is not supported by the observed API behavior.

Open **Latency** for client end-to-text, end-to-first-audio-bytes, estimated first sound, and server stage durations. Browser timings use `performance.now()`; server stages use their own monotonic clock. They are never subtracted across machines. Body receipt excludes connection establishment; provider stages include network and retry time. “End” means release/auto-stop, not a measured acoustic endpoint. When VAD is enabled its silence estimate is shown separately and included in a speech-end estimate. First sound is an output-clock estimate, not a microphone-loopback measurement.

## Reliability and limits

Defaults: 60-second recordings, 4 MiB uploads, four concurrent requests, a 25-second processing deadline, and 12 MiB TTS output (Twinly itself caps voice output at 8 MiB). Configure them in `.env.example`; increase `REQUEST_TIMEOUT_MS` if you expect slow synthesis or approval waits. No long retry queues, audio history, authentication, or database are introduced.

Groq/Google retry 429/500/502/503/504 once within a one-second delay budget. Numeric and HTTP-date `Retry-After` are honored; longer waits fail promptly. Network failures are not automatically retried. Twinly uses its own documented job-safe retry policy: bounded retries for safe rate limits and service errors, **never** automatic resubmission of `job_unverified`, `billing_unverified` or `billing_record_failed`. Known unfinished jobs get best-effort cancellation on errors. No provider, model or voice changes silently.

## Verification

The frontend uses a dark, ruled workspace with recording beside the cleaned transcript and voice output. It stacks in workflow order below 700px. Design tokens, interaction states, and reusable layout rules are documented in [DESIGN.md](DESIGN.md).

For browser checks without real microphone access or provider usage, run `npm run preview:ui` and open [the synthetic microphone preview](http://127.0.0.1:3011). This separate preview uses the production frontend, real browser recording/playback, a generated microphone signal, and mock providers; it never reads `.env`. Optional query scenarios include `?mic=denied`, `?mic=slow`, `?audio=blocked`, `?response=error`, `?response=slow`, `?response=interrupted`, and `?config=offline`. The production server exposes none of these fixtures. The synthetic transcript and tone do not validate real speech recognition or voice-clone fidelity.

```sh
npm test
npm run check:google
# Explicit paid/quota-using test: short WAV input, optional synthesized output path
npm run test:live -- /absolute/path/short-speech.wav /absolute/path/output.m4a
```

36 automated tests cover request contracts, non-streaming Gemma and optional SSE, correction instructions, completion gating, retries, safe Twinly job submission, cancellation limitations, input limits, credentials staying server-side, PCM alignment, encoded output and replay/WAV serialization.

Live checks passed: Twinly readiness (Mac online, clone ready, voice scope), Groq transcription, Gemma revision cleanup and the complete server pipeline to Twinly MP4 audio. A browser fixture using a synthetic microphone and the already-generated real Twinly clip verified automatic MP4 decoding/playback, the output player's play controls, replay and Stop without additional synthesis. That fixture's low timing readout is local playback overhead, not provider latency.

Not verified together in this session: a real browser microphone → all live providers → browser output (the in-app microphone permission request remained pending; Cancel recovered). Also not verified: mobile Safari/Android, physical cloned-voice fidelity against the user's original voice, physical first-sound timing, broad semantic accuracy, VAD tuning or hosted deployment. Voice format and playback were verified; no claim is made that every correction will be interpreted perfectly.

## Deployment

`render.yaml` defines one free Render Node service in mock mode. Push to your repository and create a Render Blueprint, then add secret keys and live configuration in its dashboard. Use `npm start`, `HOST=0.0.0.0`, the host-assigned `PORT`, and `APP_ORIGIN` equal to the exact HTTPS origin (no trailing slash). This is configuration, not an already-published deployment. HTTPS is required for microphones outside localhost.

[Render free services](https://render.com/docs/free) can sleep after 15 idle minutes and take about a minute to wake. This overwhelms voice latency. Prefer a local process or an always-on instance when speed matters; no keep-warm pings are added. Twinly still needs the key owner's awake Mac, even when this server is hosted remotely.

The server flushes responses and disables transform/proxy buffering hints; reverse proxies must pass incremental responses and allow the configured deadline. With Nginx use `proxy_buffering off`. Hosted behavior is untested. A public live endpoint lets visitors consume provider quota because authentication is intentionally absent; deploy with access and provider spending caps appropriate to your use.

## Files

```text
VoiceFlowLite/
├── .env.example, .gitignore, package.json, render.yaml, README.md
├── server.mjs
├── lib/
│   ├── config.mjs, cleanup.mjs, http.mjs, providers.mjs
│   └── tts/index.mjs, mock.mjs, twinly.mjs
├── public/index.html, style.css, app.js, playback.js
├── scripts/check-google.mjs, smoke-live.mjs
└── test/pipeline.test.mjs, playback.test.mjs, twinly.test.mjs
```
