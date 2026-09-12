"""Website <-> Twitter/X <-> ticker cross-verification, and a small
extractive summary of what a project's website actually says.

The goal (per the brief): don't trust a "website" or "twitter" link just
because a launchpad/DexScreener listing shows one - confirm they actually
point at each other and both reference the token's own ticker, so a
scammer can't slap an unrelated, legitimate-looking website or Twitter
account onto a copy-pasted token.

What's checked:
  1. The website loads and its HTML mentions the ticker (title, meta
     description/og:title, or body - as a whole word or a "$TICKER" cashtag).
  2. The website contains a link to the *declared* Twitter/X handle
     (normalizes twitter.com/x.com and compares usernames case-insensitively).
  3. (best-effort, optional) The Twitter/X bio mentions the website's domain
     - only attempted if TWITTER_BEARER_TOKEN is configured, since X's API
     is paid and there is no reliable, ToS-compliant way to read a profile
     bio without it (logged-out scraping is aggressively blocked and would
     violate X's terms). When not configured, this check is skipped and
     reported as `None` (unknown), not as a failure.

Not verifiable from this sandbox: outbound access to arbitrary websites and
to api.twitter.com/api.x.com is blocked by the environment's egress policy,
so none of this could be exercised against a live site in this session.
The ticker/twitter-matching *logic* itself is covered by offline unit tests
in tests/test_website_check.py using canned HTML, independent of network
access.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup

from .config import settings

_TWITTER_HOSTS = {"twitter.com", "x.com", "www.twitter.com", "www.x.com", "mobile.twitter.com"}


def _normalize_twitter_handle(url: str) -> str | None:
    """Extract a lowercase handle from a twitter/x URL, or None if not one."""
    try:
        parsed = urlparse(url if "//" in url else f"//{url}", scheme="https")
    except ValueError:
        return None
    host = (parsed.netloc or "").lower()
    if host not in _TWITTER_HOSTS:
        return None
    path = (parsed.path or "").strip("/")
    if not path:
        return None
    handle = path.split("/")[0]
    # Not real profile paths.
    if handle.lower() in {"i", "intent", "share", "home", "search"}:
        return None
    return handle.lower()


def _ticker_in_text(ticker: str, text: str) -> bool:
    if not ticker:
        return False
    escaped = re.escape(ticker)
    pattern = rf"(?<![A-Za-z0-9]){escaped}(?![A-Za-z0-9])|\${escaped}\b"
    return re.search(pattern, text, flags=re.IGNORECASE) is not None


@dataclass
class WebsiteCheckResult:
    reachable: bool
    ticker_found: bool
    twitter_linked: bool
    summary: str | None
    error: str | None = None


def check_website(client: httpx.Client, website_url: str, ticker: str, declared_twitter: str | None) -> WebsiteCheckResult:
    try:
        resp = client.get(website_url, follow_redirects=True, headers={"User-Agent": "coin-verifier/1.0"})
        resp.raise_for_status()
        html = resp.text
    except Exception as exc:
        return WebsiteCheckResult(reachable=False, ticker_found=False, twitter_linked=False, summary=None, error=str(exc))

    soup = BeautifulSoup(html, "html.parser")

    title = soup.title.string.strip() if soup.title and soup.title.string else ""
    meta_desc = ""
    meta_tag = soup.find("meta", attrs={"name": "description"}) or soup.find("meta", attrs={"property": "og:description"})
    if meta_tag and meta_tag.get("content"):
        meta_desc = meta_tag["content"].strip()

    body_text = soup.get_text(separator=" ", strip=True)
    searchable_text = " ".join([title, meta_desc, body_text[:5000]])
    ticker_found = _ticker_in_text(ticker, searchable_text)

    declared_handle = _normalize_twitter_handle(declared_twitter) if declared_twitter else None
    twitter_linked = False
    if declared_handle:
        for a in soup.find_all("a", href=True):
            handle = _normalize_twitter_handle(a["href"])
            if handle == declared_handle:
                twitter_linked = True
                break

    summary = _build_summary(title=title, meta_desc=meta_desc, body_text=body_text, ticker=ticker)

    return WebsiteCheckResult(reachable=True, ticker_found=ticker_found, twitter_linked=twitter_linked, summary=summary)


def _build_summary(title: str, meta_desc: str, body_text: str, ticker: str, max_len: int = 280) -> str:
    """Small extractive summary: prefer the meta description, fall back to
    the first substantial chunk of visible body text. No external LLM call
    is made - this is intentionally cheap/offline text extraction rather
    than generated prose.
    """
    candidate = meta_desc or ""
    if not candidate:
        # first sentence-ish chunk of body text that isn't just nav junk
        chunks = [c.strip() for c in re.split(r"(?<=[.!?])\s+", body_text) if len(c.strip()) > 40]
        candidate = chunks[0] if chunks else body_text[:max_len]
    candidate = candidate.strip()
    if title and title.lower() not in candidate.lower():
        candidate = f"{title}: {candidate}"
    if len(candidate) > max_len:
        candidate = candidate[: max_len - 1].rstrip() + "…"
    return candidate or f"${ticker}: no readable description found on website."


def check_twitter_bio_mentions_website(client: httpx.Client, twitter_url: str, website_url: str) -> bool | None:
    """Best-effort reverse check via the official X API. Returns None
    (unknown, not failed) when no bearer token is configured or the lookup
    fails for any reason.
    """
    if not settings.twitter_bearer_token:
        return None
    handle = _normalize_twitter_handle(twitter_url)
    if not handle:
        return None
    try:
        resp = client.get(
            f"https://api.twitter.com/2/users/by/username/{handle}",
            params={"user.fields": "description,url,entities"},
            headers={"Authorization": f"Bearer {settings.twitter_bearer_token}"},
        )
        resp.raise_for_status()
        user = (resp.json().get("data") or {})
        bio = (user.get("description") or "") + " " + (user.get("url") or "")
    except Exception:
        return None

    website_domain = urlparse(website_url if "//" in website_url else f"//{website_url}", scheme="https").netloc.lower()
    website_domain = website_domain.removeprefix("www.")
    return website_domain in bio.lower() if website_domain else None
