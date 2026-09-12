"""Data shapes shared across the pipeline."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class TokenSocials(BaseModel):
    website: Optional[str] = None
    twitter: Optional[str] = None
    telegram: Optional[str] = None
    source: Optional[str] = None  # "dexscreener" | "onchain-metadata" | None


class CandidatePair(BaseModel):
    """A raw dex pair, before any verification is applied."""

    chain_id: str
    dex_id: Optional[str] = None
    pair_address: str
    token_address: str
    name: str
    symbol: str
    price_usd: Optional[float] = None
    market_cap_usd: Optional[float] = None
    fdv_usd: Optional[float] = None
    liquidity_usd: Optional[float] = None
    pair_created_at_ms: Optional[int] = None
    url: Optional[str] = None
    socials: TokenSocials = TokenSocials()


class VerificationResult(BaseModel):
    """Outcome of running a CandidatePair through the verification pipeline."""

    token: CandidatePair
    age_hours: Optional[float] = None
    holders: Optional[int] = None
    holders_source: Optional[str] = None

    has_website: bool = False
    has_twitter: bool = False
    ticker_found_on_website: bool = False
    twitter_linked_on_website: bool = False
    twitter_bio_mentions_website: Optional[bool] = None  # None = not checked (no bearer token)

    summary: Optional[str] = None
    summary_source: Optional[str] = None  # "claude" | "extractive"
    category: Optional[str] = None
    red_flags: list[str] = []
    verified: bool = False
    reasons: list[str] = []

    def as_row(self) -> dict:
        t = self.token
        return {
            "chain": t.chain_id,
            "dex": t.dex_id,
            "name": t.name,
            "symbol": t.symbol,
            "tokenAddress": t.token_address,
            "pairUrl": t.url,
            "priceUsd": t.price_usd,
            "marketCapUsd": t.market_cap_usd,
            "ageHours": round(self.age_hours, 2) if self.age_hours is not None else None,
            "holders": self.holders,
            "holdersSource": self.holders_source,
            "website": t.socials.website,
            "twitter": t.socials.twitter,
            "tickerOnWebsite": self.ticker_found_on_website,
            "twitterLinkedOnWebsite": self.twitter_linked_on_website,
            "twitterBioMentionsWebsite": self.twitter_bio_mentions_website,
            "summary": self.summary,
            "summarySource": self.summary_source,
            "category": self.category,
            "redFlags": self.red_flags,
            "verified": self.verified,
            "reasons": self.reasons,
        }
