import { useEffect, useSyncExternalStore } from 'react'
import type { Meldung } from './meldungen'

// The Meldeleiste's register.
//
// Publishers stay where their state lives — the alarm pool is App's, the Wiedervorlagen are the
// workspace's, the waiting build is the service worker's — and the strip stays the ONE place
// that ranks and paints. The alternative was prop-drilling six messages through two screens'
// worth of components, or six components each bringing their own geometry, z-index and live
// region, which is exactly the pile this replaces.

const store = new Map<string, Meldung>()
const listeners = new Set<() => void>()
let snapshot: Meldung[] = []

const emit = () => {
  snapshot = [...store.values()]
  for (const l of listeners) l()
}

/** useSyncExternalStore wiring for the strip — nobody else should need these. */
export const subscribeMeldungen = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
export const getMeldungen = () => snapshot

/** Everything about a Meldung that can be READ. Handlers close over live state and are rebuilt on
 *  every render of their publisher; the strip only has to repaint when one of these changes. */
const face = (m: Meldung): string => [
  m.kind, m.tone, m.icon, m.title, m.sub ?? '', m.dismiss?.label ?? '',
  // whether the title is a way in at all is READ from the row (underlined words vs plain text),
  // so a message that gains or loses its `onOpen` has to repaint
  m.onOpen ? `open·${m.onOpen.label}` : '',
  ...(m.actions ?? []).map((a) => `${a.label}·${a.icon ?? ''}·${a.primary ? 1 : 0}·${a.disabled ? 1 : 0}·${a.busy ? 1 : 0}`),
].join('')

/**
 * Publish one message into the Meldeleiste for as long as the caller is mounted; pass `null` and
 * it is withdrawn. The caller keeps its own state and decides IF there is something to say — the
 * strip decides where it stands among the others.
 */
/**
 * Is a message of this kind currently standing in the strip? For the one case where a publisher
 * must yield rather than queue: «Einsatzdaten prüfen» asks the EL to confirm a dispatch's guesses,
 * which is a nonsense question while an alarm is still waiting to be opened — the data being
 * reviewed may not even be the Einsatz they are about to take. Ranking decides ORDER; this decides
 * whether there is anything to say at all.
 */
export function useMeldungKindPending(kind: Meldung['kind']): boolean {
  return useSyncExternalStore(
    subscribeMeldungen,
    () => snapshot.some((m) => m.kind === kind),
    () => false,
  )
}

export function useMeldung(m: Meldung | null) {
  const id = m?.id
  // No dependency array on purpose: the record is rebuilt every render and its handlers close
  // over live state, so the stored copy has to be replaced every time. `face` is what keeps that
  // from repainting the strip when nothing readable changed.
  useEffect(() => {
    if (!m) return
    const prev = store.get(m.id)
    store.set(m.id, m)
    if (!prev || face(prev) !== face(m)) emit()
  })
  // …and the row goes when its publisher goes, or when the message loses its identity — id
  // changed, or became undefined because the caller now has nothing to say.
  useEffect(() => () => { if (id != null) { store.delete(id); emit() } }, [id])
}
