// Pure analysis functions: turn a trade list into a cost-basis map of the
// tokens that are still held. No DOM or chrome APIs here so it can be tested
// in Node (see test/analysis.test.js).

(function (root) {
  const LAMPORTS_PER_SOL = 1e9;
  const TOKEN_DECIMALS = 1e6;
  const DEFAULT_SUPPLY = 1e9; // pump.fun tokens have a fixed 1B supply

  function normalizeTrade(t) {
    const sol = Number(t.sol_amount) / LAMPORTS_PER_SOL;
    const tokens = Number(t.token_amount) / TOKEN_DECIMALS;
    if (!(sol > 0) || !(tokens > 0) || !t.user) return null;
    return {
      user: t.user,
      isBuy: t.is_buy === true || t.is_buy === "true",
      sol,
      tokens,
      price: sol / tokens,
      ts: Number(t.timestamp) || 0,
      slot: Number(t.slot) || 0,
    };
  }

  // Average-cost accounting per wallet. A sell removes tokens at the wallet's
  // current average cost; tokens sold beyond what the wallet bought (received
  // by transfer) are ignored because we don't know their cost.
  function buildPositions(trades) {
    const sorted = trades
      .map(normalizeTrade)
      .filter(Boolean)
      .sort((a, b) => a.ts - b.ts || a.slot - b.slot);

    const wallets = new Map();
    for (const t of sorted) {
      let w = wallets.get(t.user);
      if (!w) wallets.set(t.user, (w = { user: t.user, held: 0, cost: 0, bought: 0, sold: 0 }));
      if (t.isBuy) {
        w.held += t.tokens;
        w.cost += t.sol;
        w.bought += t.tokens;
      } else {
        const qty = Math.min(t.tokens, w.held);
        if (qty > 0) {
          w.cost -= w.cost * (qty / w.held);
          w.held -= qty;
        }
        w.sold += t.tokens;
      }
    }

    const positions = [];
    for (const w of wallets.values()) {
      if (w.held > 1e-6) positions.push({ user: w.user, tokens: w.held, avgCost: w.cost / w.held });
    }
    const lastPrice = sorted.length ? sorted[sorted.length - 1].price : null;
    return { positions, sorted, lastPrice, walletCount: wallets.size };
  }

  // Log-spaced price bins, since pump.fun prices span orders of magnitude.
  function binPositions(positions, currentPrice, binCount = 28) {
    const prices = positions.map((p) => p.avgCost);
    if (currentPrice) prices.push(currentPrice);
    if (!prices.length) return [];
    let lo = Math.log10(Math.min(...prices));
    let hi = Math.log10(Math.max(...prices));
    if (hi - lo < 1e-9) {
      lo -= 0.5;
      hi += 0.5;
    }
    const step = (hi - lo) / binCount;
    const bins = Array.from({ length: binCount }, (_, i) => ({
      low: 10 ** (lo + i * step),
      high: 10 ** (lo + (i + 1) * step),
      tokens: 0,
      wallets: 0,
    }));
    for (const p of positions) {
      const i = Math.min(binCount - 1, Math.floor((Math.log10(p.avgCost) - lo) / step));
      bins[i].tokens += p.tokens;
      bins[i].wallets += 1;
    }
    return bins;
  }

  function analyze(rawTrades, opts = {}) {
    const { positions, sorted, lastPrice, walletCount } = buildPositions(rawTrades);
    const currentPrice = opts.currentPrice || lastPrice;
    const supply = opts.totalSupply || DEFAULT_SUPPLY;
    const excluded = new Set(opts.excludeWallets || []);
    const holders = positions.filter((p) => !excluded.has(p.user));

    const held = holders.reduce((s, p) => s + p.tokens, 0);
    const share = (pred) => (held ? holders.filter(pred).reduce((s, p) => s + p.tokens, 0) / held : 0);
    const mult = (p) => currentPrice / p.avgCost;

    const avgCost = held ? holders.reduce((s, p) => s + p.tokens * p.avgCost, 0) / held : null;
    const bins = binPositions(holders, currentPrice, opts.binCount);
    const poc = bins.reduce((best, b) => (b.tokens > (best?.tokens || 0) ? b : best), null);

    // Underwater supply sitting just above price: those holders tend to sell
    // when they get back to break-even, so it acts as resistance.
    const overheadBins = bins.filter((b) => b.low > currentPrice);
    const resistance = overheadBins.reduce((best, b) => (b.tokens > (best?.tokens || 0) ? b : best), null);

    const top10 = [...holders].sort((a, b) => b.tokens - a.tokens).slice(0, 10);
    const top10Share = held ? top10.reduce((s, p) => s + p.tokens, 0) / held : 0;

    const stats = {
      tradeCount: sorted.length,
      walletCount,
      holderCount: holders.length,
      heldTokens: held,
      heldPctOfSupply: held / supply,
      currentPrice,
      avgCost,
      avgMultiple: avgCost ? currentPrice / avgCost : null,
      inProfit: share((p) => mult(p) > 1),
      bigProfit: share((p) => mult(p) >= 2),
      nearBreakEven: share((p) => mult(p) > 0.8 && mult(p) < 1.25),
      underwater: share((p) => mult(p) < 1),
      deepUnderwater: share((p) => mult(p) < 0.5),
      top10Share,
      poc,
      resistance,
    };
    return { stats, bins, positions: holders, readout: readout(stats) };
  }

  // Plain-language observations. These describe positioning; they are not a
  // price prediction.
  function readout(s) {
    const notes = [];
    const pct = (x) => `${Math.round(x * 100)}%`;
    if (!s.holderCount) return [{ tone: "neutral", text: "No open positions found in the trade history." }];

    if (s.bigProfit >= 0.5) {
      notes.push({ tone: "bear", text: `${pct(s.bigProfit)} of tracked supply is up 2x or more. Lots of holders could take profit, so expect sell pressure on pumps.` });
    } else if (s.inProfit >= 0.7) {
      notes.push({ tone: "bear", text: `${pct(s.inProfit)} of tracked supply is in profit. There's some take-profit risk.` });
    }
    if (s.underwater >= 0.6) {
      notes.push({ tone: "bull", text: `${pct(s.underwater)} of supply is underwater. Those holders have little reason to sell here, so selling pressure at this price is lower.` });
    }
    if (s.resistance && s.resistance.tokens / s.heldTokens >= 0.1) {
      notes.push({ tone: "bear", text: `Large underwater cluster just above price (${pct(s.resistance.tokens / s.heldTokens)} of supply). Expect break-even sellers if price returns there.` });
    }
    if (s.nearBreakEven >= 0.4) {
      notes.push({ tone: "neutral", text: `${pct(s.nearBreakEven)} of supply bought close to the current price. Holders are near break-even, so a small move either way can trigger a lot of selling.` });
    }
    if (s.top10Share >= 0.5) {
      notes.push({ tone: "bear", text: `Top 10 wallets hold ${pct(s.top10Share)} of tracked supply. A few wallets can move the price a lot.` });
    }
    if (!notes.length) notes.push({ tone: "neutral", text: "Cost basis is spread out, with no strong cluster in either direction." });
    return notes;
  }

  const api = { analyze, buildPositions, binPositions, normalizeTrade, DEFAULT_SUPPLY };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PFAnalysis = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
