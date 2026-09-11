// Load-once fetcher for the big bundled reference datasets (public/un-hazard.json,
// public/erg.json — the tactical-symbols.json pattern, minus the artwork pipeline).
//
// They used to be JSON imports compiled into the entry chunk: ~0.5 MB of object literals
// parsed on every boot, for data most incidents never open. As static assets they are
// precached by the service worker (offline like the rest of the app shell, revisioned per
// deploy) and parsed once, natively, off the boot path.
//
// The contract consumers build on:
//   • `get()` is synchronous and returns null until the data has landed — lookup helpers
//     stay sync and simply miss during the sub-second window after boot (main.tsx kicks
//     `ensure()` at startup, so in practice the data is there before anyone types a UN-Nr).
//   • `subscribe()`/`version()` feed useSyncExternalStore, so surfaces that rendered during
//     that window re-render once the data lands (see lib/useHazardData).
//   • A failed fetch retries on a short backoff, then again on any later `ensure()` — the
//     precache makes failure rare, but a captive portal must not permanently blank the
//     Gefahrentafel readout.

/** Retry delays after a failed load; a later ensure() starts the chain over. */
export const STATIC_DATA_RETRY_MS = [2_000, 10_000]

export interface StaticDataset<T> {
  /** The data, or null until the load lands. Synchronous — safe in render. */
  get(): T | null
  /** Start the load-once fetch (no-op once loaded); resolves with the data or null. */
  ensure(): Promise<T | null>
  /** Notify on data arrival; returns the unsubscribe. */
  subscribe(cb: () => void): () => void
  /** Bumps when data lands — the useSyncExternalStore snapshot. */
  version(): number
  /** Inject data synchronously (tests; also used by ensure() internally). */
  set(data: T): void
}

export function createStaticDataset<T>(
  file: string,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): StaticDataset<T> {
  let data: T | null = null
  let ver = 0
  let inflight: Promise<T | null> | null = null
  const listeners = new Set<() => void>()

  const set = (d: T) => {
    data = d
    ver++
    inflight = null
    for (const cb of [...listeners]) cb()
  }

  const load = async (): Promise<T | null> => {
    for (let attempt = 0; ; attempt++) {
      if (data) return data
      try {
        const res = await fetchImpl(`${import.meta.env.BASE_URL}${file}`)
        if (res.ok) {
          set((await res.json()) as T)
          return data
        }
      } catch { /* offline gap / captive portal — retry below */ }
      const delay = STATIC_DATA_RETRY_MS[attempt]
      if (delay === undefined) {
        inflight = null // give up for now; the next ensure() starts over
        return null
      }
      await sleep(delay)
    }
  }

  return {
    get: () => data,
    ensure: () => (data ? Promise.resolve(data) : (inflight ??= load())),
    subscribe: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    version: () => ver,
    set,
  }
}
