"""Launchpad-agnostic Solana token socials lookup via on-chain metadata.

Pump.fun, and essentially every other Solana meme-coin launchpad (Moonshot,
LetsBonk, Believe, etc.), mints tokens using the standard Metaplex Token
Metadata program. At mint time the creator sets a `uri` pointing at an
off-chain JSON blob (usually on Arweave/IPFS) containing the name, symbol,
image, and - when the creator filled them in - `twitter`, `telegram` and
`website` fields. That JSON is the *original, creator-submitted* source for
a token's socials: it's set once, on-chain-referenced, and can't be quietly
swapped later without also changing the metadata account.

This is also almost certainly what DexScreener itself reads to populate the
`info.websites` / `info.socials` fields returned by its API - so fetching it
directly here gives us an independent way to (a) get socials for tokens
DexScreener hasn't enriched yet, and (b) cross-check what DexScreener
reports.

Two things could not be verified from inside this sandbox, because outbound
access to Solana RPC endpoints and arbitrary metadata-hosting domains
(Arweave/IPFS gateways) is blocked by the environment's egress policy:
  1. That a public RPC endpoint (or your own provider) is reachable and not
     rate-limiting anonymous `getAccountInfo` calls at the volume a screener
     needs - in practice you likely want a paid RPC provider (Helius,
     QuickNode, Triton) rather than the public mainnet-beta endpoint.
  2. That the manual borsh parsing in `parse_metadata_account` below exactly
     matches every metadata account you'll encounter. It matches the
     documented Metaplex Token Metadata account layout and is covered by a
     unit test using a synthetic account buffer (tests/test_solana_metadata.py),
     but has not been run against a real, live account.
"""
from __future__ import annotations

import base64
import struct
from dataclasses import dataclass

import httpx
from solders.pubkey import Pubkey

from .config import settings
from .models import TokenSocials

METADATA_PROGRAM_ID = Pubkey.from_string("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")


def derive_metadata_pda(mint: str) -> Pubkey:
    mint_pubkey = Pubkey.from_string(mint)
    seeds = [b"metadata", bytes(METADATA_PROGRAM_ID), bytes(mint_pubkey)]
    pda, _bump = Pubkey.find_program_address(seeds, METADATA_PROGRAM_ID)
    return pda


@dataclass
class ParsedMetadata:
    name: str
    symbol: str
    uri: str


def parse_metadata_account(data: bytes) -> ParsedMetadata:
    """Parse the borsh-encoded prefix of a Metaplex Token Metadata account.

    Layout used (only the fields needed here):
        key: u8                     (1 byte)
        update_authority: Pubkey    (32 bytes)
        mint: Pubkey                (32 bytes)
        name: borsh string          (4-byte LE length + utf8 bytes)
        symbol: borsh string
        uri: borsh string
        ... (seller_fee_basis_points, creators, etc. - not needed, ignored)

    Metaplex pre-allocates fixed-capacity buffers for name/symbol/uri and
    pads the trailing bytes with NUL, so decoded strings are right-stripped
    of "\\x00".
    """
    offset = 1 + 32 + 32

    def read_string(buf: bytes, off: int) -> tuple[str, int]:
        (length,) = struct.unpack_from("<I", buf, off)
        off += 4
        raw = buf[off : off + length]
        off += length
        return raw.decode("utf-8", errors="ignore").rstrip("\x00"), off

    name, offset = read_string(data, offset)
    symbol, offset = read_string(data, offset)
    uri, offset = read_string(data, offset)
    return ParsedMetadata(name=name, symbol=symbol, uri=uri)


def fetch_onchain_socials(client: httpx.Client, mint: str) -> TokenSocials:
    """Best-effort: read a mint's Metaplex metadata URI and pull socials out
    of the off-chain JSON it points to. Never raises - returns an empty
    TokenSocials on any failure, since this is an enrichment step, not a
    required one.
    """
    empty = TokenSocials(source=None)
    try:
        pda = derive_metadata_pda(mint)
    except Exception:
        return empty

    try:
        resp = client.post(
            settings.solana_rpc_url,
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getAccountInfo",
                "params": [str(pda), {"encoding": "base64"}],
            },
        )
        resp.raise_for_status()
        value = (resp.json().get("result") or {}).get("value")
        if not value or not value.get("data"):
            return empty
        raw = base64.b64decode(value["data"][0])
        parsed = parse_metadata_account(raw)
        if not parsed.uri:
            return empty

        json_resp = client.get(parsed.uri)
        json_resp.raise_for_status()
        meta = json_resp.json()
    except Exception:
        return empty

    extensions = meta.get("extensions") or {}
    website = meta.get("website") or meta.get("external_url") or extensions.get("website")
    twitter = meta.get("twitter") or extensions.get("twitter")
    telegram = meta.get("telegram") or extensions.get("telegram")

    if not (website or twitter or telegram):
        return empty

    return TokenSocials(website=website, twitter=twitter, telegram=telegram, source="onchain-metadata")
