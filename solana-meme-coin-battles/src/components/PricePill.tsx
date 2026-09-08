export function PricePill({ usd, change }: { usd: number; change?: number }) {
  const up = (change ?? 0) >= 0
  return (
    <div className="text-right">
      <div className="font-mono text-sm">
        ${usd < 0.01 ? usd.toPrecision(3) : usd.toFixed(2)}
      </div>
      {change !== undefined && (
        <div className={`text-xs font-mono ${up ? 'text-win' : 'text-lose'}`}>
          {up ? '+' : ''}
          {change.toFixed(2)}%
        </div>
      )}
    </div>
  )
}
