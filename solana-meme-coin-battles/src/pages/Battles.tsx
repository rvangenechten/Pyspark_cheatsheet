import { useEffect, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { FAMOUS_COINS, MODES, coinById, modeById, type ModeId } from '../lib/coins'
import { usePrices, priceFor } from '../lib/prices'
import { useLocalStorage } from '../lib/storage'
import { balanceOf, deposit, withdraw, type VaultState } from '../lib/vault'
import {
  createBattle,
  derivedStatus,
  joinBattle,
  settleBattle,
  pctChange,
  type Battle,
} from '../lib/battles'
import { signDemoAction } from '../lib/tx'
import { WalletGate } from '../components/WalletGate'
import { CoinTag } from '../components/CoinTag'
import { ModePicker } from '../components/ModePicker'
import { Countdown } from '../components/Countdown'

function CreateBattleForm({
  wallet,
  vault,
  setVault,
  addBattle,
}: {
  wallet: string
  vault: VaultState
  setVault: (u: VaultState | ((p: VaultState) => VaultState)) => void
  addBattle: (b: Battle) => void
}) {
  const { connection } = useConnection()
  const walletCtx = useWallet()
  const [coinA, setCoinA] = useState(FAMOUS_COINS[0].id)
  const [coinB, setCoinB] = useState(FAMOUS_COINS[1].id)
  const [mode, setMode] = useState<ModeId>('5min')
  const [wager, setWager] = useState('10000')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const balance = balanceOf(vault, wallet, coinA)
  const wagerNum = Number(wager)

  async function submit() {
    setError(null)
    if (coinA === coinB) return setError('Pick two different coins')
    if (!wagerNum || wagerNum <= 0) return setError('Enter a wager amount')
    if (wagerNum > balance) return setError(`Not enough ${coinA.toUpperCase()} in your vault`)
    setBusy(true)
    try {
      await signDemoAction(
        connection,
        walletCtx,
        `battle:create:${coinA}v${coinB}:${mode}:${wagerNum}`,
      )
      setVault((v) => withdraw(v, wallet, coinA, wagerNum))
      addBattle(createBattle(coinA, coinB, mode, wagerNum, wallet))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transaction failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card p-5 space-y-4">
      <h3 className="font-display font-semibold">Start a challenge</h3>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-fog block mb-1">Your coin (staked from vault)</label>
          <select
            value={coinA}
            onChange={(e) => setCoinA(e.target.value)}
            className="w-full bg-white/5 border border-line rounded-lg px-3 py-2 text-sm"
          >
            {FAMOUS_COINS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.symbol} — vault: {balanceOf(vault, wallet, c.id).toLocaleString()}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-fog block mb-1">Opponent's coin</label>
          <select
            value={coinB}
            onChange={(e) => setCoinB(e.target.value)}
            className="w-full bg-white/5 border border-line rounded-lg px-3 py-2 text-sm"
          >
            {FAMOUS_COINS.filter((c) => c.id !== coinA).map((c) => (
              <option key={c.id} value={c.id}>
                {c.symbol}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="text-xs text-fog block mb-1">Wager amount ({coinA.toUpperCase()})</label>
        <input
          value={wager}
          onChange={(e) => setWager(e.target.value)}
          type="number"
          min="0"
          className="w-full bg-white/5 border border-line rounded-lg px-3 py-2 text-sm font-mono"
        />
      </div>
      <div>
        <label className="text-xs text-fog block mb-1">Mode</label>
        <ModePicker value={mode} onChange={setMode} />
      </div>
      <p className="text-xs text-mist">
        Whoever's coin gains more (%) by the end wins both stakes. Opponents have{' '}
        {Math.round(modeById(mode).joinWindowMs / 60000)} min to accept before it expires.
      </p>
      {error && <p className="text-xs text-lose">{error}</p>}
      <button className="btn btn-primary w-full" disabled={busy} onClick={submit}>
        {busy ? 'Confirm in wallet…' : 'Create challenge'}
      </button>
    </div>
  )
}

function BattleCard({
  battle,
  wallet,
  vault,
  setVault,
  setBattles,
}: {
  battle: Battle
  wallet: string
  vault: VaultState
  setVault: (u: VaultState | ((p: VaultState) => VaultState)) => void
  setBattles: (u: Battle[] | ((p: Battle[]) => Battle[])) => void
}) {
  const { connection } = useConnection()
  const walletCtx = useWallet()
  const { prices } = usePrices()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const coinA = coinById(battle.coinA)!
  const coinB = coinById(battle.coinB)!
  const status = derivedStatus(battle, Date.now())
  const isCreator = battle.sideA.wallet === wallet
  const canJoin = status === 'open' && !isCreator

  async function join() {
    const balance = balanceOf(vault, wallet, battle.coinB)
    if (battle.wager > balance) {
      setError(`Not enough ${coinB.symbol} in your vault`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await signDemoAction(connection, walletCtx, `battle:join:${battle.id}`)
      setVault((v) => withdraw(v, wallet, battle.coinB, battle.wager))
      const startA = priceFor(prices, coinA.coingeckoId)
      const startB = priceFor(prices, coinB.coingeckoId)
      setBattles((bs) =>
        bs.map((b) => (b.id === battle.id ? joinBattle(b, wallet, startA, startB) : b)),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transaction failed')
    } finally {
      setBusy(false)
    }
  }

  function reclaim() {
    setVault((v) => deposit(v, wallet, battle.coinA, battle.wager))
    setBattles((bs) => bs.filter((b) => b.id !== battle.id))
  }

  const liveA = priceFor(prices, coinA.coingeckoId)
  const liveB = priceFor(prices, coinB.coingeckoId)
  const changeA = battle.startPriceA ? pctChange(battle.startPriceA, battle.endPriceA ?? liveA) : null
  const changeB = battle.startPriceB ? pctChange(battle.startPriceB, battle.endPriceB ?? liveB) : null

  return (
    <div className="card p-5 space-y-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-mono text-fog">{modeById(battle.mode).label} battle</span>
        <StatusPill status={status} />
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <div className="text-center">
          <CoinTag coin={coinA} size="sm" />
          {changeA !== null && (
            <div className={`text-xs font-mono mt-1 ${changeA >= 0 ? 'text-win' : 'text-lose'}`}>
              {changeA >= 0 ? '+' : ''}
              {changeA.toFixed(2)}%
            </div>
          )}
        </div>
        <span className="text-fog text-sm font-display">VS</span>
        <div className="text-center">
          <CoinTag coin={coinB} size="sm" />
          {changeB !== null && (
            <div className={`text-xs font-mono mt-1 ${changeB >= 0 ? 'text-win' : 'text-lose'}`}>
              {changeB >= 0 ? '+' : ''}
              {changeB.toFixed(2)}%
            </div>
          )}
        </div>
      </div>
      <div className="text-center text-xs text-mist font-mono">
        {battle.wager.toLocaleString()} each side
      </div>

      {status === 'open' && (
        <div className="text-center text-sm">
          <Countdown target={battle.joinDeadline} prefix="Opponent needed — starts in" />
        </div>
      )}
      {status === 'starting' && (
        <div className="text-center text-sm text-brand-2 font-medium">
          <Countdown target={battle.startsAt} prefix="Battle starts in" />
        </div>
      )}
      {status === 'active' && (
        <div className="text-center text-sm text-mist">
          <Countdown target={battle.endsAt} prefix="Settles in" doneLabel="Settling…" />
        </div>
      )}
      {status === 'settled' && battle.winner && (
        <div className="text-center text-sm font-semibold">
          🏆 {battle.winner === 'A' ? coinA.symbol : coinB.symbol} wins —{' '}
          {(battle.winner === 'A' ? battle.sideA.wallet : battle.sideB!.wallet).slice(0, 4)}…
          {(battle.winner === 'A' ? battle.sideA.wallet : battle.sideB!.wallet).slice(-4)} takes
          both stakes
        </div>
      )}
      {status === 'expired' && (
        <div className="text-center text-sm text-fog">No challenger joined in time</div>
      )}

      {error && <p className="text-xs text-lose text-center">{error}</p>}

      {canJoin && (
        <button className="btn btn-primary w-full" disabled={busy} onClick={join}>
          {busy ? 'Confirm in wallet…' : `Accept with ${coinB.symbol}`}
        </button>
      )}
      {status === 'expired' && isCreator && (
        <button className="btn btn-ghost w-full" onClick={reclaim}>
          Reclaim stake
        </button>
      )}
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    open: 'text-mist border-line bg-white/5',
    starting: 'text-brand-2 border-brand-2/40 bg-brand-2/10',
    active: 'text-brand border-brand/40 bg-brand/10',
    settled: 'text-win border-win/40 bg-win/10',
    expired: 'text-lose border-lose/40 bg-lose/10',
  }
  return (
    <span className={`px-2 py-0.5 rounded-full border font-mono ${styles[status] ?? ''}`}>
      {status}
    </span>
  )
}

export function Battles() {
  const { publicKey } = useWallet()
  const wallet = publicKey?.toBase58()
  const [vault, setVault] = useLocalStorage<VaultState>('vault', {})
  const [battles, setBattles] = useLocalStorage<Battle[]>('battles', [])
  const { prices } = usePrices()

  // Simulates the keeper: checks every few seconds for battles whose window
  // has ended and settles them using live prices, paying the winner's vault.
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now()
      for (const battle of battles) {
        if (battle.winner || !battle.endsAt || now < battle.endsAt) continue
        const coinA = coinById(battle.coinA)!
        const coinB = coinById(battle.coinB)!
        const settled = settleBattle(
          battle,
          priceFor(prices, coinA.coingeckoId),
          priceFor(prices, coinB.coingeckoId),
        )
        if (!settled.winner) continue
        const winnerWallet = settled.winner === 'A' ? battle.sideA.wallet : battle.sideB!.wallet
        setVault((v) => {
          let next = deposit(v, winnerWallet, battle.coinA, battle.wager)
          next = deposit(next, winnerWallet, battle.coinB, battle.wager)
          return next
        })
        setBattles((bs) => bs.map((b) => (b.id === battle.id ? settled : b)))
      }
    }, 3000)
    return () => clearInterval(id)
  }, [battles, prices, setBattles, setVault])

  const sorted = [...battles].sort((a, b) => b.createdAt - a.createdAt)

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 space-y-6">
      <div>
        <h1 className="font-display font-bold text-2xl mb-1">Battles</h1>
        <p className="text-mist text-sm">
          Challenge a specific opponent coin. Stakes come out of your vault; the winner's coin
          amount and the loser's are both credited to whoever's coin performs best.
        </p>
      </div>
      <WalletGate>
        {wallet && (
          <div className="grid lg:grid-cols-[380px_1fr] gap-6 items-start">
            <CreateBattleForm
              wallet={wallet}
              vault={vault}
              setVault={setVault}
              addBattle={(b) => setBattles((bs) => [b, ...bs])}
            />
            <div className="grid sm:grid-cols-2 gap-4">
              {sorted.length === 0 && (
                <p className="text-mist text-sm col-span-2">
                  No battles yet — start the first challenge.
                </p>
              )}
              {sorted.map((b) => (
                <BattleCard
                  key={b.id}
                  battle={b}
                  wallet={wallet}
                  vault={vault}
                  setVault={setVault}
                  setBattles={setBattles}
                />
              ))}
            </div>
          </div>
        )}
      </WalletGate>
      <p className="text-xs text-fog">Modes available: {MODES.map((m) => m.label).join(' · ')}</p>
    </div>
  )
}
