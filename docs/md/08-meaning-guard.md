# 08 Meaning guard (the thing that makes us credible)

Goal: never speak something the user didn't mean. Deterministic checks first (cheap, explainable), Decisions predicates second. Any deterministic failure = FAIL regardless of Decisions.

## normalize(text)
lowercase; strip punctuation except `: .` inside numbers; spoken numbers → digits ("five"→5, "twenty two"→22, "a hundred"→100); times: "five p m"/"5 p.m."/"five o'clock" → `17:00`-style token `5pm`; weekdays/months canonical; ordinals "5th"→5; contractions expanded ("won't"→"will not", "n't"→" not").

## Fact extractors (regex on normalized text) → sets
- NUMBERS: `\d+(\.\d+)?`
- TIMES: `\b\d{1,2}(:\d{2})?\s?(am|pm)\b`
- DAYS/MONTHS/dates
- NAMES: capitalized tokens not at sentence start in the ORIGINAL (ASR casing is shaky; also use a small "protected terms" list passed from UI input box)
- NEGATIONS: not|never|no|none|nobody|nothing|cannot|without
- HEDGES: maybe|probably|perhaps|might|could|i think|i guess|around|about|roughly|approximately|sort of|kind of
- QUANTIFIERS: all|everyone|everybody|some|most|few|none|every

## Rules
1. Every fact in rewrite must exist in ORIGINAL (no invention): `rewrite.facts ⊆ original.facts`.
2. Every fact in ORIGINAL's *final* values must appear in rewrite (no dropping), where "final" resolves self-corrections:
   markers = `actually|sorry|i mean|no wait|scratch that|rather|correction` → in the clause around a marker, earlier day/time/number is superseded by the one after; the superseded value MUST NOT appear in rewrite (Friday banned, Monday required).
3. Negation count/polarity per sentence must match (compare sets of negated verbs when possible; else counts).
4. Hedge set: if original has hedge h, rewrite must contain h or synonym from same group → else "dropped hedge" FAIL. Rewrite may not ADD a hedge either.
5. Quantifier changes (everyone→some) FAIL. Modal strength: will↔might, must↔should FAIL.
6. Length sanity: 0.3×–1.3× original word count (Presenter min 0.25×).
7. Output returns `violations[{rule, original_span, rewrite_span, message}]` → shown in UI in plain English.

## Decisions pass (see 05) runs in parallel with deterministic checks. Combined verdict:
`pass = no deterministic violations AND meaning_preserved≥0.85 AND bad_predicates≤0.25`. If Decisions unavailable → deterministic only, UI note "AI verifier offline".

## Unit tests (pytest, write first — tests are the spec)
- Friday→Monday: ok rewrite "Meeting is Monday at 5 PM" passes; "Friday at 5 PM" FAILS; "Monday at 6 PM" FAILS.
- "I think we might meet around five" → "We will meet at 5" FAILS (hedge, modal, 'around').
- "we're not meeting Thursday" → "We are meeting Thursday" FAILS.
- "um uh so yeah" → "" (empty) allowed only if original has no facts; speak disabled for empty.
- fluent sentence unchanged passes trivially.
- Spoken vs digit: "five p m" vs "5 PM" equal.
Target ≥25 test cases; run in <1 s, no network.

## Live demo trick
Add a UI button "Simulate bad rewrite" that injects "Friday" into the rewrite; guard blocks it and ladder falls back. Shows the safety net on stage.
