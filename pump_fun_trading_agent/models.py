"""Data models for tracking paper-trading positions and trade history."""
from __future__ import annotations

import time
from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional, Set


@dataclass
class SellAction:
    """A recommended sell decided by the strategy for a single price tick."""

    reason: str
    fraction_of_remaining: float  # 0.0 - 1.0; 1.0 means "sell all"


@dataclass
class Trade:
    """A single executed (paper) buy or sell, for the audit log."""

    mint: str
    symbol: str
    side: str  # "buy" | "sell"
    reason: str
    price_usd: float
    tokens: float
    usd_value: float
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class Position:
    """Open or closed paper-trading position in a single pump.fun token."""

    mint: str
    symbol: str
    name: str
    is_technical: bool
    entry_price_usd: float
    tokens_remaining: float
    initial_tokens: float
    usd_invested: float
    created_at: float
    opened_at: float = field(default_factory=time.time)

    peak_price_usd: float = 0.0
    been_profitable: bool = False
    recouped: bool = False
    ladder_hits: Set[float] = field(default_factory=set)

    realized_pnl_usd: float = 0.0
    usd_recovered: float = 0.0
    closed: bool = False
    closed_at: Optional[float] = None

    def __post_init__(self) -> None:
        self.peak_price_usd = max(self.peak_price_usd, self.entry_price_usd)

    @property
    def market_value_usd(self) -> float:
        return self.tokens_remaining * self.peak_price_usd

    def unrealized_pnl_usd(self, current_price_usd: float) -> float:
        return self.tokens_remaining * (current_price_usd - self.entry_price_usd)

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["ladder_hits"] = sorted(self.ladder_hits)
        return d

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Position":
        d = dict(d)
        d["ladder_hits"] = set(d.get("ladder_hits", []))
        return cls(**d)
