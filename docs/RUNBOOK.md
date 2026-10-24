# Demo-day runbook

One page. Print it. Finals: Mon Oct 26, 10:15 AM, Reitz Union. One speaker (the Mac owner, whose voice Twinly cloned) and one driver.

## The night before
- [ ] **Re-record the demo clip.** `frontend/demo-clip.m4a` is currently a macOS `say` voice, not a person. The demo speaker records the canonical announcement (with the um, the repeat, and "Friday, no wait, Monday"), saves it as m4a, and replaces `frontend/demo-clip.m4a`. Check that "Use demo clip" transcribes it correctly with `make run`.
- [ ] **Make the backup audio.** After one good real run, copy the newest `cache/*.m4a` (that's the line spoken in your voice) to the desktop as `backup-voice.m4a`. Also keep the screen-recorded demo video on the desktop.
- [ ] `make warm` once on venue-independent wifi (downloads the ASR weights; they are big).
- [ ] In Twinly: voice clone built, credits redeemed, Settings ▸ Developer API key works, auto-update off, Energy settings set to prevent sleep.

## T-60 minutes
1. Charge the Mac and plug it in. Wifi or phone tether working. Notifications off (Focus mode). Close other apps.
2. `caffeinate -d` in a terminal; leave it running.
3. **Restart Twinly's voice engine:** quit Twinly (Cmd+Q), reopen it, sign in if asked, and **wait about a minute** until the Voice screen says ready. (Right after launch, speak requests return `voice_starting`; VoiceFlow says "still starting up" and asks you to wait.)
4. Check Twinly answers, without printing the key:
   ```bash
   set -a; source .env; set +a
   curl -s -H "Authorization: Bearer $TWINLY_API_KEY" "$TWINLY_BASE/me" | head -c 300; echo
   ```
   You should see your account JSON, not an error.
5. Start the real server (not mock), offline-safe:
   ```bash
   HF_HUB_OFFLINE=1 make run
   ```
6. Open <http://localhost:8000> in **Chrome**. All four status dots green (Hearing, Decisions, Gemma, Your voice). No "Demo mode" banner: if you see it, you started `make mock` by mistake.
7. **Five clean runs in a row:** `make smoke` ×5 (if `make smoke` isn't in the Makefile yet: in the page, Use demo clip → Approve & speak → hear it, five times). Any failure resets the count. The first run warms the models, so it is slower.
8. Volume up; test the venue speakers or the HDMI audio with one line.

## T-10 minutes
- [ ] Speak-test one line live.
- [ ] `backup-voice.m4a` and the demo video are on the desktop.
- [ ] Names field filled in ("Aryan Patel, Gator Hack" or whatever the script says) so speech recognition can't mangle them.
- [ ] Mode set to Auto. "Simulate bad rewrite" unticked. Page scrolled to the top.

## When something fails live
Rule: don't debug on stage. Say the line, take the way out, keep talking.

| What you see | What to do | What to say |
|---|---|---|
| Mic doesn't work / permission prompt | Press **Use demo clip** | "Here's the same announcement, recorded." |
| Stuck on a stage; yellow box "taking longer than usual" | Press **Use text without AI edit** (filler words removed, nothing else) or **Try again** | "The AI editor is slow on venue wifi; this is the safe path." |
| "Why this text looks like this" box (fallback) | Read it out; it says what was and wasn't changed | "When the AI can't be trusted, we fall back to your own words." |
| Meaning check blocked (red) | That's the demo of the guard; untick Simulate bad rewrite | "We never speak something you didn't mean." |
| "Still starting up" when speaking | Wait 30–60 s, press Approve again | — |
| "Can't reach the Twinly app" / "voice clone isn't set up" | Play `backup-voice.m4a` from the desktop | "Let me play the line it generated earlier." |
| "Couldn't confirm whether it spoke this line" | **Do not press speak again** (may charge twice). Play `backup-voice.m4a` | — |
| Page error / server down | Switch to the demo video | "Let me show the recorded run." |

## Finals checklist (from docs/md/14 and 15)
- [ ] One team member attends in person; finals attendee named on Devpost.
- [ ] Ask organizers: power at the table, HDMI or USB-C adapter, wifi, speakers for the audio demo.
- [ ] Bring the USB-C/HDMI adapter, charger, and a phone for tethering.
- [ ] Chrome only, page zoom 100%, projector at 1280×720 works (page is designed for it).
- [ ] Rehearsed the 90-second script 3× with a timer, including the failure line.
