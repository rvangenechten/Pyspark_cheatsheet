"""Buy and sell decision logic.

Buy rule
--------
Every freshly-created token seen on the feed is bought:
  - $100 if it looks like a *technical* project AND was caught fresh
    (within ``fresh_max_age_seconds`` of creation) AND its market cap is
    still under ``mcap_threshold_usd``.
  - $25 otherwise.

Sell rule
---------
Evaluated on every price tick for each open position, in priority order:
  1. Breakeven exit: once the position has been meaningfully in profit,
     a pullback to (or below) the entry price sells the entire remaining
     position ("sell all when price reaches again same price").
  2. Recoup initial capital: the first time price reaches 2x entry, sell
     exactly enough tokens to recover the original USD invested ("take
     initial when doubled"), letting the remainder ride for free.
  3. Profit-taking ladder: at each configured multiple above entry, trim a
     fixed fraction of whatever remains ("take some profits" on the way up).
"""
from __future__ import annotations

from typing import List

from .config import Config
from .models import Position, SellAction


def evaluate_buy(
    *,
    created_at: float,
    now: float,
    mcap_usd: float,
    is_technical: bool,
    config: Config,
) -> float:
    """Return the USD size to buy for a newly observed token.

    Always returns a positive amount: every tracked new token is bought,
    sized down unless it qualifies for the larger "technical + fresh +
    under mcap threshold" tier.
    """
    age_seconds = now - created_at
    is_fresh = 0 <= age_seconds <= config.fresh_max_age_seconds
    is_under_mcap = mcap_usd < config.mcap_threshold_usd

    if is_technical and is_fresh and is_under_mcap:
        return config.buy_usd_technical
    return config.buy_usd_default


def evaluate_sell_actions(
    position: Position, current_price_usd: float, config: Config
) -> List[SellAction]:
    """Return the sells to execute for ``position`` at ``current_price_usd``.

    Mutates the position's bookkeeping fields (peak price, profitability
    flag, ladder rungs already hit, recoup flag) as a side effect so repeat
    calls on the same price tick are idempotent.
    """
    actions: List[SellAction] = []
    if current_price_usd <= 0 or position.tokens_remaining <= config.dust_token_threshold:
        return actions

    position.peak_price_usd = max(position.peak_price_usd, current_price_usd)
    if position.peak_price_usd >= position.entry_price_usd * config.breakeven_arm_multiple:
        position.been_profitable = True

    # 1. Breakeven stop -- exits fully, nothing else to evaluate.
    if (
        config.breakeven_exit_enabled
        and position.been_profitable
        and current_price_usd <= position.entry_price_usd
    ):
        actions.append(SellAction(reason="breakeven_exit", fraction_of_remaining=1.0))
        return actions

    simulated_remaining = position.tokens_remaining

    # 2. Recoup initial capital once price has (at least) doubled.
    if (
        not position.recouped
        and current_price_usd >= position.entry_price_usd * config.recoup_multiple
    ):
        position.recouped = True
        outstanding_usd = max(position.usd_invested - position.usd_recovered, 0.0)
        tokens_needed = outstanding_usd / current_price_usd
        fraction = 0.0
        if simulated_remaining > 0:
            fraction = min(1.0, tokens_needed / simulated_remaining)
        if fraction > 0:
            actions.append(SellAction(
                reason=f"recoup_initial_{config.recoup_multiple:g}x",
                fraction_of_remaining=fraction,
            ))
            simulated_remaining *= (1 - fraction)

    # 3. Profit-taking ladder for additional upside.
    for rung in sorted(config.profit_take_ladder):
        if rung in position.ladder_hits:
            continue
        if current_price_usd < position.entry_price_usd * rung:
            continue
        position.ladder_hits.add(rung)
        if simulated_remaining <= config.dust_token_threshold:
            continue
        actions.append(SellAction(
            reason=f"profit_ladder_{rung:g}x",
            fraction_of_remaining=config.profit_take_fraction,
        ))
        simulated_remaining *= (1 - config.profit_take_fraction)

    return actions
