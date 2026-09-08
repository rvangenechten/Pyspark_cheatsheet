import { useEffect, useState } from 'react'
import { FAMOUS_COINS } from './coins'

export interface PricePoint {
  usd: number
  usd_24h_change: number
}

export type PriceMap = Record<string, PricePoint>

const IDS = FAMOUS_COINS.map((c) => c.coingeckoId).join(',')
const ENDPOINT = `https://api.coingecko.com/api/v3/simple/price?ids=${IDS}&vs_currencies=usd&include_24hr_change=true`
const POLL_MS = 30_000

// Fallback prices so the UI stays populated if the API is rate-limited or
// unreachable (CoinGecko's free tier is aggressively throttled).
const FALLBACK: PriceMap = {
  bonk: { usd: 0.0000185, usd_24h_change: 1.4 },
  dogwifcoin: { usd: 0.72, usd_24h_change: -2.1 },
  popcat: { usd: 0.31, usd_24h_change: 3.6 },
  'cat-in-a-dogs-world': { usd: 0.0041, usd_24h_change: -0.8 },
  'book-of-meme': { usd: 0.0056, usd_24h_change: 0.9 },
  'peanut-the-squirrel': { usd: 0.18, usd_24h_change: 4.2 },
  fartcoin: { usd: 0.63, usd_24h_change: -1.6 },
  'moo-deng': { usd: 0.14, usd_24h_change: 2.9 },
}

let cache: PriceMap | null = null

export function usePrices() {
  const [prices, setPrices] = useState<PriceMap>(cache ?? FALLBACK)
  const [loading, setLoading] = useState(!cache)
  const [stale, setStale] = useState(!cache)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const res = await fetch(ENDPOINT)
        if (!res.ok) throw new Error(`price fetch failed: ${res.status}`)
        const data = (await res.json()) as PriceMap
        if (!cancelled && Object.keys(data).length > 0) {
          cache = data
          setPrices(data)
          setStale(false)
        }
      } catch {
        if (!cancelled) setStale(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    const interval = setInterval(load, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  return { prices, loading, stale }
}

export function priceFor(prices: PriceMap, coingeckoId: string): number {
  return prices[coingeckoId]?.usd ?? FALLBACK[coingeckoId]?.usd ?? 0
}
