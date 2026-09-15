"""Paper-trading portfolio: executes buy/sell decisions against an in-memory
+ on-disk ledger. No real funds or wallets are ever touched.
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Dict, List, Optional

from .config import Config
from .models import Position, SellAction, Trade

logger = logging.getLogger(__name__)


class Portfolio:
    def __init__(self, config: Config) -> None:
        self._config = config
        self.positions: Dict[str, Position] = {}
        self.closed_positions: List[Position] = []
        self.cash_usd_spent: float = 0.0
        self.cash_usd_recovered: float = 0.0
        self._load()

    # -- persistence ---------------------------------------------------------

    def _load(self) -> None:
        path = self._config.state_file
        if not os.path.exists(path):
            return
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not load existing state from %s: %s", path, exc)
            return

        for d in data.get("positions", []):
            pos = Position.from_dict(d)
            if pos.closed:
                self.closed_positions.append(pos)
            else:
                self.positions[pos.mint] = pos
        self.cash_usd_spent = data.get("cash_usd_spent", 0.0)
        self.cash_usd_recovered = data.get("cash_usd_recovered", 0.0)
        logger.info(
            "Resumed portfolio state: %d open position(s), %d closed, "
            "$%.2f deployed, $%.2f recovered",
            len(self.positions), len(self.closed_positions),
            self.cash_usd_spent, self.cash_usd_recovered,
        )

    def save(self) -> None:
        os.makedirs(self._config.state_dir, exist_ok=True)
        all_positions = list(self.positions.values()) + self.closed_positions
        data = {
            "positions": [p.to_dict() for p in all_positions],
            "cash_usd_spent": self.cash_usd_spent,
            "cash_usd_recovered": self.cash_usd_recovered,
            "saved_at": time.time(),
        }
        tmp_path = self._config.state_file + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
        os.replace(tmp_path, self._config.state_file)

    def _log_trade(self, trade: Trade) -> None:
        os.makedirs(self._config.state_dir, exist_ok=True)
        with open(self._config.trades_log_file, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(trade.to_dict()) + "\n")

    # -- trading ---------------------------------------------------------------

    def has_position(self, mint: str) -> bool:
        return mint in self.positions

    def open_position(
        self,
        mint: str,
        symbol: str,
        name: str,
        is_technical: bool,
        price_usd: float,
        usd_amount: float,
        created_at: float,
    ) -> Position:
        if price_usd <= 0:
            raise ValueError("price_usd must be positive to open a position")

        tokens = usd_amount / price_usd
        position = Position(
            mint=mint,
            symbol=symbol,
            name=name,
            is_technical=is_technical,
            entry_price_usd=price_usd,
            tokens_remaining=tokens,
            initial_tokens=tokens,
            usd_invested=usd_amount,
            created_at=created_at,
        )
        self.positions[mint] = position
        self.cash_usd_spent += usd_amount
        self._log_trade(Trade(
            mint=mint, symbol=symbol, side="buy", reason="entry",
            price_usd=price_usd, tokens=tokens, usd_value=usd_amount,
        ))
        logger.info(
            "BUY  %-10s $%.2f @ $%.8f (%s) -> %.4f tokens",
            symbol, usd_amount, price_usd,
            "technical" if is_technical else "standard", tokens,
        )
        self.save()
        return position

    def apply_sell(self, position: Position, action: SellAction, price_usd: float) -> None:
        fraction = max(0.0, min(1.0, action.fraction_of_remaining))
        tokens_to_sell = position.tokens_remaining * fraction
        if tokens_to_sell <= self._config.dust_token_threshold:
            return

        usd_value = tokens_to_sell * price_usd
        cost_basis = tokens_to_sell * position.entry_price_usd

        position.tokens_remaining -= tokens_to_sell
        position.realized_pnl_usd += usd_value - cost_basis
        position.usd_recovered += usd_value
        self.cash_usd_recovered += usd_value

        self._log_trade(Trade(
            mint=position.mint, symbol=position.symbol, side="sell",
            reason=action.reason, price_usd=price_usd,
            tokens=tokens_to_sell, usd_value=usd_value,
        ))
        logger.info(
            "SELL %-10s %.4f tokens (%.0f%% of remaining) @ $%.8f -> $%.2f | reason=%s",
            position.symbol, tokens_to_sell, fraction * 100, price_usd, usd_value,
            action.reason,
        )

        if position.tokens_remaining <= self._config.dust_token_threshold:
            self.close_position(position)
        self.save()

    def close_position(self, position: Position) -> None:
        if position.closed:
            return
        position.closed = True
        position.closed_at = time.time()
        self.positions.pop(position.mint, None)
        self.closed_positions.append(position)
        logger.info(
            "CLOSED %-10s realized P&L=$%.2f (invested $%.2f, recovered $%.2f)",
            position.symbol, position.realized_pnl_usd,
            position.usd_invested, position.usd_recovered,
        )

    def summary(self) -> Dict[str, float]:
        unrealized = 0.0
        realized = sum(p.realized_pnl_usd for p in self.closed_positions)
        realized += sum(p.realized_pnl_usd for p in self.positions.values())
        return {
            "open_positions": len(self.positions),
            "closed_positions": len(self.closed_positions),
            "cash_usd_spent": self.cash_usd_spent,
            "cash_usd_recovered": self.cash_usd_recovered,
            "realized_pnl_usd": realized,
        }
