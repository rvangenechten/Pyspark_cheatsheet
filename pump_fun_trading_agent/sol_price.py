"""Background SOL/USD price feed used to convert on-chain SOL prices to USD."""
from __future__ import annotations

import asyncio
import logging

import aiohttp

from .config import Config

logger = logging.getLogger(__name__)


class SolPriceFeed:
    """Polls a public price API for the SOL/USD rate and caches it.

    Falls back to the last known good price (or a configured default) if a
    poll fails, so the trading loop never blocks on network flakiness.
    """

    def __init__(self, session: aiohttp.ClientSession, config: Config) -> None:
        self._session = session
        self._config = config
        self.price_usd: float = config.sol_price_fallback_usd
        self._task: asyncio.Task | None = None
        self._stopped = asyncio.Event()

    async def _poll_once(self) -> None:
        try:
            async with self._session.get(
                self._config.sol_price_url,
                timeout=self._config.http_timeout_seconds,
            ) as resp:
                data = await resp.json(content_type=None)
                price = float(data["solana"]["usd"])
                if price > 0:
                    self.price_usd = price
        except Exception as exc:  # noqa: BLE001 - network feed must never crash the agent
            logger.warning("SOL price refresh failed, keeping last known price %.2f: %s",
                            self.price_usd, exc)

    async def _run(self) -> None:
        while not self._stopped.is_set():
            await self._poll_once()
            try:
                await asyncio.wait_for(
                    self._stopped.wait(), timeout=self._config.sol_price_refresh_seconds
                )
            except asyncio.TimeoutError:
                pass

    async def start(self) -> None:
        await self._poll_once()
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._stopped.set()
        if self._task:
            await self._task
