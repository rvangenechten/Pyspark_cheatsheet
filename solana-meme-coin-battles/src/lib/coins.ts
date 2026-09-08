export interface Coin {
  id: string
  symbol: string
  name: string
  mint: string
  coingeckoId: string
  color: string
  emoji: string
}

// A curated set of well-known Solana meme coins. Mint addresses are the real
// mainnet mints (used only to look up live prices) — this app never moves
// real tokens, see the README for the devnet-only scope.
export const FAMOUS_COINS: Coin[] = [
  {
    id: 'bonk',
    symbol: 'BONK',
    name: 'Bonk',
    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    coingeckoId: 'bonk',
    color: '#f6a723',
    emoji: '🐕',
  },
  {
    id: 'wif',
    symbol: 'WIF',
    name: 'dogwifhat',
    mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    coingeckoId: 'dogwifcoin',
    color: '#c9b7f9',
    emoji: '🐶',
  },
  {
    id: 'popcat',
    symbol: 'POPCAT',
    name: 'Popcat',
    mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
    coingeckoId: 'popcat',
    color: '#f6d94a',
    emoji: '🐱',
  },
  {
    id: 'mew',
    symbol: 'MEW',
    name: 'cat in a dogs world',
    mint: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5',
    coingeckoId: 'cat-in-a-dogs-world',
    color: '#7ee8b8',
    emoji: '😼',
  },
  {
    id: 'bome',
    symbol: 'BOME',
    name: 'Book of Meme',
    mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82',
    coingeckoId: 'book-of-meme',
    color: '#ff8fb1',
    emoji: '📖',
  },
  {
    id: 'pnut',
    symbol: 'PNUT',
    name: 'Peanut the Squirrel',
    mint: '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump',
    coingeckoId: 'peanut-the-squirrel',
    color: '#d9a066',
    emoji: '🐿️',
  },
  {
    id: 'fartcoin',
    symbol: 'FARTCOIN',
    name: 'Fartcoin',
    mint: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump',
    coingeckoId: 'fartcoin',
    color: '#a78bfa',
    emoji: '💨',
  },
  {
    id: 'moodeng',
    symbol: 'MOODENG',
    name: 'Moo Deng',
    mint: 'ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY',
    coingeckoId: 'moo-deng',
    color: '#fb7185',
    emoji: '🦛',
  },
]

export const CHAINS = [
  {
    id: 'solana',
    name: 'Solana',
    status: 'live' as const,
    note: 'Devnet demo — wallet connect, vaults, and battles are fully wired up.',
  },
  {
    id: 'robinhood',
    name: 'Robinhood Chain',
    status: 'coming-soon' as const,
    note: 'Robinhood Chain is a newly announced Arbitrum-based L2 for tokenized assets. Its token ecosystem and price feeds aren’t established enough yet to wire up honestly — support is stubbed out and will land once there’s a reliable data source.',
  },
]

export function coinById(id: string): Coin | undefined {
  return FAMOUS_COINS.find((c) => c.id === id)
}

export const MODES = [
  { id: '5min', label: '5 Minute', durationMs: 5 * 60 * 1000, joinWindowMs: 90 * 1000 },
  { id: '1h', label: '1 Hour', durationMs: 60 * 60 * 1000, joinWindowMs: 5 * 60 * 1000 },
  { id: '24h', label: '24 Hour', durationMs: 24 * 60 * 60 * 1000, joinWindowMs: 30 * 60 * 1000 },
] as const

export type ModeId = (typeof MODES)[number]['id']

export function modeById(id: ModeId) {
  return MODES.find((m) => m.id === id)!
}
