import { useEffect, useMemo, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { MODES, modeById, type ModeId } from '../lib/coins'
import { useLocalStorage } from '../lib/storage'
import { balanceOf, deposit, withdraw, type VaultState } from '../lib/vault'
import {
  createBattle,
  derivedStatus,
  joinBattle,
  settleBattle,
  pctChange,
  type Battle,
  type CollateralAsset,
} from '../lib/battles'
import { signDemoAction } from '../lib/tx'
import { fetchTokenPrice, useTokenPrices } from '../lib/tokenPrice'
import type { TokenRef } from '../lib/tokens'
import { WalletGate } from '../components/WalletGate'
import { TokenTag } from '../components/TokenTag'
import { TokenSearchPicker } from '../components/TokenSearchPicker'
import { ModePicker } from '../components/ModePicker'
import { Countdown } from '../components/Countdown'

function CollateralPicker({
  value,
  onChange,
}: {
  value: CollateralAsset
  onChange: (a: CollateralAsset) => void
}) {
  return (
    <div className="flex gap-1 p-1 rounded-xl bg-white/5 border border-line w-fit">
      {(['SOL', 'USDC'] as const).map((asset) => (
        <button
          key={asset}
          type="button"
          onClick={() => onChange(asset)}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            value === asset ? 'bg-brand text-white' : 'text-mist hover:text-white'
          }`}
        >
          {asset}
        </button>
      ))}
    </div>
  )
}

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
  const [tokenA, setTokenA] = useState<TokenRef | null>(null)
  const [collateral, setCollateral] = useState<CollateralAsset>('SOL')
  const [mode, setMode] = useState<ModeId>('5min')
  const [wager, setWager] = useState('0.5')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const balance = balanceOf(vault, wallet, collateral)
  const wagerNum = Number(wager)

  async function submit() {
    setError(null)
    if (!tokenA) return setError('Pick a coin to back')
    if (!wagerNum || wagerNum <= 0) return setError('Enter a wager amount')
    if (wagerNum > balance) return setError(`Not enough ${collateral} in your vault`)
    setBusy(true)
    try {
      await signDemoAction(
        connection,
        walletCtx,
        `battle:create:${tokenA.mint}:${collateral}:${mode}:${wagerNum}`,
      )
      setVault((v) => withdraw(v, wallet, collateral, wagerNum))
      addBattle(createBattle(tokenA, collateral, mode, wagerNum, wallet))
      setTokenA(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transaction failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card p-5 space-y-4">
      <h3 className="font-display font-semibold">Start a challenge</h3>
      <div>
        <label className="text-xs text-fog block mb-1">Coin to back</label>
        {tokenA ? (
          <div className="flex items-center justify-between">
            <TokenTag token={tokenA} size="sm" />
            <button className="text-xs text-mist underline" onClick={() => setTokenA(null)}>
              change
            </button>
          </div>
        ) : (
          <TokenSearchPicker onSelect={setTokenA} placeholder="Search any verified coin" />
        )}
      </div>
      <div>
        <label className="text-xs text-fog block mb-1">Stake with</label>
        <CollateralPicker value={collateral} onChange={setCollateral} />
        <div className="text-xs text-fog mt-1">Vault balance: {balance.toLocaleString()} {collateral}</div>
      </div>
      <div>
        <label className="text-xs text-fog block mb-1">Wager amount ({collateral})</label>
        <input
          value={wager}
          onChange={(e) => setWager(e.target.value)}
          type="number"
          min="0"
          step="0.01"
          className="w-full bg-white/5 border border-line rounded-lg px-3 py-2 text-sm font-mono"
        />
      </div>
      <div>
        <label className="text-xs text-fog block mb-1">Mode</label>
        <ModePicker value={mode} onChange={setMode} />
      </div>
      <p className="text-xs text-mist">
        No need to hold the coin itself — you're backing its price with {collateral} collateral.
        Left open for anyone to accept by backing any other verified coin with the same amount of{' '}
        {collateral}. Whoever's coin gains more (%) by the end wins both stakes. Unaccepted
        challenges expire after {Math.round(modeById(mode).joinWindowMs / 60000)} min.
      </p>
      {error && <p className="text-xs text-lose">{error}</p>}
      <button className="btn btn-primary w-full" disabled={busy} onClick={submit}>
        {busy ? 'Confirm in wallet…' : 'Create challenge'}
      </button>
    </div>
  )
}

function OpenChallengeAccept({
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
  const [candidate, setCandidate] = useState<TokenRef | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const balance = balanceOf(vault, wallet, battle.collateral)

  async function accept() {
    if (!candidate) return
    if (candidate.mint === battle.tokenA.mint) {
      setError("Can't battle a coin against itself")
      return
    }
    if (battle.wager > balance) {
      setError(`Not enough ${battle.collateral} in your vault — fund it on the Vault page first.`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const [priceA, priceB] = await Promise.all([
        fetchTokenPrice(battle.tokenA.mint),
        fetchTokenPrice(candidate.mint),
      ])
      if (!priceA || !priceB) {
        setError('Could not get a live price for one of the coins — try again in a moment.')
        setBusy(false)
        return
      }
      await signDemoAction(connection, walletCtx, `battle:join:${battle.id}:${candidate.mint}`)
      setVault((v) => withdraw(v, wallet, battle.collateral, battle.wager))
      setBattles((bs) =>
        bs.map((b) => (b.id === battle.id ? joinBattle(b, wallet, candidate, priceA, priceB) : b)),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transaction failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="text-xs text-fog text-center">
        Accepting stakes {battle.wager} {battle.collateral} from your vault (balance:{' '}
        {balance.toLocaleString()})
      </div>
      {!candidate ? (
        <TokenSearchPicker
          onSelect={setCandidate}
          excludeMint={battle.tokenA.mint}
          placeholder="Pick the coin you're backing"
        />
      ) : (
        <div className="flex items-center justify-between">
          <TokenTag token={candidate} size="sm" />
          <button className="text-xs text-mist underline" onClick={() => setCandidate(null)}>
            change
          </button>
        </div>
      )}
      {error && <p className="text-xs text-lose">{error}</p>}
      {candidate && (
        <button className="btn btn-primary w-full" disabled={busy} onClick={accept}>
          {busy ? 'Confirm in wallet…' : `Back ${candidate.symbol}`}
        </button>
      )}
    </div>
  )
}

function BattleCard({
  battle,
  wallet,
  vault,
  setVault,
  setBattles,
  prices,
}: {
  battle: Battle
  wallet: string
  vault: VaultState
  setVault: (u: VaultState | ((p: VaultState) => VaultState)) => void
  setBattles: (u: Battle[] | ((p: Battle[]) => Battle[])) => void
  prices: Record<string, number>
}) {
  const status = derivedStatus(battle, Date.now())
  const isCreator = battle.sideA.wallet === wallet

  function reclaim() {
    setVault((v) => deposit(v, wallet, battle.collateral, battle.wager))
    setBattles((bs) => bs.filter((b) => b.id !== battle.id))
  }

  const liveA = prices[battle.tokenA.mint]
  const liveB = battle.tokenB ? prices[battle.tokenB.mint] : undefined
  const changeA = battle.startPriceA ? pctChange(battle.startPriceA, battle.endPriceA ?? liveA) : null
  const changeB = battle.startPriceB ? pctChange(battle.startPriceB, battle.endPriceB ?? liveB) : null
  const winnerWallet =
    battle.winner === 'A' ? battle.sideA.wallet : battle.winner === 'B' ? battle.sideB?.wallet : undefined

  return (
    <div className="card p-5 space-y-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-mono text-fog">{modeById(battle.mode).label} battle</span>
        <StatusPill status={status} />
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <div className="text-center">
          <TokenTag token={battle.tokenA} size="sm" />
          {changeA !== null && (
            <div className={`text-xs font-mono mt-1 ${changeA >= 0 ? 'text-win' : 'text-lose'}`}>
              {changeA >= 0 ? '+' : ''}
              {changeA.toFixed(2)}%
            </div>
          )}
        </div>
        <span className="text-fog text-sm font-display">VS</span>
        <div className="text-center">
          {battle.tokenB ? (
            <>
              <TokenTag token={battle.tokenB} size="sm" />
              {changeB !== null && (
                <div className={`text-xs font-mono mt-1 ${changeB >= 0 ? 'text-win' : 'text-lose'}`}>
                  {changeB >= 0 ? '+' : ''}
                  {changeB.toFixed(2)}%
                </div>
              )}
            </>
          ) : (
            <div className="text-fog text-xs leading-tight">
              any
              <br />
              verified coin
            </div>
          )}
        </div>
      </div>
      <div className="text-center text-xs text-mist font-mono">
        {battle.wager} {battle.collateral} each side
      </div>

      {status === 'open' && (
        <div className="space-y-2">
          <div className="text-center text-sm">
            <Countdown target={battle.joinDeadline} prefix="Open — expires in" />
          </div>
          {isCreator ? (
            <p className="text-center text-xs text-fog">
              Waiting for someone to back another coin against you
            </p>
          ) : (
            <OpenChallengeAccept
              battle={battle}
              wallet={wallet}
              vault={vault}
              setVault={setVault}
              setBattles={setBattles}
            />
          )}
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
      {status === 'settled' && battle.winner && battle.tokenB && winnerWallet && (
        <div className="text-center text-sm font-semibold">
          🏆 {battle.winner === 'A' ? battle.tokenA.symbol : battle.tokenB.symbol} wins —{' '}
          {winnerWallet.slice(0, 4)}…{winnerWallet.slice(-4)} takes{' '}
          {(battle.wager * 2).toLocaleString()} {battle.collateral}
        </div>
      )}
      {status === 'expired' && <div className="text-center text-sm text-fog">No challenger accepted in time</div>}
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

  const mints = useMemo(() => {
    const s = new Set<string>()
    for (const b of battles) {
      if (!b.tokenA) continue
      s.add(b.tokenA.mint)
      if (b.tokenB) s.add(b.tokenB.mint)
    }
    return [...s]
  }, [battles])
  const prices = useTokenPrices(mints)

  // Simulates the keeper: checks every few seconds for battles whose window
  // has ended and settles them using live prices, paying the winner's vault.
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now()
      for (const battle of battles) {
        if (!battle.tokenA) continue // stale shape from before the collateral-model change
        if (battle.winner || !battle.endsAt || now < battle.endsAt || !battle.tokenB) continue
        const endA = prices[battle.tokenA.mint]
        const endB = prices[battle.tokenB.mint]
        if (endA === undefined || endB === undefined) continue
        const settled = settleBattle(battle, endA, endB)
        if (!settled.winner) continue
        const winnerWallet = settled.winner === 'A' ? battle.sideA.wallet : battle.sideB!.wallet
        setVault((v) => deposit(v, winnerWallet, battle.collateral, battle.wager * 2))
        setBattles((bs) => bs.map((b) => (b.id === battle.id ? settled : b)))
      }
    }, 3000)
    return () => clearInterval(id)
  }, [battles, prices, setBattles, setVault])

  const sorted = [...battles].filter((b) => b.tokenA).sort((a, b) => b.createdAt - a.createdAt)

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 space-y-6">
      <div>
        <h1 className="font-display font-bold text-2xl mb-1">Battles</h1>
        <p className="text-mist text-sm">
          Back a coin's price with SOL or USDC collateral and leave the challenge open. Anyone
          can accept by backing a different verified coin with the same amount — whoever's coin
          performs best wins both stakes. No need to hold either coin.
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
                  prices={prices}
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
