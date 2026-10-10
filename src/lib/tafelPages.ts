import { useCallback, useEffect, useState } from 'react'
import { idbGet, idbSet } from './idb'

/** The Tafel's free sheet in the page strip — the board itself, not a form. */
export const SKIZZE = 'skizze'

/**
 * Which Tafel page THIS DEVICE is looking at, per Einsatz (10.10.2026; kept across reloads since
 * staging round 2).
 *
 * Device-local on purpose, like a plan's zoom: the page you are on is a way of reading the Tafel,
 * so it never reaches the synced workspace — another tablet stays on its own page. Operational
 * VIEW state, so it lives in IndexedDB (lib/idb, AGENTS.md · «Operational browser state lives in
 * IndexedDB»), mirrored in a module-level map so a surface switch (the Whiteboard unmounts every
 * time) comes back on the same page without waiting for the read. A page that no longer exists
 * falls back to the Skizze by construction (Whiteboard · `page`).
 */
const memory = new Map<string, string>()
const idbKey = (incidentId: string) => `kp-front-tafel-page:${incidentId}`

export function useTafelPage(incidentId: string | undefined): [string, (page: string) => void] {
  const key = incidentId ?? ''
  const [page, setPageState] = useState(() => memory.get(key) ?? SKIZZE)
  const [seenKey, setSeenKey] = useState(key)
  // another Einsatz in the same component: its own memory (React's «adjust state while rendering»)
  if (seenKey !== key) { setSeenKey(key); setPageState(memory.get(key) ?? SKIZZE) }
  // a reload: what this device last had open on this Einsatz, once it is read
  useEffect(() => {
    if (!key || memory.has(key)) return
    let live = true
    void idbGet<string>(idbKey(key)).then((p) => {
      if (!live || typeof p !== 'string' || memory.has(key)) return
      memory.set(key, p)
      setPageState(p)
    }).catch(() => {})
    return () => { live = false }
  }, [key])
  const setPage = useCallback((p: string) => {
    memory.set(key, p)
    setPageState(p)
    if (key) void idbSet(idbKey(key), p)
  }, [key])
  return [page, setPage]
}

/** test seam */
export const resetTafelPageMemory = () => memory.clear()

/** The page after / before `current` in the strip, for PageDown / PageUp (no wrap: the ends stop). */
export function stepPage(order: readonly string[], current: string, dir: 1 | -1): string {
  const i = order.indexOf(current)
  const j = Math.min(order.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir))
  return order[j] ?? current
}

export { TAFEL_ID } from './boardForm'
