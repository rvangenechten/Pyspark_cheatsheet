// Fetches trade history from the pump.fun API. Runs in the service worker so
// requests aren't blocked by the page's CORS policy.

const DEFAULTS = {
  apiBase: "https://frontend-api-v3.pump.fun",
  maxTrades: 10000,
};

const PAGE_SIZE = 200;

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchTrades(mint, apiBase, maxTrades) {
  const trades = [];
  const seen = new Set();
  for (let offset = 0; offset < maxTrades; offset += PAGE_SIZE) {
    const url = `${apiBase}/trades/all/${mint}?limit=${PAGE_SIZE}&offset=${offset}&minimumSize=0`;
    const page = await fetchJson(url);
    const rows = Array.isArray(page) ? page : page.trades || [];
    if (rows.length === 0) break;
    for (const t of rows) {
      const key = t.signature || `${t.user}-${t.timestamp}-${t.token_amount}`;
      if (seen.has(key)) continue;
      seen.add(key);
      trades.push(t);
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return { trades, truncated: trades.length >= maxTrades };
}

async function fetchCoin(mint, apiBase) {
  try {
    return await fetchJson(`${apiBase}/coins/${mint}`);
  } catch {
    return null; // coin metadata is optional
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "pfcb:load") return false;
  (async () => {
    try {
      const { apiBase, maxTrades } = await getSettings();
      const [{ trades, truncated }, coin] = await Promise.all([
        fetchTrades(msg.mint, apiBase, maxTrades),
        fetchCoin(msg.mint, apiBase),
      ]);
      sendResponse({ ok: true, trades, truncated, coin });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();
  return true; // keep the channel open for the async response
});
