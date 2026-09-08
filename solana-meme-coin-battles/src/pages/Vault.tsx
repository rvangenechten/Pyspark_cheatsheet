import { useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { FAMOUS_COINS } from '../lib/coins'
import { usePrices, priceFor } from '../lib/prices'
import { useLocalStorage } from '../lib/storage'
import { balanceOf, deposit, withdraw, type VaultState } from '../lib/vault'
import { signDemoAction, explorerUrl } from '../lib/tx'
import { WalletGate } from '../components/WalletGate'
import { CoinTag } from '../components/CoinTag'

function SolFundCard({
  wallet,
  vault,
  setVault,
}: {
  wallet: string
  vault: VaultState
  setVault: (u: VaultState | ((p: VaultState) => VaultState)) => void
}) {
  const { connection } = useConnection()
  const walletCtx = useWallet()
  const [amount, setAmount] = useState('5')
  const [busy, setBusy] = useState(false)
  const [lastTx, setLastTx] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const solBalance = balanceOf(vault, wallet, 'SOL')

  async function fund() {
    const amt = Number(amount)
    if (!amt || amt <= 0) return
    setBusy(true)
    setError(null)
    try {
      const sig = await signDemoAction(connection, walletCtx, `vault:fund:SOL:${amt}`)
      setVault((v) => deposit(v, wallet, 'SOL', amt))
      setLastTx(sig)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transaction failed')
    } finally {
      setBusy(false)
    }
  }

  async function requestAirdrop() {
    setBusy(true)
    setError(null)
    try {
      const sig = await connection.requestAirdrop(walletCtx.publicKey!, 1_000_000_000)
      await connection.confirmTransaction(sig, 'confirmed')
      setLastTx(sig)
    } catch {
      setError('Airdrop failed — devnet faucet is likely rate-limited. Try faucet.solana.com.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card p-5 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-semibold">SOL vault balance</div>
          <div className="text-xs text-mist">Used to stake in Common Coins duels</div>
        </div>
        <div className="font-mono text-lg">{solBalance.toFixed(2)} SOL</div>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          type="number"
          min="0"
          step="0.1"
          className="w-24 bg-white/5 border border-line rounded-lg px-3 py-1.5 text-sm font-mono"
        />
        <button className="btn btn-primary" disabled={busy} onClick={fund}>
          Deposit
        </button>
        <button className="btn btn-ghost text-xs" disabled={busy} onClick={requestAirdrop}>
          Need devnet SOL? Airdrop 1 SOL
        </button>
      </div>
      {error && <p className="text-xs text-lose">{error}</p>}
      {lastTx && (
        <a
          href={explorerUrl(lastTx)}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-brand-2 underline decoration-dotted w-fit"
        >
          View devnet transaction ↗
        </a>
      )}
    </div>
  )
}

function CoinVaultRow({
  coinId,
  wallet,
  vault,
  setVault,
}: {
  coinId: string
  wallet: string
  vault: VaultState
  setVault: (u: VaultState | ((p: VaultState) => VaultState)) => void
}) {
  const coin = FAMOUS_COINS.find((c) => c.id === coinId)!
  const { connection } = useConnection()
  const walletCtx = useWallet()
  const { prices } = usePrices()
  const [amount, setAmount] = useState('10000')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const balance = balanceOf(vault, wallet, coinId)
  const usd = priceFor(prices, coin.coingeckoId) * balance

  async function doDeposit() {
    const amt = Number(amount)
    if (!amt || amt <= 0) return
    setBusy(true)
    setError(null)
    try {
      await signDemoAction(connection, walletCtx, `vault:deposit:${coinId}:${amt}`)
      setVault((v) => deposit(v, wallet, coinId, amt))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transaction failed')
    } finally {
      setBusy(false)
    }
  }

  async function doWithdraw() {
    if (balance <= 0) return
    setBusy(true)
    setError(null)
    try {
      await signDemoAction(connection, walletCtx, `vault:withdraw:${coinId}:${balance}`)
      setVault((v) => withdraw(v, wallet, coinId, balance))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transaction failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <CoinTag coin={coin} />
        <div className="text-right">
          <div className="font-mono">{balance.toLocaleString()}</div>
          <div className="text-xs text-fog">≈ ${usd.toFixed(2)}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          type="number"
          min="0"
          className="flex-1 min-w-0 bg-white/5 border border-line rounded-lg px-3 py-1.5 text-sm font-mono"
        />
        <button className="btn btn-primary text-sm" disabled={busy} onClick={doDeposit}>
          Deposit
        </button>
        <button
          className="btn btn-ghost text-sm"
          disabled={busy || balance <= 0}
          onClick={doWithdraw}
        >
          Withdraw all
        </button>
      </div>
      {error && <p className="text-xs text-lose">{error}</p>}
    </div>
  )
}

export function Vault() {
  const { publicKey } = useWallet()
  const [vault, setVault] = useLocalStorage<VaultState>('vault', {})
  const wallet = publicKey?.toBase58()

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10 space-y-6">
      <div>
        <h1 className="font-display font-bold text-2xl mb-1">Your Vault</h1>
        <p className="text-mist text-sm">
          Deposit coins here before challenging someone, or fund SOL to pick a side in Common
          Coins. Deposits ask your wallet to sign a real (free) devnet transaction — balances
          themselves are demo bookkeeping, see the README.
        </p>
      </div>
      <WalletGate>
        {wallet && (
          <div className="space-y-4">
            <SolFundCard wallet={wallet} vault={vault} setVault={setVault} />
            <div className="grid sm:grid-cols-2 gap-3">
              {FAMOUS_COINS.map((coin) => (
                <CoinVaultRow
                  key={coin.id}
                  coinId={coin.id}
                  wallet={wallet}
                  vault={vault}
                  setVault={setVault}
                />
              ))}
            </div>
          </div>
        )}
      </WalletGate>
    </div>
  )
}
