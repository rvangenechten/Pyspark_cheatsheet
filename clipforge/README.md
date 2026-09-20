# ClipForge

A free, self-hosted long-form-to-shorts pipeline, plus the business plan for
selling it as a service.

One long video goes in. Ranked, vertical, caption-burned clips come out, with
a manifest explaining *why* each clip was chosen.

```
episode.mp4 ──► transcribe ──► segment ──► score ──► suppress overlaps ──► render
                (whisper)     (sentence-   (7 free    (time-axis NMS)      (ffmpeg
                              aligned)     heuristics)                      9:16 + ASS)
```

## Why this exists

The paid tools (OpusClip, Ssemble, Choppity, 2short.ai) sell the cutting. The
cutting is free — this repo is the proof. The money is in selling the
**weekly outcome** to a vertical that publishes on a schedule. See
[`business/`](business/).

## Install

```bash
# system dependency, must include libass for burned-in captions
sudo apt install ffmpeg          # or: brew install ffmpeg
ffmpeg -filters | grep ass       # should print the ass filter

python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

## Use

```bash
# full run: transcribe + cut 8 clips
python -m clipforge episode.mp4 -o clips/ -n 8

# skip transcription if you already have a transcript
python -m clipforge episode.mp4 -t episode.srt -o clips/

# see the picks and the exact ffmpeg commands without encoding anything
python -m clipforge episode.mp4 -t episode.srt --dry-run

# wide two-shot that would lose a head to a centre crop
python -m clipforge episode.mp4 --reframe blur

# render the same moment twice for a two-person podcast
python -m clipforge episode.mp4 --bias 0.25 -o clips/left/
python -m clipforge episode.mp4 --bias 0.75 -o clips/right/
```

Output per clip: `NN-slug.mp4`, `NN-slug.ass` (karaoke captions), `NN-slug.srt`,
and one `clips.json` manifest.

## How clips are chosen

`score.py` computes seven components, each 0..1, weighted to sum to 1:

| Component | Weight | What it measures |
|---|---|---|
| `hook` | 0.26 | Strength of the first ~3.5s, where the scroll decision happens |
| `standalone` | 0.18 | Whether a cold viewer needs context they don't have |
| `concreteness` | 0.14 | Numbers and proper nouns vs abstractions |
| `payoff` | 0.12 | Does it close the loop it opened |
| `emotion` | 0.12 | Charged language, from a small hand-picked lexicon |
| `density` | 0.10 | Words per second, peaking at 2.8 |
| `length_fit` | 0.08 | Gaussian around 34 seconds |

No LLM call is required and none is made by default. `score.llm_rerank()` is
available if you want a model to re-rank the shortlist — it sends only the top
20 candidates, one small call per video, and blends 50/50 with the heuristics.

**Tuning is the product.** Run it on your niche, open `clips.json`, look at the
`components` breakdown of the clips you rejected, and move the weights or add
patterns to `HOOK_PATTERNS`. That feedback loop is what a generic tool cannot
copy.

Cuts are always sentence-aligned — a clip that starts mid-word reads as broken
no matter how good the moment was.

## Tests

```bash
python -m unittest discover -s tests -t .
```

37 tests, no ffmpeg or model weights required — they cover segmentation,
scoring bounds, caption timing, ffmpeg command construction and the SRT/JSON
loaders.

## Free compute

| Option | Limit |
|---|---|
| Your own machine | faster-whisper `small` on 4 CPU cores ≈ 8-15 min per 60-min episode |
| Google Colab | 15-30 h/week of T4 |
| Kaggle Notebooks | 30 h/week, often P100 |
| GitHub Actions | free and unlimited on public repos; 2,000 Linux min/month private |

## Layout

```
clipforge/
├── clipforge/
│   ├── model.py       Word / Sentence / Clip primitives
│   ├── transcribe.py  faster-whisper + SRT/JSON loaders
│   ├── segment.py     sentence grouping, candidate generation, overlap NMS
│   ├── score.py       the seven heuristics + optional LLM re-rank
│   ├── captions.py    karaoke ASS + plain SRT
│   ├── render.py      ffmpeg filter graphs and commands
│   ├── pipeline.py    orchestration
│   └── cli.py         python -m clipforge
├── tests/
├── business/          research, plan, 30-day launch, outreach, contracts
└── site/              landing page, ready for GitHub Pages
```

## Rights

Only clip footage you own, that is licensed to you in writing, or that is
public domain / permissively licensed. See
[`business/05-legal-and-rights.md`](business/05-legal-and-rights.md).

## Licence

MIT.
