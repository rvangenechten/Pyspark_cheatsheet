import { useMemo, useState } from 'react'
import {
  searchWithin,
  useTopTokens,
  useTrendingTokens,
  type VerifiedTokenEntry,
} from '../lib/verifiedTokens'
import { FAMOUS_TOKEN_REFS, type TokenRef } from '../lib/tokens'
import { TokenTag } from './TokenTag'

function shortMint(mint: string) {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`
}

function toTokenRef(t: VerifiedTokenEntry): TokenRef {
  return { key: t.address, mint: t.address, symbol: t.symbol, name: t.name, logoURI: t.logoURI }
}

type Tab = 'top' | 'hot'

// Only these two curated, Jupiter-ranked pools are selectable — not any
// arbitrary "verified" token — so a challenge can't be created against
// something obscure or freshly-deployed with a copycat symbol.
export function TokenSearchPicker({
  onSelect,
  excludeMint,
  placeholder = 'Search by name or symbol',
}: {
  onSelect: (token: TokenRef) => void
  excludeMint?: string
  placeholder?: string
}) {
  const [tab, setTab] = useState<Tab>('top')
  const [query, setQuery] = useState('')
  const top = useTopTokens()
  const trending = useTrendingTokens()
  const active = tab === 'top' ? top : trending

  const results = useMemo(() => {
    const pool = active.tokens.length > 0 ? active.tokens : FAMOUS_TOKEN_REFS
    if (active.tokens.length > 0) {
      return searchWithin(pool as VerifiedTokenEntry[], query, 12).filter((t) => t.address !== excludeMint)
    }
    // Fallback pool (famous coins) is already TokenRef-shaped.
    const q = query.trim().toLowerCase()
    return (pool as TokenRef[])
      .filter((t) => t.mint !== excludeMint)
      .filter((t) => !q || t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q))
      .slice(0, 12)
  }, [active.tokens, query, excludeMint])

  return (
    <div className="space-y-2">
      <div className="flex gap-1 p-1 rounded-xl bg-white/5 border border-line w-fit">
        {(['top', 'hot'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
              tab === t ? 'bg-brand text-white' : 'text-mist hover:text-white'
            }`}
          >
            {t === 'top' ? 'Top 1000' : '🔥 Hot'}
          </button>
        ))}
      </div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-white/5 border border-line rounded-lg px-3 py-2 text-sm"
      />
      {active.status === 'error' && (
        <p className="text-xs text-lose">
          {tab === 'top' ? 'Top' : 'Trending'} token list unavailable right now — showing famous
          coins only.
        </p>
      )}
      {active.status === 'loading' && active.tokens.length === 0 && (
        <p className="text-xs text-mist">Loading {tab === 'top' ? 'top' : 'trending'} tokens…</p>
      )}
      {results.length > 0 && (
        <div className="rounded-lg border border-line divide-y divide-line overflow-hidden max-h-72 overflow-y-auto">
          {results.map((t) => {
            const ref = 'address' in t ? toTokenRef(t) : t
            const mint = 'address' in t ? t.address : t.mint
            return (
              <button
                key={mint}
                type="button"
                onClick={() => onSelect(ref)}
                className="w-full flex items-center justify-between gap-3 px-3 py-2 hover:bg-white/5 text-left"
              >
                <TokenTag token={ref} size="sm" />
                <span className="text-xs font-mono text-fog shrink-0">{shortMint(mint)}</span>
              </button>
            )
          })}
        </div>
      )}
      {results.length === 0 && query && (
        <p className="text-xs text-fog">No match in {tab === 'top' ? 'the top 1000' : 'hot tokens'}.</p>
      )}
    </div>
  )
}
