"""Thin async client for the PumpPortal real-time data WebSocket API.

PumpPortal (wss://pumpportal.fun/api/data) is a free, no-API-key feed that
streams pump.fun token creations and trades. This client only *subscribes*
to data; it never sends a trade/signing request, since this agent is
paper-trading only.

Message shapes (observed, not formally versioned by PumpPortal):
  - New token creation: {"txType": "create", "mint": ..., "name": ...,
    "symbol": ..., "uri": ..., "marketCapSol": ..., "vSolInBondingCurve":
    ..., "vTokensInBondingCurve": ..., ...}
  - Trade: {"txType": "buy"|"sell", "mint": ..., "marketCapSol": ...,
    "vSolInBondingCurve": ..., "vTokensInBondingCurve": ..., ...}
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Awaitable, Callable, Dict, Optional, Set

import websockets

from .config import Config

logger = logging.getLogger(__name__)

NewTokenHandler = Callable[[Dict[str, Any]], Awaitable[None]]
TradeHandler = Callable[[Dict[str, Any]], Awaitable[None]]


class PumpPortalClient:
    """Maintains a resilient subscription to PumpPortal's data feed."""

    def __init__(
        self,
        config: Config,
        on_new_token: NewTokenHandler,
        on_trade: TradeHandler,
    ) -> None:
        self._config = config
        self._on_new_token = on_new_token
        self._on_trade = on_trade
        self._subscribed_mints: Set[str] = set()
        self._ws: Optional[websockets.WebSocketClientProtocol] = None
        self._stopped = asyncio.Event()

    async def subscribe_token_trades(self, mints: list[str]) -> None:
        """Subscribe to trade events for additional mints (idempotent)."""
        new_mints = [m for m in mints if m not in self._subscribed_mints]
        if not new_mints:
            return
        self._subscribed_mints.update(new_mints)
        if self._ws is not None:
            await self._ws.send(json.dumps({"method": "subscribeTokenTrade", "keys": new_mints}))

    async def unsubscribe_token_trades(self, mints: list[str]) -> None:
        stale = [m for m in mints if m in self._subscribed_mints]
        if not stale:
            return
        self._subscribed_mints.difference_update(stale)
        if self._ws is not None:
            await self._ws.send(json.dumps({"method": "unsubscribeTokenTrade", "keys": stale}))

    async def _handle_message(self, raw: str) -> None:
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            logger.debug("Non-JSON message from PumpPortal: %r", raw[:200])
            return

        if not isinstance(event, dict):
            return

        tx_type = event.get("txType")
        if tx_type == "create":
            await self._on_new_token(event)
        elif tx_type in ("buy", "sell"):
            await self._on_trade(event)
        # Other message types (subscription acks, errors) are ignored.

    async def _run_once(self) -> None:
        async with websockets.connect(self._config.pumpportal_ws_url) as ws:
            self._ws = ws
            await ws.send(json.dumps({"method": "subscribeNewToken"}))
            if self._subscribed_mints:
                await ws.send(json.dumps({
                    "method": "subscribeTokenTrade",
                    "keys": list(self._subscribed_mints),
                }))
            logger.info("Connected to PumpPortal data feed")

            async for raw in ws:
                await self._handle_message(raw)

    async def run_forever(self) -> None:
        backoff = self._config.ws_reconnect_min_seconds
        while not self._stopped.is_set():
            try:
                await self._run_once()
                backoff = self._config.ws_reconnect_min_seconds
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - keep the feed alive
                logger.warning("PumpPortal connection lost (%s); reconnecting in %.1fs",
                                exc, backoff)
            finally:
                self._ws = None

            if self._stopped.is_set():
                break
            try:
                await asyncio.wait_for(self._stopped.wait(), timeout=backoff)
            except asyncio.TimeoutError:
                pass
            backoff = min(backoff * 2, self._config.ws_reconnect_max_seconds)

    def stop(self) -> None:
        self._stopped.set()
