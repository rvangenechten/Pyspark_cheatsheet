import type { Vault } from "./vault.js";
import { SwapFailed, type SwapResult } from "./vault.js";
import type { TokenInfo } from "./jupiter.js";
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
  /** Largest gross USDC sell payout the gateway can settle now (liquidity and daily cap). */
  sellHeadroom(): Promise<bigint>;
  launch(sourceToken: string, name: string, symbol: string, decimals: number, logoURI: string): Promise<string>;
  fulfillBuy(id: bigint, tokensOut: bigint, solanaTx: string): Promise<string>;
  fulfillSell(id: bigint, grossQuoteOut: bigint, solanaTx: string): Promise<string>;
  reject(id: bigint, reason: string): Promise<string>;
}

export interface ProcessorDeps {
  gateway: Gateway;
  vault: Vault;
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

    // Vault account first, so the mirror is never tradable without one.
    await vault.registerAsset(sourceToken);
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

    const res = await this.swap(orderId, quote);
    if (!res) return;
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
    if ((await gateway.sellHeadroom()) < BigInt(first.outAmount)) {
      await gateway.reject(orderId, "insufficient payout liquidity");
      return;
    }
    const quote = await vault.quote(sourceToken, usdcMint, order.amountIn, slip);

    const res = await this.swap(orderId, quote);
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
   * Crash safety. The vault program writes one receipt per order and refuses
   * a second swap for it, so the receipt is the source of truth: if it exists
   * the swap happened and we only need to finish the fill.
   */
  private async resume(orderId: bigint, side: "buy" | "sell"): Promise<boolean> {
    const done = await this.d.vault.receipt(orderId);
    if (!done) return false;
    await this.settle(orderId, side, done);
    return true;
  }

  private async swap(orderId: bigint, quote: Awaited<ReturnType<Vault["quote"]>>) {
    const { gateway, vault } = this.d;
    try {
      return await vault.swap(orderId, quote);
    } catch (e) {
      // A retry of an earlier, slow transaction can fail because the first one
      // landed. Check the receipt before deciding nothing happened.
      const landed = await vault.receipt(orderId).catch(() => undefined);
      if (landed) return landed;
      if (e instanceof SwapFailed) {
        // Failed on-chain (e.g. slippage threshold hit): nothing moved, safe to refund.
        await gateway.reject(orderId, "swap failed");
        return undefined;
      }
      throw e; // outcome unknown; the retry re-checks the receipt first
    }
  }

  /** Fill from a receipt; min-out was enforced on-chain by the vault program. */
  private async settle(orderId: bigint, side: "buy" | "sell", r: SwapResult) {
    const order = await this.d.gateway.getOrder(orderId);
    if (order.status !== OrderStatus.Pending) return;
    await this.fill(orderId, side, r.amountOut, r.signature);
  }

  private async fill(orderId: bigint, side: "buy" | "sell", amountOut: bigint, sig: string) {
    const tx =
      side === "buy"
        ? await this.d.gateway.fulfillBuy(orderId, amountOut, sig)
        : await this.d.gateway.fulfillSell(orderId, amountOut, sig);
    this.log(`order ${orderId} ${side} filled: ${amountOut} (solana ${sig}, evm ${tx})`);
  }
}
