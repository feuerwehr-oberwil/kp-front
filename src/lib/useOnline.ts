import { useSyncExternalStore } from 'react'
import { isOnline, subscribeOnline } from './connectivity'

// True unless the browser said `offline` and nothing has answered since (lib/connectivity): the
// `online` event OR any fresh successful answer from our server turns it back on, so a missed
// `online` event no longer leaves it stuck. Still only a hint — use it to CHOOSE a
// richer-vs-cached data path, never to gate a hard failure; the service worker's
// stale-while-revalidate still serves the cache if an "online" fetch fails.
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, isOnline, () => true)
}
