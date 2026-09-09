import type { ModeId } from './coins'

export interface DuelPair {
  id: string
  coinA: string
  coinB: string
}

export const DUEL_PAIRS: DuelPair[] = [
  { id: 'bonk-wif', coinA: 'bonk', coinB: 'wif' },
  { id: 'popcat-mew', coinA: 'popcat', coinB: 'mew' },
  { id: 'bome-pnut', coinA: 'bome', coinB: 'pnut' },
  { id: 'fartcoin-moodeng', coinA: 'fartcoin', coinB: 'moodeng' },
]

// Stake window (picks close, "starts in X minutes" counts down to this)
// followed by the price-tracking duration for the round.
const CYCLE: Record<ModeId, { stakeMs: number; durationMs: number }> = {
  '5min': { stakeMs: 60 * 1000, durationMs: 5 * 60 * 1000 },
  '1h': { stakeMs: 5 * 60 * 1000, durationMs: 60 * 60 * 1000 },
  '24h': { stakeMs: 20 * 60 * 1000, durationMs: 24 * 60 * 60 * 1000 },
}

export interface RoundWindow {
  roundIndex: number
  roundStart: number
  locksAt: number
  endsAt: number
}

// Deterministic, server-free "round clock" — every client computes the same
// current round from wall-clock time, so no coordinator is needed for a demo.
export function currentRound(mode: ModeId, now = Date.now()): RoundWindow {
  const { stakeMs, durationMs } = CYCLE[mode]
  const cycleMs = stakeMs + durationMs
  const roundIndex = Math.floor(now / cycleMs)
  const roundStart = roundIndex * cycleMs
  return { roundIndex, roundStart, locksAt: roundStart + stakeMs, endsAt: roundStart + cycleMs }
}

export function roundKey(pairId: string, mode: ModeId, roundIndex: number) {
  return `${pairId}:${mode}:${roundIndex}`
}

// Fixed stake sizes rather than a freeform amount — keeps bet sizes legible
// at a glance and makes "both sides equal" easy to reason about visually.
export const STAKE_SIZES_SOL = [0.1, 0.5, 1, 5] as const

export type Side = 'A' | 'B'

export interface RoundPool {
  A: Record<string, number> // wallet -> staked amount (SOL)
  B: Record<string, number>
}

export function emptyPool(): RoundPool {
  return { A: {}, B: {} }
}

export function totalOf(pool: RoundPool, side: Side): number {
  return Object.values(pool[side]).reduce((a, b) => a + b, 0)
}

// The pool that's behind can freely catch up; the pool that's ahead is
// capped at zero until the other side matches it. This is what keeps both
// sides equal at every moment without a matching engine.
export function maxStake(pool: RoundPool, side: Side): number {
  const thisTotal = totalOf(pool, side)
  const otherTotal = totalOf(pool, side === 'A' ? 'B' : 'A')
  if (thisTotal > otherTotal) return 0
  if (thisTotal < otherTotal) return otherTotal - thisTotal
  return Infinity
}

export function addStake(pool: RoundPool, side: Side, wallet: string, amount: number): RoundPool {
  const cap = maxStake(pool, side)
  const clamped = Math.min(amount, cap)
  if (clamped <= 0) return pool
  return {
    ...pool,
    [side]: { ...pool[side], [wallet]: (pool[side][wallet] ?? 0) + clamped },
  }
}

export function stakeOf(pool: RoundPool, side: Side, wallet: string): number {
  return pool[side][wallet] ?? 0
}

// Settles a locked round: any stake beyond the matched (equal) portion is
// refunded — it was never actually at risk — and the matched portion either
// doubles (winner) or is lost (loser). Because both matched pools are equal
// by construction, "double the matched stake" and "matched stake + opponent
// pool share" are the same number, so this stays a flat payout instead of a
// pari-mutuel split.
export function settleRound(pool: RoundPool, winner: Side): Record<string, number> {
  const totalA = totalOf(pool, 'A')
  const totalB = totalOf(pool, 'B')
  const matched = Math.min(totalA, totalB)
  const payouts: Record<string, number> = {}

  for (const side of ['A', 'B'] as const) {
    const sideTotal = totalOf(pool, side)
    const matchedRatio = sideTotal > 0 ? matched / sideTotal : 0
    for (const [wallet, stake] of Object.entries(pool[side])) {
      const matchedStake = stake * matchedRatio
      const refund = stake - matchedStake
      const winnings = side === winner ? matchedStake * 2 : 0
      payouts[wallet] = (payouts[wallet] ?? 0) + refund + winnings
    }
  }

  return payouts
}
