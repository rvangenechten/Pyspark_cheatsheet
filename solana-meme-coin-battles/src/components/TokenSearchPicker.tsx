import { useMemo, useState } from 'react'
import {
  findVerifiedByMint,
  looksLikeMintAddress,
  searchVerified,
  useVerifiedTokenList,
} from '../lib/verifiedTokens'
import { FAMOUS_TOKEN_REFS, type TokenRef } from '../lib/tokens'
import { TokenTag } from './TokenTag'

function famousMatches(query: string, excludeMint?: string): TokenRef[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return FAMOUS_TOKEN_REFS.filter(
    (t) =>
      t.mint !== excludeMint &&
      (t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q)),
  )
}

export function TokenSearchPicker({
  onSelect,
  excludeMint,
  placeholder = 'Search a verified token, or paste a mint address',
}: {
  onSelect: (token: TokenRef) => void
  excludeMint?: string
  placeholder?: string
}) {
  const [query, setQuery] = useState('')
  const { tokens, status } = useVerifiedTokenList()

  const results = useMemo(() => {
    const famous = famousMatches(query, excludeMint)
    const famousMints = new Set(famous.map((t) => t.mint))
    const verified = searchVerified(tokens, query, 8)
      .filter((t) => t.address !== excludeMint && !famousMints.has(t.address))
      .map<TokenRef>((t) => ({
        key: t.address,
        mint: t.address,
        symbol: t.symbol,
        name: t.name,
        logoURI: t.logoURI,
      }))
    return [...famous, ...verified].slice(0, 8)
  }, [query, tokens, excludeMint])

  const trimmed = query.trim()
  const showAddressCheck =
    looksLikeMintAddress(trimmed) && trimmed !== excludeMint && results.every((r) => r.mint !== trimmed)
  const addressMatch = showAddressCheck ? findVerifiedByMint(tokens, trimmed) : undefined

  function pick(token: TokenRef) {
    onSelect(token)
    setQuery('')
  }

  return (
    <div className="space-y-2">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-white/5 border border-line rounded-lg px-3 py-2 text-sm"
      />
      {status === 'error' && (
        <p className="text-xs text-lose">
          Verified token list unavailable right now — only famous coins are searchable.
        </p>
      )}
      {results.length > 0 && (
        <div className="rounded-lg border border-line divide-y divide-line overflow-hidden">
          {results.map((t) => (
            <button
              key={t.mint}
              type="button"
              onClick={() => pick(t)}
              className="w-full flex items-center justify-between px-3 py-2 hover:bg-white/5 text-left"
            >
              <TokenTag token={t} size="sm" />
              <span className="text-xs text-win shrink-0">verified</span>
            </button>
          ))}
        </div>
      )}
      {showAddressCheck && status === 'loading' && (
        <p className="text-xs text-mist">Checking verification…</p>
      )}
      {showAddressCheck && status === 'ready' && addressMatch && (
        <button
          type="button"
          onClick={() =>
            pick({
              key: addressMatch.address,
              mint: addressMatch.address,
              symbol: addressMatch.symbol,
              name: addressMatch.name,
              logoURI: addressMatch.logoURI,
            })
          }
          className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-win/40 bg-win/10 hover:bg-win/20 text-left"
        >
          <TokenTag
            token={{
              key: addressMatch.address,
              mint: addressMatch.address,
              symbol: addressMatch.symbol,
              name: addressMatch.name,
              logoURI: addressMatch.logoURI,
            }}
            size="sm"
          />
          <span className="text-xs text-win shrink-0">✓ verified — use this</span>
        </button>
      )}
      {showAddressCheck && status === 'ready' && !addressMatch && (
        <p className="text-xs text-lose">
          That address isn't on the verified token list — it can't be used here.
        </p>
      )}
    </div>
  )
}
