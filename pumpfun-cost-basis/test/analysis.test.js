// Run with: node --test test/
const test = require("node:test");
const assert = require("node:assert");
const { analyze, buildPositions } = require("../analysis.js");

// price in SOL per token -> raw trade fields
const trade = (user, isBuy, tokens, price, ts) => ({
  user, is_buy: isBuy, timestamp: ts,
  token_amount: tokens * 1e6, sol_amount: Math.round(tokens * price * 1e9),
});

test("average cost survives partial sells", () => {
  const { positions } = buildPositions([
    trade("A", true, 100, 1e-6, 1),
    trade("A", true, 100, 3e-6, 2),
    trade("A", false, 100, 5e-6, 3),
  ]);
  assert.strictEqual(positions.length, 1);
  assert.ok(Math.abs(positions[0].tokens - 100) < 1e-6);
  assert.ok(Math.abs(positions[0].avgCost - 2e-6) < 1e-12);
});

test("fully exited wallets and excess sells are dropped", () => {
  const { positions } = buildPositions([
    trade("A", true, 100, 1e-6, 1),
    trade("A", false, 150, 2e-6, 2),
  ]);
  assert.strictEqual(positions.length, 0);
});

test("profit / underwater shares and readout", () => {
  const trades = [
    trade("early1", true, 1000, 1e-7, 1),
    trade("early2", true, 1000, 1e-7, 2),
    trade("top", true, 100, 1e-5, 3),
    trade("x", true, 1, 4e-6, 4), // sets current price
  ];
  const { stats, readout, bins } = analyze(trades);
  assert.ok(stats.bigProfit > 0.9);
  assert.ok(stats.underwater > 0 && stats.underwater < 0.1);
  assert.ok(readout.some((n) => n.text.includes("2x")));
  assert.strictEqual(bins.reduce((s, b) => s + b.wallets, 0), 4);
});

test("excludeWallets removes the dev", () => {
  const trades = [trade("dev", true, 1000, 1e-7, 1), trade("b", true, 10, 1e-6, 2)];
  assert.strictEqual(analyze(trades, { excludeWallets: ["dev"] }).stats.holderCount, 1);
});
