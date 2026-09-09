import { useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { FAMOUS_COINS } from '../lib/coins'
import { usePrices, priceFor } from '../lib/prices'
import { useTokenPrices } from '../lib/tokenPrice'
import { useLocalStorage } from '../lib/storage'
import { balanceOf, deposit, withdraw, type VaultState } from '../lib/vault'
import { signDemoAction, explorerUrl } from '../lib/tx'
import { rememberToken, tokenRefFromCoin, useCustomTokenRegistry, type TokenRef } from '../lib/tokens'
import { WalletGate } from '../components/WalletGate'
import { TokenTag } from '../components/TokenTag'
import { TokenSearchPicker } from '../components/TokenSearchPicker'

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

function TokenVaultRow({
  token,
  wallet,
  vault,
  setVault,
  usdPrice,
}: {
  token: TokenRef
  wallet: string
  vault: VaultState
  setVault: (u: VaultState | ((p: VaultState) => VaultState)) => void
  usdPrice?: number
}) {
  const { connection } = useConnection()
  const walletCtx = useWallet()
  const [amount, setAmount] = useState('10000')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const balance = balanceOf(vault, wallet, token.key)
  const usd = usdPrice !== undefined ? usdPrice * balance : undefined

  async function doDeposit() {
    const amt = Number(amount)
    if (!amt || amt <= 0) return
    setBusy(true)
    setError(null)
    try {
      await signDemoAction(connection, walletCtx, `vault:deposit:${token.key}:${amt}`)
      setVault((v) => deposit(v, wallet, token.key, amt))
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
      await signDemoAction(connection, walletCtx, `vault:withdraw:${token.key}:${balance}`)
      setVault((v) => withdraw(v, wallet, token.key, balance))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transaction failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <TokenTag token={token} />
        <div className="text-right">
          <div className="font-mono">{balance.toLocaleString()}</div>
          <div className="text-xs text-fog">{usd !== undefined ? `≈ $${usd.toFixed(2)}` : 'price unknown'}</div>
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

function CustomTokenRow({
  token,
  wallet,
  vault,
  setVault,
}: {
  token: TokenRef
  wallet: string
  vault: VaultState
  setVault: (u: VaultState | ((p: VaultState) => VaultState)) => void
}) {
  const prices = useTokenPrices([token.mint])
  return (
    <TokenVaultRow token={token} wallet={wallet} vault={vault} setVault={setVault} usdPrice={prices[token.mint]} />
  )
}

function AddCustomToken({
  registry,
  setRegistry,
}: {
  registry: Record<string, TokenRef>
  setRegistry: (u: Record<string, TokenRef> | ((p: Record<string, TokenRef>) => Record<string, TokenRef>)) => void
}) {
  const famousMints = new Set(FAMOUS_COINS.map((c) => c.mint))

  function add(token: TokenRef) {
    if (famousMints.has(token.mint)) return // already listed above, nothing to add
    rememberToken(registry, setRegistry, token)
  }

  return (
    <div className="card p-5 space-y-3">
      <div>
        <div className="font-semibold">Add a custom token</div>
        <div className="text-xs text-mist">
          Any token on the verified token list can be added — search by name, or paste its mint
          address.
        </div>
      </div>
      <TokenSearchPicker onSelect={add} />
    </div>
  )
}

export function Vault() {
  const { publicKey } = useWallet()
  const [vault, setVault] = useLocalStorage<VaultState>('vault', {})
  const [registry, setRegistry] = useCustomTokenRegistry()
  const { prices } = usePrices()
  const wallet = publicKey?.toBase58()
  const customTokens = Object.values(registry)

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
          <div className="space-y-6">
            <SolFundCard wallet={wallet} vault={vault} setVault={setVault} />
            <div className="grid sm:grid-cols-2 gap-3">
              {FAMOUS_COINS.map((coin) => (
                <TokenVaultRow
                  key={coin.id}
                  token={tokenRefFromCoin(coin)}
                  wallet={wallet}
                  vault={vault}
                  setVault={setVault}
                  usdPrice={priceFor(prices, coin.coingeckoId)}
                />
              ))}
            </div>

            <div>
              <h2 className="font-display font-semibold text-lg mb-3">Custom tokens</h2>
              <div className="space-y-3">
                <AddCustomToken registry={registry} setRegistry={setRegistry} />
                {customTokens.length > 0 && (
                  <div className="grid sm:grid-cols-2 gap-3">
                    {customTokens.map((token) => (
                      <CustomTokenRow
                        key={token.key}
                        token={token}
                        wallet={wallet}
                        vault={vault}
                        setVault={setVault}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </WalletGate>
    </div>
  )
}
