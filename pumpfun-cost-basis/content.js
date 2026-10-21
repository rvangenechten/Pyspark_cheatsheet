// Injects the cost-basis panel on pump.fun coin pages.

(() => {
  const REFRESH_MS = 60_000;
  const COLORS = { profit: "#22c55e", loss: "#ef4444", mixed: "#f59e0b", price: "#60a5fa" };

  let currentMint = null;
  let lastResult = null;
  let refreshTimer = null;
  let panel = null;
  let excludeDev = false;

  function mintFromUrl() {
    const m = location.pathname.match(/^\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
    return m ? m[1] : null;
  }

  function compact(n) {
    if (n == null || !isFinite(n)) return "–";
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
    if (abs >= 1) return n.toFixed(2);
    return n.toPrecision(3);
  }

  const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);

  // Prices are shown as the market cap they correspond to, which is how
  // pump.fun traders usually talk about levels.
  function fmtLevel(price) {
    if (!lastResult) return "–";
    const { supply, solUsd } = lastResult;
    const mcapSol = price * supply;
    return solUsd ? `$${compact(mcapSol * solUsd)}` : `${compact(mcapSol)} SOL`;
  }

  function buildPanel() {
    const el = document.createElement("div");
    el.id = "pfcb-panel";
    el.innerHTML = `
      <div class="pfcb-head">
        <span class="pfcb-title">Holder cost basis</span>
        <button class="pfcb-btn" data-act="refresh" title="Refresh">↻</button>
        <button class="pfcb-btn" data-act="toggle" title="Collapse">–</button>
      </div>
      <div class="pfcb-body">
        <div class="pfcb-status">Loading trades…</div>
        <div class="pfcb-stats"></div>
        <div class="pfcb-chart-wrap">
          <canvas class="pfcb-chart" width="320" height="300"></canvas>
          <div class="pfcb-tip" hidden></div>
        </div>
        <div class="pfcb-legend">
          <span><i style="background:${COLORS.profit}"></i>in profit</span>
          <span><i style="background:${COLORS.loss}"></i>underwater</span>
          <span><i style="background:${COLORS.price}"></i>current price</span>
        </div>
        <label class="pfcb-opt"><input type="checkbox" data-act="dev"> Exclude dev wallet</label>
        <ul class="pfcb-readout"></ul>
        <div class="pfcb-foot">Estimated from on-curve trades only. Tokens moved between wallets aren't tracked. This shows how holders are positioned. It can't tell you where the price will go.</div>
      </div>`;
    el.addEventListener("click", (e) => {
      const act = e.target?.dataset?.act;
      if (act === "refresh") load(true);
      if (act === "toggle") {
        el.classList.toggle("pfcb-collapsed");
        e.target.textContent = el.classList.contains("pfcb-collapsed") ? "+" : "–";
      }
    });
    el.querySelector('[data-act="dev"]').addEventListener("change", (e) => {
      excludeDev = e.target.checked;
      render();
    });
    const canvas = el.querySelector("canvas");
    canvas.addEventListener("mousemove", onHover);
    canvas.addEventListener("mouseleave", () => (el.querySelector(".pfcb-tip").hidden = true));
    document.body.appendChild(el);
    return el;
  }

  function setStatus(text) {
    const s = panel.querySelector(".pfcb-status");
    s.textContent = text || "";
    s.hidden = !text;
  }

  async function load(manual = false) {
    const mint = currentMint;
    if (!mint) return;
    if (manual || !lastResult) setStatus("Loading trades…");
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "pfcb:load", mint });
    } catch (err) {
      res = { ok: false, error: String(err?.message || err) };
    }
    if (mint !== currentMint) return; // user navigated away mid-request
    if (!res?.ok) {
      setStatus(`Couldn't load trades: ${res?.error || "unknown error"}`);
      return;
    }
    const coin = res.coin || {};
    const supply = coin.total_supply ? Number(coin.total_supply) / 1e6 : PFAnalysis.DEFAULT_SUPPLY;
    const solUsd = coin.usd_market_cap && coin.market_cap ? coin.usd_market_cap / coin.market_cap : null;
    lastResult = { trades: res.trades, truncated: res.truncated, coin, supply, solUsd };
    setStatus(res.truncated ? `Showing the most recent ${res.trades.length} trades. Raise the limit in Options for full history.` : "");
    render();
  }

  function render() {
    if (!lastResult) return;
    const { trades, coin, supply } = lastResult;
    const result = PFAnalysis.analyze(trades, {
      totalSupply: supply,
      excludeWallets: excludeDev && coin.creator ? [coin.creator] : [],
    });
    lastResult.analysis = result;
    const s = result.stats;

    panel.querySelector(".pfcb-stats").innerHTML = [
      ["Current MC", fmtLevel(s.currentPrice)],
      ["Avg holder entry", s.avgCost ? fmtLevel(s.avgCost) : "–"],
      ["In profit", pct(s.inProfit)],
      ["Up ≥2x", pct(s.bigProfit)],
      ["Underwater", pct(s.underwater)],
      ["Top-10 share", pct(s.top10Share)],
      ["Holders", s.holderCount],
      ["Trades", s.tradeCount],
    ]
      .map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`)
      .join("");

    panel.querySelector(".pfcb-readout").innerHTML = result.readout
      .map((n) => `<li class="pfcb-${n.tone}">${n.text}</li>`)
      .join("");

    drawChart(result.bins, s.currentPrice);
  }

  function chartLayout(canvas, bins) {
    const pad = { l: 64, r: 8, t: 6, b: 6 };
    const rowH = (canvas.height - pad.t - pad.b) / Math.max(bins.length, 1);
    return { pad, rowH, w: canvas.width - pad.l - pad.r };
  }

  function drawChart(bins, price) {
    const canvas = panel.querySelector("canvas");
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!bins.length) return;
    const { pad, rowH, w } = chartLayout(canvas, bins);
    const max = Math.max(...bins.map((b) => b.tokens), 1);
    ctx.font = "10px ui-monospace, monospace";
    ctx.textBaseline = "middle";

    // Highest price at the top, like a price chart.
    bins.forEach((b, i) => {
      const y = pad.t + (bins.length - 1 - i) * rowH;
      const color = b.high <= price ? COLORS.profit : b.low > price ? COLORS.loss : COLORS.mixed;
      ctx.fillStyle = color;
      ctx.fillRect(pad.l, y + 1, (b.tokens / max) * w, Math.max(rowH - 2, 1));
      if (i % 3 === 0) {
        ctx.fillStyle = "#9ca3af";
        ctx.textAlign = "right";
        ctx.fillText(fmtLevel(Math.sqrt(b.low * b.high)), pad.l - 6, y + rowH / 2);
      }
    });

    const lo = Math.log10(bins[0].low);
    const hi = Math.log10(bins[bins.length - 1].high);
    const frac = (Math.log10(price) - lo) / (hi - lo);
    const py = pad.t + (1 - frac) * (canvas.height - pad.t - pad.b);
    ctx.strokeStyle = COLORS.price;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(pad.l, py);
    ctx.lineTo(canvas.width - pad.r, py);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function onHover(e) {
    const bins = lastResult?.analysis?.bins;
    const tip = panel.querySelector(".pfcb-tip");
    if (!bins?.length) return;
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
    const { pad, rowH } = chartLayout(canvas, bins);
    const row = Math.floor((y - pad.t) / rowH);
    const b = bins[bins.length - 1 - row];
    if (!b) return (tip.hidden = true);
    const held = lastResult.analysis.stats.heldTokens || 1;
    tip.hidden = false;
    tip.style.top = `${e.clientY - rect.top + 10}px`;
    tip.textContent = `${fmtLevel(b.low)} – ${fmtLevel(b.high)}: ${pct(b.tokens / held)} of supply, ${b.wallets} wallets`;
  }

  function onRoute() {
    const mint = mintFromUrl();
    if (mint === currentMint) return;
    currentMint = mint;
    lastResult = null;
    clearInterval(refreshTimer);
    if (!mint) {
      panel?.remove();
      panel = null;
      return;
    }
    if (!panel) panel = buildPanel();
    panel.querySelector(".pfcb-stats").innerHTML = "";
    panel.querySelector(".pfcb-readout").innerHTML = "";
    load();
    refreshTimer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, REFRESH_MS);
  }

  // pump.fun is a single-page app, so watch for client-side navigation.
  onRoute();
  setInterval(onRoute, 1000);
})();
