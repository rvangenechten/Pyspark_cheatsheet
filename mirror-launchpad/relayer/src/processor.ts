import type { Vault } from "./vault.js";
import { SwapFailed } from "./vault.js";
import type { TokenInfo } from "./jupiter.js";
import type { Journal } from "./journal.js";
import { OrderStatus } from "./abi.js";

export interface OrderState {
  status: number;
  deadline: bigint;
  amountIn: bigint;
  minOut: bigint;
}

/** What the processor needs from the EVM gateway. Mocked in tests. */
export interface Gateway {
  getOrder(id: bigint): Promise<OrderState>;
  mirrorOf(sourceToken: string): Promise<string | undefined>;
  feeBps(): Promise<number>;
  availableLiquidity(): Promise<bigint>;
  launch(sourceToken: string, name: string, symbol: string, decimals: number, logoURI: string): Promise<string>;
  fulfillBuy(id: bigint, tokensOut: bigint, solanaTx: string): Promise<string>;
  fulfillSell(id: bigint, grossQuoteOut: bigint, solanaTx: string): Promise<string>;
  reject(id: bigint, reason: string): Promise<string>;
}

export interface ProcessorDeps {
  gateway: Gateway;
  vault: Vault;
  journal: Journal;
  tokenInfo(mint: string): Promise<TokenInfo | undefined>;
  usdcMint: string;
  maxSlippageBps: number;
  minTimeLeftSec: number;
  now?: () => number;
  log?: (...a: unknown[]) => void;
}

export interface BuyEvent { orderId: bigint; sourceToken: string }
export interface SellEvent { orderId: bigint; sourceToken: string }

/**
 * Slippage (bps) that makes Jupiter's guaranteed minimum equal `minOut`,
 * capped at `maxBps`. Returns undefined if the quote is already below minOut.
 */
export function slippageFor(quotedOut: bigint, minOut: bigint, maxBps: number): number | undefined {
  if (quotedOut <= 0n || quotedOut < minOut) return undefined;
  const room = ((quotedOut - minOut) * 10_000n) / quotedOut;
  return Number(room < BigInt(maxBps) ? room : BigInt(maxBps));
}

/** Gross USDC amount whose post-fee net is >= minNet (rounds up, so may be 1 unit conservative). */
export function grossForNet(minNet: bigint, feeBps: number): bigint {
  const denom = 10_000n - BigInt(feeBps);
  return (minNet * 10_000n + denom - 1n) / denom;
}

export class Processor {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly log: (...a: unknown[]) => void;

  constructor(private readonly d: ProcessorDeps) {
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
    this.log = d.log ?? console.log;
  }

  /** Run tasks one at a time so two orders never race on the vault's balances. */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch((e) => this.log("task failed:", e));
    return run;
  }

  async handleLaunchRequest(sourceToken: string): Promise<string | undefined> {
    const { gateway, vault } = this.d;
    if (await gateway.mirrorOf(sourceToken)) return;

    const onchain = await vault.mintExists(sourceToken);
    if (!onchain) {
      this.log(`launch ${sourceToken}: not a Solana mint, skipping`);
      return;
    }
    const info = await this.d.tokenInfo(sourceToken);
    if (!info) {
      this.log(`launch ${sourceToken}: no metadata found, skipping`);
      return;
    }

    // Exact copy of the original: same name, symbol, decimals and icon.
    const token = await gateway.launch(sourceToken, info.name, info.symbol, onchain.decimals, info.icon ?? "");
    this.log(`launched mirror of ${info.symbol} (${sourceToken}) at ${token}`);
    return token;
  }

  async handleBuy({ orderId, sourceToken }: BuyEvent): Promise<void> {
    const { gateway, vault, usdcMint } = this.d;
    const order = await this.pendingOrder(orderId);
    if (!order) return;
    if (await this.resume(orderId, "buy")) return;
    if (await this.expiring(orderId, order)) return;

    const first = await vault.quote(usdcMint, sourceToken, order.amountIn, this.d.maxSlippageBps);
    const slip = slippageFor(BigInt(first.outAmount), order.minOut, this.d.maxSlippageBps);
    if (slip === undefined) {
      await gateway.reject(orderId, `price moved: quote ${first.outAmount} < minOut ${order.minOut}`);
      return;
    }
    const quote = await vault.quote(usdcMint, sourceToken, order.amountIn, slip);

    const res = await this.swap(orderId, "buy", quote);
    if (!res) return;
    if (res.amountOut < order.minOut) {
      // Can't happen with Jupiter's threshold, but never mint unbacked: the
      // extra tokens stay in the vault as surplus and the user is refunded.
      this.log(`order ${orderId}: got ${res.amountOut} < minOut ${order.minOut}, surplus kept in vault`);
      await gateway.reject(orderId, "filled below minOut");
      this.d.journal.done(orderId);
      return;
    }
    await this.fill(orderId, "buy", res.amountOut, res.signature);
  }

  async handleSell({ orderId, sourceToken }: SellEvent): Promise<void> {
    const { gateway, vault, usdcMint } = this.d;
    const order = await this.pendingOrder(orderId);
    if (!order) return;
    if (await this.resume(orderId, "sell")) return;
    if (await this.expiring(orderId, order)) return;

    const feeBps = await gateway.feeBps();
    const minGross = grossForNet(order.minOut, feeBps);
    const first = await vault.quote(sourceToken, usdcMint, order.amountIn, this.d.maxSlippageBps);
    const slip = slippageFor(BigInt(first.outAmount), minGross, this.d.maxSlippageBps);
    if (slip === undefined) {
      await gateway.reject(orderId, `price moved: quote ${first.outAmount} < minOut ${minGross}`);
      return;
    }
    if ((await gateway.availableLiquidity()) < BigInt(first.outAmount)) {
      await gateway.reject(orderId, "insufficient payout liquidity");
      return;
    }
    const quote = await vault.quote(sourceToken, usdcMint, order.amountIn, slip);

    const res = await this.swap(orderId, "sell", quote);
    if (!res) return;
    await this.fill(orderId, "sell", res.amountOut, res.signature);
  }

  // ------------------------------------------------------------------

  private async pendingOrder(orderId: bigint): Promise<OrderState | undefined> {
    const o = await this.d.gateway.getOrder(orderId);
    return o.status === OrderStatus.Pending ? o : undefined;
  }

  private async expiring(orderId: bigint, o: OrderState): Promise<boolean> {
    if (Number(o.deadline) - this.now() >= this.d.minTimeLeftSec) return false;
    await this.d.gateway.reject(orderId, "too close to deadline");
    return true;
  }

  /**
   * Crash safety. If a swap for this order already landed, finish the fill
   * instead of swapping again. If one was started but its outcome is
   * unknown, stop and leave it for manual reconciliation.
   */
  private async resume(orderId: bigint, side: "buy" | "sell"): Promise<boolean> {
    const entry = this.d.journal.get(orderId);
    if (!entry) return false;
    if (entry.state === "swapped") {
      await this.fill(orderId, side, BigInt(entry.amountOut!), entry.signature!);
    } else if (entry.state === "swapping") {
      this.log(`order ${orderId}: swap outcome unknown, needs manual reconciliation`);
    }
    return true;
  }

  private async swap(orderId: bigint, side: "buy" | "sell", quote: Awaited<ReturnType<Vault["quote"]>>) {
    const { journal, gateway, vault } = this.d;
    journal.set(orderId, { side, state: "swapping" });
    try {
      const res = await vault.swap(quote);
      journal.set(orderId, { side, state: "swapped", signature: res.signature, amountOut: res.amountOut.toString() });
      return res;
    } catch (e) {
      if (e instanceof SwapFailed) {
        // Failed on-chain (e.g. slippage threshold hit): nothing moved, safe to refund.
        journal.done(orderId);
        await gateway.reject(orderId, "swap failed");
        return undefined;
      }
      throw e; // unknown outcome, journal stays "swapping"
    }
  }

  private async fill(orderId: bigint, side: "buy" | "sell", amountOut: bigint, sig: string) {
    const tx =
      side === "buy"
        ? await this.d.gateway.fulfillBuy(orderId, amountOut, sig)
        : await this.d.gateway.fulfillSell(orderId, amountOut, sig);
    this.d.journal.done(orderId);
    this.log(`order ${orderId} ${side} filled: ${amountOut} (solana ${sig}, evm ${tx})`);
  }
}
