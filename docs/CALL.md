# Call runbook (two MacBooks)

Aryan and Rohit each open a page. When one holds the talk button, the other hears the cleaned-up text in the speaker's Twinly voice, and the reverse.

**The original single-user page at `/` is unchanged.** The call is a separate page (`/call`) and separate endpoints (`/api/call/*`). Nothing here changes how `/api/process` works.

Status legend: **[seen]** = I ran it and saw it. **[not verified]** = written from the design, not yet observed. See the last section.

## How it works

Both laptops open the same HTTPS address, which is a free `cloudflared` quick tunnel pointing at Aryan's server. Browsers only allow the microphone on `localhost` or HTTPS, which is why the tunnel exists. The server runs the existing pipeline (Whisper, cleanup, Twinly) and sends the listener a caption plus audio clips. The speaker's own browser gets status text only, never audio.

Twinly is called with the **speaker's** key, so the key owner's Mac must be awake with Twinly open.

## Prerequisites

Aryan (host):
- Node 22 or newer (`node -v`).
- `cloudflared`: `brew install cloudflared` **[seen: `npm run call` prints this hint when it is missing]**.
- A `.env` in the repo with the live keys (`GROQ_API_KEY`, `GOOGLE_API_KEY`, `TWINLY_API_KEY`, `TWINLY_VOICE_ID`), `APP_MODE=live`, `TTS_PROVIDER=twinly`. Never paste these into chat or commit them.
- Twinly open and signed in, voice clone ready, **Jobs enabled**.
- Mac kept awake: run `caffeinate -d` in a spare terminal tab for the whole call.

Rohit:
- Chrome or Safari on a MacBook, mic permission allowed for the browser (System Settings > Privacy & Security > Microphone).
- Headphones on. Without them the mic picks up the other person's voice and it loops.
- Nothing to install. If Rohit later uses his own Twinly key, his Mac needs Twinly open, signed in, voice clone ready, Jobs enabled and awake (`caffeinate -d`) too.

## Commands

Aryan, in the repo:

```bash
caffeinate -d &        # or in another tab; keeps the display and Mac awake
npm run call
```

`npm run call` starts the server (with `TRUST_PROXY=1`, and a `CALL_TOKEN` generated if you have not set one in the shell or `.env`), starts the tunnel, and prints:

```
Aryan: https://<random>.trycloudflare.com/call?as=aryan&t=<token>
Rohit: https://<random>.trycloudflare.com/call?as=rohit&t=<token>
```

**[seen with a stand-in `cloudflared`; not yet with the real one]**. The URL changes every run. Ctrl-C stops the server and the tunnel and nothing else.

To rehearse without any provider calls, start with mock mode (no keys needed):

```bash
APP_MODE=mock TTS_PROVIDER=mock npm run call
```

### How Rohit joins

1. Aryan sends Rohit **only Rohit's link** (the `as=rohit` one) over a private channel. The token in it is the password.
2. Rohit opens it, allows the microphone, and presses Join.
3. Aryan opens his own link on his Mac the same way. Each page shows whether the other person is online.
4. Hold the talk button (or Space), speak, release. Take turns.

## Whose Twinly key is used

The speaker's. The server looks for `TWINLY_API_KEY_<NAME>` and falls back to `TWINLY_API_KEY` (this is how `lib/config.mjs` reads it).

| Today | |
|---|---|
| Aryan speaking | `TWINLY_API_KEY_ARYAN`, else `TWINLY_API_KEY` (Aryan's) |
| Rohit speaking | `TWINLY_API_KEY_ROHIT`, else `TWINLY_API_KEY`, which is **Aryan's** key today |

So today both voices go through Aryan's Twinly account: Aryan's Mac must be awake with Twinly open and Jobs on, and **both people speak in Aryan's cloned voice**. Twinly picks the voice from the API key (there is no voice id), so Rohit gets his own voice once `TWINLY_API_KEY_ROHIT` holds his key and his Mac is awake with Twinly open and Jobs on.

To switch Rohit to his own key: put his key in `.env` as `TWINLY_API_KEY_ROHIT=...` on the server, restart `npm run call`, and make sure Rohit's Mac has Twinly open with Jobs enabled. Rohit sends the key to Aryan privately, never in the shared link.

## Errors and fixes

Only messages I have seen in the code or in a run are listed. Wording from the real relay may differ; the code values are stable.

| Message / status | Meaning | Fix |
|---|---|---|
| 401 `Invalid call token.` | Wrong or missing `t=` in the link | Re-copy the full link from the `npm run call` output |
| 400 `Unknown participant.` | `as=` is not one of the two names | Use `as=aryan` or `as=rohit` |
| 503 `Set CALL_TOKEN on the server to enable calls.` | Server started without a token | Start with `npm run call` (it generates one) or set `CALL_TOKEN` |
| 503 `Set TWINLY_API_KEY on the server to enable Twinly cloned voice playback.` | `TTS_PROVIDER=twinly` with no key | Set the key in `.env`, restart |
| 503 `Live mode requires GROQ_API_KEY and GOOGLE_API_KEY on the server.` | `APP_MODE=live` without keys | Set both in `.env`, restart |
| 413 `Recording is too large.` | Talked too long | Shorter turns (limit `MAX_RECORD_SECONDS`, default 60) |
| 429 `Server is busy. Retry in a moment.` | Too many requests at once | Wait a second, talk again |
| Twinly job never finishes | Key owner's Mac asleep, Twinly closed, or Jobs off | Wake the Mac, open Twinly, enable Jobs. Speak one at a time; concurrent jobs have crashed the Twinly engine before |
| Tunnel link stops loading | `cloudflared` exited or Aryan's Mac slept | Restart `npm run call`; links change, resend Rohit's |

Anything else the relay or page adds is **[not verified]** here.

## Pre-demo checklist

- [ ] `node -v` is 22+; `cloudflared --version` works.
- [ ] `npm test` is green.
- [ ] Rehearsal passed in mock mode: `npm run call:sim` against a local server (see Testing) prints `PASS`.
- [ ] `.env` has live keys; Twinly open, signed in, voice clone ready, Jobs enabled.
- [ ] `caffeinate -d` running; Mac plugged in.
- [ ] `npm run call` running; both links printed.
- [ ] Rohit opened his link, allowed the mic, is online on Aryan's page.
- [ ] Headphones on, both sides.
- [ ] One short live test sentence each way before the audience arrives.
- [ ] The original page still works: `http://localhost:3000/` hold-to-talk as before.

## Testing without people

Simulator (headless, Node built-ins only, no devices). Start a server in mock mode, then:

```bash
PORT=3011 CALL_TOKEN=simtok APP_MODE=mock TTS_PROVIDER=mock node server.mjs &
npm run call:sim -- --url http://localhost:3011 --token simtok --rounds 2
```

It checks: wrong token gives 401, unknown name gives 400, each direction's sender gets `cleaned` then `done` (no audio), the peer gets `caption` then clips `seq 1..of` in order, each clip URL returns bytes, and after the ack the sender gets `delivered`. It prints a timing table and exits non-zero on any failure.

Browser smoke test (two Chrome contexts, fake mic, muted). Use a scratch venv outside the repo:

```bash
python3 -m venv ~/call-e2e-venv
~/call-e2e-venv/bin/pip install --upgrade playwright
~/call-e2e-venv/bin/python scripts/call-e2e.py --url http://localhost:3011 --token simtok
```

It uses the installed Google Chrome (add `--chromium` for Playwright's bundled one; run `playwright install chromium` first). Chrome runs with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --mute-audio`, so nothing is played aloud. Set `CALL_E2E_SHOTS=1` to save screenshots. It expects the page elements `#join` and `#talk`.

## Delivery: long-poll, not SSE

A cloudflared quick tunnel (2026.10.3) holds an entire `text/event-stream` response until it closes, padding or not, so SSE events never reached the other Mac. The page therefore long-polls `GET /api/call/poll?as=&t=&after=<last id>`: the server answers at once when newer events exist, otherwise holds up to 25 s and returns `[]`. Each reply carries `peerOnline`, and a polling person counts as online. `/api/call/events` (SSE) still exists for local tools such as `call:sim`.

Verified on 2026-10-24: `scripts/call-e2e.py` passes through a real quick tunnel in both directions (caption shown, clip played, marked Heard).

### Troubleshooting: "text/audio never arrives"

The server log prints one line per relay step:

- `{"call":"publish","to":"rohit","event":"clip",...,"conns":N}`: the event was queued for that person.
- `{"call":"clip-get","id":...,"status":200}`: the receiving page fetched the audio. If `publish` lines appear but no `clip-get`, the receiving page is not polling; reload it.
- `{"call":"stream",...}`: an SSE client opened or closed.

## What is not verified


- Anything with live providers (Groq, Google, Twinly) or a second physical Mac.
- Safari behaviour (autoplay rules, mic permission) on the real Macs.
- A long call across Wi-Fi changes.
