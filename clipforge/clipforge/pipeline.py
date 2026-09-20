"""End-to-end orchestration: one long video in, N ranked vertical clips out."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List

from . import captions, render, score, segment, transcribe
from .model import Clip, Word


@dataclass
class Settings:
    min_seconds: float = 18.0
    max_seconds: float = 75.0
    count: int = 8
    reframe: str = "crop"
    crop_x_bias: float = 0.5
    max_iou: float = 0.2
    font: str = "Arial Black"
    font_size: int = 96
    burn_captions: bool = True
    dry_run: bool = False


def slugify(text: str, max_len: int = 48) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return (slug[:max_len].rstrip("-") or "clip")


def select_clips(words: List[Word], settings: Settings) -> List[Clip]:
    """Segment, score, de-overlap, and take the top N."""
    sentences = segment.to_sentences(words)
    candidates = segment.candidates(
        sentences, min_seconds=settings.min_seconds, max_seconds=settings.max_seconds
    )
    scored = score.score_all(candidates)
    ranked = segment.suppress_overlaps(scored, max_iou=settings.max_iou)
    return ranked[: settings.count]


def words_in(words: List[Word], start: float, end: float) -> List[Word]:
    return [w for w in words if w.start >= start - 0.01 and w.end <= end + 0.01]


def process(
    source: str | Path,
    outdir: str | Path,
    transcript: str | Path | None = None,
    settings: Settings | None = None,
    log: Callable[[str], None] = print,
) -> List[dict]:
    """Run the whole pipeline and return a manifest of what was produced."""
    settings = settings or Settings()
    source = Path(source)
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    log(f"[1/4] transcript: {transcript or source}")
    words = transcribe.load_any(transcript or source)
    if not words:
        raise RuntimeError("no words found in transcript; nothing to clip")
    if transcript is None:
        transcribe.save_json(words, outdir / "transcript.json")

    log(f"[2/4] scoring candidates from {len(words)} words")
    clips = select_clips(words, settings)
    log(f"       kept {len(clips)} clips after overlap suppression")

    source_size = None
    if not settings.dry_run and settings.reframe == "crop":
        try:
            source_size = render.probe_dimensions(source)
        except Exception as exc:  # ffprobe missing or unreadable source
            log(f"       ffprobe unavailable ({exc}); using expression-based crop")

    manifest: List[dict] = []
    for index, clip in enumerate(clips, start=1):
        name = f"{index:02d}-{slugify(clip.title)}"
        clip_words = words_in(words, clip.start, clip.end)

        ass_path = outdir / f"{name}.ass"
        if settings.burn_captions:
            ass_path.write_text(
                captions.build_ass(
                    clip_words,
                    clip_start=clip.start,
                    font=settings.font,
                    size=settings.font_size,
                ),
                encoding="utf-8",
            )
        (outdir / f"{name}.srt").write_text(
            captions.build_srt(clip_words, clip_start=clip.start), encoding="utf-8"
        )

        filter_chain = render.build_filter(
            mode=settings.reframe,
            source_size=source_size,
            crop_x_bias=settings.crop_x_bias,
            ass_path=ass_path if settings.burn_captions else None,
        )
        output = outdir / f"{name}.mp4"
        command = render.build_command(
            source, output, clip.start, clip.duration, filter_chain
        )

        log(
            f"[3/4] {name}  {clip.start:7.1f}s +{clip.duration:5.1f}s  "
            f"score {clip.score:.2f}"
        )
        if settings.dry_run:
            log("       " + " ".join(command))
        else:
            render.run(command)

        manifest.append(
            {
                "rank": index,
                "file": output.name,
                "start": round(clip.start, 3),
                "end": round(clip.end, 3),
                "duration": round(clip.duration, 3),
                "score": round(clip.score, 4),
                "components": {k: round(v, 4) for k, v in clip.components.items()},
                "title": clip.title,
                "caption": suggested_caption(clip),
                "text": clip.text,
            }
        )

    (outdir / "clips.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    log(f"[4/4] wrote {len(manifest)} clips to {outdir}")
    return manifest


def suggested_caption(clip: Clip, tags: int = 4) -> str:
    """A post caption: the hook line plus generic, non-spammy tags."""
    base = clip.title.rstrip(".…")
    tokens = [t for t in re.findall(r"[a-zA-Z]{5,}", clip.text.lower())]
    seen: List[str] = []
    for token in tokens:
        if token not in seen and token not in {"because", "really", "though", "actually"}:
            seen.append(token)
        if len(seen) >= tags:
            break
    hashtags = " ".join(f"#{t}" for t in seen)
    return f"{base}\n\n{hashtags}".strip()
