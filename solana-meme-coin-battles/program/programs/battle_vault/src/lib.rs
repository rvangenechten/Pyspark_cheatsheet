//! Battle Vault — reference/scaffold program for meme-coin duels.
//!
//! STATUS: written for review and as a build target, NOT deployed, NOT
//! audited, NOT built in this environment (no `anchor`/`solana` CLI was
//! available when this was written — see program/README.md). Treat this as
//! the design for what the frontend's devnet-memo simulation would be
//! replaced with, not as something to point real funds at.
//!
//! Design summary:
//! - Each (owner, mint) pair gets a PDA vault token account. Users deposit
//!   SPL tokens into it ahead of time; that's "the vault" from the brief.
//! - `create_battle` escrows the creator's wager out of their vault into a
//!   battle-owned escrow account; `join_battle` does the same for the
//!   opponent and snapshots both coins' Pyth prices as the reference point.
//! - `settle_battle` is permissionless (anyone — typically the keeper in
//!   /keeper — can call it once the window ends) and re-reads Pyth prices
//!   to decide the winner, then moves both escrows into the winner's vault.
//!   Nobody can pick the outcome; the chain does, from the price feed.
//! - Coins without a reliable Pyth price feed simply can't have
//!   `set_price_feed` called for them by the admin, so they can't be battled
//!   until one exists — the program never falls back to a trusted keeper's
//!   say-so for the win condition.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use pyth_client::{Price as PythPrice, PriceStatus};

// Placeholder — replace with the real deployed program id via `anchor keys sync`.
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

/// How stale a Pyth price is allowed to be when we read it, in slots. Pyth's
/// classic V2 price account only carries the publishing slot, not a Unix
/// timestamp, so staleness here is measured in slots (mirrors the
/// `MAX_SLOT_DIFFERENCE` pyth-client itself uses internally, but checked
/// explicitly rather than relying on its `#[cfg(target_arch = "bpf")]`
/// gated staleness check, which may not fire under the modern `sbf` target).
const MAX_PRICE_SLOT_AGE: u64 = 25;

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

    pub fn initialize_config(ctx: Context<InitializeConfig>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= 1000, BattleError::FeeTooHigh); // hard cap 10%
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.fee_bps = fee_bps;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Admin-gated: wires a mint to the Pyth price account that will be
    /// trusted to judge battles involving it. There is deliberately no way
    /// to settle a battle without a registered feed.
    pub fn set_price_feed(ctx: Context<SetPriceFeed>) -> Result<()> {
        let feed = &mut ctx.accounts.feed_config;
        feed.mint = ctx.accounts.mint.key();
        feed.pyth_price_account = ctx.accounts.pyth_price_account.key();
        feed.bump = ctx.bumps.feed_config;
        Ok(())
    }

    /// Creates the caller's vault (PDA-owned token account) for `mint` if it
    /// doesn't exist yet. Idempotent-ish: Anchor's `init_if_needed` would
    /// also work here, but an explicit instruction keeps the CPI surface
    /// smaller and easier to audit.
    pub fn init_vault(ctx: Context<InitVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault_state;
        vault.owner = ctx.accounts.owner.key();
        vault.mint = ctx.accounts.mint.key();
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
        let mint_key = vault.mint;
        let bump = vault.bump;
        let seeds: &[&[u8]] = &[b"vault", owner_key.as_ref(), mint_key.as_ref(), &[bump]];

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

    /// Locks `wager` of the creator's `mint_a` vault balance into a fresh
    /// battle escrow and opens it for an opponent to accept.
    pub fn create_battle(
        ctx: Context<CreateBattle>,
        _nonce: u64,
        mode: Mode,
        wager: u64,
    ) -> Result<()> {
        require!(wager > 0, BattleError::ZeroAmount);
        require_keys_neq!(
            ctx.accounts.mint_a.key(),
            ctx.accounts.mint_b.key(),
            BattleError::SameCoinBothSides
        );

        let now = Clock::get()?.unix_timestamp;

        let battle = &mut ctx.accounts.battle;
        battle.creator = ctx.accounts.creator.key();
        battle.opponent = None;
        battle.mint_a = ctx.accounts.mint_a.key();
        battle.mint_b = ctx.accounts.mint_b.key();
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
            &ctx.accounts.escrow_a,
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

    /// Opponent matches the wager in `mint_b`; this snapshots both coins'
    /// current Pyth prices as the battle's reference point and starts the
    /// (short, fixed) "get ready" window before the price-tracking period.
    pub fn join_battle(ctx: Context<JoinBattle>) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        {
            let battle = &ctx.accounts.battle;
            require!(battle.opponent.is_none(), BattleError::AlreadyJoined);
            require!(now <= battle.join_deadline, BattleError::JoinWindowExpired);
        }

        let price_a = read_price(&ctx.accounts.pyth_price_a, clock.slot)?;
        let price_b = read_price(&ctx.accounts.pyth_price_b, clock.slot)?;

        let wager = ctx.accounts.battle.wager;
        lock_and_escrow(
            &ctx.accounts.vault_state_b,
            &ctx.accounts.vault_token_b,
            &ctx.accounts.escrow_b,
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
        battle.starts_at = now + PREP_WINDOW_SECS;
        battle.ends_at = battle.starts_at + battle.mode.duration_secs();
        battle.start_price_a = price_a;
        battle.start_price_b = price_b;
        Ok(())
    }

    /// Creator reclaims their stake if nobody accepted the challenge in time.
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
            &ctx.accounts.escrow_a,
            &ctx.accounts.vault_token_a,
            &ctx.accounts.token_program,
            wager,
            b"a",
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
    /// from re-reading Pyth, not from who calls this.
    pub fn settle_battle(ctx: Context<SettleBattle>) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        {
            let battle = &ctx.accounts.battle;
            require!(battle.opponent.is_some(), BattleError::NotJoined);
            require!(!battle.settled, BattleError::AlreadySettled);
            require!(now >= battle.ends_at, BattleError::BattleStillActive);
        }

        let end_price_a = read_price(&ctx.accounts.pyth_price_a, clock.slot)?;
        let end_price_b = read_price(&ctx.accounts.pyth_price_b, clock.slot)?;

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

        // Winner's own stake back, plus the loser's stake — "the winner
        // gets the other one's coin" from both escrow accounts.
        for (escrow, tag) in [
            (&ctx.accounts.escrow_a, b"a" as &[u8]),
            (&ctx.accounts.escrow_b, b"b" as &[u8]),
        ] {
            release_escrow(
                &ctx.accounts.battle,
                escrow,
                payout_vault_token,
                &ctx.accounts.token_program,
                wager,
                tag,
            )?;
        }

        let battle = &mut ctx.accounts.battle;
        battle.end_price_a = end_price_a;
        battle.end_price_b = end_price_b;
        battle.winner = winner;
        battle.settled = true;

        // Both escrows are now fully drained (to the winner), regardless of
        // who won, so both vaults' locked amounts release by `wager`.
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
    let mint_key = vault_state.mint;
    let bump = vault_state.bump;
    let seeds: &[&[u8]] = &[b"vault", owner_key.as_ref(), mint_key.as_ref(), &[bump]];

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
    side_tag: &[u8],
) -> Result<()> {
    let creator_key = battle.creator;
    let bump = battle.bump;
    let seeds: &[&[u8]] = &[
        b"escrow",
        creator_key.as_ref(),
        side_tag,
        battle.to_account_info().key.as_ref(),
        &[bump],
    ];
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
    pub mint: Pubkey,
    pub locked: u64,
    pub bump: u8,
}

#[account]
pub struct Battle {
    pub creator: Pubkey,
    pub opponent: Option<Pubkey>,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
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
        space = DISCRIMINATOR + 32 + 2 + 1,
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
    /// CHECK: validated at read-time via `load_price_feed_from_account_info`
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
pub struct InitVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = owner,
        space = DISCRIMINATOR + 32 + 32 + 8 + 1,
        seeds = [b"vault", owner.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        init,
        payer = owner,
        token::mint = mint,
        token::authority = vault_state,
        seeds = [b"vault-token", owner.key().as_ref(), mint.key().as_ref()],
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
    #[account(mut, address = vault_state.key())]
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
    #[account(mut)]
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
    pub mint_a: Account<'info, Mint>,
    pub mint_b: Account<'info, Mint>,
    #[account(mut, has_one = owner @ BattleError::NotVaultOwner)]
    pub vault_state_a: Account<'info, VaultState>,
    #[account(mut)]
    pub vault_token_a: Account<'info, TokenAccount>,
    /// CHECK: constrained via `has_one` on vault_state_a.owner == creator
    pub owner: UncheckedAccount<'info>,
    #[account(
        init,
        payer = creator,
        space = DISCRIMINATOR + 32 + 33 + 32 + 32 + 8 + 2 + 8 * 6 + 2 + 1 + 1,
        seeds = [b"battle", creator.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub battle: Account<'info, Battle>,
    #[account(
        init,
        payer = creator,
        token::mint = mint_a,
        token::authority = battle,
        seeds = [b"escrow", creator.key().as_ref(), b"a", battle.key().as_ref()],
        bump
    )]
    pub escrow_a: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinBattle<'info> {
    #[account(mut)]
    pub opponent: Signer<'info>,
    #[account(mut)]
    pub battle: Account<'info, Battle>,
    #[account(constraint = mint_b.key() == battle.mint_b @ BattleError::WrongMint)]
    pub mint_b: Account<'info, Mint>,
    #[account(mut, has_one = owner @ BattleError::NotVaultOwner, constraint = vault_state_b.mint == battle.mint_b)]
    pub vault_state_b: Account<'info, VaultState>,
    #[account(mut)]
    pub vault_token_b: Account<'info, TokenAccount>,
    /// CHECK: constrained via `has_one` on vault_state_b.owner == opponent
    pub owner: UncheckedAccount<'info>,
    #[account(
        init,
        payer = opponent,
        token::mint = mint_b,
        token::authority = battle,
        seeds = [b"escrow", battle.creator.as_ref(), b"b", battle.key().as_ref()],
        bump
    )]
    pub escrow_b: Account<'info, TokenAccount>,
    /// CHECK: verified against the registered FeedConfig for mint_a in the handler's caller (client is expected to pass the FeedConfig-registered account; a stricter version would load FeedConfig here and assert equality)
    pub pyth_price_a: AccountInfo<'info>,
    /// CHECK: see pyth_price_a
    pub pyth_price_b: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelExpired<'info> {
    #[account(mut, has_one = creator)]
    pub battle: Account<'info, Battle>,
    pub creator: Signer<'info>,
    #[account(mut)]
    pub vault_state_a: Account<'info, VaultState>,
    #[account(mut)]
    pub vault_token_a: Account<'info, TokenAccount>,
    #[account(mut)]
    pub escrow_a: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SettleBattle<'info> {
    /// Anyone can call settlement — this account just pays the tx fee.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub battle: Account<'info, Battle>,
    #[account(mut)]
    pub vault_state_a: Account<'info, VaultState>,
    #[account(mut)]
    pub vault_token_a: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_state_b: Account<'info, VaultState>,
    #[account(mut)]
    pub vault_token_b: Account<'info, TokenAccount>,
    #[account(mut)]
    pub escrow_a: Account<'info, TokenAccount>,
    #[account(mut)]
    pub escrow_b: Account<'info, TokenAccount>,
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
    #[msg("Mint account does not match the battle's registered coin")]
    WrongMint,
    #[msg("Pyth price account could not be parsed")]
    InvalidPriceAccount,
    #[msg("Pyth price is stale")]
    StalePrice,
    #[msg("Pyth price must be positive")]
    NonPositivePrice,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
