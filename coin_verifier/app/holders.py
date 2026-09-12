"""Holder-count lookups.

DexScreener's API does not return holder counts at all, and none of the
launchpads mentioned in the brief (pump.fun and similar) expose it through
a public, keyless API either - it has to come from a chain indexer.

Free, keyless options are essentially non-existent at any reliable volume:
  - Solscan's public API now requires a (paid) Pro key for holder data.
  - Etherscan/BscScan/etc.'s free tier does not include token holder count
    (it's a Pro-only endpoint on Etherscan itself).
  - Solana's own RPC has no cheap "holder count" call; counting requires
    `getProgramAccounts` on the SPL Token program filtered by mint, which
    public RPC nodes heavily rate-limit or reject outright for a large
    token.

So this module defines a small provider interface and ships one real
implementation (Birdeye, multi-chain including Solana, needs a free-tier
API key) rather than pretending a keyless option exists. Without a
BIRDEYE_API_KEY configured, `get_holder_count` returns None and the
verification pipeline treats holder count as "unknown" - by default
(REQUIRE_HOLDER_DATA=true) that means the token is excluded rather than
silently passed, since "at least 10 holders" can't be claimed without data.

Not verifiable from this sandbox: outbound access to Birdeye is blocked by
the environment's egress policy, so this client's request/response shape
could not be exercised against the live API. It matches Birdeye's
published API reference; confirm before relying on it in production.
"""
from __future__ import annotations

from typing import Protocol

import httpx

from .config import settings


class HolderCountProvider(Protocol):
    def get_holder_count(self, client: httpx.Client, chain_id: str, token_address: str) -> int | None:
        ...


class BirdeyeHolderProvider:
    """Uses Birdeye's `/defi/v3/token/holder` endpoint.

    Chain is passed via the `x-chain` header using Birdeye's own chain
    slugs (solana, ethereum, bsc, base, arbitrum, ...); a DexScreener
    chainId maps 1:1 for the chains Birdeye supports.
    """

    BASE_URL = "https://public-api.birdeye.so"

    def __init__(self, api_key: str | None = None):
        self.api_key = api_key or settings.birdeye_api_key

    def get_holder_count(self, client: httpx.Client, chain_id: str, token_address: str) -> int | None:
        if not self.api_key:
            return None
        try:
            resp = client.get(
                f"{self.BASE_URL}/defi/v3/token/holder",
                params={"address": token_address, "offset": 0, "limit": 1},
                headers={"X-API-KEY": self.api_key, "x-chain": chain_id},
            )
            resp.raise_for_status()
            data = resp.json()
            total = (data.get("data") or {}).get("items_total") or (data.get("data") or {}).get("total")
            return int(total) if total is not None else None
        except Exception:
            return None


def default_provider() -> HolderCountProvider | None:
    if settings.birdeye_api_key:
        return BirdeyeHolderProvider()
    return None
