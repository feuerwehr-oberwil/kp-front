import { useEffect, useState } from 'react'

// True while the browser reports network connectivity. Reactive to the online/offline
// events. `navigator.onLine` is only a hint (true doesn't guarantee reachability), so use
// this to CHOOSE a richer-vs-cached data path, never to gate a hard failure — the service
// worker's stale-while-revalidate still serves the cache if an "online" fetch fails.
export function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}
