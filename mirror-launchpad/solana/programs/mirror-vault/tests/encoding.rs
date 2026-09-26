//! Pins the wire format of every instruction (data + account order/flags) in
//! a JSON fixture that the TypeScript client test compares against, so the
//! relayer's hand-written encoder can't drift from the program.
//!
//! Regenerate after changing the program's interface:
//!   UPDATE_FIXTURES=1 cargo test -p mirror-vault --test encoding

use anchor_lang::{InstructionData, ToAccountMetas};
use mirror_vault::{ConfigUpdate, InitParams, ASSET_SEED, CONFIG_SEED, RECEIPT_SEED, VAULT_SEED};
use solana_sdk::{instruction::AccountMeta, pubkey::Pubkey};

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../relayer/test/fixtures/vault-ix.json");

fn key(n: u8) -> Pubkey {
    Pubkey::new_from_array([n; 32])
}
fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &mirror_vault::ID).0
}
fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), token_program.as_ref(), mint.as_ref()], &spl_associated_token_account::ID).0
}

fn entry(name: &str, metas: Vec<AccountMeta>, data: Vec<u8>) -> String {
    let keys: Vec<String> = metas
        .iter()
        .map(|m| format!(r#"{{"pubkey":"{}","isSigner":{},"isWritable":{}}}"#, m.pubkey, m.is_signer, m.is_writable))
        .collect();
    let hex: String = data.iter().map(|b| format!("{b:02x}")).collect();
    format!(r#"    "{name}": {{"keys":[{}],"data":"{hex}"}}"#, keys.join(","))
}

#[test]
fn instruction_encoding_fixture() {
    let token = spl_token::ID;
    let (usdc, meme) = (key(1), key(2));
    let (admin, operator, guardian, jup) = (key(3), key(4), key(5), key(6));
    let config = pda(&[CONFIG_SEED]);
    let vault = pda(&[VAULT_SEED]);
    let asset = |m: &Pubkey| pda(&[ASSET_SEED, m.as_ref()]);
    let program_data = Pubkey::find_program_address(&[mirror_vault::ID.as_ref()], &solana_sdk::bpf_loader_upgradeable::ID).0;
    let sys = solana_sdk::system_program::ID;
    let ata_prog = spl_associated_token_account::ID;

    let mut out = vec![];
    out.push(entry(
        "initialize",
        mirror_vault::accounts::Initialize {
            payer: admin, config, vault_authority: vault, usdc_mint: usdc, usdc_asset: asset(&usdc),
            usdc_vault: ata(&vault, &usdc, &token), program_data, token_program: token,
            associated_token_program: ata_prog, system_program: sys,
        }
        .to_account_metas(None),
        mirror_vault::instruction::Initialize {
            params: InitParams { admin, operator, guardian, swap_program: jup, usdc_max_outflow: 150_000_000, default_sell_bps: 2_000 },
        }
        .data(),
    ));
    out.push(entry(
        "registerAsset",
        mirror_vault::accounts::RegisterAsset {
            signer: operator, config, vault_authority: vault, mint: meme, asset: asset(&meme),
            vault_token: ata(&vault, &meme, &token), token_program: token, associated_token_program: ata_prog, system_program: sys,
        }
        .to_account_metas(None),
        mirror_vault::instruction::RegisterAsset {}.data(),
    ));
    let mut swap_metas = mirror_vault::accounts::Swap {
        operator, config, vault_authority: vault, asset_in: asset(&usdc), asset_out: asset(&meme),
        vault_in: ata(&vault, &usdc, &token), vault_out: ata(&vault, &meme, &token),
        receipt: pda(&[RECEIPT_SEED, &42u64.to_le_bytes()]), swap_program: jup, system_program: sys,
    }
    .to_account_metas(None);
    // Route accounts: the PDA's signer flag is cleared, others pass through.
    swap_metas.push(AccountMeta::new_readonly(vault, false));
    swap_metas.push(AccountMeta::new(key(9), false));
    out.push(entry(
        "swap",
        swap_metas,
        mirror_vault::instruction::Swap { order_id: 42, amount_in: 100_000_000, min_out: 5_000_000, route: vec![0xde, 0xad, 0xbe, 0xef] }.data(),
    ));
    out.push(entry(
        "withdraw",
        mirror_vault::accounts::Withdraw {
            admin, config, vault_authority: vault, mint: usdc, vault_token: ata(&vault, &usdc, &token), destination: key(7), token_program: token,
        }
        .to_account_metas(None),
        mirror_vault::instruction::Withdraw { amount: 1_000_000 }.data(),
    ));
    out.push(entry(
        "setAssetCaps",
        mirror_vault::accounts::SetAssetCaps { admin, config, asset: asset(&meme) }.to_account_metas(None),
        mirror_vault::instruction::SetAssetCaps { max_outflow_abs: 5, max_outflow_bps: 300 }.data(),
    ));
    out.push(entry(
        "updateConfig",
        mirror_vault::accounts::AdminOnly { admin, config }.to_account_metas(None),
        mirror_vault::instruction::UpdateConfig {
            update: ConfigUpdate { operator: Some(key(8)), guardian: None, swap_program: None, default_sell_bps: Some(1_000), paused: Some(false) },
        }
        .data(),
    ));
    out.push(entry(
        "pause",
        mirror_vault::accounts::Pause { signer: guardian, config }.to_account_metas(None),
        mirror_vault::instruction::Pause {}.data(),
    ));
    out.push(entry(
        "proposeAdmin",
        mirror_vault::accounts::AdminOnly { admin, config }.to_account_metas(None),
        mirror_vault::instruction::ProposeAdmin { new_admin: key(8) }.data(),
    ));
    out.push(entry(
        "acceptAdmin",
        mirror_vault::accounts::AcceptAdmin { new_admin: key(8), config }.to_account_metas(None),
        mirror_vault::instruction::AcceptAdmin {}.data(),
    ));

    let json = format!("{{\n  \"programId\": \"{}\",\n  \"instructions\": {{\n{}\n  }}\n}}\n", mirror_vault::ID, out.join(",\n"));
    if std::env::var("UPDATE_FIXTURES").is_ok() {
        std::fs::create_dir_all(std::path::Path::new(FIXTURE).parent().unwrap()).unwrap();
        std::fs::write(FIXTURE, &json).unwrap();
    } else {
        let current = std::fs::read_to_string(FIXTURE).expect("fixture missing: run with UPDATE_FIXTURES=1");
        assert_eq!(current, json, "instruction encoding changed: rerun with UPDATE_FIXTURES=1 and update the TS client");
    }
}
