"""Thin client for DexScreener's free public API.

Confirmed (as of DexScreener's published API reference) endpoints and shapes
used here, none of which require an API key:

  GET /token-profiles/latest/v1
      -> list of the most recently *submitted* token profiles across all
         chains: {chainId, tokenAddress, icon, header, description,
         links: [{type|label, url}]}. This is the closest thing DexScreener
         offers to a "newest tokens with social info" feed - it's driven by
         projects proactively filling in their DexScreener listing, not by
         pair-creation time, so it's used here as a *candidate source*, not
         as ground truth for age or market cap.

  GET /token-boosts/latest/v1
      -> similarly shaped list of tokens whose listing was recently
         "boosted" (paid promotion). Same caveat as above.

  GET /latest/dex/tokens/{chainId}/{tokenAddresses}
      -> up to 30 comma-separated token addresses, returns full live pair
         data: priceUsd, marketCap, fdv, liquidity, pairCreatedAt (ms epoch),
         and, when present, an `info` block with `websites` and `socials`
         links. This is the source of truth for market cap / age used by
         the screener filters.

  GET /latest/dex/search?q={query}
      -> free-text search across pairs; useful as a manual/testing entry
         point, not used by the automatic screener loop.

DexScreener does NOT expose: holder counts, or a dedicated "brand new
pairs" feed. Those gaps are filled elsewhere in this app (see holders.py
and solana_metadata.py).

NOTE: outbound network access to api.dexscreener.com is blocked by this
sandbox's egress policy, so this client could not be exercised against the
live API from inside this session. The endpoint paths and response shapes
below match DexScreener's published API reference; verify against a live
environment before relying on them in production.
"""
from __future__ import annotations

import httpx

from .config import settings
from .models import CandidatePair, TokenSocials


class DexScreenerClient:
    def __init__(self, base_url: str | None = None, timeout: float | None = None):
        self.base_url = (base_url or settings.dexscreener_base_url).rstrip("/")
        self.timeout = timeout or settings.http_timeout_seconds

    def _get(self, client: httpx.Client, path: str, params: dict | None = None) -> dict | list:
        resp = client.get(f"{self.base_url}{path}", params=params)
        resp.raise_for_status()
        return resp.json()

    def latest_token_profiles(self, client: httpx.Client) -> list[dict]:
        data = self._get(client, "/token-profiles/latest/v1")
        return data if isinstance(data, list) else []

    def latest_token_boosts(self, client: httpx.Client) -> list[dict]:
        data = self._get(client, "/token-boosts/latest/v1")
        return data if isinstance(data, list) else []

    def get_pairs_for_tokens(self, client: httpx.Client, chain_id: str, token_addresses: list[str]) -> list[dict]:
        """Fetch live pair data for up to 30 token addresses on one chain."""
        pairs: list[dict] = []
        for batch in _chunk(token_addresses, 30):
            joined = ",".join(batch)
            data = self._get(client, f"/latest/dex/tokens/{chain_id}/{joined}")
            if isinstance(data, dict):
                pairs.extend(data.get("pairs") or [])
            elif isinstance(data, list):
                pairs.extend(data)
        return pairs

    def search(self, client: httpx.Client, query: str) -> list[dict]:
        data = self._get(client, "/latest/dex/search", params={"q": query})
        if isinstance(data, dict):
            return data.get("pairs") or []
        return []


def _chunk(items: list[str], size: int):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def parse_pair(raw: dict) -> CandidatePair | None:
    """Convert a raw DexScreener pair dict into a CandidatePair."""
    base = raw.get("baseToken") or {}
    if not base.get("address"):
        return None

    info = raw.get("info") or {}
    website = None
    for w in info.get("websites") or []:
        if w.get("url"):
            website = w["url"]
            break
    twitter = None
    telegram = None
    for s in info.get("socials") or []:
        s_type = (s.get("type") or s.get("label") or "").lower()
        url = s.get("url")
        if not url:
            continue
        if s_type in {"twitter", "x"} and twitter is None:
            twitter = url
        elif s_type == "telegram" and telegram is None:
            telegram = url

    try:
        price_usd = float(raw["priceUsd"]) if raw.get("priceUsd") is not None else None
    except (TypeError, ValueError):
        price_usd = None

    return CandidatePair(
        chain_id=raw.get("chainId", ""),
        dex_id=raw.get("dexId"),
        pair_address=raw.get("pairAddress", ""),
        token_address=base["address"],
        name=base.get("name") or base.get("symbol") or "?",
        symbol=base.get("symbol") or "?",
        price_usd=price_usd,
        market_cap_usd=raw.get("marketCap"),
        fdv_usd=raw.get("fdv"),
        liquidity_usd=(raw.get("liquidity") or {}).get("usd"),
        pair_created_at_ms=raw.get("pairCreatedAt"),
        url=raw.get("url"),
        socials=TokenSocials(website=website, twitter=twitter, telegram=telegram, source="dexscreener" if (website or twitter) else None),
    )
