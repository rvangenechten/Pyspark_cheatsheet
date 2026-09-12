import httpx
import pytest

from app.website_check import _normalize_twitter_handle, _ticker_in_text, check_website


def test_normalize_twitter_handle_variants():
    assert _normalize_twitter_handle("https://twitter.com/DogeCoin") == "dogecoin"
    assert _normalize_twitter_handle("https://x.com/DogeCoin/status/123") == "dogecoin"
    assert _normalize_twitter_handle("https://x.com/intent/follow?user=x") is None
    assert _normalize_twitter_handle("https://example.com/DogeCoin") is None


def test_ticker_in_text_word_boundary_and_cashtag():
    assert _ticker_in_text("DOGE", "The $DOGE community welcomes you") is True
    assert _ticker_in_text("DOGE", "the doge coin project") is True
    assert _ticker_in_text("DOGE", "this is about dogecoin the animal") is False  # substring, not whole word
    assert _ticker_in_text("DOGE", "unrelated content here") is False


REAL_TOKEN_HTML = """
<html>
<head>
  <title>DogeCoin - $DOGE</title>
  <meta name="description" content="DOGE is a community coin on Solana.">
</head>
<body>
  <p>Welcome to DOGE. Follow us on Twitter.</p>
  <a href="https://x.com/RealDogeCoin">Twitter</a>
</body>
</html>
"""

SCAM_TOKEN_HTML = """
<html>
<head><title>Unrelated Landing Page</title></head>
<body>
  <p>This page has nothing to do with the token and links to a different account.</p>
  <a href="https://x.com/SomeoneElse">Twitter</a>
</body>
</html>
"""


def _client_returning(html: str) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=html)

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_check_website_matches_ticker_and_linked_twitter():
    client = _client_returning(REAL_TOKEN_HTML)
    result = check_website(client, "https://dogecoin.example", "DOGE", "https://x.com/RealDogeCoin")
    assert result.reachable is True
    assert result.ticker_found is True
    assert result.twitter_linked is True
    assert "DOGE" in result.summary or "doge" in result.summary.lower()


def test_check_website_flags_mismatched_twitter():
    client = _client_returning(SCAM_TOKEN_HTML)
    result = check_website(client, "https://scam.example", "DOGE", "https://x.com/RealDogeCoin")
    assert result.reachable is True
    assert result.ticker_found is False
    assert result.twitter_linked is False


def test_check_website_handles_unreachable_site():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom", request=request)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = check_website(client, "https://down.example", "DOGE", "https://x.com/RealDogeCoin")
    assert result.reachable is False
    assert result.error is not None
