import { modeById, type ModeId } from './coins'
import type { TokenRef } from './tokens'

export type CollateralAsset = 'SOL' | 'USDC'

export interface BattleSide {
  wallet: string
}

export interface Battle {
  id: string
  mode: ModeId
  /** The coin each side is backing — not held, just bet on. */
  tokenA: TokenRef
  /** Unset until someone accepts — any verified token, chosen by whoever joins. */
  tokenB?: TokenRef
  collateral: CollateralAsset
  wager: number // equal collateral stake, in `collateral` units, on both sides
  sideA: BattleSide
  sideB?: BattleSide
  createdAt: number
  joinDeadline: number
  startsAt?: number
  endsAt?: number
  startPriceA?: number
  startPriceB?: number
  endPriceA?: number
  endPriceB?: number
  winner?: 'A' | 'B'
  settledAt?: number
}

// Fixed "get ready" countdown once an opponent joins, before the price
// window officially starts — this is the "starts in X minutes" the brief
// asked for. A production keeper (see /keeper) would snapshot the reference
// price exactly at startsAt instead of at match time.
export const PREP_WINDOW_MS = 60 * 1000

export type DerivedStatus = 'open' | 'expired' | 'starting' | 'active' | 'settled'

export function derivedStatus(battle: Battle, now: number): DerivedStatus {
  if (battle.winner) return 'settled'
  if (!battle.sideB) return now > battle.joinDeadline ? 'expired' : 'open'
  if (battle.startsAt && now < battle.startsAt) return 'starting'
  if (battle.endsAt && now < battle.endsAt) return 'active'
  return 'active' // ready to settle, settlement flips it to 'settled'
}

export function createBattle(
  tokenA: TokenRef,
  collateral: CollateralAsset,
  mode: ModeId,
  wager: number,
  wallet: string,
): Battle {
  const now = Date.now()
  const m = modeById(mode)
  return {
    id: crypto.randomUUID(),
    mode,
    tokenA,
    collateral,
    wager,
    sideA: { wallet },
    createdAt: now,
    joinDeadline: now + m.joinWindowMs,
  }
}

/** Any verified token can be backed — `tokenB` is the joiner's own choice. */
export function joinBattle(
  battle: Battle,
  wallet: string,
  tokenB: TokenRef,
  startPriceA: number,
  startPriceB: number,
): Battle {
  const now = Date.now()
  const m = modeById(battle.mode)
  const startsAt = now + PREP_WINDOW_MS
  return {
    ...battle,
    tokenB,
    sideB: { wallet },
    startsAt,
    endsAt: startsAt + m.durationMs,
    startPriceA,
    startPriceB,
  }
}

export function settleBattle(battle: Battle, endPriceA: number, endPriceB: number): Battle {
  if (!battle.startPriceA || !battle.startPriceB) return battle
  const pctA = (endPriceA - battle.startPriceA) / battle.startPriceA
  const pctB = (endPriceB - battle.startPriceB) / battle.startPriceB
  return {
    ...battle,
    endPriceA,
    endPriceB,
    winner: pctA === pctB ? (battle.sideA.wallet < (battle.sideB?.wallet ?? '') ? 'A' : 'B') : pctA > pctB ? 'A' : 'B',
    settledAt: Date.now(),
  }
}

export function pctChange(start: number | undefined, end: number | undefined): number | null {
  if (!start || end === undefined) return null
  return ((end - start) / start) * 100
}
