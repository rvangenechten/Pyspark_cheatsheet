# battle_vault (Anchor program)

This is the on-chain design the frontend's devnet memo-transaction simulation
stands in for. It **type-checks** (`cargo check -p battle_vault` passes clean
in this repo) but has **not been built with `anchor build`, deployed, tested,
or audited** — there was no `anchor`/`solana` CLI available in the sandbox
this was written in, only `cargo`/`rustc`. Treat it as a reviewable design,
not a build artifact.

## What it does

- **Vaults hold collateral, not the meme coin.** `init_vault` + `deposit`/
  `withdraw` give each `(owner, asset)` pair a PDA-owned SPL token account,
  where `asset` is wrapped SOL or USDC — "the vault" from the brief. You
  never need to hold the coin you're backing.
- **Challenge battles**: `create_battle` names the coin the creator is
  backing (`mint_a`, referenced only — never custodied) and escrows their
  collateral wager, leaving the opponent's coin unset — an open challenge,
  not a 1:1 pairing the creator dictates. `join_battle` lets **anyone accept
  with any coin that has a registered price feed**, matching the same
  collateral wager, and snapshots both coins' Pyth prices as the reference
  point. `settle_battle` is **permissionless** — anyone (the keeper,
  normally) can call it once the window ends, and it re-reads Pyth to
  decide the winner and pay the single collateral escrow (now holding both
  sides' wagers) to the winner's vault. The outcome comes from the price
  feed, not from whoever calls it.
- **Price feeds**: `set_price_feed` is admin-gated per mint. A coin without a
  registered feed simply can't be backed — there's no fallback to a trusted
  party's word on who won.

## Known gaps before this could hold real funds

- **Not built or tested.** No `anchor test` run, no localnet/devnet deploy,
  no fuzzing. `cargo check` catches type errors, not logic bugs — and it
  didn't: an earlier revision of this file had `vault_token` accounts
  constrained with `address = vault_state.key()` (checking the token
  account's address against an unrelated PDA — always false at runtime, so
  every deposit/withdraw/battle instruction would have failed) and
  `release_escrow` signing with `battle`'s bump when the escrow's actual
  SPL authority was `battle` but the seeds used to sign were the escrow's
  own — a mismatch that only surfaces when a transaction is actually
  simulated or run. Both were caught by manual review, not by the compiler.
  That's the whole reason "compiles clean" and "correct" are different
  claims here, and why `anchor test` against a local validator is
  non-negotiable before this goes anywhere near real funds — it exercises
  account constraints and CPI signing that `cargo check` cannot see.
- **No audit.** Escrow programs are exactly the kind of code that needs one.
- **Pyth integration uses the deprecated `pyth-client` crate**, not the
  current `pyth-sdk-solana`. Reason: `pyth-sdk-solana` (current releases)
  transitively depends on the post-2024 split Solana SDK crates (e.g.
  `solana-account-info` 2.x), whose `AccountInfo` type doesn't match the one
  anchor-lang 0.30.1 pins via `solana-program` 1.18 — they're incompatible
  Rust types with the same name, and `cargo check` fails immediately on it.
  `pyth-client` still depends on classic `solana-program` 1.x, so it
  compiles today, and its `Price` account layout (Pyth's stable V2 push-model
  format) is exactly what devnet/mainnet price accounts of that generation
  expose — but it's unmaintained, and Pyth's current recommended integration
  is the Hermes **pull oracle** via `pyth-solana-receiver-sdk` (price updates
  are posted on-chain per-transaction rather than read from a long-lived
  account). Migrating to it would also mean moving off anchor 0.30.1 to a
  version pinned to a newer `solana-program`. That's the right move before
  any real deployment; it just wasn't a same-session change here.
- **No devnet price feeds wired up.** `set_price_feed` needs real Pyth price
  account pubkeys per mint, looked up from Pyth's feed registry for whichever
  network you deploy to.
- **Fees**: `Config.fee_bps` is stored but never actually taken anywhere —
  add a transfer-out step in `settle_battle` if you want a rake.
- **No slashing/timeout for a joined-but-abandoned battle** beyond what's
  here — settlement is always available once `ends_at` passes, which is the
  important part, but there's no explicit "opponent went offline" handling
  beyond that (nothing needs it: settlement doesn't require either party to
  be online).

## Layout

```
program/
  Anchor.toml            placeholder config (program id is a placeholder too)
  Cargo.toml              workspace root
  programs/battle_vault/  the program crate
```

## If you pick this up

1. Install the Solana + Anchor CLIs (`solana-install`, `avm install
   latest`).
2. `anchor keys sync` to generate a real program id (replaces the
   `declare_id!` placeholder and `Anchor.toml` entry).
3. Decide: keep `pyth-client` for a quick devnet demo, or do the
   `pyth-solana-receiver-sdk` + newer-anchor migration for something closer
   to production.
4. Write the Anchor test suite (TypeScript, under `program/tests/` — not
   included yet) exercising the full flow: `init_vault` → `deposit` →
   `create_battle` → `join_battle` → `settle_battle`, plus the failure paths
   (join after deadline, settle before `ends_at`, double-settle, withdraw
   more than unlocked balance, wrong-collateral-asset vault). This would
   also be what actually proves the account constraints are correct —
   see the note above about what manual review already caught.
5. `anchor build && anchor deploy --provider.cluster devnet`, then update the
   frontend to call the program instead of the memo-transaction simulation
   in `src/lib/tx.ts`.
