//! Runs the vault program natively inside solana-program-test, with a fake
//! swap program standing in for Jupiter. The fake can be told to misbehave
//! (overspend, underpay, touch other vault accounts) to prove the vault
//! rejects it.

use anchor_lang::{InstructionData, ToAccountMetas};
use mirror_vault::{ConfigUpdate, InitParams, Receipt, VaultError, ASSET_SEED, CONFIG_SEED, RECEIPT_SEED, VAULT_SEED};
use solana_program_test::{processor, BanksClientError, ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::Account,
    account_info::{next_account_info, AccountInfo},
    bpf_loader_upgradeable::{self, UpgradeableLoaderState},
    clock::Clock,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction, InstructionError},
    program::{invoke, invoke_signed},
    program_pack::Pack,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction, system_program,
    transaction::{Transaction, TransactionError},
};
use spl_associated_token_account::get_associated_token_address;

const FAKE_SWAP: Pubkey = solana_sdk::pubkey!("FakeSwap11111111111111111111111111111111111");

// ----------------------------------------------------------------------
// Fake swap program: pays `amount_out` from its pool for `amount_in` from
// the caller. Mode 1 additionally pulls 1 unit from accounts[7].
// accounts: [authority, src, dst, pool_in, pool_out, pool_auth, token_program, extra?]
// ----------------------------------------------------------------------

fn fake_swap(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let authority = next_account_info(it)?;
    let src = next_account_info(it)?;
    let dst = next_account_info(it)?;
    let pool_in = next_account_info(it)?;
    let pool_out = next_account_info(it)?;
    let pool_auth = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let mode = data[0];
    let amount_in = u64::from_le_bytes(data[1..9].try_into().unwrap());
    let amount_out = u64::from_le_bytes(data[9..17].try_into().unwrap());

    invoke(
        &spl_token::instruction::transfer(token_program.key, src.key, pool_in.key, authority.key, &[], amount_in)?,
        &[src.clone(), pool_in.clone(), authority.clone(), token_program.clone()],
    )?;
    let (_, bump) = Pubkey::find_program_address(&[b"pool"], program_id);
    invoke_signed(
        &spl_token::instruction::transfer(token_program.key, pool_out.key, dst.key, pool_auth.key, &[], amount_out)?,
        &[pool_out.clone(), dst.clone(), pool_auth.clone(), token_program.clone()],
        &[&[b"pool", &[bump]]],
    )?;
    if mode == 1 {
        let extra = next_account_info(it)?;
        invoke(
            &spl_token::instruction::transfer(token_program.key, extra.key, pool_in.key, authority.key, &[], 1)?,
            &[extra.clone(), pool_in.clone(), authority.clone(), token_program.clone()],
        )?;
    }
    Ok(())
}

fn vault_entry(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    // Anchor's entry wants `&'info [AccountInfo<'info>]`; leak to satisfy it in tests.
    let accounts: &'static [AccountInfo<'static>] = unsafe { std::mem::transmute(Box::leak(accounts.to_vec().into_boxed_slice())) };
    mirror_vault::entry(program_id, accounts, data)
}

// ----------------------------------------------------------------------
// Harness
// ----------------------------------------------------------------------

struct Env {
    ctx: ProgramTestContext,
    admin: Keypair,
    operator: Keypair,
    guardian: Keypair,
    usdc: Pubkey,
    meme: Pubkey,
    pool_auth: Pubkey,
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &mirror_vault::ID).0
}
fn config() -> Pubkey { pda(&[CONFIG_SEED]) }
fn vault() -> Pubkey { pda(&[VAULT_SEED]) }
fn asset(mint: &Pubkey) -> Pubkey { pda(&[ASSET_SEED, mint.as_ref()]) }
fn receipt(id: u64) -> Pubkey { pda(&[RECEIPT_SEED, &id.to_le_bytes()]) }
fn vault_ata(mint: &Pubkey) -> Pubkey { get_associated_token_address(&vault(), mint) }
fn pool_ata(e: &Env, mint: &Pubkey) -> Pubkey { get_associated_token_address(&e.pool_auth, mint) }

fn code(e: VaultError) -> u32 {
    e as u32 + anchor_lang::error::ERROR_CODE_OFFSET
}

fn assert_custom(res: Result<(), BanksClientError>, expected: u32) {
    match res {
        Err(BanksClientError::TransactionError(TransactionError::InstructionError(_, InstructionError::Custom(c)))) => {
            assert_eq!(c, expected, "wrong error code")
        }
        other => panic!("expected custom error {expected}, got {other:?}"),
    }
}

impl Env {
    async fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), BanksClientError> {
        let mut all: Vec<&Keypair> = vec![&self.ctx.payer];
        all.extend_from_slice(signers);
        let bh = self.ctx.banks_client.get_latest_blockhash().await.unwrap();
        let tx = Transaction::new_signed_with_payer(ixs, Some(&self.ctx.payer.pubkey()), &all, bh);
        self.ctx.banks_client.process_transaction(tx).await
    }

    async fn balance(&mut self, ata: Pubkey) -> u64 {
        let acc = self.ctx.banks_client.get_account(ata).await.unwrap().unwrap();
        spl_token::state::Account::unpack(&acc.data).unwrap().amount
    }

    async fn mint_to(&mut self, mint: Pubkey, to: Pubkey, amount: u64) {
        let payer = self.ctx.payer.pubkey();
        let ix = spl_token::instruction::mint_to(&spl_token::ID, &mint, &to, &payer, &[], amount).unwrap();
        self.send(&[ix], &[]).await.unwrap();
    }

    fn register_ix(&self, signer: &Pubkey, mint: Pubkey) -> Instruction {
        Instruction {
            program_id: mirror_vault::ID,
            accounts: mirror_vault::accounts::RegisterAsset {
                signer: *signer,
                config: config(),
                vault_authority: vault(),
                mint,
                asset: asset(&mint),
                vault_token: vault_ata(&mint),
                token_program: spl_token::ID,
                associated_token_program: spl_associated_token_account::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: mirror_vault::instruction::RegisterAsset {}.data(),
        }
    }

    /// Build a vault swap wrapping a fake-swap route.
    #[allow(clippy::too_many_arguments)]
    fn swap_ix(&self, signer: &Pubkey, order_id: u64, mint_in: Pubkey, mint_out: Pubkey, amount_in: u64, min_out: u64, route: (u8, u64, u64), extra: Option<Pubkey>, swap_program: Pubkey) -> Instruction {
        let mut accounts = mirror_vault::accounts::Swap {
            operator: *signer,
            config: config(),
            vault_authority: vault(),
            asset_in: asset(&mint_in),
            asset_out: asset(&mint_out),
            vault_in: vault_ata(&mint_in),
            vault_out: vault_ata(&mint_out),
            receipt: receipt(order_id),
            swap_program,
            system_program: system_program::ID,
        }
        .to_account_metas(None);
        // Route accounts, as Jupiter's swap-instructions API would return them.
        accounts.extend([
            AccountMeta::new_readonly(vault(), false),
            AccountMeta::new(vault_ata(&mint_in), false),
            AccountMeta::new(vault_ata(&mint_out), false),
            AccountMeta::new(pool_ata(self, &mint_in), false),
            AccountMeta::new(pool_ata(self, &mint_out), false),
            AccountMeta::new_readonly(self.pool_auth, false),
            AccountMeta::new_readonly(spl_token::ID, false),
        ]);
        if let Some(x) = extra {
            accounts.push(AccountMeta::new(x, false));
        }
        let mut data = vec![route.0];
        data.extend(route.1.to_le_bytes());
        data.extend(route.2.to_le_bytes());
        Instruction {
            program_id: mirror_vault::ID,
            accounts,
            data: mirror_vault::instruction::Swap { order_id, amount_in, min_out, route: data }.data(),
        }
    }

    fn update_ix(&self, signer: &Pubkey, update: ConfigUpdate) -> Instruction {
        Instruction {
            program_id: mirror_vault::ID,
            accounts: mirror_vault::accounts::AdminOnly { admin: *signer, config: config() }.to_account_metas(None),
            data: mirror_vault::instruction::UpdateConfig { update }.data(),
        }
    }

    async fn warp(&mut self, secs: i64) {
        let mut clock: Clock = self.ctx.banks_client.get_sysvar().await.unwrap();
        clock.unix_timestamp += secs;
        self.ctx.set_sysvar(&clock);
    }
}

async fn create_mint(e: &mut Env, decimals: u8) -> Pubkey {
    let mint = Keypair::new();
    let payer = e.ctx.payer.pubkey();
    let rent = e.ctx.banks_client.get_rent().await.unwrap();
    let ixs = [
        system_instruction::create_account(&payer, &mint.pubkey(), rent.minimum_balance(82), 82, &spl_token::ID),
        spl_token::instruction::initialize_mint2(&spl_token::ID, &mint.pubkey(), &payer, None, decimals).unwrap(),
    ];
    e.send(&ixs, &[&mint]).await.unwrap();
    mint.pubkey()
}

async fn create_ata(e: &mut Env, owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    let payer = e.ctx.payer.pubkey();
    let ix = spl_associated_token_account::instruction::create_associated_token_account(&payer, owner, mint, &spl_token::ID);
    e.send(&[ix], &[]).await.unwrap();
    get_associated_token_address(owner, mint)
}

const USDC_CAP: u64 = 150_000_000; // 150 USDC per day
const SELL_BPS: u16 = 2_000; // 20% of balance per day

/// Deployed, initialized vault with USDC + MEME registered, 1000 USDC in the
/// vault, and a fake pool with liquidity on both sides.
async fn setup() -> Env {
    let mut pt = ProgramTest::default();
    pt.prefer_bpf(false);
    pt.add_program("mirror_vault", mirror_vault::ID, processor!(vault_entry));
    pt.add_program("fake_swap", FAKE_SWAP, processor!(fake_swap));

    // Mark the test payer as upgrade authority via a ProgramData account.
    let upgrade_authority = Keypair::new();
    let program_data = Pubkey::find_program_address(&[mirror_vault::ID.as_ref()], &bpf_loader_upgradeable::ID).0;
    let state = UpgradeableLoaderState::ProgramData { slot: 0, upgrade_authority_address: Some(upgrade_authority.pubkey()) };
    pt.add_account(program_data, Account {
        lamports: 1_000_000_000,
        data: bincode::serialize(&state).unwrap(),
        owner: bpf_loader_upgradeable::ID,
        executable: false,
        rent_epoch: 0,
    });
    pt.add_account(upgrade_authority.pubkey(), Account { lamports: 10_000_000_000, ..Account::default() });

    let ctx = pt.start_with_context().await;
    let mut e = Env {
        ctx,
        admin: Keypair::new(),
        operator: Keypair::new(),
        guardian: Keypair::new(),
        usdc: Pubkey::default(),
        meme: Pubkey::default(),
        pool_auth: Pubkey::find_program_address(&[b"pool"], &FAKE_SWAP).0,
    };
    // Operator pays for receipts.
    let fund = system_instruction::transfer(&e.ctx.payer.pubkey(), &e.operator.pubkey(), 1_000_000_000);
    e.send(&[fund], &[]).await.unwrap();

    e.usdc = create_mint(&mut e, 6).await;
    e.meme = create_mint(&mut e, 5).await;

    let init = |payer: Pubkey, e: &Env| Instruction {
        program_id: mirror_vault::ID,
        accounts: mirror_vault::accounts::Initialize {
            payer,
            config: config(),
            vault_authority: vault(),
            usdc_mint: e.usdc,
            usdc_asset: asset(&e.usdc),
            usdc_vault: vault_ata(&e.usdc),
            program_data,
            token_program: spl_token::ID,
            associated_token_program: spl_associated_token_account::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: mirror_vault::instruction::Initialize {
            params: InitParams {
                admin: e.admin.pubkey(),
                operator: e.operator.pubkey(),
                guardian: e.guardian.pubkey(),
                swap_program: FAKE_SWAP,
                usdc_max_outflow: USDC_CAP,
                default_sell_bps: SELL_BPS,
            },
        }
        .data(),
    };

    // Only the upgrade authority can initialize.
    let payer = e.ctx.payer.pubkey();
    assert_custom(e.send(&[init(payer, &e)], &[]).await, code(VaultError::Unauthorized));
    let ix = init(upgrade_authority.pubkey(), &e);
    e.send(&[ix], &[&upgrade_authority]).await.unwrap();

    let ix = e.register_ix(&e.operator.pubkey(), e.meme);
    let op = e.operator.insecure_clone();
    e.send(&[ix], &[&op]).await.unwrap();

    let pool_auth = e.pool_auth;
    let (usdc, meme) = (e.usdc, e.meme);
    let pool_usdc = create_ata(&mut e, &pool_auth, &usdc).await;
    let pool_meme = create_ata(&mut e, &pool_auth, &meme).await;
    e.mint_to(usdc, pool_usdc, 1_000_000_000_000).await;
    e.mint_to(meme, pool_meme, 1_000_000_000_000_000).await;
    e.mint_to(usdc, vault_ata(&usdc), 1_000_000_000).await; // 1000 USDC float
    e
}

// ----------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------

#[tokio::test]
async fn buy_and_sell_settle_into_the_vault() {
    let mut e = setup().await;
    let op = e.operator.insecure_clone();
    let (usdc, meme) = (e.usdc, e.meme);

    // Buy: 100 USDC -> 5,000,000 MEME
    let ix = e.swap_ix(&op.pubkey(), 1, usdc, meme, 100_000_000, 5_000_000, (0, 100_000_000, 5_000_000), None, FAKE_SWAP);
    e.send(&[ix], &[&op]).await.unwrap();
    assert_eq!(e.balance(vault_ata(&usdc)).await, 900_000_000);
    assert_eq!(e.balance(vault_ata(&meme)).await, 5_000_000);

    let r: Receipt = {
        let acc = e.ctx.banks_client.get_account(receipt(1)).await.unwrap().unwrap();
        anchor_lang::AccountDeserialize::try_deserialize(&mut acc.data.as_slice()).unwrap()
    };
    assert_eq!((r.order_id, r.amount_in, r.amount_out, r.mint_in, r.mint_out), (1, 100_000_000, 5_000_000, usdc, meme));

    // Sell: 1,000,000 MEME (20% of balance) -> 20 USDC
    let ix = e.swap_ix(&op.pubkey(), 2, meme, usdc, 1_000_000, 20_000_000, (0, 1_000_000, 20_000_000), None, FAKE_SWAP);
    e.send(&[ix], &[&op]).await.unwrap();
    assert_eq!(e.balance(vault_ata(&meme)).await, 4_000_000);
    assert_eq!(e.balance(vault_ata(&usdc)).await, 920_000_000);
}

#[tokio::test]
async fn an_order_can_only_be_swapped_once() {
    let mut e = setup().await;
    let op = e.operator.insecure_clone();
    let (usdc, meme) = (e.usdc, e.meme);
    let ix = e.swap_ix(&op.pubkey(), 7, usdc, meme, 10_000_000, 1, (0, 10_000_000, 1), None, FAKE_SWAP);
    e.send(&[ix.clone()], &[&op]).await.unwrap();
    e.ctx.get_new_latest_blockhash().await.unwrap();
    // `init` on the receipt PDA fails: account already in use.
    assert!(e.send(&[ix], &[&op]).await.is_err());
    assert_eq!(e.balance(vault_ata(&usdc)).await, 990_000_000);
}

#[tokio::test]
async fn rejects_underpaying_and_overspending_routes() {
    let mut e = setup().await;
    let op = e.operator.insecure_clone();
    let (usdc, meme) = (e.usdc, e.meme);

    let ix = e.swap_ix(&op.pubkey(), 1, usdc, meme, 10_000_000, 500, (0, 10_000_000, 499), None, FAKE_SWAP);
    assert_custom(e.send(&[ix], &[&op]).await, code(VaultError::Slippage));

    let ix = e.swap_ix(&op.pubkey(), 2, usdc, meme, 10_000_000, 1, (0, 10_000_001, 1), None, FAKE_SWAP);
    assert_custom(e.send(&[ix], &[&op]).await, code(VaultError::Overspent));
    assert_eq!(e.balance(vault_ata(&usdc)).await, 1_000_000_000);
}

#[tokio::test]
async fn route_cannot_touch_other_vault_accounts() {
    let mut e = setup().await;
    let op = e.operator.insecure_clone();
    let (usdc, meme) = (e.usdc, e.meme);
    // A second registered asset whose vault account the route tries to drain.
    let other = create_mint(&mut e, 6).await;
    let ix = e.register_ix(&op.pubkey(), other);
    e.send(&[ix], &[&op]).await.unwrap();
    e.mint_to(other, vault_ata(&other), 1_000).await;

    let ix = e.swap_ix(&op.pubkey(), 1, usdc, meme, 1_000_000, 1, (1, 1_000_000, 1), Some(vault_ata(&other)), FAKE_SWAP);
    assert_custom(e.send(&[ix], &[&op]).await, code(VaultError::ForeignVaultAccount));
    assert_eq!(e.balance(vault_ata(&other)).await, 1_000);
}

#[tokio::test]
async fn only_operator_only_allowlisted_program_only_usdc_pairs() {
    let mut e = setup().await;
    let op = e.operator.insecure_clone();
    let rando = Keypair::new();
    let (usdc, meme) = (e.usdc, e.meme);
    let fund = system_instruction::transfer(&e.ctx.payer.pubkey(), &rando.pubkey(), 1_000_000_000);
    e.send(&[fund], &[]).await.unwrap();

    let ix = e.swap_ix(&rando.pubkey(), 1, usdc, meme, 1_000_000, 1, (0, 1_000_000, 1), None, FAKE_SWAP);
    assert_custom(e.send(&[ix], &[&rando]).await, code(VaultError::Unauthorized));

    let ix = e.swap_ix(&op.pubkey(), 1, usdc, meme, 1_000_000, 1, (0, 1_000_000, 1), None, spl_token::ID);
    assert_custom(e.send(&[ix], &[&op]).await, code(VaultError::WrongSwapProgram));

    let ix = e.swap_ix(&op.pubkey(), 1, usdc, usdc, 1_000_000, 1, (0, 1_000_000, 1), None, FAKE_SWAP);
    assert_custom(e.send(&[ix], &[&op]).await, code(VaultError::NotUsdcPair));

    let ix = e.register_ix(&rando.pubkey(), Keypair::new().pubkey());
    assert!(e.send(&[ix], &[&rando]).await.is_err());
}

#[tokio::test]
async fn daily_outflow_caps() {
    let mut e = setup().await;
    let op = e.operator.insecure_clone();
    let (usdc, meme) = (e.usdc, e.meme);

    // USDC: 150/day absolute.
    let ix = e.swap_ix(&op.pubkey(), 1, usdc, meme, 100_000_000, 1, (0, 100_000_000, 1_000_000), None, FAKE_SWAP);
    e.send(&[ix], &[&op]).await.unwrap();
    let ix = e.swap_ix(&op.pubkey(), 2, usdc, meme, 60_000_000, 1, (0, 60_000_000, 1), None, FAKE_SWAP);
    assert_custom(e.send(&[ix], &[&op]).await, code(VaultError::CapExceeded));

    // MEME: 20% of the balance at window start (1,000,000 -> 200,000).
    let ix = e.swap_ix(&op.pubkey(), 3, meme, usdc, 200_001, 1, (0, 200_001, 1), None, FAKE_SWAP);
    assert_custom(e.send(&[ix], &[&op]).await, code(VaultError::CapExceeded));
    let ix = e.swap_ix(&op.pubkey(), 4, meme, usdc, 200_000, 1, (0, 200_000, 1), None, FAKE_SWAP);
    e.send(&[ix], &[&op]).await.unwrap();

    // Next day the windows reset.
    e.warp(86_400).await;
    let ix = e.swap_ix(&op.pubkey(), 5, usdc, meme, 60_000_000, 1, (0, 60_000_000, 1), None, FAKE_SWAP);
    e.send(&[ix], &[&op]).await.unwrap();

    // Admin can raise a cap; the operator can't.
    let caps = |signer: Pubkey, mint: Pubkey| Instruction {
        program_id: mirror_vault::ID,
        accounts: mirror_vault::accounts::SetAssetCaps { admin: signer, config: config(), asset: asset(&mint) }.to_account_metas(None),
        data: mirror_vault::instruction::SetAssetCaps { max_outflow_abs: 0, max_outflow_bps: 10_000 }.data(),
    };
    assert_custom(e.send(&[caps(op.pubkey(), meme)], &[&op]).await, code(VaultError::Unauthorized));
    let admin = e.admin.insecure_clone();
    e.send(&[caps(admin.pubkey(), meme)], &[&admin]).await.unwrap();
}

#[tokio::test]
async fn withdraw_is_admin_only() {
    let mut e = setup().await;
    let (op, admin) = (e.operator.insecure_clone(), e.admin.insecure_clone());
    let usdc = e.usdc;
    let dest = create_ata(&mut e, &op.pubkey(), &usdc).await;

    let wd = |signer: Pubkey| Instruction {
        program_id: mirror_vault::ID,
        accounts: mirror_vault::accounts::Withdraw {
            admin: signer,
            config: config(),
            vault_authority: vault(),
            mint: usdc,
            vault_token: vault_ata(&usdc),
            destination: dest,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
        data: mirror_vault::instruction::Withdraw { amount: 1_000_000 }.data(),
    };
    assert_custom(e.send(&[wd(op.pubkey())], &[&op]).await, code(VaultError::Unauthorized));
    e.send(&[wd(admin.pubkey())], &[&admin]).await.unwrap();
    assert_eq!(e.balance(dest).await, 1_000_000);
}

#[tokio::test]
async fn guardian_pauses_admin_unpauses_and_rotates() {
    let mut e = setup().await;
    let (op, admin, guardian) = (e.operator.insecure_clone(), e.admin.insecure_clone(), e.guardian.insecure_clone());
    let (usdc, meme) = (e.usdc, e.meme);

    let pause = Instruction {
        program_id: mirror_vault::ID,
        accounts: mirror_vault::accounts::Pause { signer: guardian.pubkey(), config: config() }.to_account_metas(None),
        data: mirror_vault::instruction::Pause {}.data(),
    };
    e.send(&[pause], &[&guardian]).await.unwrap();

    let ix = e.swap_ix(&op.pubkey(), 1, usdc, meme, 1_000_000, 1, (0, 1_000_000, 1), None, FAKE_SWAP);
    assert_custom(e.send(&[ix.clone()], &[&op]).await, code(VaultError::Paused));

    let unpause = ConfigUpdate { paused: Some(false), ..Default::default() };
    assert_custom(e.send(&[e.update_ix(&op.pubkey(), unpause.clone())], &[&op]).await, code(VaultError::Unauthorized));

    // Admin (the multisig) unpauses and rotates the operator key.
    let new_op = Keypair::new();
    let upd = ConfigUpdate { paused: Some(false), operator: Some(new_op.pubkey()), ..Default::default() };
    e.send(&[e.update_ix(&admin.pubkey(), upd)], &[&admin]).await.unwrap();
    e.ctx.get_new_latest_blockhash().await.unwrap();
    assert_custom(e.send(&[ix], &[&op]).await, code(VaultError::Unauthorized));
}

#[tokio::test]
async fn admin_handover_is_two_step() {
    let mut e = setup().await;
    let admin = e.admin.insecure_clone();
    let next = Keypair::new();
    let propose = Instruction {
        program_id: mirror_vault::ID,
        accounts: mirror_vault::accounts::AdminOnly { admin: admin.pubkey(), config: config() }.to_account_metas(None),
        data: mirror_vault::instruction::ProposeAdmin { new_admin: next.pubkey() }.data(),
    };
    e.send(&[propose], &[&admin]).await.unwrap();
    let accept = |s: Pubkey| Instruction {
        program_id: mirror_vault::ID,
        accounts: mirror_vault::accounts::AcceptAdmin { new_admin: s, config: config() }.to_account_metas(None),
        data: mirror_vault::instruction::AcceptAdmin {}.data(),
    };
    assert_custom(e.send(&[accept(admin.pubkey())], &[&admin]).await, code(VaultError::Unauthorized));
    e.send(&[accept(next.pubkey())], &[&next]).await.unwrap();
    // Old admin is out.
    let upd = ConfigUpdate { paused: Some(true), ..Default::default() };
    assert_custom(e.send(&[e.update_ix(&admin.pubkey(), upd)], &[&admin]).await, code(VaultError::Unauthorized));
}
