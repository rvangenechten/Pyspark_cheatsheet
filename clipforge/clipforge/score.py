"""Rank candidate clips without calling an LLM.

The paid tools sell "virality scores". In practice the signal that separates
a clip that holds a viewer from one that doesn't is mostly mechanical, and
mechanical things are free to compute:

* does it open with something that creates an open loop (hook)
* does it close the loop it opened (payoff)
* can you understand it with zero prior context (standalone)
* is the speaker saying something concrete rather than hedging (concreteness)
* is the delivery paced like speech people finish watching (density)
* does it carry emotional charge (emotion)
* is it the length the platform rewards (length_fit)

Every component returns 0..1 and the weights sum to 1, so the final score is
directly readable as a percentage. `llm_rerank` is an optional second pass for
operators who want it; nothing in the pipeline requires it.
"""

from __future__ import annotations

import math
import re
from typing import Dict, List

from .model import Clip

WEIGHTS: Dict[str, float] = {
    "hook": 0.26,
    "payoff": 0.12,
    "standalone": 0.18,
    "concreteness": 0.14,
    "density": 0.10,
    "emotion": 0.12,
    "length_fit": 0.08,
}

HOOK_PATTERNS = [
    r"^(?:what|why|how|when|where|who|which)\b",
    r"^(?:the (?:biggest|worst|best|hardest|number one|#1|real|only))\b",
    r"^(?:most people|nobody|everyone|everybody|no one)\b",
    r"^(?:here'?s|that'?s) (?:why|how|the|what)\b",
    r"^(?:i (?:used to|never|always|almost|once))\b",
    r"^(?:stop|never|don'?t|forget|listen|look)\b",
    r"^(?:if you|when you)\b",
    r"\b(?:the mistake|the problem|the truth|the secret|the trick)\b",
]

PAYOFF_MARKERS = [
    "so the lesson",
    "which is why",
    "that's why",
    "thats why",
    "the point is",
    "bottom line",
    "in the end",
    "what i learned",
    "turns out",
    "and that changed",
    "so now",
]

# Words that carry charge. Deliberately small and hand-picked: a large
# sentiment lexicon scores generic positivity, which does not predict retention.
EMOTION_WORDS = {
    "insane", "crazy", "brutal", "terrifying", "shocked", "furious", "devastating",
    "hate", "love", "fear", "afraid", "broke", "failed", "failure", "fired",
    "quit", "lost", "won", "worst", "best", "never", "always", "desperate",
    "humiliating", "embarrassing", "painful", "obsessed", "addicted", "regret",
    "proud", "grateful", "betrayed", "lied", "lying", "truth", "secret",
    "impossible", "unbelievable", "ridiculous", "dangerous", "wrong", "right",
}

HEDGES = {
    "maybe", "perhaps", "kind", "sort", "probably", "possibly", "somewhat",
    "basically", "essentially", "arguably", "i guess", "i mean", "you know",
}

# An opener that leans on something the viewer never heard.
DANGLING_OPENERS = {
    "and", "but", "so", "because", "which", "that", "then", "also", "anyway",
    "however", "therefore", "plus", "or", "yeah", "yes", "no", "right", "okay",
    "ok", "well", "um", "uh", "he", "she", "they", "it", "him", "her", "them",
    "this", "these", "those", "his", "their", "its",
}

_WORD_RE = re.compile(r"[a-z']+")
_NUMBER_RE = re.compile(r"\b\d[\d,.]*\b|\b(?:one|two|three|five|ten|twenty|fifty|hundred|thousand|million|billion)\b")


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower()).strip()


def _tokens(text: str) -> List[str]:
    return _WORD_RE.findall(text.lower())


def hook_score(clip: Clip, window: float = 3.5) -> float:
    """Strength of the first ~3.5 seconds, where the scroll decision happens."""
    opening_words = [w for w in clip.words if w.start - clip.start <= window]
    if not opening_words:
        return 0.0
    opening = _normalize(" ".join(w.text for w in opening_words))

    score = 0.0
    for pattern in HOOK_PATTERNS:
        if re.search(pattern, opening):
            score += 0.45
            break

    first = _tokens(opening)[:1]
    if first and first[0] in DANGLING_OPENERS:
        score -= 0.25

    if "?" in opening:
        score += 0.2
    if _NUMBER_RE.search(opening):
        score += 0.15
    if any(word in EMOTION_WORDS for word in _tokens(opening)):
        score += 0.2

    return max(0.0, min(1.0, score))


def payoff_score(clip: Clip) -> float:
    """Does the clip resolve, or does it stop mid-thought?"""
    text = _normalize(clip.text)
    score = 0.0
    if any(marker in text for marker in PAYOFF_MARKERS):
        score += 0.5
    if clip.text.rstrip('"”\')').endswith((".", "!", "?", "…")):
        score += 0.5
    return min(1.0, score)


def standalone_score(clip: Clip) -> float:
    """Penalize clips that need context the viewer does not have."""
    tokens = _tokens(clip.text)
    if not tokens:
        return 0.0

    score = 1.0
    if tokens[0] in DANGLING_OPENERS:
        score -= 0.45

    # Unbound pronouns early on read as "who are we talking about?"
    early = tokens[:12]
    pronouns = sum(1 for t in early if t in {"he", "she", "they", "him", "her", "them", "it"})
    score -= min(0.3, 0.1 * pronouns)

    hedge_hits = sum(1 for t in tokens if t in HEDGES)
    score -= min(0.25, 0.03 * hedge_hits)

    return max(0.0, min(1.0, score))


def concreteness_score(clip: Clip) -> float:
    """Numbers, names and specifics beat abstractions."""
    text = clip.text
    tokens = _tokens(text)
    if not tokens:
        return 0.0

    numbers = len(_NUMBER_RE.findall(text.lower()))
    # Capitalized mid-sentence tokens approximate proper nouns.
    raw = text.split()
    propers = sum(1 for t in raw[1:] if t[:1].isupper() and not t[:1].isdigit())

    per_100 = 100.0 / max(1, len(tokens))
    density = (numbers * 2.0 + propers) * per_100
    return max(0.0, min(1.0, density / 6.0))


def density_score(clip: Clip) -> float:
    """Words per second, scored against the range conversational speech lands in.

    Below ~1.8 wps the clip drags; above ~4.0 it is unintelligible on a phone
    speaker. Peak is 2.8.
    """
    if clip.duration <= 0:
        return 0.0
    wps = len(clip.words) / clip.duration
    return math.exp(-((wps - 2.8) ** 2) / (2 * 0.75 ** 2))


def emotion_score(clip: Clip) -> float:
    tokens = _tokens(clip.text)
    if not tokens:
        return 0.0
    hits = sum(1 for t in tokens if t in EMOTION_WORDS)
    per_100 = hits * 100.0 / len(tokens)
    return max(0.0, min(1.0, per_100 / 4.0))


def length_fit_score(clip: Clip, target: float = 34.0, spread: float = 16.0) -> float:
    """Gaussian around the duration that performs across TikTok/Reels/Shorts."""
    return math.exp(-((clip.duration - target) ** 2) / (2 * spread ** 2))


def score_clip(clip: Clip, weights: Dict[str, float] | None = None) -> Clip:
    """Attach a 0..1 score and its component breakdown to a clip, in place."""
    weights = weights or WEIGHTS
    components = {
        "hook": hook_score(clip),
        "payoff": payoff_score(clip),
        "standalone": standalone_score(clip),
        "concreteness": concreteness_score(clip),
        "density": density_score(clip),
        "emotion": emotion_score(clip),
        "length_fit": length_fit_score(clip),
    }
    clip.components = components
    clip.score = sum(components[k] * weights.get(k, 0.0) for k in components)
    clip.title = suggest_title(clip)
    return clip


def score_all(clips: List[Clip], weights: Dict[str, float] | None = None) -> List[Clip]:
    return [score_clip(c, weights) for c in clips]


def suggest_title(clip: Clip, max_chars: int = 60) -> str:
    """A caption/title drawn from the clip's own opening line.

    Using the speaker's words beats a generated title: it is accurate by
    construction, and it is what the viewer is about to hear.
    """
    text = re.sub(r"\s+", " ", clip.text).strip()
    if not text:
        return ""
    first = re.split(r"(?<=[.?!])\s", text)[0]
    if len(first) <= max_chars:
        return first
    cut = first[:max_chars].rsplit(" ", 1)[0]
    return cut + "…"


def llm_rerank(clips: List[Clip], client, model: str = "claude-sonnet-5", top_k: int = 20) -> List[Clip]:
    """Optional second pass: let a model re-rank the heuristic shortlist.

    Only the shortlist is sent, so cost stays at one small call per source
    video. `client` is an Anthropic SDK client supplied by the caller; the
    pipeline never constructs one, so the default path stays free.
    """
    shortlist = sorted(clips, key=lambda c: c.score, reverse=True)[:top_k]
    listing = "\n\n".join(
        f"[{i}] ({c.duration:.0f}s) {c.text[:500]}" for i, c in enumerate(shortlist)
    )
    prompt = (
        "You rank candidate short-form clips cut from a long video. "
        "Score each 0-100 on how likely a cold viewer is to watch it to the end. "
        "Reward a clip that opens a loop in its first sentence and closes it, and "
        "that needs no context from the rest of the video.\n"
        "Reply with one line per clip: `index,score`. No other text.\n\n"
        f"{listing}"
    )
    response = client.messages.create(
        model=model,
        max_tokens=1000,
        messages=[{"role": "user", "content": prompt}],
    )
    text = "".join(block.text for block in response.content if block.type == "text")

    for line in text.strip().splitlines():
        parts = line.split(",")
        if len(parts) != 2:
            continue
        try:
            index, value = int(parts[0].strip().lstrip("[").rstrip("]")), float(parts[1])
        except ValueError:
            continue
        if 0 <= index < len(shortlist):
            clip = shortlist[index]
            clip.components["llm"] = value / 100.0
            # Blend rather than replace: the heuristics encode format rules the
            # model does not see (duration, caption density, cut alignment).
            clip.score = 0.5 * clip.score + 0.5 * (value / 100.0)
    return shortlist
