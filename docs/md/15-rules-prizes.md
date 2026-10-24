# 15 Rules, prizes, submission checklist

## Event facts
UF Gator Hack V · Oct 23–25 2026 · 48 h · Devpost: gatorhack2026.devpost.com · submissions due Sun Oct 25 5 PM ET · finals Mon Oct 26 10:15 AM, Reitz Union (one member must attend in person). Team 2–5.

## Rules to obey
- Code written during the window; existing libraries/APIs/models fine. No pre-written project code (don't fork twinly examples as base; write own client; attribute any copied snippet).
- Public repo, open licence (MIT) for Best Open Source.
- Devpost requires: title, description, public repo URL, demo video ≤3 min or slides, team roster, selected tracks + sponsor challenges.
- Judging: Impact · Technical Execution · Design & Usability · Presentation/Demo (+ novelty).

## Prizes we target (VERIFY details on Devpost)
- Main 1st/2nd/3rd
- Tracks: Best AI Hack · Best Design · Best Social Impact (track descriptions not retrieved — read them on Devpost and tailor)
- Vobile — "Fresh off the frontier": tech public within past 12 months, central to project, show what it does, difficulties, why it's recent
- Best Use of Twinly API — macOS-only; prize text mentions computer use, voice-clone calling, iMessage → confirm speak counts
- MLH Best Use of Gemini — MUST BE WITH GEMMA (ours: Gemma 4 via Gemini API)
- MLH Best Open Source Project

## Per-prize evidence to show
| Prize | Show |
|---|---|
| Vobile | frontier table, DIFFICULTIES.md, live demo of each new tech |
| Twinly | speak in own voice; `/v1/me` health; (stretch) iMessage voice note |
| Gemini/Gemma | model id in trace panel, prompt/guard design, edit reasons |
| Open source | MIT LICENSE, clean README, tests, CONTRIBUTING-lite, issues/roadmap |
| Social impact | audience framing, optional-assist ethics, consent design |
| Design | accessibility choices, diff UX, status/error states |

## README must contain
What/why · demo GIF · architecture diagram · quickstart (`make setup`, `.env`, `make run`) · requirements (Mac for Twinly, ffmpeg, keys) · tech frontier table · licence notes (CrisperWhisper weights non-commercial, not bundled) · privacy (audio deleted after ASR) · ethics statement · limitations (single voice, async, English only) · tests/eval results · credits/attribution (Twinly examples, libs).

## Submission checklist (Sun 3–4 PM)
[ ] repo public, opened logged-out [ ] LICENSE MIT [ ] no secrets (`git grep -nE "twk_live_|sk-|AIza"`) [ ] README renders [ ] video public/unlisted link works logged-out [ ] all teammates added to Devpost [ ] tracks + sponsor prizes ticked (Vobile, Twinly, MLH Gemini, MLH Open Source) [ ] frontier/difficulties text pasted [ ] screenshots uploaded [ ] finals attendee named [ ] submit, then re-open submission to confirm saved.

## Ask organizers (Fri night)
Does Gemma 4 via Gemini API qualify? Does Twinly speak qualify? Is a Devpost "built with" list required? Finals logistics (power, HDMI/USB-C, wifi, speakers for audio demo).

## Ethics & compliance lines
Own voice only; consent via Twinly owner gate; user approves text; synthetic disclosure; no storage of audio beyond processing; no claim of medical/therapeutic benefit.
