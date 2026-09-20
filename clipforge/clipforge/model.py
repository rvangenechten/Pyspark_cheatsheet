"""Core data types shared by every stage of the pipeline.

Everything downstream of transcription speaks in `Word`s: a flat, ordered list
of word-level timestamps. Keeping one primitive means the segmenter, the
scorer and the caption renderer never have to agree on a richer format.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, List


@dataclass(frozen=True)
class Word:
    """A single spoken word with its timing, in seconds from source start."""

    text: str
    start: float
    end: float

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


@dataclass
class Sentence:
    """A run of words treated as one indivisible unit when cutting."""

    words: List[Word]

    @property
    def start(self) -> float:
        return self.words[0].start

    @property
    def end(self) -> float:
        return self.words[-1].end

    @property
    def duration(self) -> float:
        return self.end - self.start

    @property
    def text(self) -> str:
        return " ".join(w.text for w in self.words)


@dataclass
class Clip:
    """A scored candidate clip, ready to render."""

    start: float
    end: float
    words: List[Word]
    score: float = 0.0
    components: dict = field(default_factory=dict)
    title: str = ""

    @property
    def duration(self) -> float:
        return self.end - self.start

    @property
    def text(self) -> str:
        return " ".join(w.text for w in self.words)

    def overlaps(self, other: "Clip") -> float:
        """Intersection-over-union of the two clips' time ranges."""
        inter = min(self.end, other.end) - max(self.start, other.start)
        if inter <= 0:
            return 0.0
        union = max(self.end, other.end) - min(self.start, other.start)
        return inter / union if union > 0 else 0.0


def total_duration(words: Iterable[Word]) -> float:
    words = list(words)
    if not words:
        return 0.0
    return words[-1].end - words[0].start
