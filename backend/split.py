"""Sentence splitter and Twinly chunk packer (docs/md/03 'Splitting').

Pure functions. ``split_sentences`` splits on [.?!] and, when word timings exist,
on pauses longer than 0.7 s. ``pack`` packs sentences into chunks of at most
``limit`` characters without cutting a sentence unless a single sentence is too long.
"""
from __future__ import annotations

import re
from typing import Any, Iterable, Sequence

PAUSE_S = 0.7
CHUNK_LIMIT = 550

_ABBREV = {"mr", "mrs", "ms", "dr", "prof", "st", "vs", "etc", "sr", "jr", "e.g", "i.e"}
_END = re.compile(r"[.?!]+[\"')\]]*$")


def _alnum(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _get(word: Any, key: str):
    return word[key] if isinstance(word, dict) else getattr(word, key)


def _ends_sentence(tok: str, nxt: str | None) -> bool:
    """tok ends with terminal punctuation and the following token starts a new sentence."""
    if not _END.search(tok):
        return False
    stem = re.sub(r"[^a-z.]", "", tok.lower()).rstrip(".")
    if stem in _ABBREV:
        return False
    if nxt is not None and nxt[:1].isalpha() and nxt[:1].islower():
        return False
    return True


def _by_punctuation(text: str) -> list[str]:
    toks = text.split()
    out: list[str] = []
    cur: list[str] = []
    for i, t in enumerate(toks):
        cur.append(t)
        if _ends_sentence(t, toks[i + 1] if i + 1 < len(toks) else None):
            out.append(" ".join(cur))
            cur = []
    if cur:
        out.append(" ".join(cur))
    return out


def split_sentences(text: str, words: Sequence[Any] | None = None, pause: float = PAUSE_S) -> list[str]:
    """Split ``text`` into sentences. ``words``: items with w/start/end (dicts or objects)."""
    text = (text or "").strip()
    if not text:
        return []
    if words and _alnum(" ".join(_get(w, "w") for w in words)) == _alnum(text):
        out: list[str] = []
        cur: list[str] = []
        for i, w in enumerate(words):
            tok = str(_get(w, "w")).strip()
            cur.append(tok)
            nxt = words[i + 1] if i + 1 < len(words) else None
            gap = (_get(nxt, "start") - _get(w, "end")) if nxt is not None else 0
            nxt_tok = str(_get(nxt, "w")).strip() if nxt is not None else None
            if nxt is None or gap > pause or _ends_sentence(tok, nxt_tok):
                out.append(" ".join(cur))
                cur = []
        return out
    return _by_punctuation(text)


def _hard_cut(piece: str, limit: int) -> list[str]:
    """Last resort: split on spaces, then raw characters, so no chunk exceeds ``limit``."""
    out: list[str] = []
    cur = ""
    for word in piece.split():
        while len(word) > limit:
            if cur:
                out.append(cur)
                cur = ""
            out.append(word[:limit])
            word = word[limit:]
        if cur and len(cur) + 1 + len(word) > limit:
            out.append(cur)
            cur = word
        else:
            cur = f"{cur} {word}".strip()
    if cur:
        out.append(cur)
    return out


def _split_long(sentence: str, limit: int) -> list[str]:
    """Split one over-long sentence at commas (and ; : —), then at spaces if still too long."""
    parts = re.split(r"(?<=[,;:—])\s+", sentence)
    out: list[str] = []
    cur = ""
    for p in parts:
        if len(p) > limit:
            if cur:
                out.append(cur)
                cur = ""
            out.extend(_hard_cut(p, limit))
        elif cur and len(cur) + 1 + len(p) > limit:
            out.append(cur)
            cur = p
        else:
            cur = f"{cur} {p}".strip()
    if cur:
        out.append(cur)
    return out


def pack(text: str | Iterable[str], limit: int = CHUNK_LIMIT) -> list[str]:
    """Pack sentences into chunks of <= ``limit`` chars, preserving order."""
    sentences = split_sentences(text) if isinstance(text, str) else [s.strip() for s in text if s and s.strip()]
    chunks: list[str] = []
    cur = ""
    for s in sentences:
        pieces = [s] if len(s) <= limit else _split_long(s, limit)
        for p in pieces:
            if cur and len(cur) + 1 + len(p) > limit:
                chunks.append(cur)
                cur = p
            else:
                cur = f"{cur} {p}".strip()
    if cur:
        chunks.append(cur)
    return chunks
