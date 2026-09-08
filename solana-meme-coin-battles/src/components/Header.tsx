import { NavLink } from 'react-router-dom'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { NETWORK } from '../lib/wallet'

const LINKS = [
  { to: '/', label: 'Home', end: true },
  { to: '/vault', label: 'Vault' },
  { to: '/battles', label: 'Battles' },
  { to: '/common-coins', label: 'Common Coins' },
]

export function Header() {
  return (
    <header className="sticky top-0 z-30 border-b border-line/60 bg-ink/85 backdrop-blur">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-6">
          <NavLink to="/" className="flex items-center gap-2 shrink-0">
            <span className="text-xl">⚔️</span>
            <span className="font-display font-bold text-lg tracking-tight">
              Meme Coin Battles
            </span>
          </NavLink>
          <nav className="hidden md:flex items-center gap-1">
            {LINKS.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.end}
                className={({ isActive }) =>
                  `px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    isActive ? 'bg-white/10 text-white' : 'text-mist hover:text-white'
                  }`
                }
              >
                {l.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden sm:inline text-xs font-mono px-2 py-1 rounded-full border border-line text-mist">
            {NETWORK}
          </span>
          <WalletMultiButton />
        </div>
      </div>
      <nav className="md:hidden flex items-center gap-1 px-4 pb-2 overflow-x-auto">
        {LINKS.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.end}
            className={({ isActive }) =>
              `px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                isActive ? 'bg-white/10 text-white' : 'text-mist hover:text-white'
              }`
            }
          >
            {l.label}
          </NavLink>
        ))}
      </nav>
    </header>
  )
}
