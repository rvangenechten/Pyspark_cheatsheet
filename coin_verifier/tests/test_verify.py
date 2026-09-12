import httpx

from app.config import settings
from app.models import CandidatePair, TokenSocials
from app.verify import verify_token

GOOD_HTML = """
<html><head><title>DOGE</title>
<meta name="description" content="DOGE token official site."></head>
<body><a href="https://x.com/RealDoge">Twitter</a></body></html>
"""


def _client_returning(html: str) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=html)

    return httpx.Client(transport=httpx.MockTransport(handler))


def _token(**overrides) -> CandidatePair:
    base = dict(
        chain_id="solana",
        pair_address="pair1",
        token_address="mint1",
        name="Doge Coin",
        symbol="DOGE",
        price_usd=0.001,
        market_cap_usd=50_000,
        pair_created_at_ms=None,
        url="https://dexscreener.com/solana/pair1",
        socials=TokenSocials(website="https://doge.example", twitter="https://x.com/RealDoge", source="dexscreener"),
    )
    base.update(overrides)
    return CandidatePair(**base)


def test_verify_token_passes_when_everything_lines_up(monkeypatch):
    import time

    monkeypatch.setattr(settings, "require_holder_data", False)
    token = _token(pair_created_at_ms=int(time.time() * 1000) - 3600_000)  # 1h old
    client = _client_returning(GOOD_HTML)

    result = verify_token(client, token, holder_provider=None)

    assert result.verified is True
    assert result.reasons == []
    assert result.ticker_found_on_website is True
    assert result.twitter_linked_on_website is True


def test_verify_token_rejects_below_market_cap(monkeypatch):
    monkeypatch.setattr(settings, "require_holder_data", False)
    token = _token(market_cap_usd=500)
    client = _client_returning(GOOD_HTML)

    result = verify_token(client, token, holder_provider=None)

    assert result.verified is False
    assert any("market cap" in r for r in result.reasons)


def test_verify_token_rejects_missing_socials(monkeypatch):
    monkeypatch.setattr(settings, "require_holder_data", False)
    token = _token(socials=TokenSocials())
    client = _client_returning(GOOD_HTML)

    result = verify_token(client, token, holder_provider=None)

    assert result.verified is False
    assert "no website found" in result.reasons
    assert "no twitter/X found" in result.reasons


def test_verify_token_rejects_unlinked_twitter(monkeypatch):
    monkeypatch.setattr(settings, "require_holder_data", False)
    token = _token(socials=TokenSocials(website="https://doge.example", twitter="https://x.com/Impostor"))
    client = _client_returning(GOOD_HTML)

    result = verify_token(client, token, holder_provider=None)

    assert result.verified is False
    assert any("does not link to the declared twitter" in r for r in result.reasons)


def test_verify_token_requires_holder_data_by_default(monkeypatch):
    monkeypatch.setattr(settings, "require_holder_data", True)
    token = _token()
    client = _client_returning(GOOD_HTML)

    result = verify_token(client, token, holder_provider=None)

    assert result.verified is False
    assert any("holder count unavailable" in r for r in result.reasons)
