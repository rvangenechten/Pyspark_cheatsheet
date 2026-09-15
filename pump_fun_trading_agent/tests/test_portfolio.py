import time

from pump_fun_trading_agent.config import Config
from pump_fun_trading_agent.models import SellAction
from pump_fun_trading_agent.portfolio import Portfolio


def make_config(tmp_path) -> Config:
    base = Config()
    return Config(**{
        **base.__dict__,
        "state_dir": str(tmp_path),
        "state_file": str(tmp_path / "portfolio.json"),
        "trades_log_file": str(tmp_path / "trades.jsonl"),
    })


def test_open_position_deducts_and_records(tmp_path):
    config = make_config(tmp_path)
    portfolio = Portfolio(config)

    position = portfolio.open_position(
        mint="MINT1", symbol="TEST", name="Test", is_technical=True,
        price_usd=1.0, usd_amount=100.0, created_at=time.time(),
    )

    assert position.tokens_remaining == 100.0
    assert portfolio.cash_usd_spent == 100.0
    assert portfolio.has_position("MINT1")


def test_apply_sell_reduces_position_and_closes_on_full_exit(tmp_path):
    config = make_config(tmp_path)
    portfolio = Portfolio(config)
    position = portfolio.open_position(
        mint="MINT1", symbol="TEST", name="Test", is_technical=True,
        price_usd=1.0, usd_amount=100.0, created_at=time.time(),
    )

    portfolio.apply_sell(position, SellAction(reason="test", fraction_of_remaining=0.5), 2.0)
    assert position.tokens_remaining == 50.0
    assert position.realized_pnl_usd == 50.0  # sold 50 tokens at +$1 profit each
    assert portfolio.has_position("MINT1")

    portfolio.apply_sell(position, SellAction(reason="test", fraction_of_remaining=1.0), 2.0)
    assert position.closed is True
    assert not portfolio.has_position("MINT1")
    assert portfolio in [portfolio]  # sanity
    assert position in portfolio.closed_positions


def test_state_persists_and_reloads(tmp_path):
    config = make_config(tmp_path)
    portfolio = Portfolio(config)
    portfolio.open_position(
        mint="MINT1", symbol="TEST", name="Test", is_technical=False,
        price_usd=2.0, usd_amount=25.0, created_at=time.time(),
    )

    reloaded = Portfolio(config)
    assert reloaded.has_position("MINT1")
    assert reloaded.positions["MINT1"].usd_invested == 25.0
    assert reloaded.cash_usd_spent == 25.0
