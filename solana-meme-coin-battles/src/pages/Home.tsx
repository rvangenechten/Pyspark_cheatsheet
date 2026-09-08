import { Link } from 'react-router-dom'
import { CHAINS, FAMOUS_COINS } from '../lib/coins'
import { usePrices, priceFor } from '../lib/prices'
import { CoinTag } from '../components/CoinTag'
import { PricePill } from '../components/PricePill'

export function Home() {
  const { prices } = usePrices()

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10 space-y-16">
      <section className="text-center max-w-2xl mx-auto">
        <span className="inline-block text-xs font-mono px-3 py-1 rounded-full border border-line text-mist mb-4">
          devnet prototype · pick a fighter
        </span>
        <h1 className="font-display font-bold text-4xl sm:text-5xl tracking-tight mb-4">
          Battle meme coins.<br />Winner takes the vault.
        </h1>
        <p className="text-mist text-base sm:text-lg mb-8">
          Connect Phantom or any Solana wallet, drop your favorite meme coin in the vault,
          and challenge someone else's. Whoever's coin performs better when the clock runs
          out wins both stakes — checked and paid out automatically.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Link to="/vault" className="btn btn-primary">
            Fund your vault
          </Link>
          <Link to="/battles" className="btn btn-ghost">
            Browse battles
          </Link>
          <Link to="/common-coins" className="btn btn-ghost">
            Pick a side
          </Link>
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display font-semibold text-xl">Famous coins, live</h2>
          <span className="text-xs text-fog">prices refresh every 30s</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {FAMOUS_COINS.map((coin) => {
            const p = prices[coin.coingeckoId]
            return (
              <div key={coin.id} className="card p-4 flex items-center justify-between">
                <CoinTag coin={coin} />
                <PricePill usd={priceFor(prices, coin.coingeckoId)} change={p?.usd_24h_change} />
              </div>
            )
          })}
        </div>
      </section>

      <section>
        <h2 className="font-display font-semibold text-xl mb-4">How it works</h2>
        <div className="grid sm:grid-cols-3 gap-4">
          {[
            {
              step: '1',
              title: 'Vault your coin',
              body: 'Connect your wallet and deposit a famous meme coin into its vault. Your balance is yours until a battle settles.',
            },
            {
              step: '2',
              title: 'Pick a mode & challenge',
              body: 'Choose 5 min, 1 hour, or 24 hour battles. Create a challenge, or pick a side in the Common Coins arena and pay in SOL.',
            },
            {
              step: '3',
              title: 'Auto-settled, no disputes',
              body: 'When the clock hits zero, price performance decides the winner and the vault pays out automatically — no manual claims.',
            },
          ].map((s) => (
            <div key={s.step} className="card p-5">
              <div className="w-8 h-8 rounded-full bg-brand/20 border border-brand/40 text-brand flex items-center justify-center font-mono text-sm mb-3">
                {s.step}
              </div>
              <h3 className="font-semibold mb-1">{s.title}</h3>
              <p className="text-sm text-mist">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="font-display font-semibold text-xl mb-4">Chains</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          {CHAINS.map((c) => (
            <div key={c.id} className="card p-5 flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="font-semibold">{c.name}</span>
                <span
                  className={`text-xs font-mono px-2 py-0.5 rounded-full border ${
                    c.status === 'live'
                      ? 'text-win border-win/40 bg-win/10'
                      : 'text-mist border-line bg-white/5'
                  }`}
                >
                  {c.status === 'live' ? 'live · devnet' : 'coming soon'}
                </span>
              </div>
              <p className="text-sm text-mist">{c.note}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
