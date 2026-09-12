"""FastAPI app exposing the verified-token screener.

    GET /api/tokens         -> list of results (verified + rejected, so the
                                UI/caller can see *why* something was
                                filtered out, not just a silent empty list)
    GET /api/tokens?only_verified=true
    GET /healthz

Results are cached in-process for CACHE_TTL_SECONDS to avoid hammering
DexScreener/Birdeye/websites on every request - a real deployment should
instead run `run_screener()` on a background schedule and serve the last
result, but an on-demand+cache approach keeps this app runnable with a
single `uvicorn` process.
"""
from __future__ import annotations

import time

from fastapi import FastAPI, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .verify import run_screener

app = FastAPI(title="Coin Verifier")

_static_dir = __file__.rsplit("/", 2)[0] + "/static"
app.mount("/static", StaticFiles(directory=_static_dir), name="static")

_cache: dict[str, object] = {"at": 0.0, "results": []}


def _get_results(force_refresh: bool = False) -> list:
    now = time.time()
    if force_refresh or now - _cache["at"] > settings.cache_ttl_seconds:
        _cache["results"] = run_screener()
        _cache["at"] = now
    return _cache["results"]


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/api/tokens")
def api_tokens(only_verified: bool = Query(default=True), refresh: bool = Query(default=False)):
    results = _get_results(force_refresh=refresh)
    if only_verified:
        results = [r for r in results if r.verified]
    return {
        "generatedAt": _cache["at"],
        "filters": {
            "minMarketCapUsd": settings.min_market_cap_usd,
            "minHolders": settings.min_holders,
            "maxAgeHours": settings.max_age_hours,
        },
        "count": len(results),
        "tokens": [r.as_row() for r in results],
    }


@app.get("/")
def index():
    return FileResponse(f"{_static_dir}/index.html")
