import { useEffect, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { coinById, MODES, type ModeId } from '../lib/coins'
import { usePrices, priceFor } from '../lib/prices'
import { useLocalStorage } from '../lib/storage'
import { balanceOf, deposit, withdraw, type VaultState } from '../lib/vault'
import {
  DUEL_PAIRS,
  STAKE_SIZES_SOL,
  currentRound,
  roundKey,
  emptyPool,
  totalOf,
  maxStake,
  addStake,
  stakeOf,
  settleRound,
  type RoundPool,
  type Side,
} from '../lib/duels'
import { signDemoAction } from '../lib/tx'
import { WalletGate } from '../components/WalletGate'
import { CoinTag } from '../components/CoinTag'
import { ModePicker } from '../components/ModePicker'
import { Countdown } from '../components/Countdown'

interface RoundRecord {
  startPrices?: { A: number; B: number }
  endPrices?: { A: number; B: number }
  winner?: Side
  settled?: boolean
}

function DuelCard({
  pairId,
  coinAId,
  coinBId,
  mode,
  wallet,
  vault,
  setVault,
  pools,
  setPools,
  rounds,
}: {
  pairId: string
  coinAId: string
  coinBId: string
  mode: ModeId
  wallet: string
  vault: VaultState
  setVault: (u: VaultState | ((p: VaultState) => VaultState)) => void
  pools: Record<string, RoundPool>
  setPools: (u: Record<string, RoundPool> | ((p: Record<string, RoundPool>) => Record<string, RoundPool>)) => void
  rounds: Record<string, RoundRecord>
}) {
  const { connection } = useConnection()
  const walletCtx = useWallet()
  const [size, setSize] = useState<number>(STAKE_SIZES_SOL[0])
  const [busy, setBusy] = useState<Side | null>(null)
  const [error, setError] = useState<string | null>(null)

  const coinA = coinById(coinAId)!
  const coinB = coinById(coinBId)!
  const round = currentRound(mode)
  const key = roundKey(pairId, mode, round.roundIndex)
  const pool = pools[key] ?? emptyPool()
  const now = Date.now()
  const locked = now >= round.locksAt

  const totalA = totalOf(pool, 'A')
  const totalB = totalOf(pool, 'B')
  const myA = stakeOf(pool, 'A', wallet)
  const myB = stakeOf(pool, 'B', wallet)

  async function stake(side: Side) {
    const cap = maxStake(pool, side)
    if (size > cap) {
      setError(
        cap === 0
          ? 'This side is already ahead — stake the other side to keep it equal.'
          : `Max ${cap.toFixed(2)} SOL right now to keep both sides equal — try a smaller size.`,
      )
      return
    }
    const solBalance = balanceOf(vault, wallet, 'SOL')
    if (size > solBalance) {
      setError('Not enough SOL in your vault — fund it on the Vault page.')
      return
    }
    setBusy(side)
    setError(null)
    try {
      await signDemoAction(connection, walletCtx, `duel:stake:${key}:${side}:${size}`)
      setVault((v) => withdraw(v, wallet, 'SOL', size))
      setPools((ps) => ({ ...ps, [key]: addStake(ps[key] ?? emptyPool(), side, wallet, size) }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transaction failed')
    } finally {
      setBusy(null)
    }
  }

  const prevKey = roundKey(pairId, mode, round.roundIndex - 1)
  const prevRound = rounds[prevKey]

  return (
    <div className="card p-5 space-y-3">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <CoinTag coin={coinA} size="sm" />
        <span className="text-fog text-sm font-display">VS</span>
        <div className="flex justify-end">
          <CoinTag coin={coinB} size="sm" />
        </div>
      </div>

      <div className="text-center text-sm">
        {!locked ? (
          <Countdown target={round.locksAt} prefix="Picks close in" className="text-brand-2 font-medium" />
        ) : (
          <Countdown target={round.endsAt} prefix="Round settles in" doneLabel="Settling…" className="text-mist" />
        )}
      </div>

      <div className="flex gap-1 justify-center">
        {STAKE_SIZES_SOL.map((s) => (
          <button
            key={s}
            type="button"
            disabled={locked}
            onClick={() => setSize(s)}
            className={`px-2.5 py-1 rounded-lg text-xs font-mono border transition-colors disabled:opacity-40 ${
              size === s ? 'bg-brand text-white border-brand' : 'border-line text-mist hover:text-white'
            }`}
          >
            {s} SOL
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        {(['A', 'B'] as const).map((side) => {
          const total = side === 'A' ? totalA : totalB
          const mine = side === 'A' ? myA : myB
          const cap = maxStake(pool, side)
          return (
            <div key={side} className="rounded-xl border border-line p-3 space-y-2">
              <div className="text-xs text-fog">
                Pool: <span className="font-mono text-white">{total.toFixed(2)} SOL</span>
              </div>
              {mine > 0 && (
                <div className="text-xs text-brand-2 font-mono">Your stake: {mine.toFixed(2)}</div>
              )}
              <button
                className="btn btn-ghost w-full text-sm"
                disabled={locked || busy !== null || size > cap}
                onClick={() => stake(side)}
              >
                {busy === side ? 'Confirm…' : `Pick ${side === 'A' ? coinA.symbol : coinB.symbol}`}
              </button>
            </div>
          )
        })}
      </div>

      <p className="text-xs text-fog">
        Stakes are matched 1:1 — the side that's ahead is capped until the other catches up, so
        both pools stay equal.
      </p>
      {error && <p className="text-xs text-lose">{error}</p>}

      {prevRound?.winner && (
        <p className="text-xs text-mist border-t border-line pt-2">
          Last round: 🏆 {prevRound.winner === 'A' ? coinA.symbol : coinB.symbol} won
        </p>
      )}
    </div>
  )
}

export function CommonCoins() {
  const { publicKey } = useWallet()
  const wallet = publicKey?.toBase58()
  const [mode, setMode] = useState<ModeId>('5min')
  const [vault, setVault] = useLocalStorage<VaultState>('vault', {})
  const [pools, setPools] = useLocalStorage<Record<string, RoundPool>>('duel-pools', {})
  const [rounds, setRounds] = useLocalStorage<Record<string, RoundRecord>>('duel-rounds', {})
  const { prices } = usePrices()

  // Simulated keeper: snapshots the reference price the instant picks close,
  // and again when the round ends, then settles and pays winners' vaults.
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now()
      for (const pair of DUEL_PAIRS) {
        for (const m of MODES) {
          const round = currentRound(m.id, now)
          const key = roundKey(pair.id, m.id, round.roundIndex)
          const coinA = coinById(pair.coinA)!
          const coinB = coinById(pair.coinB)!
          const existing = rounds[key]

          if (now >= round.locksAt && !existing?.startPrices) {
            setRounds((rs) => ({
              ...rs,
              [key]: {
                ...rs[key],
                startPrices: {
                  A: priceFor(prices, coinA.coingeckoId),
                  B: priceFor(prices, coinB.coingeckoId),
                },
              },
            }))
          }

          const prevIndex = round.roundIndex - 1
          const prevKey = roundKey(pair.id, m.id, prevIndex)
          const prevRecord = rounds[prevKey]
          const prevPool = pools[prevKey]
          if (prevRecord?.startPrices && !prevRecord.settled && prevPool) {
            const endA = priceFor(prices, coinA.coingeckoId)
            const endB = priceFor(prices, coinB.coingeckoId)
            const pctA = (endA - prevRecord.startPrices.A) / prevRecord.startPrices.A
            const pctB = (endB - prevRecord.startPrices.B) / prevRecord.startPrices.B
            const winner: Side = pctA >= pctB ? 'A' : 'B'
            const payouts = settleRound(prevPool, winner)
            setVault((v) => {
              let next = v
              for (const [w, amt] of Object.entries(payouts)) {
                if (amt > 0) next = deposit(next, w, 'SOL', amt)
              }
              return next
            })
            setRounds((rs) => ({
              ...rs,
              [prevKey]: { ...rs[prevKey], endPrices: { A: endA, B: endB }, winner, settled: true },
            }))
          }
        }
      }
    }, 3000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pools, rounds, prices])

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display font-bold text-2xl mb-1">Common Coins</h1>
          <p className="text-mist text-sm max-w-xl">
            Fixed matchups running around the clock. Pick a side and pay with SOL from your
            vault — stakes are kept equal on both sides automatically.
          </p>
        </div>
        <ModePicker value={mode} onChange={setMode} />
      </div>
      <WalletGate>
        {wallet && (
          <div className="grid sm:grid-cols-2 gap-4">
            {DUEL_PAIRS.map((pair) => (
              <DuelCard
                key={pair.id}
                pairId={pair.id}
                coinAId={pair.coinA}
                coinBId={pair.coinB}
                mode={mode}
                wallet={wallet}
                vault={vault}
                setVault={setVault}
                pools={pools}
                setPools={setPools}
                rounds={rounds}
              />
            ))}
          </div>
        )}
      </WalletGate>
    </div>
  )
}
