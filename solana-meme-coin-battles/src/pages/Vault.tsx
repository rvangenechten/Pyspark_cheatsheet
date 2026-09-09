import { useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { useLocalStorage } from '../lib/storage'
import { balanceOf, deposit, type VaultState } from '../lib/vault'
import { signDemoAction, explorerUrl } from '../lib/tx'
import { WalletGate } from '../components/WalletGate'
import type { CollateralAsset } from '../lib/battles'

function CollateralFundCard({
  asset,
  wallet,
  vault,
  setVault,
}: {
  asset: CollateralAsset
  wallet: string
  vault: VaultState
  setVault: (u: VaultState | ((p: VaultState) => VaultState)) => void
}) {
  const { connection } = useConnection()
  const walletCtx = useWallet()
  const [amount, setAmount] = useState(asset === 'SOL' ? '5' : '100')
  const [busy, setBusy] = useState(false)
  const [lastTx, setLastTx] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const balance = balanceOf(vault, wallet, asset)

  async function fund() {
    const amt = Number(amount)
    if (!amt || amt <= 0) return
    setBusy(true)
    setError(null)
    try {
      const sig = await signDemoAction(connection, walletCtx, `vault:fund:${asset}:${amt}`)
      setVault((v) => deposit(v, wallet, asset, amt))
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
          <div className="font-semibold">{asset} vault balance</div>
          <div className="text-xs text-mist">Used to back a coin's price in Battles or Common Coins</div>
        </div>
        <div className="font-mono text-lg">
          {balance.toLocaleString()} {asset}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          type="number"
          min="0"
          step={asset === 'SOL' ? '0.1' : '1'}
          className="w-24 bg-white/5 border border-line rounded-lg px-3 py-1.5 text-sm font-mono"
        />
        <button className="btn btn-primary" disabled={busy} onClick={fund}>
          Deposit
        </button>
        {asset === 'SOL' && (
          <button className="btn btn-ghost text-xs" disabled={busy} onClick={requestAirdrop}>
            Need devnet SOL? Airdrop 1 SOL
          </button>
        )}
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

export function Vault() {
  const { publicKey } = useWallet()
  const [vault, setVault] = useLocalStorage<VaultState>('vault', {})
  const wallet = publicKey?.toBase58()

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10 space-y-6">
      <div>
        <h1 className="font-display font-bold text-2xl mb-1">Your Vault</h1>
        <p className="text-mist text-sm">
          Fund SOL or USDC here — that's all you need. You don't have to hold any meme coin to
          battle it: pick which coin's price to back when you create or accept a challenge, or
          when you pick a side in Common Coins. Deposits ask your wallet to sign a real (free)
          devnet transaction — balances themselves are demo bookkeeping, see the README.
        </p>
      </div>
      <WalletGate>
        {wallet && (
          <div className="space-y-4">
            <CollateralFundCard asset="SOL" wallet={wallet} vault={vault} setVault={setVault} />
            <CollateralFundCard asset="USDC" wallet={wallet} vault={vault} setVault={setVault} />
          </div>
        )}
      </WalletGate>
    </div>
  )
}
