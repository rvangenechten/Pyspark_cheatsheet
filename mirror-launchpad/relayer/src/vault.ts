import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config.js";
import { getQuote, getSwapTx, type Quote } from "./jupiter.js";

export interface SwapResult {
  signature: string;
  /** Actual amount of the output mint the vault received. */
  amountOut: bigint;
}

/** What the order processor needs from the Solana side. Mocked in tests. */
export interface Vault {
  quote(inputMint: string, outputMint: string, amount: bigint, slippageBps: number): Promise<Quote>;
  swap(quote: Quote): Promise<SwapResult>;
  balance(mint: string): Promise<bigint>;
  mintExists(mint: string): Promise<{ decimals: number } | undefined>;
}

function loadKeypair(secret: string): Keypair {
  const s = secret.trim();
  const bytes = s.startsWith("[") ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s);
  return Keypair.fromSecretKey(bytes);
}

/**
 * Custodial vault: a Solana wallet held by the relayer that owns the real
 * tokens backing every mirror, plus a USDC float used to buy them.
 */
export class SolanaVault implements Vault {
  readonly conn: Connection;
  readonly keypair: Keypair;

  constructor() {
    this.conn = new Connection(config.solanaRpcUrl, "confirmed");
    this.keypair = loadKeypair(config.vaultKey());
  }

  get address(): string {
    return this.keypair.publicKey.toBase58();
  }

  quote(inputMint: string, outputMint: string, amount: bigint, slippageBps: number) {
    return getQuote(inputMint, outputMint, amount, slippageBps);
  }

  async swap(quote: Quote): Promise<SwapResult> {
    const txB64 = await getSwapTx(quote, this.address);
    const tx = VersionedTransaction.deserialize(Buffer.from(txB64, "base64"));
    tx.sign([this.keypair]);

    const signature = await this.conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    const bh = await this.conn.getLatestBlockhash("confirmed");
    const res = await this.conn.confirmTransaction(
      { signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
      "confirmed",
    );
    if (res.value.err) throw new SwapFailed(signature, JSON.stringify(res.value.err));

    const amountOut = await this.balanceDelta(signature, quote.outputMint);
    return { signature, amountOut };
  }

  /** Change in the vault's balance of `mint` in a confirmed tx, read from tx metadata. */
  private async balanceDelta(signature: string, mint: string): Promise<bigint> {
    for (let i = 0; i < 10; i++) {
      const tx = await this.conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (tx?.meta) {
        const sum = (list: typeof tx.meta.preTokenBalances) =>
          (list ?? [])
            .filter((b) => b.mint === mint && b.owner === this.address)
            .reduce((acc, b) => acc + BigInt(b.uiTokenAmount.amount), 0n);
        return sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Could not load tx ${signature} to measure output`);
  }

  async balance(mint: string): Promise<bigint> {
    const res = await this.conn.getParsedTokenAccountsByOwner(this.keypair.publicKey, { mint: new PublicKey(mint) });
    return res.value.reduce((acc, a) => acc + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  }

  async mintExists(mint: string) {
    try {
      const info = await this.conn.getParsedAccountInfo(new PublicKey(mint));
      const data = info.value?.data;
      if (data && "parsed" in data && data.parsed.type === "mint") return { decimals: data.parsed.info.decimals as number };
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
