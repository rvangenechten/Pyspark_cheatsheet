import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { Journal } from "../src/journal.js";
import type { Quote } from "../src/jupiter.js";
import { Processor, grossForNet, slippageFor, type Gateway, type OrderState } from "../src/processor.js";
import { SwapFailed, type SwapResult, type Vault } from "../src/vault.js";

const USDC = "USDC";
const BONK = "BONK";
const NOW = 1_000_000;

class FakeGateway implements Gateway {
  orders = new Map<bigint, OrderState>();
  mirrors = new Map<string, string>();
  calls: string[] = [];
  fee = 100;
  liquidity = 10n ** 12n;

  async getOrder(id: bigint) {
    return this.orders.get(id) ?? { status: 0, deadline: 0n, amountIn: 0n, minOut: 0n };
  }
  async mirrorOf(s: string) { return this.mirrors.get(s); }
  async feeBps() { return this.fee; }
  async availableLiquidity() { return this.liquidity; }
  async launch(s: string, name: string, symbol: string, decimals: number, logo: string) {
    this.calls.push(`launch ${s} ${name} ${symbol} ${decimals} ${logo}`);
    this.mirrors.set(s, "0xMIRROR");
    return "0xMIRROR";
  }
  private settle(id: bigint, status: number) {
    this.orders.set(id, { ...this.orders.get(id)!, status });
  }
  async fulfillBuy(id: bigint, out: bigint, sig: string) { this.calls.push(`fulfillBuy ${id} ${out} ${sig}`); this.settle(id, 2); return "0x"; }
  async fulfillSell(id: bigint, out: bigint, sig: string) { this.calls.push(`fulfillSell ${id} ${out} ${sig}`); this.settle(id, 2); return "0x"; }
  async reject(id: bigint, reason: string) { this.calls.push(`reject ${id} ${reason}`); this.settle(id, 3); return "0x"; }
}

class FakeVault implements Vault {
  /** price as output units per input unit, keyed by "in>out" */
  rate: Record<string, number> = { [`${USDC}>${BONK}`]: 50_000, [`${BONK}>${USDC}`]: 1 / 50_000 };
  quotes: { slippageBps: number }[] = [];
  swaps = 0;
  swapResult?: (q: Quote) => SwapResult | Error;

  async quote(inputMint: string, outputMint: string, amount: bigint, slippageBps: number): Promise<Quote> {
    this.quotes.push({ slippageBps });
    const out = BigInt(Math.floor(Number(amount) * this.rate[`${inputMint}>${outputMint}`]));
    const threshold = (out * BigInt(10_000 - slippageBps)) / 10_000n;
    return { inputMint, outputMint, inAmount: amount.toString(), outAmount: out.toString(), otherAmountThreshold: threshold.toString(), slippageBps, priceImpactPct: "0" };
  }
  async swap(q: Quote): Promise<SwapResult> {
    this.swaps++;
    const r = this.swapResult?.(q) ?? { signature: `sig${this.swaps}`, amountOut: BigInt(q.outAmount) };
    if (r instanceof Error) throw r;
    return r;
  }
  async balance() { return 0n; }
  async mintExists(m: string) { return m === BONK ? { decimals: 5 } : undefined; }
}

describe("slippage helpers", () => {
  it("slippageFor fits the threshold to minOut", () => {
    assert.equal(slippageFor(1000n, 990n, 300), 100);
    assert.equal(slippageFor(1000n, 0n, 300), 300);
    assert.equal(slippageFor(1000n, 1000n, 300), 0);
    assert.equal(slippageFor(999n, 1000n, 300), undefined);
  });

  it("grossForNet always leaves at least minNet after the fee", () => {
    assert.equal(grossForNet(99n, 100), 100n);
    for (const net of [1n, 100n, 12_345n, 10n ** 12n]) {
      const gross = grossForNet(net, 100);
      assert.ok(gross - (gross * 100n) / 10_000n >= net);
    }
  });
});

describe("Processor", () => {
  let gw: FakeGateway, vault: FakeVault, journal: Journal, p: Processor;

  beforeEach(() => {
    gw = new FakeGateway();
    vault = new FakeVault();
    journal = new Journal();
    p = new Processor({
      gateway: gw,
      vault,
      journal,
      tokenInfo: async (m) => (m === BONK ? { id: BONK, name: "Bonk", symbol: "Bonk", decimals: 5, icon: "https://x/bonk.png" } : undefined),
      usdcMint: USDC,
      maxSlippageBps: 300,
      minTimeLeftSec: 30,
      now: () => NOW,
      log: () => {},
    });
  });

  const pending = (amountIn: bigint, minOut: bigint, deadline = NOW + 600): OrderState => ({ status: 1, deadline: BigInt(deadline), amountIn, minOut });

  it("launches an exact copy of the source token", async () => {
    await p.handleLaunchRequest(BONK);
    assert.deepEqual(gw.calls, ["launch BONK Bonk Bonk 5 https://x/bonk.png"]);
    await p.handleLaunchRequest(BONK); // already launched
    await p.handleLaunchRequest("NOPE"); // not a mint
    assert.equal(gw.calls.length, 1);
  });

  it("buys into the vault and mints the actual amount received", async () => {
    gw.orders.set(1n, pending(1_000n, 49_000_000n));
    await p.handleBuy({ orderId: 1n, sourceToken: BONK });
    assert.deepEqual(gw.calls, ["fulfillBuy 1 50000000 sig1"]);
    assert.equal(vault.quotes.at(-1)!.slippageBps, 200); // (50M-49M)/50M
    assert.equal(journal.get(1n), undefined);
  });

  it("rejects when the price already moved past minOut", async () => {
    gw.orders.set(1n, pending(1_000n, 60_000_000n));
    await p.handleBuy({ orderId: 1n, sourceToken: BONK });
    assert.match(gw.calls[0], /^reject 1 price moved/);
    assert.equal(vault.swaps, 0);
  });

  it("rejects orders about to expire", async () => {
    gw.orders.set(1n, pending(1_000n, 1n, NOW + 10));
    await p.handleBuy({ orderId: 1n, sourceToken: BONK });
    assert.deepEqual(gw.calls, ["reject 1 too close to deadline"]);
  });

  it("ignores orders that are no longer pending", async () => {
    gw.orders.set(1n, { ...pending(1_000n, 1n), status: 3 });
    await p.handleBuy({ orderId: 1n, sourceToken: BONK });
    assert.deepEqual(gw.calls, []);
  });

  it("refunds when the swap fails on-chain", async () => {
    gw.orders.set(1n, pending(1_000n, 1n));
    vault.swapResult = () => new SwapFailed("badsig", "SlippageToleranceExceeded");
    await p.handleBuy({ orderId: 1n, sourceToken: BONK });
    assert.deepEqual(gw.calls, ["reject 1 swap failed"]);
  });

  it("never swaps twice: resumes a landed swap, halts on unknown outcome", async () => {
    gw.orders.set(1n, pending(1_000n, 1n));
    vault.swapResult = () => new Error("RPC timeout");
    await assert.rejects(p.handleBuy({ orderId: 1n, sourceToken: BONK }));
    assert.equal(journal.get(1n)?.state, "swapping");
    await p.handleBuy({ orderId: 1n, sourceToken: BONK });
    assert.equal(vault.swaps, 1);
    assert.deepEqual(gw.calls, []);

    journal.set(1n, { side: "buy", state: "swapped", signature: "landed", amountOut: "123" });
    await p.handleBuy({ orderId: 1n, sourceToken: BONK });
    assert.equal(vault.swaps, 1);
    assert.deepEqual(gw.calls, ["fulfillBuy 1 123 landed"]);
  });

  it("sells from the vault and pays the gross USDC received", async () => {
    gw.orders.set(2n, pending(50_000_000n, 950n));
    await p.handleSell({ orderId: 2n, sourceToken: BONK });
    assert.deepEqual(gw.calls, ["fulfillSell 2 1000 sig1"]);
    // minGross = ceil(950 / 0.99) = 960 -> slippage (1000-960)/1000 = 400bps capped at 300
    assert.equal(vault.quotes.at(-1)!.slippageBps, 300);
  });

  it("rejects sells the gateway can't pay out", async () => {
    gw.orders.set(2n, pending(50_000_000n, 1n));
    gw.liquidity = 10n;
    await p.handleSell({ orderId: 2n, sourceToken: BONK });
    assert.deepEqual(gw.calls, ["reject 2 insufficient payout liquidity"]);
  });

  it("rejects sells whose net after fee is below minOut", async () => {
    gw.orders.set(2n, pending(50_000_000n, 995n)); // needs gross 1006 > 1000
    await p.handleSell({ orderId: 2n, sourceToken: BONK });
    assert.match(gw.calls[0], /^reject 2 price moved/);
  });
});
