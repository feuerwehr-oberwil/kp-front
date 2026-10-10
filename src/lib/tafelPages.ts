import { useCallback, useState } from 'react'

/** The Tafel's free sheet in the page strip — the board itself, not a form. */
export const SKIZZE = 'skizze'

/**
 * Which Tafel page THIS DEVICE is looking at, per Einsatz, for the session (10.10.2026).
 *
 * Device-local on purpose, like a plan's zoom (IncidentWorkspace · planViews): the page you are
 * on is a way of reading the Tafel, so it never reaches the synced workspace — another tablet
 * stays on its own page. A module-level memory rather than component state, because the
 * Whiteboard unmounts on every surface switch and a glance at the Verlauf must not drop the
 * operator back onto the Skizze.
 */
const memory = new Map<string, string>()

export function useTafelPage(incidentId: string | undefined): [string, (page: string) => void] {
  const key = incidentId ?? ''
  const [page, setPageState] = useState(() => memory.get(key) ?? SKIZZE)
  const [seenKey, setSeenKey] = useState(key)
  // another Einsatz in the same component: its own memory (React's «adjust state while rendering»)
  if (seenKey !== key) { setSeenKey(key); setPageState(memory.get(key) ?? SKIZZE) }
  const setPage = useCallback((p: string) => { memory.set(key, p); setPageState(p) }, [key])
  return [page, setPage]
}

/** The page after / before `current` in the strip, for PageDown / PageUp (no wrap: the ends stop). */
export function stepPage(order: readonly string[], current: string, dir: 1 | -1): string {
  const i = order.indexOf(current)
  const j = Math.min(order.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir))
  return order[j] ?? current
}

export { TAFEL_ID } from './boardForm'
/** px the page strip takes under the floating top bar (09-whiteboard.css · .tps) */
export const TAFEL_STRIP_H = 52
