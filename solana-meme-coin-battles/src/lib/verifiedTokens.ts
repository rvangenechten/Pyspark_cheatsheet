import { useEffect, useState } from 'react'

export interface VerifiedTokenEntry {
  address: string
  symbol: string
  name: string
  logoURI?: string
}

// Jupiter's "strict" list: the community-curated set of tokens Jupiter's own
// swap UI treats as verified. It's the closest thing Solana has to a
// standard verification signal for an arbitrary token, so it's what gates
// "any random token" battles here — a token not on this list can't be used.
const STRICT_LIST_URL = 'https://token.jup.ag/strict'

let cache: VerifiedTokenEntry[] | null = null
let inFlight: Promise<VerifiedTokenEntry[]> | null = null

async function fetchList(): Promise<VerifiedTokenEntry[]> {
  if (cache) return cache
  if (!inFlight) {
    inFlight = fetch(STRICT_LIST_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`status ${res.status}`)
        return res.json()
      })
      .then((data: VerifiedTokenEntry[]) => {
        cache = data
        return data
      })
      .catch((err) => {
        inFlight = null
        throw err
      })
  }
  return inFlight
}

export type ListStatus = 'loading' | 'ready' | 'error'

export function useVerifiedTokenList() {
  const [tokens, setTokens] = useState<VerifiedTokenEntry[]>(cache ?? [])
  const [status, setStatus] = useState<ListStatus>(cache ? 'ready' : 'loading')

  useEffect(() => {
    if (cache) {
      setTokens(cache)
      setStatus('ready')
      return
    }
    let cancelled = false
    fetchList()
      .then((list) => {
        if (!cancelled) {
          setTokens(list)
          setStatus('ready')
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { tokens, status }
}

export function searchVerified(
  list: VerifiedTokenEntry[],
  query: string,
  limit = 8,
): VerifiedTokenEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const exact: VerifiedTokenEntry[] = []
  const prefix: VerifiedTokenEntry[] = []
  const contains: VerifiedTokenEntry[] = []
  for (const t of list) {
    const sym = t.symbol.toLowerCase()
    const name = t.name.toLowerCase()
    if (sym === q) exact.push(t)
    else if (sym.startsWith(q) || name.startsWith(q)) prefix.push(t)
    else if (sym.includes(q) || name.includes(q)) contains.push(t)
    if (exact.length + prefix.length >= limit) break
  }
  return [...exact, ...prefix, ...contains].slice(0, limit)
}

export function findVerifiedByMint(
  list: VerifiedTokenEntry[],
  mint: string,
): VerifiedTokenEntry | undefined {
  return list.find((t) => t.address === mint)
}

// Base58 alphabet, Solana address lengths — good enough to tell "looks like
// an address" from "still typing a symbol" without being a full validator.
export function looksLikeMintAddress(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim())
}
