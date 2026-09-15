import time

from pump_fun_trading_agent.config import Config
from pump_fun_trading_agent.models import Position
from pump_fun_trading_agent.strategy import evaluate_buy, evaluate_sell_actions


def make_config(**overrides) -> Config:
    base = Config()
    return Config(**{**base.__dict__, **overrides})


def make_position(entry_price_usd: float = 1.0, tokens: float = 100.0, **overrides) -> Position:
    defaults = dict(
        mint="MINT1",
        symbol="TEST",
        name="Test Token",
        is_technical=True,
        entry_price_usd=entry_price_usd,
        tokens_remaining=tokens,
        initial_tokens=tokens,
        usd_invested=entry_price_usd * tokens,
        created_at=time.time(),
    )
    defaults.update(overrides)
    return Position(**defaults)


# -- evaluate_buy -------------------------------------------------------------


def test_buy_full_size_when_technical_fresh_and_under_mcap():
    config = make_config()
    now = time.time()
    amount = evaluate_buy(
        created_at=now, now=now, mcap_usd=5_000.0, is_technical=True, config=config,
    )
    assert amount == config.buy_usd_technical


def test_buy_default_size_when_not_technical():
    config = make_config()
    now = time.time()
    amount = evaluate_buy(
        created_at=now, now=now, mcap_usd=5_000.0, is_technical=False, config=config,
    )
    assert amount == config.buy_usd_default


def test_buy_default_size_when_over_mcap_threshold():
    config = make_config()
    now = time.time()
    amount = evaluate_buy(
        created_at=now, now=now, mcap_usd=50_000.0, is_technical=True, config=config,
    )
    assert amount == config.buy_usd_default


def test_buy_default_size_when_stale():
    config = make_config(fresh_max_age_seconds=60)
    now = time.time()
    created_at = now - 600  # 10 minutes old
    amount = evaluate_buy(
        created_at=created_at, now=now, mcap_usd=5_000.0, is_technical=True, config=config,
    )
    assert amount == config.buy_usd_default


# -- evaluate_sell_actions: profit ladder --------------------------------------


def test_ladder_rung_triggers_partial_sell_once():
    config = make_config(profit_take_ladder=[1.5], profit_take_fraction=0.2)
    position = make_position(entry_price_usd=1.0, tokens=100.0)

    actions = evaluate_sell_actions(position, 1.6, config)
    assert len(actions) == 1
    assert actions[0].reason == "profit_ladder_1.5x"
    assert actions[0].fraction_of_remaining == 0.2
    assert 1.5 in position.ladder_hits

    # Same rung must not fire twice.
    actions_again = evaluate_sell_actions(position, 1.7, config)
    assert actions_again == []


def test_multiple_ladder_rungs_fire_in_one_tick_if_price_jumps():
    config = make_config(profit_take_ladder=[1.5, 3.0], profit_take_fraction=0.2, recoup_multiple=100.0)
    position = make_position(entry_price_usd=1.0, tokens=100.0)

    actions = evaluate_sell_actions(position, 4.0, config)
    reasons = {a.reason for a in actions}
    assert reasons == {"profit_ladder_1.5x", "profit_ladder_3x"}


# -- evaluate_sell_actions: recoup initial capital at 2x -----------------------


def test_recoup_sells_enough_to_recover_initial_investment():
    config = make_config(recoup_multiple=2.0, profit_take_ladder=[])
    position = make_position(entry_price_usd=1.0, tokens=100.0)  # $100 invested

    actions = evaluate_sell_actions(position, 2.0, config)
    assert len(actions) == 1
    action = actions[0]
    assert action.reason.startswith("recoup_initial")

    tokens_sold = position.tokens_remaining * action.fraction_of_remaining
    proceeds = tokens_sold * 2.0
    assert proceeds == 100.0  # recovers exactly the $100 invested
    assert position.recouped is True


def test_recoup_only_triggers_once():
    config = make_config(recoup_multiple=2.0, profit_take_ladder=[])
    position = make_position(entry_price_usd=1.0, tokens=100.0)

    evaluate_sell_actions(position, 2.0, config)
    actions_again = evaluate_sell_actions(position, 2.5, config)
    assert all(not a.reason.startswith("recoup_initial") for a in actions_again)


# -- evaluate_sell_actions: breakeven exit -------------------------------------


def test_breakeven_exit_sells_all_after_being_profitable():
    config = make_config(breakeven_arm_multiple=1.1)
    position = make_position(entry_price_usd=1.0, tokens=100.0)

    # Rise well above entry to arm the breakeven stop.
    evaluate_sell_actions(position, 1.5, config)
    assert position.been_profitable is True

    # Fall back to entry price -> full exit.
    actions = evaluate_sell_actions(position, 1.0, config)
    assert len(actions) == 1
    assert actions[0].reason == "breakeven_exit"
    assert actions[0].fraction_of_remaining == 1.0


def test_no_breakeven_exit_if_never_profitable():
    config = make_config(breakeven_arm_multiple=1.1)
    position = make_position(entry_price_usd=1.0, tokens=100.0)

    # Price dips without ever having armed the breakeven stop.
    actions = evaluate_sell_actions(position, 0.9, config)
    assert actions == []


def test_no_actions_for_dust_position():
    config = make_config()
    position = make_position(entry_price_usd=1.0, tokens=0.0)
    actions = evaluate_sell_actions(position, 5.0, config)
    assert actions == []
