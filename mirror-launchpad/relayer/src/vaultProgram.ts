// Client for the mirror-vault Anchor program (solana/programs/mirror-vault):
// PDAs, instruction encoding and account decoding, without an IDL dependency.
import { createHash } from "node:crypto";
import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";

export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const JUPITER_V6 = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const LOADER_V3 = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

const u64 = (v: bigint) => {
  if (v < 0n || v >= 2n ** 64n) throw new Error(`u64 out of range: ${v}`);
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};
const u16 = (v: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
};
const option = (v: Buffer | undefined) => (v ? Buffer.concat([Buffer.from([1]), v]) : Buffer.from([0]));
const bytes = (v: Uint8Array) => Buffer.concat([Buffer.from(Uint32Array.of(v.length).buffer), Buffer.from(v)]);

const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });

export interface ConfigUpdate {
  operator?: PublicKey;
  guardian?: PublicKey;
  swapProgram?: PublicKey;
  defaultSellBps?: number;
  paused?: boolean;
}

export interface VaultConfig {
  admin: PublicKey;
  pendingAdmin: PublicKey;
  operator: PublicKey;
  guardian: PublicKey;
  usdcMint: PublicKey;
  swapProgram: PublicKey;
  defaultSellBps: number;
  paused: boolean;
}

export interface Receipt {
  orderId: bigint;
  mintIn: PublicKey;
  mintOut: PublicKey;
  amountIn: bigint;
  amountOut: bigint;
  slot: bigint;
}

export class VaultProgram {
  constructor(readonly programId: PublicKey) {}

  pda(...seeds: (Buffer | Uint8Array)[]) {
    return PublicKey.findProgramAddressSync(seeds, this.programId)[0];
  }
  get config() { return this.pda(Buffer.from("config")); }
  get vault() { return this.pda(Buffer.from("vault")); }
  asset(mint: PublicKey) { return this.pda(Buffer.from("asset"), mint.toBuffer()); }
  receipt(orderId: bigint) { return this.pda(Buffer.from("receipt"), u64(orderId)); }
  vaultAta(mint: PublicKey, tokenProgram: PublicKey) { return ata(this.vault, mint, tokenProgram); }
  get programData() { return PublicKey.findProgramAddressSync([this.programId.toBuffer()], LOADER_V3)[0]; }

  private ix(keys: AccountMeta[], data: Buffer) {
    return new TransactionInstruction({ programId: this.programId, keys, data });
  }

  initialize(p: {
    payer: PublicKey; usdcMint: PublicKey; tokenProgram: PublicKey;
    admin: PublicKey; operator: PublicKey; guardian: PublicKey; swapProgram: PublicKey;
    usdcMaxOutflow: bigint; defaultSellBps: number;
  }) {
    return this.ix(
      [
        w(p.payer, true), w(this.config), r(this.vault), r(p.usdcMint), w(this.asset(p.usdcMint)),
        w(this.vaultAta(p.usdcMint, p.tokenProgram)), r(this.programData), r(p.tokenProgram), r(ATA_PROGRAM), r(SystemProgram.programId),
      ],
      Buffer.concat([
        disc("initialize"), p.admin.toBuffer(), p.operator.toBuffer(), p.guardian.toBuffer(), p.swapProgram.toBuffer(),
        u64(p.usdcMaxOutflow), u16(p.defaultSellBps),
      ]),
    );
  }

  registerAsset(signer: PublicKey, mint: PublicKey, tokenProgram: PublicKey) {
    return this.ix(
      [
        w(signer, true), r(this.config), r(this.vault), r(mint), w(this.asset(mint)),
        w(this.vaultAta(mint, tokenProgram)), r(tokenProgram), r(ATA_PROGRAM), r(SystemProgram.programId),
      ],
      disc("register_asset"),
    );
  }

  /**
   * Wrap a swap-program instruction (Jupiter) so the vault PDA executes it.
   * `route` must use the vault PDA as user and its ATAs as source/destination.
   */
  swap(p: {
    operator: PublicKey; orderId: bigint; amountIn: bigint; minOut: bigint;
    mintIn: PublicKey; mintOut: PublicKey; tokenProgramIn: PublicKey; tokenProgramOut: PublicKey;
    route: TransactionInstruction;
  }) {
    const routeKeys = p.route.keys.map((k) => ({
      ...k,
      // The PDA can't sign the transaction; the program signs for it in the CPI.
      isSigner: k.pubkey.equals(p.operator) ? k.isSigner : false,
    }));
    return this.ix(
      [
        w(p.operator, true), r(this.config), r(this.vault), w(this.asset(p.mintIn)), r(this.asset(p.mintOut)),
        w(this.vaultAta(p.mintIn, p.tokenProgramIn)), w(this.vaultAta(p.mintOut, p.tokenProgramOut)),
        w(this.receipt(p.orderId)), r(p.route.programId), r(SystemProgram.programId),
        ...routeKeys,
      ],
      Buffer.concat([disc("swap"), u64(p.orderId), u64(p.amountIn), u64(p.minOut), bytes(p.route.data)]),
    );
  }

  withdraw(p: { admin: PublicKey; mint: PublicKey; tokenProgram: PublicKey; destination: PublicKey; amount: bigint }) {
    return this.ix(
      [
        r(p.admin, true), r(this.config), r(this.vault), r(p.mint), w(this.vaultAta(p.mint, p.tokenProgram)),
        w(p.destination), r(p.tokenProgram),
      ],
      Buffer.concat([disc("withdraw"), u64(p.amount)]),
    );
  }

  setAssetCaps(admin: PublicKey, mint: PublicKey, maxOutflowAbs: bigint, maxOutflowBps: number) {
    return this.ix([r(admin, true), r(this.config), w(this.asset(mint))], Buffer.concat([disc("set_asset_caps"), u64(maxOutflowAbs), u16(maxOutflowBps)]));
  }

  updateConfig(admin: PublicKey, u: ConfigUpdate) {
    return this.ix(
      [r(admin, true), w(this.config)],
      Buffer.concat([
        disc("update_config"),
        option(u.operator?.toBuffer()),
        option(u.guardian?.toBuffer()),
        option(u.swapProgram?.toBuffer()),
        option(u.defaultSellBps === undefined ? undefined : u16(u.defaultSellBps)),
        option(u.paused === undefined ? undefined : Buffer.from([u.paused ? 1 : 0])),
      ]),
    );
  }

  pause(signer: PublicKey) {
    return this.ix([r(signer, true), w(this.config)], disc("pause"));
  }

  proposeAdmin(admin: PublicKey, newAdmin: PublicKey) {
    return this.ix([r(admin, true), w(this.config)], Buffer.concat([disc("propose_admin"), newAdmin.toBuffer()]));
  }

  acceptAdmin(newAdmin: PublicKey) {
    return this.ix([r(newAdmin, true), w(this.config)], disc("accept_admin"));
  }
}

export function ata(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey) {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
}

export function decodeConfig(data: Buffer): VaultConfig {
  const pk = (o: number) => new PublicKey(data.subarray(o, o + 32));
  return {
    admin: pk(8),
    pendingAdmin: pk(40),
    operator: pk(72),
    guardian: pk(104),
    usdcMint: pk(136),
    swapProgram: pk(168),
    defaultSellBps: data.readUInt16LE(200),
    paused: data[202] === 1,
  };
}

export function decodeReceipt(data: Buffer): Receipt {
  return {
    orderId: data.readBigUInt64LE(8),
    mintIn: new PublicKey(data.subarray(16, 48)),
    mintOut: new PublicKey(data.subarray(48, 80)),
    amountIn: data.readBigUInt64LE(80),
    amountOut: data.readBigUInt64LE(88),
    slot: data.readBigUInt64LE(96),
  };
}
