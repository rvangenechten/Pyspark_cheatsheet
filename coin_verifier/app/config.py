"""Runtime configuration, all overridable via environment variables."""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _float_env(name: str, default: float) -> float:
    raw = os.environ.get(name)
    return float(raw) if raw else default


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw else default


def _bool_env(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    # --- Screener thresholds ---
    min_market_cap_usd: float = field(default_factory=lambda: _float_env("MIN_MARKET_CAP_USD", 10_000))
    min_holders: int = field(default_factory=lambda: _int_env("MIN_HOLDERS", 10))
    max_age_hours: float = field(default_factory=lambda: _float_env("MAX_AGE_HOURS", 24))

    # If no holder-count provider is configured/available, should tokens be
    # excluded (safer, default) or let through unverified on that one check?
    require_holder_data: bool = field(default_factory=lambda: _bool_env("REQUIRE_HOLDER_DATA", True))

    # --- LLM summaries (Claude) ---
    # Credentials are resolved by the Anthropic SDK itself (ANTHROPIC_API_KEY,
    # ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile), so there's no key
    # setting here - only whether to attempt summaries at all.
    enable_llm_summary: bool = field(default_factory=lambda: _bool_env("ENABLE_LLM_SUMMARY", True))
    summary_model: str = field(default_factory=lambda: os.environ.get("SUMMARY_MODEL", "claude-opus-5"))
    summary_max_chars: int = field(default_factory=lambda: _int_env("SUMMARY_MAX_CHARS", 6000))
    summary_timeout_seconds: float = field(default_factory=lambda: _float_env("SUMMARY_TIMEOUT_SECONDS", 30.0))

    # --- Optional third-party API keys (features degrade gracefully without them) ---
    birdeye_api_key: str | None = field(default_factory=lambda: os.environ.get("BIRDEYE_API_KEY"))
    helius_api_key: str | None = field(default_factory=lambda: os.environ.get("HELIUS_API_KEY"))
    twitter_bearer_token: str | None = field(default_factory=lambda: os.environ.get("TWITTER_BEARER_TOKEN"))

    # --- Networking ---
    http_timeout_seconds: float = field(default_factory=lambda: _float_env("HTTP_TIMEOUT_SECONDS", 10.0))
    dexscreener_base_url: str = field(
        default_factory=lambda: os.environ.get("DEXSCREENER_BASE_URL", "https://api.dexscreener.com")
    )
    solana_rpc_url: str = field(
        default_factory=lambda: os.environ.get("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")
    )

    # --- Cache ---
    cache_ttl_seconds: int = field(default_factory=lambda: _int_env("CACHE_TTL_SECONDS", 60))


settings = Settings()
