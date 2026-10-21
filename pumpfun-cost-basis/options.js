const DEFAULTS = { apiBase: "https://frontend-api-v3.pump.fun", maxTrades: 10000 };

chrome.storage.sync.get(DEFAULTS, (s) => {
  document.getElementById("apiBase").value = s.apiBase;
  document.getElementById("maxTrades").value = s.maxTrades;
});

document.getElementById("save").addEventListener("click", () => {
  const apiBase = document.getElementById("apiBase").value.trim().replace(/\/+$/, "") || DEFAULTS.apiBase;
  const maxTrades = Math.max(200, Number(document.getElementById("maxTrades").value) || DEFAULTS.maxTrades);
  chrome.storage.sync.set({ apiBase, maxTrades }, () => {
    document.getElementById("msg").textContent = "Saved.";
  });
});
