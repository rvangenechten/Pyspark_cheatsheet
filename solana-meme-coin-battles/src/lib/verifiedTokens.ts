import { useEffect, useState } from 'react'

export interface VerifiedTokenEntry {
  address: string
  symbol: string
  name: string
  logoURI?: string
}

// Jupiter's Token API v2 — ranked/curated endpoints, not just a flat
// "is this verified" list. `toporganicscore` ranks by Jupiter's own
// bot-resistant quality score (a reasonable proxy for "top by legitimate
// size/activity"); `toptrending` is newly-hot tokens over the window.
// Both only return tokens Jupiter itself treats as tradeable/verified.
const API_BASE = 'https://lite-api.jup.ag/tokens/v2'
const TOP_LIMIT = 1000
const TRENDING_LIMIT = 100
const TOP_REFRESH_MS = 5 * 60 * 1000
const TRENDING_REFRESH_MS = 2 * 60 * 1000

// Shape returned by Jupiter's v2 endpoints has shifted before, so this
// normalizer accepts a few plausible field-name variants rather than
// assuming one exact shape — an entry only survives if it at least has a
// usable address, symbol, and name.
function normalize(raw: unknown): VerifiedTokenEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const address = r.id ?? r.address ?? r.mint
  const symbol = r.symbol
  const name = r.name
  const logoURI = r.icon ?? r.logoURI ?? r.image
  if (typeof address !== 'string' || typeof symbol !== 'string' || typeof name !== 'string') {
    return null
  }
  return { address, symbol, name, logoURI: typeof logoURI === 'string' ? logoURI : undefined }
}

async function fetchRanked(path: string, limit: number): Promise<VerifiedTokenEntry[]> {
  const res = await fetch(`${API_BASE}${path}?limit=${limit}`)
  if (!res.ok) throw new Error(`status ${res.status}`)
  const data = await res.json()
  const list = Array.isArray(data) ? data : (data.tokens ?? data.data ?? [])
  const entries = list.map(normalize).filter((t: VerifiedTokenEntry | null): t is VerifiedTokenEntry => t !== null)
  if (entries.length === 0) throw new Error('empty or unrecognized response')
  return entries
}

interface Cache {
  entries: VerifiedTokenEntry[]
  fetchedAt: number
}

let topCache: Cache | null = null
let trendingCache: Cache | null = null

export type ListStatus = 'loading' | 'ready' | 'error'

function useRankedList(
  cacheRef: { current: Cache | null },
  fetcher: () => Promise<VerifiedTokenEntry[]>,
  refreshMs: number,
) {
  const [tokens, setTokens] = useState<VerifiedTokenEntry[]>(cacheRef.current?.entries ?? [])
  const [status, setStatus] = useState<ListStatus>(cacheRef.current ? 'ready' : 'loading')

  useEffect(() => {
    const fresh = cacheRef.current && Date.now() - cacheRef.current.fetchedAt < refreshMs
    if (fresh) {
      setTokens(cacheRef.current!.entries)
      setStatus('ready')
      return
    }
    let cancelled = false
    setStatus(cacheRef.current ? 'ready' : 'loading') // keep showing stale data while refreshing
    fetcher()
      .then((entries) => {
        cacheRef.current = { entries, fetchedAt: Date.now() }
        if (!cancelled) {
          setTokens(entries)
          setStatus('ready')
        }
      })
      .catch(() => {
        if (!cancelled && !cacheRef.current) setStatus('error')
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { tokens, status }
}

// Module-level boxes so the cache survives component unmount/remount
// (matches the pattern in lib/prices.ts and lib/tokenPrice.ts).
const topBox = {
  get current() {
    return topCache
  },
  set current(v: Cache | null) {
    topCache = v
  },
}
const trendingBox = {
  get current() {
    return trendingCache
  },
  set current(v: Cache | null) {
    trendingCache = v
  },
}

export function useTopTokens() {
  return useRankedList(topBox, () => fetchRanked('/toporganicscore/24h', TOP_LIMIT), TOP_REFRESH_MS)
}

export function useTrendingTokens() {
  return useRankedList(trendingBox, () => fetchRanked('/toptrending/1h', TRENDING_LIMIT), TRENDING_REFRESH_MS)
}

export function searchWithin(list: VerifiedTokenEntry[], query: string, limit = 20): VerifiedTokenEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return list.slice(0, limit)
  const exact: VerifiedTokenEntry[] = []
  const prefix: VerifiedTokenEntry[] = []
  const contains: VerifiedTokenEntry[] = []
  for (const t of list) {
    const sym = t.symbol.toLowerCase()
    const name = t.name.toLowerCase()
    if (sym === q) exact.push(t)
    else if (sym.startsWith(q) || name.startsWith(q)) prefix.push(t)
    else if (sym.includes(q) || name.includes(q) || t.address.toLowerCase().includes(q)) contains.push(t)
    if (exact.length + prefix.length >= limit) break
  }
  return [...exact, ...prefix, ...contains].slice(0, limit)
}
