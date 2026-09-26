# Mirror Launchpad

Launch a mirror of an existing Solana memecoin on **Robinhood Chain**. The mirror has the same name, symbol, decimals and icon as the original. Every mirror token is backed 1:1 by the real token, which is held by an on-chain vault program on Solana. Buying and selling the mirror buys and sells the real token through Jupiter, so its price and market cap follow the original.

```
Robinhood Chain                              Solana
─────────────────────────                    ─────────────────────────────────────
user ── buy(USDC) ──▶ MirrorGateway          mirror-vault program (PDA owns tokens)
                       │ BuyRequested ──────▶ relayer ── swap(order, USDC→TOKEN)
                       │                              └─ CPI Jupiter, paid back into vault
        mint ◀──────── fulfillBuy(receipt.amountOut, solanaSig)

user ── sell(mirror) ─▶ MirrorGateway
                       │ SellRequested ─────▶ relayer ── swap(order, TOKEN→USDC)
        USDC ◀──────── fulfillSell(receipt.amountOut, solanaSig)  (burns escrowed mirror)
```

**Invariant:** `mirror.totalSupply() <= vault balance of the source mint`. Mirror tokens are only minted after the vault's swap has landed, for the amount written in its on-chain receipt. `npm run reserves` checks this for every mirror.

## Who controls what

| Key | Can | Can't |
|---|---|---|
| **Admin: Squads multisig** (Solana) | Withdraw from the vault (to rebalance USDC), set caps, rotate operator/guardian, unpause, hand over admin (two-step) | — |
| **Owner: Safe multisig** (Robinhood Chain) | Withdraw gateway liquidity and fees, set fee and payout cap, rotate relayer/guardian, unpause, hand over ownership (two-step) | — |
| **Relayer / operator** (hot key on the server) | Launch mirrors, fill or reject orders, and ask the vault to swap USDC↔token for an order | Withdraw anything; swap anywhere except Jupiter; send swap output anywhere except the vault; swap the same order twice; go over the daily caps |
| **Guardian** | Pause the gateway and the vault | Unpause, or anything else |
| **Users** | Cancel their own order after its deadline and get their escrow back | — |

### What the vault program enforces (`solana/programs/mirror-vault`)

- Backing tokens and the USDC float sit in token accounts owned by the program's PDA. No key can sign for them.
- `swap` is operator-only and only calls the allow-listed swap program (Jupiter v6). The vault PDA signs the swap, and afterwards the program checks the vault spent at most `amount_in` and received at least `min_out` into its own account.
- The route can't reference any other vault token account, so one swap can't drain a different asset.
- Only USDC↔token pairs are allowed.
- One receipt account is created per EVM order id. A second swap for the same order fails, and the receipt is the proof the relayer fills from.
- Outflow is capped per 24h per asset: an absolute amount for USDC, and a share of the balance at the start of the window for tokens (default 20%).
- `withdraw`, cap changes, operator rotation and unpause are admin-only. `initialize` can only be called by the program's upgrade authority, so nobody can front-run the deploy.

### What the gateway enforces (`contracts/`)

- `Ownable2Step`, so ownership goes to a Safe with a propose/accept handover.
- USDC paid out to sellers is capped per day (`payoutCapPerDay`).
- The guardian can pause but not unpause.

### What's still trusted

The operator key is no longer a custody key, but it can still do damage, limited by the caps.

- **Solana side.** It could route vault swaps through a bad-price pool it controls, or swap without a matching Robinhood order. Each day this can cost at most the USDC cap, plus the token cap's share of each asset.
- **Robinhood side.** It could mint mirrors without a real buy and sell them. That costs at most the gateway's daily payout cap.

In both cases the guardian pauses and the multisigs rotate the key.

Removing this remaining trust means the vault has to verify Robinhood Chain orders itself: a cross-chain message (Wormhole, LayerZero or Hyperlane, once one supports Robinhood Chain) or a quorum of independent attesters. The receipt-per-order design is already set up for that.

Set the caps to what you'd accept losing in a day before anyone notices.

## Layout

| Path | What |
|---|---|
| `solana/programs/mirror-vault` | Anchor program: custody, capped Jupiter swaps, receipts, admin controls. |
| `contracts/` | Solidity (Hardhat). `MirrorGateway` is the launchpad, order escrow and payouts. `MirrorToken` is the ERC-20 copy of the original. |
| `relayer/` | TypeScript service. It watches the gateway, registers the vault account and launches the mirror, runs swaps through the vault program, and fills or refunds orders. It also serves the web app's API and contains the admin CLI. |
| `app/index.html` | Single-file web app: launch a mirror, list mirrors with price, source mcap and backing, and buy/sell. |

## How an order works

1. **Buy.** The user escrows USDC and sets `minTokensOut` and a deadline. The gateway keeps a fee (default 1%).
2. The relayer gets a Jupiter quote for the net USDC. If the quote is already below `minOut`, it calls `reject` and the user is refunded in full. Otherwise it asks Jupiter for the raw swap instruction, with the vault PDA as the user and the vault's token account as the destination, and wraps it in `mirror-vault::swap` with the order id and `min_out`.
3. `fulfillBuy` mints the `amount_out` recorded in the order's receipt.
4. **Sell** works the same way in reverse. The mirror tokens are escrowed, the vault sells that amount, and `fulfillSell` burns them and pays the USDC minus the fee.
5. If the relayer does nothing before the deadline, the user can call `cancel(orderId)` to get their escrow back.

### Crash safety

The relayer never keeps a local record of which orders it has swapped; the on-chain receipt is the source of truth.

- For each order, the relayer first checks for a receipt. If one exists, it only finishes the fill.
- If a swap's outcome is unknown, the order is retried. The program refuses a second swap for the same order id, so a retry can't double-spend.
- The relayer checks the receipt again before refunding, so an order whose swap landed late is never refunded.

`data/journal.json` only stores the last processed block.

### USDC settlement

To avoid waiting on a bridge for every trade, each chain keeps its own USDC float:

- Buyers' USDC collects in the gateway on Robinhood Chain, while the vault spends USDC on Solana.
- Sells work the other way round.

The two multisigs rebalance the floats (`withdraw` on the vault, `withdrawLiquidity` / `depositLiquidity` on the gateway) using any USDC bridge that supports Robinhood Chain. If the gateway can't cover a sell, whether from low liquidity or the daily cap, the relayer rejects it before swapping and the user gets their tokens back.

## Tests

```bash
cd solana && cargo test -p mirror-vault   # 10: program runs natively with SPL Token + a fake Jupiter
cd contracts && npm test                  # 14
cd relayer && npm test                    # 22: order logic + TS client vs Rust encoding fixture
```

The vault tests try the attacks directly:

- a route that underpays or overspends;
- a route that pulls from another vault account;
- a swap program that isn't allow-listed;
- a non-operator signer, or a replayed order id;
- going over the daily caps;
- withdrawing or unpausing without the admin.

`tests/encoding.rs` writes `relayer/test/fixtures/vault-ix.json`, and the relayer's TypeScript client is checked against it. If the program's interface changes, run `UPDATE_FIXTURES=1 cargo test -p mirror-vault --test encoding`.

## Deploy

### 1. Multisigs

- **Solana:** create a Squads multisig. Its *vault* address becomes the vault program's admin.
- **Robinhood Chain:** deploy or use a Safe as the gateway owner. Robinhood Chain is EVM, so the standard Safe contracts can be deployed there if they aren't already.
- Create a separate **guardian** key for each chain, for pausing.

### 2. Vault program (Solana)

```bash
cd solana
anchor keys sync          # replaces the placeholder program id with your deploy keypair's
anchor build && anchor deploy --provider.cluster mainnet
cd ../relayer
UPGRADE_AUTHORITY_KEY=... OPERATOR_KEY=... VAULT_PROGRAM_ID=... \
  npm run admin -- init --admin <SquadsVault> --guardian <pk> --usdc-cap 1000 --sell-bps 2000
solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <SquadsVault>
```

After `anchor keys sync`, run `UPDATE_FIXTURES=1 cargo test -p mirror-vault --test encoding` so the fixture uses the new program id. Then send USDC to the vault's USDC account (`npm run admin -- status` shows it).

Hand the **upgrade authority** to the multisig too. Otherwise whoever holds it could deploy a program that ignores all of these checks.

### 3. Gateway (Robinhood Chain)

```bash
cd contracts && npm install
DEPLOYER_KEY=0x... OWNER_ADDRESS=0x<Safe> RELAYER_ADDRESS=0x... GUARDIAN_ADDRESS=0x... PAYOUT_CAP_USDC=1000 \
  npm run deploy:testnet
```

The script refuses a plain wallet as owner on live networks. On testnet it also deploys a `MockUSDC` that anyone can mint.

### 4. Relayer and app

```bash
cd relayer && npm install
cp .env.example .env      # GATEWAY_ADDRESS, RELAYER_KEY, VAULT_PROGRAM_ID, OPERATOR_KEY, START_BLOCK
npm start                 # checks the vault config, then watches + serves the API on :8787
npm run reserves          # proof-of-reserves check
npm run admin -- status   # vault config and USDC float
npm run admin -- pause    # guardian emergency stop
npm run admin -- unpause  # prints a Squads proposal
```

Serve `app/` as static files and open `index.html?api=http://localhost:8787`.

## Testnet caveat

Jupiter only runs on Solana mainnet, so the test setup uses:

- **Robinhood Chain testnet** (chain id 46630) with `MockUSDC`.
- **Solana mainnet** with the real vault program and a small real USDC float.

Buyers pay test USDC while the vault spends real USDC, so keep the float and the caps tiny.

## Not done yet

- **No audit.** Neither the vault program nor the gateway has been audited.
- **Operator trust is limited, not removed.** Verifying orders across chains is the next step (see "What's still trusted" above).
- **Not yet built as a real on-chain Solana program here.** The program has only been tested natively, because the Solana build tools couldn't be downloaded in this environment. Run `anchor build` and a devnet deploy before mainnet.
- **The Jupiter route must fit in one transaction** together with the vault's own accounts. Quotes are limited to 48 accounts and use address lookup tables.
- **Exact copy of name, symbol and icon.** This is what you asked for, but wallets and explorers can flag look-alike tokens, and the original team may object. The app shows a "mirror" badge and the token stores its Solana source on-chain.
