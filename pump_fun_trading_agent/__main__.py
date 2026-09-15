"""CLI entry point: ``python -m pump_fun_trading_agent``."""
from __future__ import annotations

import asyncio
import logging
import signal

from .agent import PumpFunPaperTradingAgent
from .config import DEFAULT_CONFIG

logger = logging.getLogger(__name__)


def _setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )


async def _main() -> None:
    _setup_logging()
    agent = PumpFunPaperTradingAgent(DEFAULT_CONFIG)

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, agent.stop)
        except NotImplementedError:
            pass  # signal handlers unsupported on this platform (e.g. Windows)

    logger.info("Starting pump.fun paper-trading agent (Ctrl+C to stop)")
    try:
        await agent.run()
    finally:
        logger.info("Final summary: %s", agent.portfolio.summary())


if __name__ == "__main__":
    asyncio.run(_main())
