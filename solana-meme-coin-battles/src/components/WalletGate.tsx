import type { ReactNode } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'

export function WalletGate({ children }: { children: ReactNode }) {
  const { connected } = useWallet()
  const { setVisible } = useWalletModal()

  if (connected) return <>{children}</>

  return (
    <div className="card p-8 text-center">
      <div className="text-3xl mb-2">👛</div>
      <h3 className="font-display font-semibold text-lg mb-1">Connect a wallet to continue</h3>
      <p className="text-mist text-sm mb-4">
        Phantom, Solflare, Coinbase Wallet, Trust Wallet, and any Wallet Standard wallet are
        supported. Switch your wallet to <span className="font-mono">Devnet</span> first.
      </p>
      <button className="btn btn-primary" onClick={() => setVisible(true)}>
        Connect Wallet
      </button>
    </div>
  )
}
