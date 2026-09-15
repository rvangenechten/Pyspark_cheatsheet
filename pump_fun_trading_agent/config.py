"""Central configuration for the pump.fun paper-trading agent.

All thresholds live here so the strategy can be tuned without touching
the trading logic itself.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List


@dataclass(frozen=True)
class Config:
    # --- PumpPortal data feed -------------------------------------------------
    pumpportal_ws_url: str = "wss://pumpportal.fun/api/data"
    ws_reconnect_min_seconds: float = 1.0
    ws_reconnect_max_seconds: float = 30.0

    # --- Token qualification ---------------------------------------------------
    # A token only enters the "technical" buy tier if it is caught within this
    # many seconds of its creation event.
    fresh_max_age_seconds: int = 300
    # "under 10k mcap"
    mcap_threshold_usd: float = 10_000.0

    # --- Position sizing (USD) --------------------------------------------------
    # buy $100 if the token is a technical project AND fresh AND under the
    # market-cap threshold; otherwise buy $25.
    buy_usd_technical: float = 100.0
    buy_usd_default: float = 25.0

    # --- Profit taking ------------------------------------------------------
    # Ladder of price multiples (relative to entry price) at which a slice of
    # the *remaining* position is sold to "take some profits" on the way up.
    # 2.0x is deliberately excluded here: it is handled by recoup_multiple
    # below ("take initial when doubled").
    profit_take_ladder: List[float] = field(
        default_factory=lambda: [1.5, 3.0, 5.0, 10.0, 20.0]
    )
    # Fraction of the *remaining* tokens sold at each ladder rung.
    profit_take_fraction: float = 0.20

    # "take initial when doubled": once price reaches this multiple of the
    # entry price, sell exactly enough tokens to recoup the original USD
    # invested (a "risk-free" runner for whatever remains).
    recoup_multiple: float = 2.0

    # "sell all when price reaches again same price": once a position has
    # gone into profit (peak price above entry), a pullback to at or below
    # the entry price triggers a full exit of whatever remains.
    breakeven_exit_enabled: bool = True
    # Price must rise at least this multiple above entry before the
    # breakeven-exit rule is "armed" — avoids a full exit being triggered by
    # noise that never really left the entry price.
    breakeven_arm_multiple: float = 1.05

    # Position is considered fully closed once fewer than this many tokens
    # remain (avoids float dust keeping a position open forever).
    dust_token_threshold: float = 1e-6

    # --- Technical-project classification --------------------------------------
    technical_keywords: List[str] = field(
        default_factory=lambda: [
            "protocol", "infrastructure", "infra", "sdk", "api", "framework",
            "smart contract", "blockchain", "rollup", "layer 2", "layer-2",
            "zk-", "zero knowledge", "zero-knowledge", "oracle", "compiler",
            "open source", "open-source", "github", "developer tool",
            "dev tool", "agent framework", "ai agent", "artificial intelligence",
            "machine learning", "neural network", "llm", "algorithm", "on-chain",
            "onchain", "node", "validator", "consensus", "cryptography",
            "encryption", "decentralized", "middleware", "toolkit", "cli",
            "library", "codebase", "whitepaper", "technical paper", "research",
        ]
    )
    # Minimum number of distinct technical keyword hits across the token's
    # name/symbol/description/website/twitter text before it counts as a
    # "technical project" rather than a plain meme coin.
    technical_keyword_min_hits: int = 1

    # --- Networking --------------------------------------------------------
    http_timeout_seconds: float = 8.0
    sol_price_refresh_seconds: int = 60
    sol_price_fallback_usd: float = 150.0
    sol_price_url: str = (
        "https://api.coingecko.com/api/v3/simple/price"
        "?ids=solana&vs_currencies=usd"
    )

    # --- Persistence ---------------------------------------------------------
    state_dir: str = "state"
    state_file: str = "state/portfolio.json"
    trades_log_file: str = "state/trades.jsonl"


DEFAULT_CONFIG = Config()
