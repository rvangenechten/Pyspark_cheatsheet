"""Orchestrates the full pipeline: discover candidates -> enrich socials ->
apply mcap/age/holder filters -> cross-verify website<->twitter<->ticker.
"""
from __future__ import annotations

import time

import httpx

from .config import settings
from .dexscreener import DexScreenerClient, parse_pair
from .holders import HolderCountProvider, default_provider
from .models import CandidatePair, VerificationResult
from .solana_metadata import fetch_onchain_socials
from .website_check import check_twitter_bio_mentions_website, check_website


def _age_hours(pair_created_at_ms: int | None) -> float | None:
    if not pair_created_at_ms:
        return None
    return max(0.0, (time.time() * 1000 - pair_created_at_ms) / 3_600_000)


def enrich_socials(client: httpx.Client, token: CandidatePair) -> CandidatePair:
    """If DexScreener didn't return socials and this is a Solana token, fall
    back to reading them straight off the mint's on-chain metadata."""
    if (token.socials.website or token.socials.twitter) or token.chain_id != "solana":
        return token
    onchain = fetch_onchain_socials(client, token.token_address)
    if onchain.website or onchain.twitter:
        token = token.model_copy(update={"socials": onchain})
    return token


def verify_token(
    client: httpx.Client,
    token: CandidatePair,
    holder_provider: HolderCountProvider | None,
) -> VerificationResult:
    reasons: list[str] = []
    age_hours = _age_hours(token.pair_created_at_ms)

    if token.market_cap_usd is None or token.market_cap_usd < settings.min_market_cap_usd:
        reasons.append(f"market cap below ${settings.min_market_cap_usd:,.0f}")

    if age_hours is None:
        reasons.append("unknown pair age")
    elif age_hours > settings.max_age_hours:
        reasons.append(f"older than {settings.max_age_hours}h")

    holders: int | None = None
    holders_source: str | None = None
    if holder_provider is not None:
        holders = holder_provider.get_holder_count(client, token.chain_id, token.token_address)
        holders_source = type(holder_provider).__name__ if holders is not None else None
    if holders is None:
        if settings.require_holder_data:
            reasons.append("holder count unavailable (no provider/API key configured)")
    elif holders < settings.min_holders:
        reasons.append(f"fewer than {settings.min_holders} holders")

    has_website = bool(token.socials.website)
    has_twitter = bool(token.socials.twitter)
    if not has_website:
        reasons.append("no website found")
    if not has_twitter:
        reasons.append("no twitter/X found")

    ticker_found = False
    twitter_linked = False
    twitter_bio_mentions_website: bool | None = None
    summary: str | None = None

    if has_website:
        result = check_website(client, token.socials.website, token.symbol, token.socials.twitter)
        if not result.reachable:
            reasons.append(f"website unreachable ({result.error})")
        else:
            ticker_found = result.ticker_found
            twitter_linked = result.twitter_linked
            summary = result.summary
            if not ticker_found:
                reasons.append("ticker not found on website")
            if has_twitter and not twitter_linked:
                reasons.append("website does not link to the declared twitter")

        if has_website and has_twitter:
            twitter_bio_mentions_website = check_twitter_bio_mentions_website(
                client, token.socials.twitter, token.socials.website
            )

    verified = not reasons

    return VerificationResult(
        token=token,
        age_hours=age_hours,
        holders=holders,
        holders_source=holders_source,
        has_website=has_website,
        has_twitter=has_twitter,
        ticker_found_on_website=ticker_found,
        twitter_linked_on_website=twitter_linked,
        twitter_bio_mentions_website=twitter_bio_mentions_website,
        summary=summary,
        verified=verified,
        reasons=reasons,
    )


def discover_candidates(client: httpx.Client, dex: DexScreenerClient) -> list[CandidatePair]:
    """Pull candidate tokens from DexScreener's "latest profiles"/"latest
    boosts" feeds (the closest free proxy for "new-ish tokens"), then fetch
    live pair data for each so we have real price/mcap/age.
    """
    raw_candidates = dex.latest_token_profiles(client) + dex.latest_token_boosts(client)

    by_chain: dict[str, set[str]] = {}
    for c in raw_candidates:
        chain = c.get("chainId")
        addr = c.get("tokenAddress")
        if chain and addr:
            by_chain.setdefault(chain, set()).add(addr)

    tokens: list[CandidatePair] = []
    for chain, addrs in by_chain.items():
        for raw_pair in dex.get_pairs_for_tokens(client, chain, list(addrs)):
            token = parse_pair(raw_pair)
            if token is not None:
                tokens.append(token)
    return tokens


def run_screener(client: httpx.Client | None = None) -> list[VerificationResult]:
    dex = DexScreenerClient()
    holder_provider = default_provider()
    owns_client = client is None
    client = client or httpx.Client(timeout=settings.http_timeout_seconds)
    try:
        candidates = discover_candidates(client, dex)
        results = []
        for token in candidates:
            token = enrich_socials(client, token)
            results.append(verify_token(client, token, holder_provider))
        results.sort(key=lambda r: (r.token.market_cap_usd or 0), reverse=True)
        return results
    finally:
        if owns_client:
            client.close()
