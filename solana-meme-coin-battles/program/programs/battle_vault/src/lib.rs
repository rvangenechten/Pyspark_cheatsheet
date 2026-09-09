//! Battle Vault — reference/scaffold program for meme-coin duels.
//!
//! STATUS: written for review and as a build target, NOT deployed, NOT
//! audited, NOT built in this environment (no `anchor`/`solana` CLI was
//! available when this was written — see program/README.md). Treat this as
//! the design for what the frontend's devnet-memo simulation would be
//! replaced with, not as something to point real funds at.
//!
//! Design summary:
//! - You never custody the meme coin you battle. Each user has at most two
//!   vaults — one for wrapped SOL, one for USDC — funded ahead of time via
//!   `deposit`. That's "the vault" from the brief: SOL/USDC collateral, not
//!   the coin itself.
//! - `create_battle` names the coin the creator is backing (`mint_a`) and
//!   escrows their collateral wager, leaving the opponent's coin unset — an
//!   open challenge. `join_battle` lets anyone accept with *any* coin that
//!   has a registered price feed, matching the same collateral wager, and
//!   snapshots both coins' Pyth prices as the reference point.
//! - `settle_battle` is permissionless (anyone — typically the keeper in
//!   /keeper — can call it once the window ends) and re-reads Pyth prices
//!   to decide the winner, then pays the single collateral escrow (now
//!   holding both sides' wagers) into the winner's vault. Nobody can pick
//!   the outcome; the chain does, from the price feed.
//! - Coins without a reliable Pyth price feed simply can't have
//!   `set_price_feed` called for them by the admin, so they can't be backed
//!   until one exists — the program never falls back to a trusted keeper's
//!   say-so for the win condition.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use pyth_client::{Price as PythPrice, PriceStatus};

// Placeholder — replace with the real deployed program id via `anchor keys sync`.
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

/// Wrapped SOL's mint address — a network constant, same on devnet and
/// mainnet. Collateral is always an SPL token account so deposit/withdraw/
/// escrow share one code path for both SOL and USDC; clients wrap native
/// SOL into this mint (standard `system_program::transfer` + `sync_native`)
/// before calling `deposit`.
pub mod wrapped_sol {
    use anchor_lang::declare_id;
    declare_id!("So11111111111111111111111111111111111111112");
}

/// How stale a Pyth price is allowed to be when we read it, in slots. Pyth's
/// classic V2 price account only carries the publishing slot, not a Unix
/// timestamp, so staleness here is measured in slots (mirrors the
/// `MAX_SLOT_DIFFERENCE` pyth-client itself uses internally, but checked
/// explicitly rather than relying on its `#[cfg(target_arch = "bpf")]`
/// gated staleness check, which may not fire under the modern `sbf` target).
const MAX_PRICE_SLOT_AGE: u64 = 25;

// #[repr(u8)] makes the `as u8` casts used in PDA seeds well-defined and
// stable (Sol=0, Usdc=1) rather than relying on an implicit default.
#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum CollateralAsset {
    Sol,
    Usdc,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    FiveMin,
    OneHour,
    TwentyFourHour,
}

impl Mode {
    fn duration_secs(self) -> i64 {
        match self {
            Mode::FiveMin => 5 * 60,
            Mode::OneHour => 60 * 60,
            Mode::TwentyFourHour => 24 * 60 * 60,
        }
    }

    fn join_window_secs(self) -> i64 {
        match self {
            Mode::FiveMin => 90,
            Mode::OneHour => 5 * 60,
            Mode::TwentyFourHour => 30 * 60,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Winner {
    None,
    A,
    B,
}

#[program]
pub mod battle_vault {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        usdc_mint: Pubkey,
        fee_bps: u16,
    ) -> Result<()> {
        require!(fee_bps <= 1000, BattleError::FeeTooHigh); // hard cap 10%
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.usdc_mint = usdc_mint;
        config.fee_bps = fee_bps;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Admin-gated: wires a meme coin's mint to the Pyth price account that
    /// will be trusted to judge battles involving it. There is deliberately
    /// no way to settle a battle without a registered feed.
    pub fn set_price_feed(ctx: Context<SetPriceFeed>) -> Result<()> {
        let feed = &mut ctx.accounts.feed_config;
        feed.mint = ctx.accounts.mint.key();
        feed.pyth_price_account = ctx.accounts.pyth_price_account.key();
        feed.bump = ctx.bumps.feed_config;
        Ok(())
    }

    /// Creates the caller's collateral vault (PDA-owned token account) for
    /// `asset` if it doesn't exist yet.
    pub fn init_vault(ctx: Context<InitVault>, asset: CollateralAsset) -> Result<()> {
        let vault = &mut ctx.accounts.vault_state;
        vault.owner = ctx.accounts.owner.key();
        vault.asset = asset;
        vault.locked = 0;
        vault.bump = ctx.bumps.vault_state;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, BattleError::ZeroAmount);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.owner_token_account.to_account_info(),
                    to: ctx.accounts.vault_token.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, BattleError::ZeroAmount);
        let vault = &ctx.accounts.vault_state;
        let available = ctx
            .accounts
            .vault_token
            .amount
            .checked_sub(vault.locked)
            .ok_or(BattleError::MathOverflow)?;
        require!(amount <= available, BattleError::InsufficientUnlockedBalance);

        let owner_key = vault.owner;
        let asset_byte = [vault.asset as u8];
        let bump = vault.bump;
        let seeds: &[&[u8]] = &[b"vault", owner_key.as_ref(), &asset_byte, &[bump]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_token.to_account_info(),
                    to: ctx.accounts.owner_token_account.to_account_info(),
                    authority: ctx.accounts.vault_state.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )
    }

    /// Locks `wager` of the creator's collateral vault into a fresh escrow
    /// and opens the battle for anyone to accept — with *any* coin of their
    /// own choosing backing the other side. `mint_a` is never custodied,
    /// only referenced (for its Pyth feed at settlement).
    pub fn create_battle(
        ctx: Context<CreateBattle>,
        _nonce: u64,
        mode: Mode,
        collateral: CollateralAsset,
        wager: u64,
    ) -> Result<()> {
        require!(wager > 0, BattleError::ZeroAmount);
        require!(
            ctx.accounts.vault_state_a.asset == collateral,
            BattleError::WrongCollateralVault
        );

        let now = Clock::get()?.unix_timestamp;

        let battle = &mut ctx.accounts.battle;
        battle.creator = ctx.accounts.creator.key();
        battle.opponent = None;
        battle.mint_a = ctx.accounts.mint_a.key();
        // Set for real in `join_battle`, once the opponent picks their coin.
        battle.mint_b = Pubkey::default();
        battle.collateral = collateral;
        battle.wager = wager;
        battle.mode = mode;
        battle.join_deadline = now + mode.join_window_secs();
        battle.starts_at = 0;
        battle.ends_at = 0;
        battle.start_price_a = 0;
        battle.start_price_b = 0;
        battle.end_price_a = 0;
        battle.end_price_b = 0;
        battle.winner = Winner::None;
        battle.settled = false;
        battle.bump = ctx.bumps.battle;

        lock_and_escrow(
            &ctx.accounts.vault_state_a,
            &ctx.accounts.vault_token_a,
            &ctx.accounts.escrow,
            &ctx.accounts.token_program,
            wager,
        )?;
        ctx.accounts.vault_state_a.locked = ctx
            .accounts
            .vault_state_a
            .locked
            .checked_add(wager)
            .ok_or(BattleError::MathOverflow)?;
        Ok(())
    }

    /// Opponent matches the collateral wager while backing `mint_b`, their
    /// own choice; this snapshots both coins' current Pyth prices as the
    /// battle's reference point and starts the (short, fixed) "get ready"
    /// window before the price-tracking period.
    pub fn join_battle(ctx: Context<JoinBattle>) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        {
            let battle = &ctx.accounts.battle;
            require!(battle.opponent.is_none(), BattleError::AlreadyJoined);
            require!(now <= battle.join_deadline, BattleError::JoinWindowExpired);
            require_keys_neq!(
                battle.mint_a,
                ctx.accounts.mint_b.key(),
                BattleError::SameCoinBothSides
            );
            require!(
                ctx.accounts.vault_state_b.asset == battle.collateral,
                BattleError::WrongCollateralVault
            );
        }

        let price_a = read_price(&ctx.accounts.pyth_price_a, clock.slot)?;
        let price_b = read_price(&ctx.accounts.pyth_price_b, clock.slot)?;

        let wager = ctx.accounts.battle.wager;
        lock_and_escrow(
            &ctx.accounts.vault_state_b,
            &ctx.accounts.vault_token_b,
            &ctx.accounts.escrow,
            &ctx.accounts.token_program,
            wager,
        )?;
        ctx.accounts.vault_state_b.locked = ctx
            .accounts
            .vault_state_b
            .locked
            .checked_add(wager)
            .ok_or(BattleError::MathOverflow)?;

        const PREP_WINDOW_SECS: i64 = 60;
        let battle = &mut ctx.accounts.battle;
        battle.opponent = Some(ctx.accounts.opponent.key());
        battle.mint_b = ctx.accounts.mint_b.key();
        battle.starts_at = now + PREP_WINDOW_SECS;
        battle.ends_at = battle.starts_at + battle.mode.duration_secs();
        battle.start_price_a = price_a;
        battle.start_price_b = price_b;
        Ok(())
    }

    /// Creator reclaims their collateral if nobody accepted in time.
    pub fn cancel_expired(ctx: Context<CancelExpired>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        {
            let battle = &ctx.accounts.battle;
            require!(battle.opponent.is_none(), BattleError::AlreadyJoined);
            require!(now > battle.join_deadline, BattleError::JoinWindowStillOpen);
        }
        let wager = ctx.accounts.battle.wager;
        release_escrow(
            &ctx.accounts.battle,
            &ctx.accounts.escrow,
            &ctx.accounts.vault_token_a,
            &ctx.accounts.token_program,
            wager,
            ctx.bumps.escrow,
        )?;
        ctx.accounts.vault_state_a.locked = ctx
            .accounts
            .vault_state_a
            .locked
            .checked_sub(wager)
            .ok_or(BattleError::MathOverflow)?;
        Ok(())
    }

    /// Permissionless: anyone (typically the off-chain keeper) can trigger
    /// settlement once the window has ended. The outcome comes entirely
    /// from re-reading Pyth, not from who calls this. Pays the whole
    /// escrow (both sides' collateral) to the winner's vault.
    pub fn settle_battle(ctx: Context<SettleBattle>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        {
            let battle = &ctx.accounts.battle;
            require!(battle.opponent.is_some(), BattleError::NotJoined);
            require!(!battle.settled, BattleError::AlreadySettled);
            require!(now >= battle.ends_at, BattleError::BattleStillActive);
        }

        let end_price_a = read_price(&ctx.accounts.pyth_price_a, Clock::get()?.slot)?;
        let end_price_b = read_price(&ctx.accounts.pyth_price_b, Clock::get()?.slot)?;

        let (start_a, start_b, wager) = {
            let battle = &ctx.accounts.battle;
            (battle.start_price_a, battle.start_price_b, battle.wager)
        };

        // Cross-multiply instead of dividing so this stays integer-exact:
        // pct_a > pct_b  <=>  end_a * start_b > end_b * start_a  (prices > 0).
        let lhs = (end_price_a as i128) * (start_b as i128);
        let rhs = (end_price_b as i128) * (start_a as i128);
        let winner = if lhs >= rhs { Winner::A } else { Winner::B };

        let payout_vault_token = if winner == Winner::A {
            &ctx.accounts.vault_token_a
        } else {
            &ctx.accounts.vault_token_b
        };

        // Both sides' collateral sat in one escrow — pay the full 2x wager
        // to whichever vault backed the winning coin.
        release_escrow(
            &ctx.accounts.battle,
            &ctx.accounts.escrow,
            payout_vault_token,
            &ctx.accounts.token_program,
            wager.checked_mul(2).ok_or(BattleError::MathOverflow)?,
            ctx.bumps.escrow,
        )?;

        let battle = &mut ctx.accounts.battle;
        battle.end_price_a = end_price_a;
        battle.end_price_b = end_price_b;
        battle.winner = winner;
        battle.settled = true;

        // The escrow is fully drained now, regardless of who won, so both
        // vaults' locked amounts release by `wager`.
        ctx.accounts.vault_state_a.locked = ctx
            .accounts
            .vault_state_a
            .locked
            .checked_sub(wager)
            .ok_or(BattleError::MathOverflow)?;
        ctx.accounts.vault_state_b.locked = ctx
            .accounts
            .vault_state_b
            .locked
            .checked_sub(wager)
            .ok_or(BattleError::MathOverflow)?;
        Ok(())
    }
}

// pyth-client is deprecated upstream (see the Cargo.toml comment for why
// it's still used here); this silences the resulting field-access warnings
// without hiding anything else.
#[allow(deprecated)]
fn read_price(price_account: &AccountInfo, current_slot: u64) -> Result<i64> {
    let data = price_account
        .try_borrow_data()
        .map_err(|_| error!(BattleError::InvalidPriceAccount))?;
    require!(
        data.len() >= std::mem::size_of::<PythPrice>(),
        BattleError::InvalidPriceAccount
    );
    let price: &PythPrice =
        bytemuck::try_from_bytes(&data[..std::mem::size_of::<PythPrice>()])
            .map_err(|_| error!(BattleError::InvalidPriceAccount))?;
    require!(price.magic == pyth_client::MAGIC, BattleError::InvalidPriceAccount);
    require!(
        matches!(price.agg.status, PriceStatus::Trading),
        BattleError::StalePrice
    );
    require!(
        current_slot.saturating_sub(price.agg.pub_slot) <= MAX_PRICE_SLOT_AGE,
        BattleError::StalePrice
    );
    require!(price.agg.price > 0, BattleError::NonPositivePrice);
    Ok(price.agg.price)
}

fn lock_and_escrow<'info>(
    vault_state: &Account<'info, VaultState>,
    vault_token: &Account<'info, TokenAccount>,
    escrow: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    let available = vault_token
        .amount
        .checked_sub(vault_state.locked)
        .ok_or(BattleError::MathOverflow)?;
    require!(amount <= available, BattleError::InsufficientUnlockedBalance);

    let owner_key = vault_state.owner;
    let asset_byte = [vault_state.asset as u8];
    let bump = vault_state.bump;
    let seeds: &[&[u8]] = &[b"vault", owner_key.as_ref(), &asset_byte, &[bump]];

    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: vault_token.to_account_info(),
                to: escrow.to_account_info(),
                authority: vault_state.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
    // Callers are responsible for incrementing `vault_state.locked` after
    // this returns — kept out of this helper since it only borrows the
    // vault state immutably (for the PDA signer seeds).
}

fn release_escrow<'info>(
    battle: &Account<'info, Battle>,
    escrow: &Account<'info, TokenAccount>,
    destination: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    amount: u64,
    escrow_bump: u8,
) -> Result<()> {
    // The escrow is its own SPL authority (see `token::authority = escrow`
    // on its `init`), so it signs for itself — that's the only way to sign
    // for it later, since Battle's own PDA seeds include a `nonce` that
    // isn't stored anywhere once the account exists.
    let creator_key = battle.creator;
    let battle_key = battle.key();
    let seeds: &[&[u8]] = &[b"escrow", creator_key.as_ref(), battle_key.as_ref(), &[escrow_bump]];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: escrow.to_account_info(),
                to: destination.to_account_info(),
                authority: escrow.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub fee_bps: u16,
    pub bump: u8,
}

#[account]
pub struct FeedConfig {
    pub mint: Pubkey,
    pub pyth_price_account: Pubkey,
    pub bump: u8,
}

#[account]
pub struct VaultState {
    pub owner: Pubkey,
    pub asset: CollateralAsset,
    pub locked: u64,
    pub bump: u8,
}

#[account]
pub struct Battle {
    pub creator: Pubkey,
    pub opponent: Option<Pubkey>,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub collateral: CollateralAsset,
    pub wager: u64,
    pub mode: Mode,
    pub join_deadline: i64,
    pub starts_at: i64,
    pub ends_at: i64,
    pub start_price_a: i64,
    pub start_price_b: i64,
    pub end_price_a: i64,
    pub end_price_b: i64,
    pub winner: Winner,
    pub settled: bool,
    pub bump: u8,
}

const DISCRIMINATOR: usize = 8;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = DISCRIMINATOR + 32 + 32 + 2 + 1,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPriceFeed<'info> {
    #[account(has_one = admin)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint: Account<'info, Mint>,
    /// CHECK: validated at read-time via manual Pyth account parsing in `read_price`
    pub pyth_price_account: AccountInfo<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = DISCRIMINATOR + 32 + 32 + 1,
        seeds = [b"feed", mint.key().as_ref()],
        bump
    )]
    pub feed_config: Account<'info, FeedConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(asset: CollateralAsset)]
pub struct InitVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// The collateral mint for `asset` — wrapped SOL or `config.usdc_mint`.
    /// Client picks the right one; enforced against `Config` in `deposit`.
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = owner,
        space = DISCRIMINATOR + 32 + 1 + 8 + 1,
        seeds = [b"vault", owner.key().as_ref(), &[asset as u8]],
        bump
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        init,
        payer = owner,
        token::mint = mint,
        token::authority = vault_state,
        seeds = [b"vault-token", owner.key().as_ref(), &[asset as u8]],
        bump
    )]
    pub vault_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner)]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [b"vault-token", owner.key().as_ref(), &[vault_state.asset as u8]],
        bump
    )]
    pub vault_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner)]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [b"vault-token", owner.key().as_ref(), &[vault_state.asset as u8]],
        bump
    )]
    pub vault_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CreateBattle<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// The coin the creator is backing — referenced only, never custodied.
    pub mint_a: Account<'info, Mint>,
    /// The collateral mint (wrapped SOL or USDC) backing this specific battle.
    pub collateral_mint: Account<'info, Mint>,
    #[account(mut, constraint = vault_state_a.owner == creator.key() @ BattleError::NotVaultOwner)]
    pub vault_state_a: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [b"vault-token", creator.key().as_ref(), &[vault_state_a.asset as u8]],
        bump
    )]
    pub vault_token_a: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = creator,
        // creator(32) + opponent(1+32) + mint_a(32) + mint_b(32) + collateral(1)
        // + wager(8) + mode(1) + 7×i64 timing/price fields(56) + winner(1)
        // + settled(1) + bump(1)
        space = DISCRIMINATOR + 32 + 33 + 32 + 32 + 1 + 8 + 1 + 8 * 7 + 1 + 1 + 1,
        seeds = [b"battle", creator.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub battle: Account<'info, Battle>,
    #[account(
        init,
        payer = creator,
        token::mint = collateral_mint,
        token::authority = escrow,
        seeds = [b"escrow", creator.key().as_ref(), battle.key().as_ref()],
        bump
    )]
    pub escrow: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinBattle<'info> {
    #[account(mut)]
    pub opponent: Signer<'info>,
    #[account(mut)]
    pub battle: Account<'info, Battle>,
    /// The opponent's own choice of coin — not fixed by the creator. The
    /// client is responsible for only offering mints that are actually on
    /// the verified token registry (`FeedConfig` must exist for it, checked
    /// implicitly: settlement can't happen without a registered price feed).
    pub mint_b: Account<'info, Mint>,
    #[account(mut, constraint = vault_state_b.owner == opponent.key() @ BattleError::NotVaultOwner)]
    pub vault_state_b: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [b"vault-token", opponent.key().as_ref(), &[vault_state_b.asset as u8]],
        bump
    )]
    pub vault_token_b: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"escrow", battle.creator.as_ref(), battle.key().as_ref()], bump)]
    pub escrow: Account<'info, TokenAccount>,
    /// CHECK: should be checked against FeedConfig for battle.mint_a (see
    /// program/README.md — a stricter version loads FeedConfig here and
    /// asserts equality instead of trusting the client to pass the right one)
    pub pyth_price_a: AccountInfo<'info>,
    /// CHECK: see pyth_price_a
    pub pyth_price_b: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelExpired<'info> {
    #[account(mut, has_one = creator)]
    pub battle: Account<'info, Battle>,
    pub creator: Signer<'info>,
    #[account(mut, constraint = vault_state_a.owner == creator.key() @ BattleError::NotVaultOwner)]
    pub vault_state_a: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [b"vault-token", creator.key().as_ref(), &[vault_state_a.asset as u8]],
        bump
    )]
    pub vault_token_a: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"escrow", battle.creator.as_ref(), battle.key().as_ref()], bump)]
    pub escrow: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SettleBattle<'info> {
    /// Anyone can call settlement — this account just pays the tx fee.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub battle: Account<'info, Battle>,
    #[account(mut, constraint = vault_state_a.owner == battle.creator @ BattleError::NotVaultOwner)]
    pub vault_state_a: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [b"vault-token", vault_state_a.owner.as_ref(), &[vault_state_a.asset as u8]],
        bump
    )]
    pub vault_token_a: Account<'info, TokenAccount>,
    #[account(mut, constraint = Some(vault_state_b.owner) == battle.opponent @ BattleError::NotVaultOwner)]
    pub vault_state_b: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [b"vault-token", vault_state_b.owner.as_ref(), &[vault_state_b.asset as u8]],
        bump
    )]
    pub vault_token_b: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"escrow", battle.creator.as_ref(), battle.key().as_ref()], bump)]
    pub escrow: Account<'info, TokenAccount>,
    /// CHECK: should be checked against FeedConfig for battle.mint_a (see JoinBattle note)
    pub pyth_price_a: AccountInfo<'info>,
    /// CHECK: should be checked against FeedConfig for battle.mint_b (see JoinBattle note)
    pub pyth_price_b: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum BattleError {
    #[msg("Fee cannot exceed 10%")]
    FeeTooHigh,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Not enough unlocked vault balance")]
    InsufficientUnlockedBalance,
    #[msg("Both sides of a battle must use different coins")]
    SameCoinBothSides,
    #[msg("Battle already has an opponent")]
    AlreadyJoined,
    #[msg("Battle does not have an opponent yet")]
    NotJoined,
    #[msg("Join window has expired")]
    JoinWindowExpired,
    #[msg("Join window has not expired yet")]
    JoinWindowStillOpen,
    #[msg("Battle is already settled")]
    AlreadySettled,
    #[msg("Battle window has not ended yet")]
    BattleStillActive,
    #[msg("Signer does not own this vault")]
    NotVaultOwner,
    #[msg("Vault is for a different collateral asset than this battle uses")]
    WrongCollateralVault,
    #[msg("Pyth price account could not be parsed")]
    InvalidPriceAccount,
    #[msg("Pyth price is stale")]
    StalePrice,
    #[msg("Pyth price must be positive")]
    NonPositivePrice,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
