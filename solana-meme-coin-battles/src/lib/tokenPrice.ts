import { useEffect, useState } from 'react'

const PRICE_ENDPOINT = 'https://api.jup.ag/price/v2'
const POLL_MS = 30_000

/**
 * Live USD price by mint address, for battles — which can involve any
 * verified token, not just the curated famous-coins list (that one still
 * uses CoinGecko, see lib/prices.ts). Missing/unreachable mints are simply
 * absent from the returned map; callers should treat that as "unknown" and
 * hold off on anything that needs a price (joining, settling) until it
 * resolves.
 */
/** One-shot lookup — used to capture a fresh reference price at the exact
 * moment a battle is joined, rather than relying on the polling cache
 * (which may not have the joiner's just-chosen token yet). */
export async function fetchTokenPrice(mint: string): Promise<number | undefined> {
  try {
    const res = await fetch(`${PRICE_ENDPOINT}?ids=${mint}`)
    if (!res.ok) return undefined
    const json = await res.json()
    const price = json.data?.[mint]?.price
    return price ? Number(price) : undefined
  } catch {
    return undefined
  }
}

export function useTokenPrices(mints: string[]) {
  const key = [...new Set(mints.filter(Boolean))].sort().join(',')
  const [prices, setPrices] = useState<Record<string, number>>({})

  useEffect(() => {
    if (!key) return
    let cancelled = false

    async function load() {
      try {
        const res = await fetch(`${PRICE_ENDPOINT}?ids=${key}`)
        if (!res.ok) throw new Error(`status ${res.status}`)
        const json = await res.json()
        const next: Record<string, number> = {}
        for (const [mint, entry] of Object.entries(json.data ?? {})) {
          const price = (entry as { price?: string } | null)?.price
          if (price) next[mint] = Number(price)
        }
        if (!cancelled) setPrices((prev) => ({ ...prev, ...next }))
      } catch {
        // Keep whatever prices we already have; missing ones stay "unknown".
      }
    }

    load()
    const id = setInterval(load, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [key])

  return prices
}
