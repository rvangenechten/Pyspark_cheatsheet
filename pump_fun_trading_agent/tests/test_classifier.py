import asyncio

from pump_fun_trading_agent import classifier
from pump_fun_trading_agent.config import Config


def run(coro):
    return asyncio.run(coro)


def test_score_text_counts_keyword_hits():
    config = Config()
    text = "An open-source protocol with an SDK and on-chain oracle."
    hits = classifier.score_text(text, config)
    assert hits >= 3


def test_no_website_or_twitter_is_not_technical(monkeypatch):
    config = Config()

    async def fake_fetch_metadata(session, uri, cfg):
        return {}

    monkeypatch.setattr(classifier, "_fetch_metadata", fake_fetch_metadata)

    token = {"name": "AI Protocol Agent", "symbol": "AIP"}  # technical-sounding name only
    result = run(classifier.classify_technical(session=None, token=token, config=config))
    assert result is False


def test_technical_keywords_in_website_text_classify_as_technical(monkeypatch):
    config = Config()

    async def fake_fetch_metadata(session, uri, cfg):
        return {"website": "https://example.com", "description": ""}

    async def fake_fetch_text(session, url, cfg):
        return "We are building open-source developer infrastructure and an SDK."

    monkeypatch.setattr(classifier, "_fetch_metadata", fake_fetch_metadata)
    monkeypatch.setattr(classifier, "_fetch_text", fake_fetch_text)

    token = {"name": "Random Dog Coin", "symbol": "DOG", "uri": "ipfs://fake"}
    result = run(classifier.classify_technical(session=None, token=token, config=config))
    assert result is True


def test_website_present_but_no_technical_content_is_not_technical(monkeypatch):
    config = Config()

    async def fake_fetch_metadata(session, uri, cfg):
        return {"website": "https://example.com", "description": "very funny dog coin"}

    async def fake_fetch_text(session, url, cfg):
        return "wow much doge very moon to the moon lambo"

    monkeypatch.setattr(classifier, "_fetch_metadata", fake_fetch_metadata)
    monkeypatch.setattr(classifier, "_fetch_text", fake_fetch_text)

    token = {"name": "Doge Coin 2", "symbol": "DOGE2", "uri": "ipfs://fake"}
    result = run(classifier.classify_technical(session=None, token=token, config=config))
    assert result is False
