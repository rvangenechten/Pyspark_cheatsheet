import { FAMOUS_COINS, type Coin } from './coins'

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
