import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config.js";
import { getQuote, getSwapInstructions, type JupIx, type Quote } from "./jupiter.js";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, VaultProgram, decodeConfig, decodeReceipt } from "./vaultProgram.js";

export interface SwapResult {
  signature: string;
  /** Actual amount of the output mint the vault received. */
  amountOut: bigint;
}

/** What the order processor needs from the Solana side. Mocked in tests. */
export interface Vault {
  quote(inputMint: string, outputMint: string, amount: bigint, slippageBps: number): Promise<Quote>;
  /** Swap through the vault program for this EVM order. At most once per order, enforced on-chain. */
  swap(orderId: bigint, quote: Quote): Promise<SwapResult>;
  /** The on-chain receipt of a swap already done for this order, if any. */
  receipt(orderId: bigint): Promise<SwapResult | undefined>;
  /** Make sure the vault has an account for this mint (idempotent). */
  registerAsset(mint: string): Promise<void>;
  balance(mint: string): Promise<bigint>;
  mintExists(mint: string): Promise<{ decimals: number } | undefined>;
}

export function loadKeypair(secret: string): Keypair {
  const s = secret.trim();
  const bytes = s.startsWith("[") ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s);
  return Keypair.fromSecretKey(bytes);
}

const toIx = (i: JupIx) =>
  new TransactionInstruction({
    programId: new PublicKey(i.programId),
    keys: i.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(i.data, "base64"),
  });

/**
 * Backing tokens live in token accounts owned by the mirror-vault program's
 * PDA. The relayer only holds the *operator* key, which can request capped
 * USDC<->token swaps that must pay back into the vault. It cannot withdraw.
 */
export class SolanaVault implements Vault {
  readonly conn: Connection;
  readonly operator: Keypair;
  readonly program: VaultProgram;
  private tokenPrograms = new Map<string, PublicKey>();

  constructor() {
    this.conn = new Connection(config.solanaRpcUrl, "confirmed");
    this.operator = loadKeypair(config.operatorKey());
    this.program = new VaultProgram(new PublicKey(config.vaultProgramId()));
  }

  /** The vault PDA: owner of all backing token accounts. */
  get address(): string {
    return this.program.vault.toBase58();
  }

  async checkConfig() {
    const acc = await this.conn.getAccountInfo(this.program.config);
    if (!acc) throw new Error(`Vault program ${this.program.programId.toBase58()} is not initialized`);
    const cfg = decodeConfig(acc.data);
    if (!cfg.operator.equals(this.operator.publicKey)) {
      throw new Error(`OPERATOR_KEY ${this.operator.publicKey.toBase58()} is not the vault operator (${cfg.operator.toBase58()})`);
    }
    if (cfg.usdcMint.toBase58() !== config.solanaUsdcMint) throw new Error(`Vault USDC mint is ${cfg.usdcMint.toBase58()}`);
    return cfg;
  }

  quote(inputMint: string, outputMint: string, amount: bigint, slippageBps: number) {
    return getQuote(inputMint, outputMint, amount, slippageBps);
  }

  private async tokenProgram(mint: string): Promise<PublicKey> {
    let p = this.tokenPrograms.get(mint);
    if (!p) {
      const info = await this.conn.getAccountInfo(new PublicKey(mint));
      if (!info) throw new Error(`Mint ${mint} not found`);
      p = info.owner;
      this.tokenPrograms.set(mint, p);
    }
    return p;
  }

  async swap(orderId: bigint, quote: Quote): Promise<SwapResult> {
    const mintIn = new PublicKey(quote.inputMint);
    const mintOut = new PublicKey(quote.outputMint);
    const [tpIn, tpOut] = await Promise.all([this.tokenProgram(quote.inputMint), this.tokenProgram(quote.outputMint)]);
    const vaultOut = this.program.vaultAta(mintOut, tpOut);

    // Vault ATAs already exist (registerAsset), so Jupiter's setup/cleanup
    // instructions (ATA creation, SOL wrapping) are dropped; they'd need the
    // PDA to pay, which it can't.
    const jup = await getSwapInstructions(quote, this.address, vaultOut.toBase58());
    const route = toIx(jup.swapInstruction);
    const ix = this.program.swap({
      operator: this.operator.publicKey,
      orderId,
      amountIn: BigInt(quote.inAmount),
      minOut: BigInt(quote.otherAmountThreshold),
      mintIn,
      mintOut,
      tokenProgramIn: tpIn,
      tokenProgramOut: tpOut,
      route,
    });
    const budget = jup.computeBudgetInstructions
      .map(toIx)
      .filter((i) => i.data[0] !== 2); // drop Jupiter's CU limit; ours covers the wrapper too
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...budget, ix];

    const alts = (
      await Promise.all(jup.addressLookupTableAddresses.map((a) => this.conn.getAddressLookupTable(new PublicKey(a))))
    )
      .map((r) => r.value)
      .filter((v): v is AddressLookupTableAccount => !!v);

    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: this.operator.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alts);
    const tx = new VersionedTransaction(msg);
    tx.sign([this.operator]);

    const signature = await this.conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    const res = await this.conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new SwapFailed(signature, JSON.stringify(res.value.err));

    const receipt = await this.receipt(orderId);
    if (!receipt) throw new Error(`Swap ${signature} confirmed but no receipt for order ${orderId}`);
    return { signature, amountOut: receipt.amountOut };
  }

  async receipt(orderId: bigint): Promise<SwapResult | undefined> {
    const address = this.program.receipt(orderId);
    const acc = await this.conn.getAccountInfo(address, "confirmed");
    if (!acc) return undefined;
    const r = decodeReceipt(acc.data);
    // Receipts are written once, so the only transaction touching it is the swap.
    const [sig] = await this.conn.getSignaturesForAddress(address, { limit: 1 }, "confirmed");
    return { signature: sig?.signature ?? "", amountOut: r.amountOut };
  }

  async registerAsset(mint: string): Promise<void> {
    const m = new PublicKey(mint);
    if (await this.conn.getAccountInfo(this.program.asset(m))) return;
    const ix = this.program.registerAsset(this.operator.publicKey, m, await this.tokenProgram(mint));
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: this.operator.publicKey, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([this.operator]);
    const signature = await this.conn.sendRawTransaction(tx.serialize());
    const res = await this.conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error(`registerAsset ${mint} failed: ${JSON.stringify(res.value.err)}`);
  }

  async balance(mint: string): Promise<bigint> {
    const ata = this.program.vaultAta(new PublicKey(mint), await this.tokenProgram(mint));
    try {
      const b = await this.conn.getTokenAccountBalance(ata, "confirmed");
      return BigInt(b.value.amount);
    } catch {
      return 0n; // not registered yet
    }
  }

  async mintExists(mint: string) {
    try {
      const info = await this.conn.getParsedAccountInfo(new PublicKey(mint));
      const data = info.value?.data;
      const owner = info.value?.owner;
      if (owner && (owner.equals(TOKEN_PROGRAM) || owner.equals(TOKEN_2022_PROGRAM)) && data && "parsed" in data && data.parsed.type === "mint") {
        return { decimals: data.parsed.info.decimals as number };
      }
    } catch {
      // invalid base58 etc.
    }
    return undefined;
  }
}

export class SwapFailed extends Error {
  constructor(readonly signature: string, reason: string) {
    super(`Swap ${signature} failed: ${reason}`);
  }
}
