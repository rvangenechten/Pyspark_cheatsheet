import type { TokenRef } from '../lib/tokens'

export function TokenTag({ token, size = 'md' }: { token: TokenRef; size?: 'sm' | 'md' | 'lg' }) {
  const dims = size === 'lg' ? 'w-11 h-11 text-xl' : size === 'sm' ? 'w-6 h-6 text-xs' : 'w-8 h-8 text-sm'
  return (
    <div className="flex items-center gap-2">
      <div
        className={`${dims} rounded-full flex items-center justify-center shrink-0 overflow-hidden`}
        style={{ background: `${token.color ?? '#7c5cff'}22`, border: `1px solid ${token.color ?? '#7c5cff'}55` }}
      >
        {token.logoURI ? (
          <img src={token.logoURI} alt="" className="w-full h-full object-cover" />
        ) : token.emoji ? (
          <span>{token.emoji}</span>
        ) : (
          <span className="font-semibold">{token.symbol.slice(0, 1)}</span>
        )}
      </div>
      <div className="text-left min-w-0">
        <div className="font-semibold text-sm leading-tight truncate">{token.symbol}</div>
        {size !== 'sm' && <div className="text-xs text-fog leading-tight truncate">{token.name}</div>}
      </div>
    </div>
  )
}
