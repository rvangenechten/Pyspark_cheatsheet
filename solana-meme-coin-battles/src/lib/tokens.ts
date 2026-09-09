import { coinById, FAMOUS_COINS, type Coin } from './coins'
import { useLocalStorage } from './storage'

/** A token as used anywhere in the app, regardless of where it came from. */
export interface TokenRef {
  /** Vault balance key: a famous coin's id, or a mint address for anything else. */
  key: string
  mint: string
  symbol: string
  name: string
  logoURI?: string
  emoji?: string
  color?: string
}

export function tokenRefFromCoin(coin: Coin): TokenRef {
  return {
    key: coin.id,
    mint: coin.mint,
    symbol: coin.symbol,
    name: coin.name,
    emoji: coin.emoji,
    color: coin.color,
  }
}

export const FAMOUS_TOKEN_REFS: TokenRef[] = FAMOUS_COINS.map(tokenRefFromCoin)

/**
 * Custom (non-famous) tokens people have actually picked or deposited get
 * remembered here so their symbol/logo keep displaying even if the verified
 * token list is unreachable on a later visit, or the token drops off it.
 */
export function useCustomTokenRegistry() {
  return useLocalStorage<Record<string, TokenRef>>('custom-tokens', {})
}

export function rememberToken(
  registry: Record<string, TokenRef>,
  setRegistry: (u: Record<string, TokenRef> | ((p: Record<string, TokenRef>) => Record<string, TokenRef>)) => void,
  token: TokenRef,
) {
  if (registry[token.key]?.mint === token.mint) return
  setRegistry((r) => ({ ...r, [token.key]: token }))
}

/** Resolves a vault key back to a displayable token: famous coin first, then the custom registry. */
export function resolveToken(key: string, registry: Record<string, TokenRef>): TokenRef | undefined {
  const famous = coinById(key)
  if (famous) return tokenRefFromCoin(famous)
  return registry[key]
}

/** All tokens a wallet currently holds a positive vault balance of. */
export function heldTokens(
  vault: Record<string, Record<string, number>>,
  wallet: string,
  registry: Record<string, TokenRef>,
): { token: TokenRef; balance: number }[] {
  const holdings = vault[wallet] ?? {}
  const result: { token: TokenRef; balance: number }[] = []
  for (const [key, balance] of Object.entries(holdings)) {
    if (key === 'SOL' || balance <= 0) continue
    const token = resolveToken(key, registry)
    if (token) result.push({ token, balance })
  }
  return result
}
