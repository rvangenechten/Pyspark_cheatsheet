//! Mirror vault: on-chain custody for the tokens that back every mirror.
//!
//! The relayer ("operator") can no longer move funds. All it can do is ask
//! this program to swap between USDC and a registered token through Jupiter,
//! and the program enforces that:
//!
//! * the swap goes to the allow-listed swap program (Jupiter v6) only;
//! * it spends at most `amount_in` from the vault and pays at least `min_out`
//!   back into the vault; the vault PDA is the only signer and it can't touch
//!   any other vault account in the same call;
//! * each EVM order id can be swapped only once (a receipt PDA per order);
//! * outflow per asset is capped per 24h window, so a compromised operator key
//!   can lose at most the cap (via bad-price routes) before it's paused;
//! * withdrawals, caps, operator rotation and unpausing are admin-only, and
//!   the admin is meant to be a Squads multisig.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    bpf_loader_upgradeable,
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("77e98v62pJJkauey8tz3GS6wGU3CghkZD8ob6MTRU7y2");

pub const CONFIG_SEED: &[u8] = b"config";
pub const VAULT_SEED: &[u8] = b"vault";
pub const ASSET_SEED: &[u8] = b"asset";
pub const RECEIPT_SEED: &[u8] = b"receipt";
pub const WINDOW_SECS: i64 = 86_400;
pub const JUPITER_V6: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

#[program]
pub mod mirror_vault {
    use super::*;

    /// One-time setup. Only the program's upgrade authority can call it, so
    /// nobody can front-run the deploy and install themselves as admin.
    pub fn initialize(ctx: Context<Initialize>, params: InitParams) -> Result<()> {
        require!(params.default_sell_bps <= 10_000, VaultError::BadCaps);
        let cfg = &mut ctx.accounts.config;
        cfg.admin = params.admin;
        cfg.pending_admin = Pubkey::default();
        cfg.operator = params.operator;
        cfg.guardian = params.guardian;
        cfg.usdc_mint = ctx.accounts.usdc_mint.key();
        cfg.swap_program = params.swap_program;
        cfg.default_sell_bps = params.default_sell_bps;
        cfg.paused = false;
        cfg.bump = ctx.bumps.config;
        cfg.vault_bump = ctx.bumps.vault_authority;

        let usdc = &mut ctx.accounts.usdc_asset;
        usdc.mint = cfg.usdc_mint;
        usdc.max_outflow_abs = params.usdc_max_outflow;
        usdc.max_outflow_bps = 0;
        usdc.bump = ctx.bumps.usdc_asset;
        emit!(ConfigChanged { admin: cfg.admin, operator: cfg.operator, guardian: cfg.guardian, swap_program: cfg.swap_program, paused: false });
        Ok(())
    }

    /// Create the vault's token account for a newly launched mirror. The
    /// operator may do this (it happens on every launch); new assets get the
    /// default sell cap, which only the admin can change.
    pub fn register_asset(ctx: Context<RegisterAsset>) -> Result<()> {
        let cfg = &ctx.accounts.config;
        let signer = ctx.accounts.signer.key();
        require!(signer == cfg.operator || signer == cfg.admin, VaultError::Unauthorized);
        let asset = &mut ctx.accounts.asset;
        asset.mint = ctx.accounts.mint.key();
        asset.max_outflow_abs = 0;
        asset.max_outflow_bps = cfg.default_sell_bps;
        asset.bump = ctx.bumps.asset;
        emit!(AssetRegistered { mint: asset.mint, vault: ctx.accounts.vault_token.key() });
        Ok(())
    }

    /// Swap vault funds through the allow-listed swap program. `route` is the
    /// swap program's instruction data (e.g. Jupiter `shared_accounts_route`)
    /// and its accounts are passed as remaining accounts, with the vault PDA as
    /// the transfer authority and the vault's own token accounts as source and
    /// destination.
    pub fn swap<'info>(
        ctx: Context<'_, '_, 'info, 'info, Swap<'info>>,
        order_id: u64,
        amount_in: u64,
        min_out: u64,
        route: Vec<u8>,
    ) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(!cfg.paused, VaultError::Paused);
        require!(amount_in > 0 && min_out > 0, VaultError::BadAmount);

        let mint_in = ctx.accounts.vault_in.mint;
        let mint_out = ctx.accounts.vault_out.mint;
        // Exactly one side is USDC: the vault only ever trades USDC <-> token.
        require!((mint_in == cfg.usdc_mint) != (mint_out == cfg.usdc_mint), VaultError::NotUsdcPair);

        let vault_key = ctx.accounts.vault_authority.key();
        let vault_in_key = ctx.accounts.vault_in.key();
        let vault_out_key = ctx.accounts.vault_out.key();

        // The vault PDA signs the CPI, so make sure the route can't reach any
        // vault account other than the two this swap is about.
        for acc in ctx.remaining_accounts.iter() {
            if token_account_owner(acc) == Some(vault_key) {
                require!(acc.key() == vault_in_key || acc.key() == vault_out_key, VaultError::ForeignVaultAccount);
            }
        }

        let now = Clock::get()?.unix_timestamp;
        let pre_in = ctx.accounts.vault_in.amount;
        let pre_out = ctx.accounts.vault_out.amount;

        let asset_in = &mut ctx.accounts.asset_in;
        asset_in.roll_window(now, pre_in);
        let used = asset_in.window_outflow.checked_add(amount_in).ok_or(VaultError::BadAmount)?;
        require!(used <= asset_in.window_limit(), VaultError::CapExceeded);

        let metas: Vec<AccountMeta> = ctx
            .remaining_accounts
            .iter()
            .map(|a| AccountMeta {
                pubkey: a.key(),
                is_signer: a.is_signer || a.key() == vault_key,
                is_writable: a.is_writable,
            })
            .collect();
        let mut infos = ctx.remaining_accounts.to_vec();
        infos.push(ctx.accounts.swap_program.to_account_info());
        invoke_signed(
            &Instruction { program_id: ctx.accounts.swap_program.key(), accounts: metas, data: route },
            &infos,
            &[&[VAULT_SEED, &[cfg.vault_bump]]],
        )?;

        ctx.accounts.vault_in.reload()?;
        ctx.accounts.vault_out.reload()?;
        let post_in = ctx.accounts.vault_in.amount;
        let post_out = ctx.accounts.vault_out.amount;
        require!(post_in <= pre_in && post_out >= pre_out, VaultError::BadBalances);
        let spent = pre_in - post_in;
        let received = post_out - pre_out;
        require!(spent <= amount_in, VaultError::Overspent);
        require!(received >= min_out, VaultError::Slippage);

        let asset_in = &mut ctx.accounts.asset_in;
        asset_in.window_outflow = asset_in.window_outflow.checked_add(spent).ok_or(VaultError::BadAmount)?;

        let r = &mut ctx.accounts.receipt;
        r.order_id = order_id;
        r.mint_in = mint_in;
        r.mint_out = mint_out;
        r.amount_in = spent;
        r.amount_out = received;
        r.slot = Clock::get()?.slot;
        r.bump = ctx.bumps.receipt;

        emit!(Swapped { order_id, mint_in, mint_out, amount_in: spent, amount_out: received });
        Ok(())
    }

    /// Move funds out of the vault (USDC rebalancing, migrations). Admin only.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let cfg = &ctx.accounts.config;
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[&[VAULT_SEED, &[cfg.vault_bump]]],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        emit!(Withdrawn { mint: ctx.accounts.mint.key(), to: ctx.accounts.destination.key(), amount });
        Ok(())
    }

    /// Per-asset outflow cap per 24h: an absolute amount, or a share (bps) of
    /// the balance at the start of the window. Admin only.
    pub fn set_asset_caps(ctx: Context<SetAssetCaps>, max_outflow_abs: u64, max_outflow_bps: u16) -> Result<()> {
        require!(max_outflow_bps <= 10_000, VaultError::BadCaps);
        let a = &mut ctx.accounts.asset;
        a.max_outflow_abs = max_outflow_abs;
        a.max_outflow_bps = max_outflow_bps;
        emit!(CapsChanged { mint: a.mint, max_outflow_abs, max_outflow_bps });
        Ok(())
    }

    /// Rotate the operator / guardian, change the swap program or default cap,
    /// or unpause. Admin only.
    pub fn update_config(ctx: Context<AdminOnly>, update: ConfigUpdate) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        if let Some(v) = update.operator { cfg.operator = v; }
        if let Some(v) = update.guardian { cfg.guardian = v; }
        if let Some(v) = update.swap_program { cfg.swap_program = v; }
        if let Some(v) = update.default_sell_bps {
            require!(v <= 10_000, VaultError::BadCaps);
            cfg.default_sell_bps = v;
        }
        if let Some(v) = update.paused { cfg.paused = v; }
        emit!(ConfigChanged { admin: cfg.admin, operator: cfg.operator, guardian: cfg.guardian, swap_program: cfg.swap_program, paused: cfg.paused });
        Ok(())
    }

    /// Emergency stop. The guardian, operator or admin can pause; only the
    /// admin can unpause (via `update_config`).
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        let s = ctx.accounts.signer.key();
        require!(s == cfg.admin || s == cfg.guardian || s == cfg.operator, VaultError::Unauthorized);
        cfg.paused = true;
        emit!(ConfigChanged { admin: cfg.admin, operator: cfg.operator, guardian: cfg.guardian, swap_program: cfg.swap_program, paused: true });
        Ok(())
    }

    /// Two-step admin handover (e.g. to a new multisig).
    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.config.pending_admin = new_admin;
        Ok(())
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.admin = cfg.pending_admin;
        cfg.pending_admin = Pubkey::default();
        emit!(ConfigChanged { admin: cfg.admin, operator: cfg.operator, guardian: cfg.guardian, swap_program: cfg.swap_program, paused: cfg.paused });
        Ok(())
    }
}

/// If `acc` is an SPL Token / Token-2022 token account, return its owner.
fn token_account_owner(acc: &AccountInfo) -> Option<Pubkey> {
    if *acc.owner != anchor_spl::token::ID && *acc.owner != anchor_spl::token_2022::ID {
        return None;
    }
    let data = acc.try_borrow_data().ok()?;
    // 165 bytes = token account. Token-2022 accounts with extensions are
    // longer and carry an account-type byte at 165 (2 = Account). Mints are
    // 82 bytes, or longer with type byte 1.
    let is_account = data.len() == 165 || (data.len() > 165 && data[165] == 2);
    if !is_account {
        return None;
    }
    Pubkey::try_from(&data[32..64]).ok()
}

// ----------------------------------------------------------------------
// State
// ----------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    pub operator: Pubkey,
    pub guardian: Pubkey,
    pub usdc_mint: Pubkey,
    pub swap_program: Pubkey,
    pub default_sell_bps: u16,
    pub paused: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Asset {
    pub mint: Pubkey,
    /// Absolute cap on outflow per window (used when non-zero).
    pub max_outflow_abs: u64,
    /// Otherwise: cap as bps of the balance at the start of the window.
    pub max_outflow_bps: u16,
    pub window_start: i64,
    pub window_base: u64,
    pub window_outflow: u64,
    pub bump: u8,
}

impl Asset {
    pub fn roll_window(&mut self, now: i64, balance: u64) {
        if now - self.window_start >= WINDOW_SECS {
            self.window_start = now;
            self.window_base = balance;
            self.window_outflow = 0;
        }
    }

    pub fn window_limit(&self) -> u64 {
        if self.max_outflow_abs > 0 {
            self.max_outflow_abs
        } else {
            ((self.window_base as u128 * self.max_outflow_bps as u128) / 10_000) as u64
        }
    }
}

/// One per EVM order: proves what the vault did for it and blocks a second swap.
#[account]
#[derive(InitSpace)]
pub struct Receipt {
    pub order_id: u64,
    pub mint_in: Pubkey,
    pub mint_out: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub slot: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitParams {
    pub admin: Pubkey,
    pub operator: Pubkey,
    pub guardian: Pubkey,
    pub swap_program: Pubkey,
    pub usdc_max_outflow: u64,
    pub default_sell_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct ConfigUpdate {
    pub operator: Option<Pubkey>,
    pub guardian: Option<Pubkey>,
    pub swap_program: Option<Pubkey>,
    pub default_sell_bps: Option<u16>,
    pub paused: Option<bool>,
}

// ----------------------------------------------------------------------
// Accounts
// ----------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    /// CHECK: PDA that owns every vault token account; never holds data.
    #[account(seeds = [VAULT_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = payer, space = 8 + Asset::INIT_SPACE, seeds = [ASSET_SEED, usdc_mint.key().as_ref()], bump)]
    pub usdc_asset: Account<'info, Asset>,
    #[account(
        init,
        payer = payer,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault_authority,
        associated_token::token_program = token_program,
    )]
    pub usdc_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = bpf_loader_upgradeable::ID,
        constraint = program_data.upgrade_authority_address == Some(payer.key()) @ VaultError::Unauthorized,
    )]
    pub program_data: Account<'info, ProgramData>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterAsset<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: vault PDA.
    #[account(seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = signer, space = 8 + Asset::INIT_SPACE, seeds = [ASSET_SEED, mint.key().as_ref()], bump)]
    pub asset: Account<'info, Asset>,
    #[account(
        init,
        payer = signer,
        associated_token::mint = mint,
        associated_token::authority = vault_authority,
        associated_token::token_program = token_program,
    )]
    pub vault_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(order_id: u64)]
pub struct Swap<'info> {
    #[account(mut, address = config.operator @ VaultError::Unauthorized)]
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: vault PDA; signs the swap CPI.
    #[account(seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [ASSET_SEED, vault_in.mint.as_ref()], bump = asset_in.bump)]
    pub asset_in: Account<'info, Asset>,
    #[account(seeds = [ASSET_SEED, vault_out.mint.as_ref()], bump = asset_out.bump)]
    pub asset_out: Account<'info, Asset>,
    #[account(
        mut,
        associated_token::mint = vault_in.mint,
        associated_token::authority = vault_authority,
        associated_token::token_program = vault_in.to_account_info().owner,
    )]
    pub vault_in: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = vault_out.mint,
        associated_token::authority = vault_authority,
        associated_token::token_program = vault_out.to_account_info().owner,
    )]
    pub vault_out: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = operator,
        space = 8 + Receipt::INIT_SPACE,
        seeds = [RECEIPT_SEED, order_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub receipt: Account<'info, Receipt>,
    /// CHECK: must be the allow-listed swap program.
    #[account(executable, address = config.swap_program @ VaultError::WrongSwapProgram)]
    pub swap_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(address = config.admin @ VaultError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: vault PDA.
    #[account(seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault_authority,
        associated_token::token_program = token_program,
    )]
    pub vault_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SetAssetCaps<'info> {
    #[account(address = config.admin @ VaultError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [ASSET_SEED, asset.mint.as_ref()], bump = asset.bump)]
    pub asset: Account<'info, Asset>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(address = config.admin @ VaultError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct Pause<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    #[account(address = config.pending_admin @ VaultError::Unauthorized)]
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

// ----------------------------------------------------------------------
// Events & errors
// ----------------------------------------------------------------------

#[event]
pub struct Swapped {
    pub order_id: u64,
    pub mint_in: Pubkey,
    pub mint_out: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
}

#[event]
pub struct AssetRegistered {
    pub mint: Pubkey,
    pub vault: Pubkey,
}

#[event]
pub struct Withdrawn {
    pub mint: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
}

#[event]
pub struct CapsChanged {
    pub mint: Pubkey,
    pub max_outflow_abs: u64,
    pub max_outflow_bps: u16,
}

#[event]
pub struct ConfigChanged {
    pub admin: Pubkey,
    pub operator: Pubkey,
    pub guardian: Pubkey,
    pub swap_program: Pubkey,
    pub paused: bool,
}

#[error_code]
pub enum VaultError {
    #[msg("Signer is not allowed to do this")]
    Unauthorized,
    #[msg("Vault is paused")]
    Paused,
    #[msg("Amounts must be non-zero")]
    BadAmount,
    #[msg("Swaps must be between USDC and a registered token")]
    NotUsdcPair,
    #[msg("Route touches a vault account outside this swap")]
    ForeignVaultAccount,
    #[msg("Outflow cap for this window exceeded")]
    CapExceeded,
    #[msg("Swap left the vault with less than expected")]
    BadBalances,
    #[msg("Swap spent more than amount_in")]
    Overspent,
    #[msg("Swap returned less than min_out")]
    Slippage,
    #[msg("Swap program is not allow-listed")]
    WrongSwapProgram,
    #[msg("Caps out of range")]
    BadCaps,
}
