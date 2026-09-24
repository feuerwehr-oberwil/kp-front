import { vi } from 'vitest'

// Simulated devices for the «one login, three tablets» tests (post-mortem 23.09.2026).
//
// A second device differs from the first in exactly the two things an id mint can lean on: its
// module state starts fresh (every counter at 0 again) and its `Math.random` is its own. Both are
// reproduced here — a fresh module graph per device (`vi.resetModules` before the load) and a
// seeded generator swapped in for the duration of each `run` — so a test can freeze the clock and
// put two devices in the same millisecond deterministically.

/** mulberry32 — small, seeded, good enough to stand in for one device's `Math.random`. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface SimulatedDevice<M> {
  /** the device's own copy of the modules `load` imported */
  mod: M
  /** run `fn` as this device: its `Math.random` in place for the (synchronous) call */
  run: <T>(fn: () => T) => T
}

/** A fresh device: `load` must import the modules under test (dynamic `import()`), AFTER the
 *  registry reset this does — so their module-level counters start from zero again. */
export async function simulatedDevice<M>(seed: number, load: () => Promise<M>): Promise<SimulatedDevice<M>> {
  vi.resetModules()
  const mod = await load()
  const random = seeded(seed)
  return {
    mod,
    run: (fn) => {
      const spy = vi.spyOn(Math, 'random').mockImplementation(random)
      try { return fn() } finally { spy.mockRestore() }
    },
  }
}
