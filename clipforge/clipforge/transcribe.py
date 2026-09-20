"""Word-level transcription.

`faster-whisper` is the default engine because it runs the `small`/`medium`
models on CPU fast enough to be free: a 60-minute podcast transcribes in
roughly 8-15 minutes on 4 cores, which is fine for an overnight batch.

The loaders below exist so the rest of the pipeline can run against a
transcript you already have (a podcast host's SRT export, a previous run's
JSON) without paying for transcription twice.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import List

from .model import Word

_SRT_TIME = re.compile(
    r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})"
)


def _hms_to_seconds(h: str, m: str, s: str, ms: str) -> float:
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def transcribe(
    audio_path: str | Path,
    model_size: str = "small",
    language: str | None = None,
    compute_type: str = "int8",
) -> List[Word]:
    """Transcribe with faster-whisper, returning word-level timestamps.

    Imported lazily so the package stays importable (and testable) on a box
    with no model weights and no torch.
    """
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:  # pragma: no cover - depends on optional dep
        raise RuntimeError(
            "faster-whisper is not installed. Run: pip install -r requirements.txt"
        ) from exc

    model = WhisperModel(model_size, device="auto", compute_type=compute_type)
    segments, _info = model.transcribe(
        str(audio_path),
        language=language,
        word_timestamps=True,
        vad_filter=True,
    )

    words: List[Word] = []
    for segment in segments:
        for word in segment.words or []:
            text = word.word.strip()
            if text:
                words.append(Word(text=text, start=float(word.start), end=float(word.end)))
    return words


def load_json(path: str | Path) -> List[Word]:
    """Load words from a `[{"text","start","end"}, ...]` JSON file."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(data, dict):
        data = data.get("words", [])
    return [
        Word(text=str(d["text"]).strip(), start=float(d["start"]), end=float(d["end"]))
        for d in data
        if str(d.get("text", "")).strip()
    ]


def save_json(words: List[Word], path: str | Path) -> None:
    Path(path).write_text(
        json.dumps([{"text": w.text, "start": w.start, "end": w.end} for w in words], indent=2),
        encoding="utf-8",
    )


def load_srt(path: str | Path) -> List[Word]:
    """Load an SRT and spread each cue's words evenly across its time range.

    Cue-level timing is coarser than whisper's word timings, but it is close
    enough for segmentation and scoring; captions rendered from it drift by a
    few tenths of a second at most within a cue.
    """
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    words: List[Word] = []
    blocks = re.split(r"\n\s*\n", text.strip())
    for block in blocks:
        match = _SRT_TIME.search(block)
        if not match:
            continue
        start = _hms_to_seconds(*match.groups()[:4])
        end = _hms_to_seconds(*match.groups()[4:])
        lines = block[match.end():].strip().splitlines()
        cue = " ".join(line.strip() for line in lines if line.strip())
        cue = re.sub(r"<[^>]+>", "", cue)
        tokens = [t for t in cue.split() if t]
        if not tokens or end <= start:
            continue
        step = (end - start) / len(tokens)
        for i, token in enumerate(tokens):
            words.append(
                Word(text=token, start=start + i * step, end=start + (i + 1) * step)
            )
    return words


def load_any(path: str | Path) -> List[Word]:
    """Dispatch on extension: .json/.srt/.vtt are transcripts, anything else is media."""
    suffix = Path(path).suffix.lower()
    if suffix == ".json":
        return load_json(path)
    if suffix in {".srt", ".vtt"}:
        return load_srt(path)
    return transcribe(path)
