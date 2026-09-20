"""Word-highlight (karaoke) captions as an ASS subtitle file.

Burned-in captions are not optional: most short-form watch time is muted.
ASS rather than SRT because it gives per-word timing, an outline heavy enough
to survive over any footage, and a fixed safe-area margin so the text never
lands under the platform's own UI.
"""

from __future__ import annotations

import re
from typing import List

from .model import Word

ASS_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,{font},{size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,{outline},2,2,80,80,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def _ass_time(seconds: float) -> str:
    seconds = max(0.0, seconds)
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = seconds % 60
    return f"{hours}:{minutes:02d}:{secs:05.2f}"


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("{", "(").replace("}", ")")


def group_lines(words: List[Word], max_words: int = 4, max_gap: float = 0.8) -> List[List[Word]]:
    """Chunk words into caption lines.

    Short lines (3-5 words) read far better on a phone than full sentences,
    and a line break at a long pause keeps the caption in sync with delivery.
    """
    lines: List[List[Word]] = []
    current: List[Word] = []
    for i, word in enumerate(words):
        current.append(word)
        gap_to_next = (words[i + 1].start - word.end) if i + 1 < len(words) else float("inf")
        ends_clause = word.text.rstrip('"”\')').endswith((".", "?", "!", ",", "…"))
        if len(current) >= max_words or gap_to_next >= max_gap or (ends_clause and len(current) >= 2):
            lines.append(current)
            current = []
    if current:
        lines.append(current)
    return lines


def build_ass(
    words: List[Word],
    clip_start: float = 0.0,
    font: str = "Arial Black",
    size: int = 96,
    outline: int = 6,
    margin_v: int = 420,
    highlight: str = "&H0000E5FF",  # BGR: amber
    max_words: int = 4,
) -> str:
    """Render an ASS file where the word being spoken is highlighted.

    Times are rebased to `clip_start` so the file lines up with a clip that
    ffmpeg has already trimmed to start at zero.
    """
    body = ASS_HEADER.format(font=font, size=size, outline=outline, margin_v=margin_v)
    events: List[str] = []

    for line in group_lines(words, max_words=max_words):
        line_start = line[0].start - clip_start
        line_end = line[-1].end - clip_start
        for index, word in enumerate(line):
            rendered = " ".join(
                (f"{{\\c{highlight}}}{_escape(w.text)}{{\\c&H00FFFFFF&}}" if i == index else _escape(w.text))
                for i, w in enumerate(line)
            )
            start = word.start - clip_start
            end = (line[index + 1].start - clip_start) if index + 1 < len(line) else line_end
            if end <= start:
                end = start + 0.05
            events.append(
                f"Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Caption,,0,0,0,,{rendered}"
            )
        del line_start
    return body + "\n".join(events) + "\n"


def build_srt(words: List[Word], clip_start: float = 0.0, max_words: int = 7) -> str:
    """Plain SRT, for platforms that want an uploaded caption file."""
    out: List[str] = []
    for i, line in enumerate(group_lines(words, max_words=max_words), start=1):
        start = line[0].start - clip_start
        end = line[-1].end - clip_start
        out.append(str(i))
        out.append(f"{_srt_time(start)} --> {_srt_time(end)}")
        out.append(re.sub(r"\s+", " ", " ".join(w.text for w in line)).strip())
        out.append("")
    return "\n".join(out)


def _srt_time(seconds: float) -> str:
    seconds = max(0.0, seconds)
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int(round((seconds - int(seconds)) * 1000))
    if millis == 1000:
        millis = 999
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"
