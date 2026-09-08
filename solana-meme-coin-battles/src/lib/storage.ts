import { useCallback, useEffect, useState } from 'react'

// Demo-only persistence. Everything here lives in localStorage so the app
// works without a backend; a real deployment would replace this with reads
// from the on-chain program (see /program) via the keeper/indexer.
export function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // storage full or unavailable — demo state just won't persist
    }
  }, [key, value])

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === key && e.newValue) {
        try {
          setValue(JSON.parse(e.newValue) as T)
        } catch {
          /* ignore malformed external write */
        }
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [key])

  const update = useCallback((updater: T | ((prev: T) => T)) => {
    setValue((prev) =>
      typeof updater === 'function' ? (updater as (prev: T) => T)(prev) : updater,
    )
  }, [])

  return [value, update] as const
}
