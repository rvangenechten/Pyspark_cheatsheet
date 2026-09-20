"""ffmpeg command construction and execution.

Command building is kept separate from running so the exact arguments can be
asserted in tests and printed with `--dry-run` before a four-hour batch burns
CPU on a wrong crop.

Two reframe modes:

* `crop`   - centre (or offset) crop of the source to 9:16. Correct when the
             speaker is framed centrally, which covers most podcast setups.
* `blur`   - source scaled to fit inside 1080x1920 over a blurred, zoomed copy
             of itself. Correct when the source is a screen share, a wide two-
             shot, or anything where cropping would cut a head off.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import List, Sequence

TARGET_W, TARGET_H = 1080, 1920


class FFmpegMissing(RuntimeError):
    pass


def require_ffmpeg() -> None:
    for binary in ("ffmpeg", "ffprobe"):
        if shutil.which(binary) is None:
            raise FFmpegMissing(
                f"{binary} not found on PATH. Install it: "
                "`apt install ffmpeg` / `brew install ffmpeg`."
            )


def probe_dimensions(source: str | Path) -> tuple[int, int]:
    """Source width and height via ffprobe."""
    require_ffmpeg()
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height", "-of", "json", str(source),
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    stream = json.loads(out)["streams"][0]
    return int(stream["width"]), int(stream["height"])


def build_filter(
    mode: str = "crop",
    source_size: tuple[int, int] | None = None,
    crop_x_bias: float = 0.5,
    ass_path: str | Path | None = None,
) -> str:
    """Build the -vf filter chain for one clip.

    `crop_x_bias` is where the crop window sits horizontally, 0.0 = hard left,
    0.5 = centre, 1.0 = hard right. For a two-person podcast, rendering the
    same moment twice at 0.25 and 0.75 gives you both speakers.
    """
    if mode == "crop":
        if source_size:
            src_w, src_h = source_size
            crop_w = min(src_w, int(src_h * TARGET_W / TARGET_H))
            crop_w -= crop_w % 2
            offset = int((src_w - crop_w) * max(0.0, min(1.0, crop_x_bias)))
            offset -= offset % 2
            chain = [f"crop={crop_w}:{src_h}:{offset}:0", f"scale={TARGET_W}:{TARGET_H}"]
        else:
            chain = [
                f"crop='min(iw,ih*{TARGET_W}/{TARGET_H})':ih",
                f"scale={TARGET_W}:{TARGET_H}",
            ]
    elif mode == "blur":
        chain = [
            f"split=2[bg][fg];"
            f"[bg]scale={TARGET_W}:{TARGET_H}:force_original_aspect_ratio=increase,"
            f"crop={TARGET_W}:{TARGET_H},boxblur=40:2[bgb];"
            f"[fg]scale={TARGET_W}:-2[fgs];"
            f"[bgb][fgs]overlay=(W-w)/2:(H-h)/2"
        ]
    else:
        raise ValueError(f"unknown reframe mode: {mode!r}")

    chain.append("setsar=1")
    if ass_path:
        escaped = str(ass_path).replace("\\", "/").replace(":", r"\:").replace("'", r"\'")
        chain.append(f"ass='{escaped}'")
    return ",".join(chain)


def build_command(
    source: str | Path,
    output: str | Path,
    start: float,
    duration: float,
    filter_chain: str,
    crf: int = 20,
    preset: str = "veryfast",
    fps: int = 30,
) -> List[str]:
    """The full ffmpeg invocation for one clip.

    `-ss` before `-i` seeks fast; `-accurate_seek` keeps the cut frame-exact so
    captions stay aligned with speech.
    """
    return [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-accurate_seek", "-ss", f"{start:.3f}",
        "-i", str(source),
        "-t", f"{duration:.3f}",
        "-vf", filter_chain,
        "-r", str(fps),
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
        "-pix_fmt", "yuv420p", "-profile:v", "high",
        "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart",
        str(output),
    ]


def run(command: Sequence[str]) -> None:
    require_ffmpeg()
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg failed ({result.returncode}):\n{result.stderr.strip()[-2000:]}"
        )
