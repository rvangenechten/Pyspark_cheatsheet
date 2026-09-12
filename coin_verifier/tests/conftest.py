import pytest

from app.config import settings


@pytest.fixture(autouse=True)
def _no_live_llm_calls(monkeypatch):
    """Keep the test suite fully offline by default. test_summarize.py opts
    back in with its own fake client."""
    monkeypatch.setattr(settings, "enable_llm_summary", False)
