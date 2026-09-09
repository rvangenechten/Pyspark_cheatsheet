import { useEffect, useState } from 'react'
import type { TokenRef } from '../lib/tokens'

export function TokenTag({ token, size = 'md' }: { token: TokenRef; size?: 'sm' | 'md' | 'lg' }) {
  const dims = size === 'lg' ? 'w-11 h-11 text-xl' : size === 'sm' ? 'w-6 h-6 text-xs' : 'w-8 h-8 text-sm'

  // Token logos come from wherever each project hosted them — slow CDNs,
  // dead links, and IPFS gateways are common. Without this, a failed image
  // leaves the browser's broken-image glyph sitting in the circle; this
  // falls back to the emoji/initial instead, same as when there's no
  // logoURI at all.
  const [imgFailed, setImgFailed] = useState(false)
  useEffect(() => setImgFailed(false), [token.logoURI])
  const showImg = Boolean(token.logoURI) && !imgFailed

  return (
    <div className="flex items-center gap-2">
      <div
        className={`${dims} rounded-full flex items-center justify-center shrink-0 overflow-hidden`}
        style={{ background: `${token.color ?? '#7c5cff'}22`, border: `1px solid ${token.color ?? '#7c5cff'}55` }}
      >
        {showImg ? (
          <img
            src={token.logoURI}
            alt=""
            loading="lazy"
            className="w-full h-full object-cover"
            onError={() => setImgFailed(true)}
          />
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
