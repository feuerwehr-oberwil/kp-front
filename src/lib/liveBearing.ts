import { useSyncExternalStore } from 'react'

/** The Karte's bearing FRAME BY FRAME, for the few read-outs that must turn with the map while a
 *  finger is still twisting it (the wind arrow, 24.09.2026: «only live-rotate the wind direction
 *  on map rotation» – it used to settle on release, so the arrow pointed the wrong way for the
 *  whole gesture).
 *
 *  ⚠️ A module store and not App state on purpose: MapView deliberately does NOT hand every
 *  rotate frame up (`onView` fires on move END), because that re-rendered all of
 *  IncidentWorkspace per frame. A subscriber here re-renders only itself.
 *
 *  `null` while no Karte is mounted – a reader then falls back to the bearing it was given. */
let bearing: number | null = null
const listeners = new Set<() => void>()

export function setLiveBearing(next: number | null): void {
  if (next === bearing) return
  bearing = next
  listeners.forEach((l) => l())
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

const read = () => bearing

/** The live Karte bearing, or `fallback` while no Karte is mounted. */
export function useLiveBearing(fallback: number): number {
  return useSyncExternalStore(subscribe, read, read) ?? fallback
}
