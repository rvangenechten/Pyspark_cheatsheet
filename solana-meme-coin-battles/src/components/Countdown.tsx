import { useEffect, useState } from 'react'

function format(msLeft: number): string {
  if (msLeft <= 0) return '0s'
  const totalSec = Math.floor(msLeft / 1000)
  const d = Math.floor(totalSec / 86400)
  const h = Math.floor((totalSec % 86400) / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function useCountdown(target: number | undefined) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!target) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [target])
  if (!target) return { label: '—', msLeft: 0, done: true }
  const msLeft = target - now
  return { label: format(msLeft), msLeft, done: msLeft <= 0 }
}

export function Countdown({
  target,
  prefix = 'Starts in',
  doneLabel = 'Live now',
  className = '',
}: {
  target: number | undefined
  prefix?: string
  doneLabel?: string
  className?: string
}) {
  const { label, done } = useCountdown(target)
  return (
    <span className={className}>
      {done ? doneLabel : `${prefix} ${label}`}
    </span>
  )
}
