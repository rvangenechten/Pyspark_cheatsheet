"""Best-effort classification of a freshly-launched token as a "technical
project" (as opposed to a plain meme coin) by inspecting whatever web
presence its creator supplied: an on-chain metadata URI, a project website,
and/or a Twitter/X profile.

This is a heuristic, not a guarantee: pump.fun tokens carry no verified
"category" field, so we score keyword hits across whatever text we can
fetch. If a token has neither a website nor a Twitter link at all, it is
treated as non-technical (nothing to evaluate).
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, Optional
from urllib.parse import urlparse

import aiohttp

from .config import Config

logger = logging.getLogger(__name__)

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def _strip_html(html: str) -> str:
    """Very small HTML->text reduction, good enough for keyword scoring."""
    text = _TAG_RE.sub(" ", html)
    return _WS_RE.sub(" ", text).strip()


def _normalize_twitter_url(handle_or_url: str) -> Optional[str]:
    handle_or_url = handle_or_url.strip()
    if not handle_or_url:
        return None
    if handle_or_url.startswith("http"):
        return handle_or_url
    handle = handle_or_url.lstrip("@")
    return f"https://x.com/{handle}"


async def _fetch_text(session: aiohttp.ClientSession, url: str, config: Config) -> str:
    try:
        async with session.get(
            url,
            timeout=config.http_timeout_seconds,
            headers={"User-Agent": "Mozilla/5.0 (compatible; PumpFunPaperBot/0.1)"},
            allow_redirects=True,
        ) as resp:
            if resp.status != 200:
                return ""
            raw = await resp.text(errors="ignore")
            return _strip_html(raw)
    except Exception as exc:  # noqa: BLE001 - a single dead link must not crash classification
        logger.debug("Fetch failed for %s: %s", url, exc)
        return ""


async def _fetch_metadata(
    session: aiohttp.ClientSession, uri: Optional[str], config: Config
) -> Dict[str, Any]:
    if not uri:
        return {}
    try:
        async with session.get(uri, timeout=config.http_timeout_seconds) as resp:
            if resp.status != 200:
                return {}
            return await resp.json(content_type=None)
    except Exception as exc:  # noqa: BLE001
        logger.debug("Metadata fetch failed for %s: %s", uri, exc)
        return {}


def score_text(text: str, config: Config) -> int:
    """Return the number of distinct technical keywords found in ``text``."""
    lowered = text.lower()
    return sum(1 for kw in config.technical_keywords if kw in lowered)


async def classify_technical(
    session: aiohttp.ClientSession,
    token: Dict[str, Any],
    config: Config,
) -> bool:
    """Decide whether ``token`` looks like a technical project.

    ``token`` is expected to carry at least ``name``/``symbol``, and
    optionally ``uri`` (on-chain metadata JSON), ``website``, ``twitter``.
    """
    metadata = await _fetch_metadata(session, token.get("uri"), config)

    website = token.get("website") or metadata.get("website")
    twitter = token.get("twitter") or metadata.get("twitter")
    description = metadata.get("description", "") or ""

    if not website and not twitter:
        # No verifiable project presence at all -> treat as a plain meme
        # launch, regardless of how technical-sounding the name is.
        return False

    texts = [token.get("name", ""), token.get("symbol", ""), description]

    if website:
        parsed = urlparse(website if website.startswith("http") else f"https://{website}")
        if parsed.netloc:
            texts.append(await _fetch_text(session, parsed.geturl(), config))

    if twitter:
        twitter_url = _normalize_twitter_url(twitter)
        if twitter_url:
            texts.append(await _fetch_text(session, twitter_url, config))

    combined = " ".join(t for t in texts if t)
    hits = score_text(combined, config)
    return hits >= config.technical_keyword_min_hits
