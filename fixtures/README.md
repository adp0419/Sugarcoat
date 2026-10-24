Fixtures for MOCK=1 and tests.

- `asr_canonical.json`, `decisions_canonical.json`, `rewrite_*.json`, `guard_pass.json`: hand-written from
  docs/md/01 (the canonical "Friday—actually, sorry, Monday" line). MOCK=1 serves them with 300-800 ms sleeps.
- `real_*.json`: raw responses captured from real calls (audio_b64 replaced by its length).
- `backup_demo.m4a`: the canonical line spoken by Twinly in the owner's cloned voice, 3.84 s (ffprobe), AAC.
  ASR of it: "Our meeting will take place on Monday at five PM. Everyone should attend." MOCK=1 speak and the
  demo-day backup both play it. Synthetic voice: label it as such wherever it is played.
