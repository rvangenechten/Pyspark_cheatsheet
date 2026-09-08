import { HashRouter, Route, Routes } from 'react-router-dom'
import { SolanaProviders } from './lib/wallet'
import { Header } from './components/Header'
import { PrototypeBanner } from './components/PrototypeBanner'
import { Home } from './pages/Home'
import { Vault } from './pages/Vault'
import { Battles } from './pages/Battles'
import { CommonCoins } from './pages/CommonCoins'

export default function App() {
  return (
    <SolanaProviders>
      <HashRouter>
        <div className="min-h-screen flex flex-col">
          <PrototypeBanner />
          <Header />
          <main className="flex-1">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/vault" element={<Vault />} />
              <Route path="/battles" element={<Battles />} />
              <Route path="/common-coins" element={<CommonCoins />} />
            </Routes>
          </main>
          <footer className="border-t border-line py-6 text-center text-xs text-fog px-4">
            Solana devnet prototype · not audited · not affiliated with Phantom, Solflare,
            Coinbase, or Robinhood
          </footer>
        </div>
      </HashRouter>
    </SolanaProviders>
  )
}
