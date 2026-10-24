# 07 ASR — CrisperWhisper 2.0 (verbatim)

Why: stock Whisper silently drops fillers/stutters/false starts, which kills the product (nothing left to detect). CrisperWhisper (nyrahealth/nyralabs, arXiv 2607.18934, ~Jul 2026 — VERIFY date for "frontier" claim) keeps them.

## Install & use
```
pip install "crisperwhisper[transformers]"     # macOS/CPU/MPS path. NOT [ct2] (NVIDIA-oriented, needs [convert])
from crisperwhisper import CrisperWhisperModel
model = CrisperWhisperModel("turbo")           # sizes: large(default) turbo medium small
out = model.transcribe("x.wav", language="en", mode="verbatim", word_timestamps=True)
```
- `mode="intended"` gives a cleaned reference; with transformers backend `transcribe_dual` is unavailable (ct2-only) → two passes. Use intended only for eval/debug, not in the hot path.
- First load downloads weights from HuggingFace — DO IT TONIGHT on good wifi, then set `HF_HUB_OFFLINE=1` on demo day. Cache dir `~/.cache/huggingface`.
- Weights: Nyra Non-Commercial Research License (fine for hackathon). Inference code MIT. Don't bundle weights; README states this. Pro models are commercial-only — don't use.
- Return type field names VERIFY on first run (print the object). Normalize into `ASRResult{text, words[], seconds}` in asr.py so nothing else depends on the lib.

## Speed / hardware
Dev machine: M4 Pro 24 GB. MPS support unverified → try `device="mps"` (or lib's flag), fall back to CPU. Measure on a 10 s clip; budget ≤6 s. If `large` too slow use `turbo`, then `medium`. Pick on gate 4 and record in DIFFICULTIES.md.

## Fallback ASR (if CrisperWhisper won't install/run by 2 AM)
`mlx-whisper` or `faster-whisper` with prompt-priming: `initial_prompt="Um, uh, so, like, I- I mean, you know, well..."` (partially coaxes fillers; unreliable). Lose some "wow" but pipeline still works; note honestly in the writeup. Also acceptable: Web Speech API is NOT an option (drops fillers, Chrome-cloud).

## Audio handling
- Browser: `new MediaRecorder(stream, {mimeType:"audio/webm;codecs=opus"})`; Safari gives mp4/aac → send blob with its real `type`, ffmpeg autodetects.
- Constraints: `{audio:{echoCancellation:true,noiseSuppression:false}}` — noise suppression can eat soft fillers.
- Max record 45 s (UI countdown) to bound latency/credits.
- Silence/near-zero RMS check before ASR (ffmpeg `volumedetect`, mean_volume < -50 dB → "can't hear you").

## Self-correction test clips (record these tonight, save in eval/audio/)
1 canonical Friday→Monday; 2 stutter "I- I- I want"; 3 long pause mid-sentence; 4 mumbled numbers "five p m"; 5 hedge "I think maybe around five"; 6 negation "we're not meeting Thursday"; 7 clean fluent sentence (must be left alone); 8 noisy-room clip.

## Number normalization
ASR may output "five p m", "5 p.m.", "five o'clock". `guard.normalize()` maps to canonical forms (see 08) — never edit ASR text itself.

## Gotchas
- ffmpeg must be installed (`brew install ffmpeg`).
- Hallucinated text on silence (classic Whisper) → RMS gate + reject if text has ≥3 repeated n-grams.
- Run model in a thread executor; one worker (memory).
