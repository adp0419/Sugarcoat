# 05 OpenAI Decisions API (analysis + verification)

Public beta since Oct 6 2026 → qualifies as "frontier". Playground: https://platform.openai.com/decisions
It CLASSIFIES / ROUTES / SCORES. It cannot rewrite text and takes no audio. Use it for decisions, never generation.
(User's old doc says "Zoom Decisions API" — wrong; it's OpenAI's.)

## Request (VERIFY against live response on gate 2)
```
POST https://api.openai.com/v1/decisions
{"model":"gpt-6-luna","input":"<text or messages>",
 "questions":[
  {"type":"predicate","name":"has_self_correction","instructions":"..."},
  {"type":"choice","name":"mode","instructions":"...","choices":[{"value":"minimal","description":"..."}]},
  {"type":"score","name":"formality","instructions":"...","levels":[...]}]}
→ {"answers":[{"name","type":"predicate","probability":0.93}, {"name","choice","confidence","probabilities"}, {"name","score","confidence"}], "model","usage"}
```
- Answers come in question order; a question may return `Refusal{name,type}` while others succeed → handle per answer.
- Python SDK: `client.decisions.create(model=..., input=..., questions=[...])`; if attribute missing, fall back to `client.post("/decisions", body=..., cast_to=dict)` or raw httpx. Wrap in `decide._call()` so only one place changes.
- Cost $0.10/M input tokens, no output charge → effectively free. Only `gpt-6-luna`. May be gated per key (VERIFY on gate 2). Question-limit sources conflict (10 vs 400) → keep ≤10 per call.

## Pass 1 — analysis (stage 3)
Input: verbatim transcript. Questions:
- predicates: `has_filler`, `has_repetition`, `has_self_correction`, `has_false_start`, `is_incomplete_thought`, `contains_hedging`, `is_already_fluent` (→ skip rewrite, "leave unchanged")
- choice `register`: casual | professional | announcement
- choice `recommended_mode`: minimal | natural | presenter (rule of thumb in `instructions`: announcement → presenter)
Per-sentence "leave unchanged?": one call per sentence (≤8 sentences) with predicate `needs_edit`, run concurrently. Cap at 8; beyond that skip per-sentence.
Output feeds Gemma prompt: issues list + sentences to leave verbatim.

## Pass 2 — verification (stage 5)
Input: JSON `{"original":..., "rewrite":...}`. Predicates (probability thresholds in guard.py):
- `meaning_preserved`, `added_new_information`, `dropped_hedge_or_uncertainty`, `changed_commitment_strength`, `changed_number_date_or_name`, `negation_changed`
Pass if meaning_preserved ≥ 0.85 AND every "bad" predicate ≤ 0.25 (tune on eval set; log probabilities in trace).
This LLM-judge is advisory-plus-deterministic: deterministic regex failures always override a Decisions pass.

## UI value
Show the raw probabilities in a "Decisions" panel (bars). This is what makes usage "meaningful" to judges — keep it visible.

## Failure modes
- 401/403/404 model → run with `DECISIONS_ENABLED=0`: default mode=natural, skip per-sentence, guard = deterministic only; banner in UI. Don't fake Decisions output.
- 429 → backoff 2 s ×2. Timeout 15 s → treat as unavailable for this job.
- Keep a recorded real response in `fixtures/decisions_*.json` for MOCK=1.
