// Admin CLI for the mirror-vault program.
//
//   npm run admin -- status
//   npm run admin -- init --admin <SquadsVault> --guardian <pk> --usdc-cap 10000 --sell-bps 2000
//   npm run admin -- pause                                   (signs with GUARDIAN_KEY or OPERATOR_KEY)
//
// Admin-only actions can't be signed here: the admin is a Squads multisig.
// These print an unsigned transaction (base58) to import as a Squads proposal:
//   npm run admin -- unpause
//   npm run admin -- set-operator <pubkey>
//   npm run admin -- set-guardian <pubkey>
//   npm run admin -- set-caps <mint> <maxOutflowAbs raw units, 0 = use bps> <maxOutflowBps>
//   npm run admin -- withdraw <mint> <destinationTokenAccount> <raw amount>
//   npm run admin -- propose-admin <pubkey>
import "dotenv/config";
import bs58 from "bs58";
import { Connection, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { config } from "./config.js";
import { loadKeypair } from "./vault.js";
import { JUPITER_V6, VaultProgram, decodeConfig } from "./vaultProgram.js";

const [cmd, ...rest] = process.argv.slice(2);
const flags = Object.fromEntries(
  rest.flatMap((a, i) => (a.startsWith("--") ? [[a.slice(2), rest[i + 1]]] : [])),
) as Record<string, string>;
const args = rest.filter((a, i) => !a.startsWith("--") && !rest[i - 1]?.startsWith("--"));

const conn = new Connection(config.solanaRpcUrl, "confirmed");
const vp = new VaultProgram(new PublicKey(config.vaultProgramId()));

async function currentConfig() {
  const acc = await conn.getAccountInfo(vp.config);
  if (!acc) throw new Error("Vault not initialized");
  return decodeConfig(acc.data);
}

async function send(ix: TransactionInstruction, signerEnv: string) {
  const signer = loadKeypair(process.env[signerEnv] ?? "");
  const tx = new Transaction().add(ix);
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(signer);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  console.log("sent", sig);
}

/** Print an unsigned tx for the multisig (fee payer = admin) plus a readable form. */
async function propose(ix: TransactionInstruction) {
  const cfg = await currentConfig();
  const tx = new Transaction().add(ix);
  tx.feePayer = cfg.admin;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  console.log(`Admin (multisig): ${cfg.admin.toBase58()}`);
  console.log("Instruction:", JSON.stringify({
    programId: ix.programId.toBase58(),
    keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
    data: ix.data.toString("base64"),
  }, null, 2));
  console.log("\nUnsigned transaction (base58), import into Squads as a proposal:\n");
  console.log(bs58.encode(tx.serialize({ requireAllSignatures: false, verifySignatures: false })));
}

async function tokenProgramOf(mint: PublicKey) {
  const info = await conn.getAccountInfo(mint);
  if (!info) throw new Error(`mint ${mint.toBase58()} not found`);
  return info.owner;
}

async function main() {
  switch (cmd) {
    case "status": {
      const c = await currentConfig();
      const usdcTp = await tokenProgramOf(c.usdcMint);
      const bal = await conn.getTokenAccountBalance(vp.vaultAta(c.usdcMint, usdcTp)).catch(() => undefined);
      console.log({
        program: vp.programId.toBase58(),
        vault: vp.vault.toBase58(),
        admin: c.admin.toBase58(),
        pendingAdmin: c.pendingAdmin.toBase58(),
        operator: c.operator.toBase58(),
        guardian: c.guardian.toBase58(),
        swapProgram: c.swapProgram.toBase58(),
        usdcMint: c.usdcMint.toBase58(),
        usdcFloat: bal?.value.uiAmountString,
        defaultSellBps: c.defaultSellBps,
        paused: c.paused,
      });
      break;
    }
    case "init": {
      // Must be signed by the program's upgrade authority (checked on-chain).
      const payer = loadKeypair(process.env.UPGRADE_AUTHORITY_KEY ?? "");
      const operator = flags.operator ? new PublicKey(flags.operator) : loadKeypair(config.operatorKey()).publicKey;
      if (!flags.admin || !flags.guardian) throw new Error("--admin <Squads vault> and --guardian <pubkey> are required");
      const usdcMint = new PublicKey(config.solanaUsdcMint);
      const ix = vp.initialize({
        payer: payer.publicKey,
        usdcMint,
        tokenProgram: await tokenProgramOf(usdcMint),
        admin: new PublicKey(flags.admin),
        operator,
        guardian: new PublicKey(flags.guardian),
        swapProgram: flags["swap-program"] ? new PublicKey(flags["swap-program"]) : JUPITER_V6,
        usdcMaxOutflow: BigInt(flags["usdc-cap"] ?? "10000") * 1_000_000n,
        defaultSellBps: Number(flags["sell-bps"] ?? 2000),
      });
      const tx = new Transaction().add(ix);
      tx.feePayer = payer.publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      tx.sign(payer);
      const sig = await conn.sendRawTransaction(tx.serialize());
      await conn.confirmTransaction(sig, "confirmed");
      console.log("initialized", sig);
      console.log("Next: fund the vault's USDC account", vp.vaultAta(usdcMint, await tokenProgramOf(usdcMint)).toBase58());
      console.log("Then consider handing the program upgrade authority to the multisig too.");
      break;
    }
    case "pause": {
      const env = process.env.GUARDIAN_KEY ? "GUARDIAN_KEY" : "OPERATOR_KEY";
      await send(vp.pause(loadKeypair(process.env[env]!).publicKey), env);
      break;
    }
    case "unpause":
      return propose(vp.updateConfig((await currentConfig()).admin, { paused: false }));
    case "set-operator":
      return propose(vp.updateConfig((await currentConfig()).admin, { operator: new PublicKey(args[0]) }));
    case "set-guardian":
      return propose(vp.updateConfig((await currentConfig()).admin, { guardian: new PublicKey(args[0]) }));
    case "set-caps":
      return propose(vp.setAssetCaps((await currentConfig()).admin, new PublicKey(args[0]), BigInt(args[1]), Number(args[2])));
    case "withdraw": {
      const mint = new PublicKey(args[0]);
      return propose(vp.withdraw({
        admin: (await currentConfig()).admin,
        mint,
        tokenProgram: await tokenProgramOf(mint),
        destination: new PublicKey(args[1]),
        amount: BigInt(args[2]),
      }));
    }
    case "propose-admin":
      return propose(vp.proposeAdmin((await currentConfig()).admin, new PublicKey(args[0])));
    default:
      console.log("usage: npm run admin -- <status|init|pause|unpause|set-operator|set-guardian|set-caps|withdraw|propose-admin> ...");
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
