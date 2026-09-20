"""ClipForge - a free, self-hosted long-form-to-shorts pipeline.

    from clipforge.pipeline import process, Settings
    process("episode.mp4", "out/", settings=Settings(count=10))
"""

__version__ = "0.1.0"

from .model import Clip, Sentence, Word  # noqa: F401
