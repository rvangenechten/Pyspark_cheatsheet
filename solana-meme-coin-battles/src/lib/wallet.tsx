import { useMemo, type ReactNode } from 'react'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import {
  CoinbaseWalletAdapter,
  PhantomWalletAdapter,
  SolflareWalletAdapter,
  TrustWalletAdapter,
} from '@solana/wallet-adapter-wallets'
import { clusterApiUrl } from '@solana/web3.js'

import '@solana/wallet-adapter-react-ui/styles.css'

// Devnet only, on purpose: this is a prototype and never touches real funds.
// See README for what a mainnet deployment would additionally require.
export const NETWORK = 'devnet'

export function SolanaProviders({ children }: { children: ReactNode }) {
  const endpoint = useMemo(() => clusterApiUrl(NETWORK), [])

  // Phantom, Solflare, Coinbase, and Trust Wallet ship as explicit adapters
  // here; most modern wallets (Backpack, Glow, etc.) auto-register via the
  // Wallet Standard and show up in the modal without needing an adapter.
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
      new CoinbaseWalletAdapter(),
      new TrustWalletAdapter(),
    ],
    [],
  )

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}
