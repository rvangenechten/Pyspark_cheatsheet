import type { Coin } from '../lib/coins'

export function CoinTag({ coin, size = 'md' }: { coin: Coin; size?: 'sm' | 'md' | 'lg' }) {
  const dims = size === 'lg' ? 'w-11 h-11 text-xl' : size === 'sm' ? 'w-6 h-6 text-xs' : 'w-8 h-8 text-sm'
  return (
    <div className="flex items-center gap-2">
      <div
        className={`${dims} rounded-full flex items-center justify-center shrink-0`}
        style={{ background: `${coin.color}22`, border: `1px solid ${coin.color}55` }}
      >
        <span>{coin.emoji}</span>
      </div>
      <div className="text-left">
        <div className="font-semibold text-sm leading-tight">{coin.symbol}</div>
        {size !== 'sm' && <div className="text-xs text-fog leading-tight">{coin.name}</div>}
      </div>
    </div>
  )
}
