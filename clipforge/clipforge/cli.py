"""Command line entry point: `python -m clipforge`."""

from __future__ import annotations

import argparse
import sys

from .pipeline import Settings, process


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="clipforge",
        description="Turn a long video into ranked, captioned 9:16 clips.",
    )
    parser.add_argument("source", help="Source video or audio file")
    parser.add_argument("-o", "--outdir", default="clips", help="Output directory")
    parser.add_argument(
        "-t",
        "--transcript",
        help="Existing transcript (.json or .srt). Skips transcription.",
    )
    parser.add_argument("-n", "--count", type=int, default=8, help="Clips to produce")
    parser.add_argument("--min", type=float, default=18.0, dest="min_seconds")
    parser.add_argument("--max", type=float, default=75.0, dest="max_seconds")
    parser.add_argument(
        "--reframe",
        choices=("crop", "blur"),
        default="crop",
        help="crop: centre-crop to 9:16. blur: fit over a blurred backdrop.",
    )
    parser.add_argument(
        "--bias",
        type=float,
        default=0.5,
        dest="crop_x_bias",
        help="Horizontal crop position, 0=left 0.5=centre 1=right",
    )
    parser.add_argument("--font", default="Arial Black")
    parser.add_argument("--font-size", type=int, default=96, dest="font_size")
    parser.add_argument(
        "--no-captions", action="store_true", help="Skip burned-in captions"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Pick clips and print ffmpeg commands without encoding",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    settings = Settings(
        min_seconds=args.min_seconds,
        max_seconds=args.max_seconds,
        count=args.count,
        reframe=args.reframe,
        crop_x_bias=args.crop_x_bias,
        font=args.font,
        font_size=args.font_size,
        burn_captions=not args.no_captions,
        dry_run=args.dry_run,
    )
    try:
        process(args.source, args.outdir, transcript=args.transcript, settings=settings)
    except Exception as exc:
        print(f"clipforge: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
