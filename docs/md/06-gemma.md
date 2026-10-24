# 06 Gemma 4 rewrite (via Gemini API — MLH prize requires Gemma)

Models: `gemma-4-26b-a4b-it` (faster MoE, default) · `gemma-4-31b-it` (fallback if quality weak). Launched Apr 2 2026.
Key: https://aistudio.google.com/apikey → `GEMINI_API_KEY`.
```
from google import genai
client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
r = client.models.generate_content(model=GEMMA_MODEL, contents=prompt,
      config={"system_instruction": SYSTEM, "temperature": 0})
```
Install `pip install google-genai`. Free tier limits (~15 RPM / 1500 RPD, third-party, VERIFY on gate 3) → 3-mode compare uses 3 calls; don't loop.

## Output format
JSON-in-prompt + pydantic validation (native JSON mode for Gemma unverified):
`{"rewrite":"...","edits":[{"from":"um, uh","to":"","reason":"filler"},...]}`
Parse: strip ```json fences, `json.loads`, validate; on failure retry once with "return ONLY valid JSON"; second failure → ladder rung 2.
Function-calling is supported — try it if plain JSON is flaky (VERIFY).

## System prompt (core rules, keep verbatim in code)
- You EDIT, you do not compose. Output must use the speaker's own words wherever possible.
- Preserve: every date, time, number, name, place; negations (not, never, n't); hedges (maybe, probably, I think, might, around); commitments (will vs might); quantifiers (all, some, most).
- Self-corrections: keep only the final corrected value. Never keep both.
- Never add facts, greetings, sign-offs, or politeness not spoken.
- Convert to announcement voice only in Presenter mode.
- Sentences marked LEAVE_UNCHANGED must be returned exactly.
- If unsure, change less.
Input block: MODE, ISSUES (from Decisions), SENTENCES with ids and keep flags, VERBATIM text.
Few-shot: 3 short examples including the Friday→Monday one and a hedge-preserving one ("I think we might meet around 5").

## Mode differences
Minimal: delete fillers/duplicates only. Natural: + fix false starts, grammar. Presenter: + restructure, shorter sentences.

## Reasons for edits
`reason` comes from the same call (cheap). Enum: filler | repetition | self_correction | false_start | grammar | restructure. UI maps enum → plain label.

## Extras (only if time)
- `compare modes`: 3 parallel calls via asyncio.gather.
- Edit diff: compute with `difflib.SequenceMatcher` on tokens in the frontend or backend to highlight deletions/insertions; don't trust model's `edits` alone — verify each `from` exists in verbatim.

## Failure modes
- 429/503 → backoff 2 s ×2 → switch to 31b → ladder rung 2.
- Rewrite longer than 1.3× verbatim word count → reject (hallucination signal).
- Rewrite empty or identical to verbatim in Natural/Presenter when fillers exist → treat as failure, retry.
- Offline fallback: Ollama `gemma` locally (`OLLAMA=1`), never the demo default.
- Ask MLH rep to confirm Gemma 4 via Gemini API counts for "Best Use of Gemini".
