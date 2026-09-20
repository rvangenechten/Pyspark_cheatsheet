"""Turn a flat word stream into candidate clips.

Two stages:

1. `to_sentences` groups words into units we refuse to cut through. A unit
   ends at terminal punctuation, or at a silence long enough that the speaker
   has clearly finished a thought.
2. `candidates` slides over those units and emits every contiguous run whose
   duration lands in the target window. Sentence-aligned boundaries are the
   single biggest quality win in a clipper: a clip that starts mid-word reads
   as broken no matter how good the moment was.
"""

from __future__ import annotations

from typing import List

from .model import Clip, Sentence, Word

TERMINAL = ".?!…"
PAUSE_SPLIT = 0.65  # seconds of silence that ends a sentence on its own


def to_sentences(words: List[Word], pause_split: float = PAUSE_SPLIT) -> List[Sentence]:
    """Group words into sentence-ish units."""
    sentences: List[Sentence] = []
    current: List[Word] = []

    for i, word in enumerate(words):
        current.append(word)
        ends_on_punctuation = word.text.rstrip('"”\')').endswith(tuple(TERMINAL))
        gap_to_next = (words[i + 1].start - word.end) if i + 1 < len(words) else float("inf")
        if ends_on_punctuation or gap_to_next >= pause_split:
            sentences.append(Sentence(words=current))
            current = []

    if current:
        sentences.append(Sentence(words=current))
    return sentences


def candidates(
    sentences: List[Sentence],
    min_seconds: float = 18.0,
    max_seconds: float = 75.0,
    max_per_start: int = 4,
) -> List[Clip]:
    """Every sentence-aligned run whose duration fits the target window.

    `max_per_start` caps how many end points we try per start point. Without
    it a two-hour transcript produces hundreds of thousands of near-identical
    candidates and the scorer becomes the bottleneck for no quality gain.
    """
    clips: List[Clip] = []
    for i in range(len(sentences)):
        emitted = 0
        words: List[Word] = []
        for j in range(i, len(sentences)):
            words = words + sentences[j].words
            duration = sentences[j].end - sentences[i].start
            if duration > max_seconds:
                break
            if duration >= min_seconds:
                clips.append(
                    Clip(start=sentences[i].start, end=sentences[j].end, words=list(words))
                )
                emitted += 1
                if emitted >= max_per_start:
                    break
    return clips


def suppress_overlaps(clips: List[Clip], max_iou: float = 0.2) -> List[Clip]:
    """Greedy non-maximum suppression over the time axis.

    Candidates overlap heavily by construction, so the top 10 by raw score are
    usually 10 views of the same 40 seconds. Keep the best, drop anything that
    shares more than `max_iou` of its span with a clip already kept.
    """
    kept: List[Clip] = []
    for clip in sorted(clips, key=lambda c: c.score, reverse=True):
        if all(clip.overlaps(k) <= max_iou for k in kept):
            kept.append(clip)
    return kept
