/** The third home a georeference can have while it is being edited: an admin alignment draft.
 *
 *  The field's pairing mode (lib/georefMode) writes wherever its `storageKey` points — the
 *  station document, or an incident's frozen binding (`incident:` keys). The admin's review
 *  modal pairs by hand with the very same mode, so it registers an `admin:<alignment id>` key
 *  here: reads come from the modal's draft, writes land in it, and nothing is stored until the
 *  admin presses «Ausrichtung freigeben». Same shape as incidentPlanBindings' sessions, on
 *  purpose — one lookup function, three homes. */
import type { Georef, GeorefPair } from './georef'

export const adminGeorefKey = (alignmentId: number) => `admin:${alignmentId}`
export const isAdminGeorefKey = (key: string) => key.startsWith('admin:')

interface AdminDraft {
  pairs: () => GeorefPair[]
  save: (pairs: GeorefPair[]) => void
}
const drafts = new Map<string, AdminDraft>()

/** Registers the modal's draft under its key; the returned function forgets it again. */
export function registerAdminGeoref(key: string, draft: AdminDraft): () => void {
  drafts.set(key, draft)
  return () => { if (drafts.get(key) === draft) drafts.delete(key) }
}

export function adminGeorefForPlan(key: string): Georef | null {
  const draft = drafts.get(key)
  return draft ? { pairs: draft.pairs().map((p) => ({ ...p, plan: { ...p.plan }, lngLat: { ...p.lngLat } })) } : null
}

export function saveAdminGeoref(key: string, georef: Georef): void {
  const draft = drafts.get(key)
  if (!draft) throw new Error('Admin alignment draft is no longer open')
  draft.save(georef.pairs.map((p) => ({ ...p, plan: { ...p.plan }, lngLat: { ...p.lngLat } })))
}
