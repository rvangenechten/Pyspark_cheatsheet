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
} from '../lib/battles'
import { signDemoAction } from '../lib/tx'
import { fetchTokenPrice, useTokenPrices } from '../lib/tokenPrice'
import { heldTokens, rememberToken, useCustomTokenRegistry, type TokenRef } from '../lib/tokens'
import { WalletGate } from '../components/WalletGate'
import { TokenTag } from '../components/TokenTag'
import { TokenSearchPicker } from '../components/TokenSearchPicker'
import { ModePicker } from '../components/ModePicker'
import { Countdown } from '../components/Countdown'

function CreateBattleForm({
  wallet,
  vault,
  setVault,
  registry,
  addBattle,
}: {
  wallet: string
  vault: VaultState
  setVault: (u: VaultState | ((p: VaultState) => VaultState)) => void
  registry: Record<string, TokenRef>
  addBattle: (b: Battle) => void
}) {
  const { connection } = useConnection()
  const walletCtx = useWallet()
  const held = heldTokens(vault, wallet, registry)
  const [tokenKey, setTokenKey] = useState(held[0]?.token.key ?? '')
  const [mode, setMode] = useState<ModeId>('5min')
  const [wager, setWager] = useState('10000')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selected = held.find((h) => h.token.key === tokenKey) ?? held[0]
  const wagerNum = Number(wager)

  async function submit() {
    setError(null)
    if (!selected) return setError('Deposit a coin into your vault first')
    if (!wagerNum || wagerNum <= 0) return setError('Enter a wager amount')
    if (wagerNum > selected.balance) return setError(`Not enough ${selected.token.symbol} in your vault`)
    setBusy(true)
    try {
      await signDemoAction(
        connection,
        walletCtx,
        `battle:create:${selected.token.key}:${mode}:${wagerNum}`,
      )
      setVault((v) => withdraw(v, wallet, selected.token.key, wagerNum))
      addBattle(createBattle(selected.token, mode, wagerNum, wallet))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transaction failed')
    } finally {
      setBusy(false)
    }
  }

  if (held.length === 0) {
    return (
      <div className="card p-5 text-center text-sm text-mist">
        Deposit a coin into your vault before you can challenge anyone — visit the Vault page
        first.
      </div>
    )
  }

  return (
    <div className="card p-5 space-y-4">
      <h3 className="font-display font-semibold">Start a challenge</h3>
      <div>
        <label className="text-xs text-fog block mb-1">Your coin (staked from vault)</label>
        <select
          value={selected?.token.key}
          onChange={(e) => setTokenKey(e.target.value)}
          className="w-full bg-white/5 border border-line rounded-lg px-3 py-2 text-sm"
        >
          {held.map(({ token, balance }) => (
            <option key={token.key} value={token.key}>
              {token.symbol} — vault: {balance.toLocaleString()}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="text-xs text-fog block mb-1">
          Wager amount ({selected?.token.symbol})
        </label>
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
        Left open for anyone to accept — with any verified token of their choice, staking the
        same amount. Whoever's coin gains more (%) by the end wins both stakes. Unaccepted
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
  registry,
  setRegistry,
}: {
  battle: Battle
  wallet: string
  vault: VaultState
  setVault: (u: VaultState | ((p: VaultState) => VaultState)) => void
  setBattles: (u: Battle[] | ((p: Battle[]) => Battle[])) => void
  registry: Record<string, TokenRef>
  setRegistry: (u: Record<string, TokenRef> | ((p: Record<string, TokenRef>) => Record<string, TokenRef>)) => void
}) {
  const { connection } = useConnection()
  const walletCtx = useWallet()
  const [candidate, setCandidate] = useState<TokenRef | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const balance = candidate ? balanceOf(vault, wallet, candidate.key) : 0

  async function accept() {
    if (!candidate) return
    if (candidate.mint === battle.tokenA.mint) {
      setError("Can't battle a coin against itself")
      return
    }
    if (battle.wager > balance) {
      setError(`Not enough ${candidate.symbol} in your vault — deposit it on the Vault page first.`)
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
      setVault((v) => withdraw(v, wallet, candidate.key, battle.wager))
      rememberToken(registry, setRegistry, candidate)
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
      {!candidate ? (
        <TokenSearchPicker
          onSelect={setCandidate}
          excludeMint={battle.tokenA.mint}
          placeholder="Pick your coin to accept with"
        />
      ) : (
        <div className="flex items-center justify-between">
          <TokenTag token={candidate} size="sm" />
          <button className="text-xs text-mist underline" onClick={() => setCandidate(null)}>
            change
          </button>
        </div>
      )}
      {candidate && (
        <div className="text-xs text-fog">
          Your vault: {balance.toLocaleString()} {candidate.symbol}
        </div>
      )}
      {error && <p className="text-xs text-lose">{error}</p>}
      {candidate && (
        <button className="btn btn-primary w-full" disabled={busy} onClick={accept}>
          {busy ? 'Confirm in wallet…' : `Accept with ${candidate.symbol}`}
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
  registry,
  setRegistry,
  prices,
}: {
  battle: Battle
  wallet: string
  vault: VaultState
  setVault: (u: VaultState | ((p: VaultState) => VaultState)) => void
  setBattles: (u: Battle[] | ((p: Battle[]) => Battle[])) => void
  registry: Record<string, TokenRef>
  setRegistry: (u: Record<string, TokenRef> | ((p: Record<string, TokenRef>) => Record<string, TokenRef>)) => void
  prices: Record<string, number>
}) {
  const status = derivedStatus(battle, Date.now())
  const isCreator = battle.sideA.wallet === wallet

  function reclaim() {
    setVault((v) => deposit(v, wallet, battle.tokenA.key, battle.wager))
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
              verified token
            </div>
          )}
        </div>
      </div>
      <div className="text-center text-xs text-mist font-mono">
        {battle.wager.toLocaleString()} each side
      </div>

      {status === 'open' && (
        <div className="space-y-2">
          <div className="text-center text-sm">
            <Countdown target={battle.joinDeadline} prefix="Open — expires in" />
          </div>
          {isCreator ? (
            <p className="text-center text-xs text-fog">
              Waiting for someone to accept with any verified token
            </p>
          ) : (
            <OpenChallengeAccept
              battle={battle}
              wallet={wallet}
              vault={vault}
              setVault={setVault}
              setBattles={setBattles}
              registry={registry}
              setRegistry={setRegistry}
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
          {winnerWallet.slice(0, 4)}…{winnerWallet.slice(-4)} takes both stakes
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
  const [registry, setRegistry] = useCustomTokenRegistry()

  const mints = useMemo(() => {
    const s = new Set<string>()
    for (const b of battles) {
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
        if (battle.winner || !battle.endsAt || now < battle.endsAt || !battle.tokenB) continue
        const endA = prices[battle.tokenA.mint]
        const endB = prices[battle.tokenB.mint]
        if (endA === undefined || endB === undefined) continue
        const settled = settleBattle(battle, endA, endB)
        if (!settled.winner) continue
        const winnerWallet = settled.winner === 'A' ? battle.sideA.wallet : battle.sideB!.wallet
        setVault((v) => {
          let next = deposit(v, winnerWallet, battle.tokenA.key, battle.wager)
          next = deposit(next, winnerWallet, battle.tokenB!.key, battle.wager)
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
          Stake a coin from your vault and leave the challenge open. Anyone can accept with any
          verified token of their choice, staking the same amount — whoever's coin performs
          best wins both stakes.
        </p>
      </div>
      <WalletGate>
        {wallet && (
          <div className="grid lg:grid-cols-[380px_1fr] gap-6 items-start">
            <CreateBattleForm
              wallet={wallet}
              vault={vault}
              setVault={setVault}
              registry={registry}
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
                  registry={registry}
                  setRegistry={setRegistry}
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
