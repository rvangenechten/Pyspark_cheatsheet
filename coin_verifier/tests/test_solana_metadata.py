import struct

from app.solana_metadata import parse_metadata_account


def _borsh_string(s: str) -> bytes:
    encoded = s.encode("utf-8")
    return struct.pack("<I", len(encoded)) + encoded


def _fake_metadata_account(name: str, symbol: str, uri: str) -> bytes:
    key = bytes([4])  # MetadataV1 discriminant
    update_authority = bytes(32)
    mint = bytes(32)
    return key + update_authority + mint + _borsh_string(name) + _borsh_string(symbol) + _borsh_string(uri)


def test_parse_metadata_account_extracts_name_symbol_uri():
    raw = _fake_metadata_account("Doge Coin", "DOGE", "https://arweave.net/abc123")
    parsed = parse_metadata_account(raw)
    assert parsed.name == "Doge Coin"
    assert parsed.symbol == "DOGE"
    assert parsed.uri == "https://arweave.net/abc123"


def test_parse_metadata_account_strips_null_padding():
    # Simulate a fixed-capacity buffer where trailing NULs were serialized
    # as part of the string content.
    padded_symbol = "DOGE" + "\x00" * 6
    raw = _fake_metadata_account("Doge Coin", padded_symbol, "https://arweave.net/abc123")
    parsed = parse_metadata_account(raw)
    assert parsed.symbol == "DOGE"
