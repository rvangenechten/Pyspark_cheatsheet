# Mirror Launchpad

Launch a mirror of an existing Solana memecoin on **Robinhood Chain**. The mirror has the same name, symbol, decimals and icon as the original. Every mirror token is backed 1:1 by the real token, which sits in a vault on Solana. Buying and selling the mirror buys and sells the real token through Jupiter, so its price and market cap follow the original.

```
Robinhood Chain                              Solana
─────────────────────────                    ──────────────────────────
user ── buy(USDC) ──▶ MirrorGateway          vault wallet
                       │ BuyRequested ──────▶ relayer ── USDC→TOKEN via Jupiter
                       │                              (tokens land in vault)
        mint ◀──────── fulfillBuy(amountOut, solanaSig)

user ── sell(mirror) ─▶ MirrorGateway
                       │ SellRequested ─────▶ relayer ── TOKEN→USDC via Jupiter
        USDC ◀──────── fulfillSell(usdcOut, solanaSig)   (burns escrowed mirror)
```

**Invariant:** `mirror.totalSupply() <= vault balance of the source mint`. Mirror tokens are only minted after the Jupiter buy has landed, for the amount that actually arrived. Each fill includes the Solana transaction signature so anyone can audit it, and `npm run reserves` checks the invariant for every mirror.

## Layout

| Path | What |
|---|---|
| `contracts/` | Solidity (Hardhat). `MirrorGateway` is the launchpad, order escrow and payouts. `MirrorToken` is the ERC-20 copy of the original. |
| `relayer/` | TypeScript service. It watches the gateway, launches mirrors from Jupiter token metadata, runs the swaps from the vault wallet, fills or refunds orders, and serves the API the web app uses. |
| `app/index.html` | Single-file web app: launch a mirror, list mirrors with price, source mcap and backing, and buy/sell. |

## How an order works

1. **Buy.** The user escrows USDC and sets `minTokensOut` and a deadline. The gateway keeps a fee (default 1%).
2. The relayer gets a Jupiter quote for the net USDC. If the quote is already below `minOut`, it calls `reject` and the user is refunded in full. Otherwise it sets Jupiter's slippage so the swap's guaranteed minimum equals `minOut`, and swaps.
3. `fulfillBuy` mints exactly what the vault received.
4. **Sell** works the same way in reverse. The mirror tokens are escrowed, the relayer sells that amount through Jupiter, and `fulfillSell` burns them and pays the USDC minus the fee.
5. If the relayer does nothing before the deadline, the user can call `cancel(orderId)` to get their escrow back. The relayer is never in a position to keep user funds on the Robinhood side.

### USDC settlement

To avoid waiting on a bridge for every trade, each chain keeps its own USDC float:

- Buyers' USDC collects in the gateway on Robinhood Chain, while the vault spends USDC on Solana.
- Sells work the other way round.

The operator rebalances the two floats now and then, using `withdrawLiquidity` / `depositLiquidity` plus any USDC bridge that supports Robinhood Chain. If the gateway can't cover a sell, the relayer rejects it before swapping, so the user just gets their tokens back.

### Crash safety

The relayer writes each swap to `data/journal.json` before and after it runs. After a restart:

- If the swap landed, the relayer finishes the fill instead of swapping again.
- If the swap's outcome is unknown, the relayer stops and logs the order for manual reconciliation.

It also records the last processed block, so no events are missed.

## Run it

### Contracts

```bash
cd contracts
npm install
npm test                          # 12 tests
DEPLOYER_KEY=0x... RELAYER_ADDRESS=0x<relayer> npm run deploy:testnet
```

On testnet, `deploy.js` also deploys a `MockUSDC` that anyone can mint. On mainnet, set `QUOTE_TOKEN` to USDC.

The compiler comes from the `solc` npm package, so there's no compiler download.

### Relayer

```bash
cd relayer
npm install
cp .env.example .env              # GATEWAY_ADDRESS, RELAYER_KEY, VAULT_KEY, START_BLOCK
npm test                          # order-logic tests (Jupiter/Solana mocked)
npm start                         # watcher + API on :8787
npm run reserves                  # proof-of-reserves check
```

Fund the vault wallet with SOL for fees and a USDC float on Solana. Fund the relayer key with ETH on Robinhood Chain.

### Web app

Serve `app/` as static files and open `index.html?api=http://localhost:8787`, e.g. `npx serve app`.

## Test setup on Robinhood Chain testnet

Jupiter only works on Solana mainnet, so the test setup uses:

- **Robinhood Chain testnet** (chain id 46630) with `MockUSDC`.
- **Solana mainnet** with real, small amounts in the vault.

Buyers pay test USDC and the vault spends real USDC. Keep the vault float tiny, and use `setFeeBps` / `pause` if needed.

## Known limits of this version

- **The vault is custodial.** It's a Solana wallet held by the relayer. Next steps: an Anchor program that owns the tokens and only releases them for Jupiter swaps tied to an order, a multisig owner on the gateway, and several relayers.
- **Exact copy of name, symbol and icon.** This is what you asked for, but wallets and explorers can flag look-alike tokens as scams, and the original team may object. The token stores `sourceChain` and `sourceToken` on-chain and the app shows a "mirror" badge. Consider adding a suffix to the name.
- **Fills aren't instant.** Every trade needs a Jupiter swap, so it takes seconds, not one block. A Robinhood-side pool with arbitrage bots minting and redeeming would allow instant trades but only an approximate peg.
- **Not audited.** Don't put real size through it until it has been reviewed.
