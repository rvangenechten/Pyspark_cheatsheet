# pump.fun Paper-Trading Agent

A **paper-trading** (simulation only — no real wallet, no real funds)
agent that watches pump.fun's live token-creation feed and trades a virtual
portfolio according to a fixed sizing and exit strategy.

> ⚠️ This is not financial advice. Meme-coin / pump.fun trading is
> extremely high risk; most new tokens go to zero. This tool trades a
> simulated portfolio only. Wiring it to a real wallet would require
> substantial additional safety work (slippage limits, rug-pull detection,
> transaction signing, key management) that is intentionally **not**
> included here.

## Strategy

**Entry (on every new token seen):**

| Condition | Buy size |
|---|---|
| Technical project **and** caught fresh **and** market cap under $10,000 | **$100** |
| Anything else | **$25** |

- *Fresh* = observed within `fresh_max_age_seconds` (default 300s) of the
  token's creation event.
- *Technical project* is a best-effort heuristic: the agent looks at the
  token's website and Twitter/X link (from its metadata) and scores the
  fetched text against a list of technical keywords (protocol, SDK, API,
  on-chain, agent framework, open-source, github, etc.). A token with
  neither a website nor a Twitter link is treated as non-technical. See
  `classifier.py` to tune the keyword list.

**Exit (evaluated on every price tick, in priority order):**

1. **Breakeven stop** — once a position has meaningfully gone into profit,
   if the price falls back to (or below) the entry price, sell the entire
   remaining position. ("sell all when price reaches again same price")
2. **Recoup initial capital** — the first time price reaches 2x the entry
   price, sell exactly enough tokens to recover the original USD invested,
   letting the rest of the position ride for free. ("take initial when
   doubled")
3. **Profit ladder** — at each configured multiple above entry (default
   1.5x, 3x, 5x, 10x, 20x), trim a fixed fraction (default 20%) of
   whatever remains. ("take some profits" as price rises)

All thresholds live in `config.py`.

## Data source

Live token-creation and trade data comes from
[PumpPortal](https://pumpportal.fun)'s free, no-API-key WebSocket feed
(`wss://pumpportal.fun/api/data`). The agent only *subscribes* to data — it
never sends a trade/signing request. SOL/USD conversion uses CoinGecko's
public price API, polled once a minute with a cached fallback.

## Running

```bash
cd pump_fun_trading_agent
pip install -r requirements.txt
python -m pump_fun_trading_agent
```

Portfolio state is persisted to `state/portfolio.json` after every trade,
and every buy/sell is appended to `state/trades.jsonl`. Restarting the
agent resumes any open positions and running P&L from where it left off.
Stop with Ctrl+C.

## Tests

```bash
pip install -r requirements-dev.txt
pytest pump_fun_trading_agent
```

Tests cover the buy-sizing rule and all three sell rules (ladder, recoup,
breakeven) deterministically, plus the classifier's keyword scoring and
the portfolio's persistence — none of them touch the network.

## Layout

- `config.py` — all tunable thresholds
- `models.py` — `Position` / `Trade` / `SellAction` data models
- `classifier.py` — technical-project heuristic (website + Twitter text)
- `strategy.py` — pure buy/sell decision functions
- `portfolio.py` — paper-trading ledger with JSON persistence
- `sol_price.py` — background SOL/USD price poller
- `pumpportal_client.py` — resilient PumpPortal WebSocket subscriber
- `agent.py` — orchestrator wiring the above together
- `__main__.py` — CLI entry point
