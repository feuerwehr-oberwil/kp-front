// The Atemschutz board's one second ticker. Every clock on the board (contact, break, Einsatzzeit,
// Notfall, the tabs of the handed-over Tafel) is a small leaf that reads it through `useBoardNow`,
// so a tick renders the leaves and nothing else; the board itself asks with a key (its tiers and
// its sort) and renders only when that key changes. The ticker runs while somebody listens and
// stops when nobody does — a board with no running clock runs no timer at all.
//
// ⚠️ The DEPLOYMENT's clock (`serverNow`), never `Date.now()`: the chip in the top bar, the board
// and the map pill must show the same number on every device (lib/serverClock).

import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import { serverNow } from './serverClock'
import type { Trupp } from '../types'

/** A source of «now» for the board: the running deployment clock, or one stopped at a moment. */
export interface BoardClock {
  /** the now every reader of this tick shares (epoch ms) */
  read(): number
  /** called on every tick, and at once when the device wakes; returns the unsubscribe */
  subscribe(onTick: () => void): () => void
}

const TICK_MS = 1000

function runningClock(): BoardClock {
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setInterval> | null = null
  let current = 0
  // while nobody listens a read is fresh — but the same for one task, so React's repeated
  // snapshot reads within one render agree
  let idle: number | null = null
  const sample = () => {
    current = serverNow()
    listeners.forEach((l) => l())
  }
  // a backgrounded tab runs its interval once a minute at best: wake reads the clock again at once
  const onVisible = () => { if (document.visibilityState === 'visible') sample() }
  return {
    read() {
      if (timer != null) return current
      if (idle == null) {
        idle = serverNow()
        queueMicrotask(() => { idle = null })
      }
      return idle
    },
    subscribe(onTick) {
      listeners.add(onTick)
      if (timer == null) {
        current = serverNow()
        timer = setInterval(sample, TICK_MS)
        document.addEventListener('visibilitychange', onVisible)
      }
      return () => {
        listeners.delete(onTick)
        if (listeners.size > 0 || timer == null) return
        clearInterval(timer)
        timer = null
        document.removeEventListener('visibilitychange', onVisible)
      }
    },
  }
}

/** The running board clock — one for the app, so every board reading it ticks in the same phase. */
export const liveBoardClock: BoardClock = runningClock()

const noSubscribe = () => () => {}

/** A clock that stands at `at` (a closed Einsatz, `frozenAt`): it never ticks. */
export function stoppedClock(at: number): BoardClock {
  return { read: () => at, subscribe: noSubscribe }
}

/** What the board's leaves need besides the clock: the contact doctrine their numbers fold with. */
export interface BoardClockValue {
  clock: BoardClock
  intervalMin: number
  graceSec: number
}

/** Provided by AtemschutzView around its board; absent, a leaf reads the running clock. */
export const BoardClockContext = createContext<BoardClockValue | null>(null)

/** Whether anything about this Trupp is counted against the clock — an Eintritt, an Austritt or a
 *  Notfall. Gates the ticker: a board of crews still at the door runs no timer. It errs on the
 *  side of ticking (a stood-down crew's fixed Anmeldezeit is read every second, unchanged). */
export function truppClockRuns(t: Pick<Trupp, 'entryTime' | 'exitTime' | 'notfallAt'>): boolean {
  return !!(t.entryTime || t.exitTime || t.notfallAt)
}

/** A primitive the ticker compares between ticks — a render happens only when it changes. */
export type TickKey = string | number | boolean | null

const always = () => 0

/**
 * Now, from `clock`, re-rendering the caller on a tick only when `key(now)` changes. While
 * `running` is false nothing is subscribed (no timer) and the now is read once at render.
 * Returns the now the caller renders at — the same value `key` was given.
 */
export function useClockNow(clock: BoardClock, key: (now: number) => TickKey, running = true): number {
  useSyncExternalStore(running ? clock.subscribe : noSubscribe, running ? () => key(clock.read()) : always)
  return clock.read()
}

/** The board's clock and doctrine, as the nearest AtemschutzView provides them. */
export function useBoardClock(): BoardClockValue | null {
  return useContext(BoardClockContext)
}

/** `useClockNow` on the board's clock (the running one outside a board). Default: every tick. */
export function useBoardNow(key: (now: number) => TickKey = (now) => now, running = true): number {
  return useClockNow(useContext(BoardClockContext)?.clock ?? liveBoardClock, key, running)
}

/** A leaf that renders `children(now)` on the board's ticks — for a clock drawn by a component
 *  that takes `now` as a prop (the Notfall banners). */
export function BoardNow({ children, running = true }: { children: (now: number) => ReactNode; running?: boolean }) {
  return children(useBoardNow(undefined, running))
}
