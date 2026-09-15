"""Orchestrator wiring the PumpPortal feed to the classifier, strategy, and
paper-trading portfolio.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, Optional

import aiohttp

from .classifier import classify_technical
from .config import Config, DEFAULT_CONFIG
from .portfolio import Portfolio
from .pumpportal_client import PumpPortalClient
from .sol_price import SolPriceFeed
from .strategy import evaluate_buy, evaluate_sell_actions

logger = logging.getLogger(__name__)


def _price_usd_from_bonding_curve(event: Dict[str, Any], sol_usd_price: float) -> float:
    """pump.fun tokens trade on a bonding curve; every create/trade event
    carries the curve's current SOL and token reserves, whose ratio is the
    instantaneous spot price in SOL per token."""
    v_sol = float(event.get("vSolInBondingCurve", 0) or 0)
    v_tokens = float(event.get("vTokensInBondingCurve", 0) or 0)
    if v_tokens <= 0:
        return 0.0
    return (v_sol / v_tokens) * sol_usd_price


class PumpFunPaperTradingAgent:
    """Ties together the data feed, technical-project classifier, sizing/
    exit strategy, and the (paper) portfolio ledger."""

    def __init__(self, config: Config = DEFAULT_CONFIG) -> None:
        self._config = config
        self._portfolio = Portfolio(config)
        self._session: Optional[aiohttp.ClientSession] = None
        self._sol_price: Optional[SolPriceFeed] = None
        self._client: Optional[PumpPortalClient] = None

    @property
    def portfolio(self) -> Portfolio:
        return self._portfolio

    # -- event handlers -------------------------------------------------------

    async def _on_new_token(self, event: Dict[str, Any]) -> None:
        try:
            await self._process_new_token(event)
        except Exception:  # noqa: BLE001 - one bad event must not kill the feed
            logger.exception("Failed to process new-token event for mint=%s", event.get("mint"))

    async def _process_new_token(self, event: Dict[str, Any]) -> None:
        mint = event.get("mint")
        if not mint or self._portfolio.has_position(mint):
            return

        assert self._session is not None and self._sol_price is not None and self._client is not None
        symbol = event.get("symbol", "?")
        name = event.get("name", "?")
        now = time.time()
        sol_usd = self._sol_price.price_usd

        mcap_usd = float(event.get("marketCapSol", 0) or 0) * sol_usd
        price_usd = _price_usd_from_bonding_curve(event, sol_usd)
        if price_usd <= 0:
            logger.debug("Skipping %s (%s): no usable bonding-curve price yet", symbol, mint)
            return

        is_technical = await classify_technical(self._session, event, self._config)

        # The create event is our first sighting of the token, so "now" is
        # effectively its creation time from the agent's point of view.
        usd_amount = evaluate_buy(
            created_at=now,
            now=now,
            mcap_usd=mcap_usd,
            is_technical=is_technical,
            config=self._config,
        )

        self._portfolio.open_position(
            mint=mint,
            symbol=symbol,
            name=name,
            is_technical=is_technical,
            price_usd=price_usd,
            usd_amount=usd_amount,
            created_at=now,
        )
        await self._client.subscribe_token_trades([mint])

    async def _on_trade(self, event: Dict[str, Any]) -> None:
        try:
            await self._process_trade(event)
        except Exception:  # noqa: BLE001
            logger.exception("Failed to process trade event for mint=%s", event.get("mint"))

    async def _process_trade(self, event: Dict[str, Any]) -> None:
        mint = event.get("mint")
        if not mint:
            return
        position = self._portfolio.positions.get(mint)
        if position is None:
            return  # not one of our open positions (or already closed)

        assert self._sol_price is not None and self._client is not None
        price_usd = _price_usd_from_bonding_curve(event, self._sol_price.price_usd)
        if price_usd <= 0:
            return

        for action in evaluate_sell_actions(position, price_usd, self._config):
            self._portfolio.apply_sell(position, action, price_usd)
            if position.closed:
                break

        if position.closed:
            await self._client.unsubscribe_token_trades([mint])

    # -- lifecycle --------------------------------------------------------------

    async def run(self) -> None:
        async with aiohttp.ClientSession() as session:
            self._session = session
            self._sol_price = SolPriceFeed(session, self._config)
            await self._sol_price.start()

            self._client = PumpPortalClient(
                self._config, on_new_token=self._on_new_token, on_trade=self._on_trade,
            )
            # Resume watching any positions carried over from a previous run.
            if self._portfolio.positions:
                await self._client.subscribe_token_trades(list(self._portfolio.positions.keys()))
                logger.info("Resuming %d open position(s) from saved state",
                            len(self._portfolio.positions))

            try:
                await self._client.run_forever()
            finally:
                await self._sol_price.stop()

    def stop(self) -> None:
        if self._client is not None:
            self._client.stop()
