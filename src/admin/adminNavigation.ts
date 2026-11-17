// Stable admin destinations (/admin/<area>/<page>) and the ids old devices remember. Keep
// every page in exactly one area. Bare /admin may resume a device preference; an explicit
// unknown path must not.
export type SectionId =
  | 'identitaet' | 'doktrin' | 'rapport' | 'alarme' | 'fahrzeuge' | 'material' | 'ebenen' | 'objektplaene'
  | 'checklisten' | 'tafel' | 'objektbesuche' | 'mitglieder' | 'mannschaft'
  | 'einsaetze' | 'divera' | 'traccar' | 'arbeitsmappe' | 'zugaenge' | 'links' | 'system' | 'sicherung'

type GroupKey = 'groupOverview' | 'groupPersonen' | 'groupFleet' | 'groupMap' | 'groupStation' | 'groupConnections' | 'groupSystem'
interface NavGroup {
  id: string
  heading: GroupKey
  icon: string
  entries: { id: SectionId; icon: string }[]
}

export const ADMIN_NAV: readonly NavGroup[] = [
  { id: 'uebersicht', heading: 'groupOverview', icon: 'gauge', entries: [
    { id: 'system', icon: 'gauge' },
  ] },
  { id: 'personal', heading: 'groupPersonen', icon: 'people', entries: [
    { id: 'mannschaft', icon: 'people' }, { id: 'mitglieder', icon: 'lock' },
  ] },
  { id: 'ausstattung', heading: 'groupFleet', icon: 'truck', entries: [
    { id: 'fahrzeuge', icon: 'truck' }, { id: 'material', icon: 'box' }, { id: 'arbeitsmappe', icon: 'download' },
  ] },
  { id: 'karte', heading: 'groupMap', icon: 'layers', entries: [
    { id: 'ebenen', icon: 'layers' }, { id: 'objektplaene', icon: 'doc' },
    { id: 'checklisten', icon: 'checklist' }, { id: 'tafel', icon: 'easel' }, { id: 'objektbesuche', icon: 'clipboard' },
  ] },
  { id: 'station', heading: 'groupStation', icon: 'flag', entries: [
    { id: 'identitaet', icon: 'flag' }, { id: 'doktrin', icon: 'compass' },
    { id: 'rapport', icon: 'printer' }, { id: 'alarme', icon: 'bell' }, { id: 'einsaetze', icon: 'history' },
  ] },
  { id: 'anbindungen', heading: 'groupConnections', icon: 'link', entries: [
    { id: 'zugaenge', icon: 'link' }, { id: 'divera', icon: 'radio' },
    { id: 'traccar', icon: 'pin' }, { id: 'links', icon: 'external' },
  ] },
  { id: 'sicherung', heading: 'groupSystem', icon: 'swap', entries: [
    { id: 'sicherung', icon: 'swap' },
  ] },
]

/** Every page, flat, in sidebar order. */
export const ADMIN_ENTRIES = ADMIN_NAV.flatMap((g) => g.entries)

/** The area a page sits in – every SectionId is in exactly one (see the test). */
export function adminAreaOf(id: SectionId): NavGroup {
  const group = ADMIN_NAV.find((g) => g.entries.some((e) => e.id === id))
  if (!group) throw new Error(`Unknown admin section: ${id}`)
  return group
}

// Page ids a device may still remember from before a page was merged or moved.
const ALIASES = new Map<string, SectionId>([
  ['karte', 'identitaet'], ['journal', 'rapport'], ['uebersicht', 'system'],
  ['statistik', 'links'], ['erfassung', 'links'], ['einsatzlink', 'zugaenge'],
])

/** A remembered page id (device preference), old ids included. */
export function resolveAdminSection(id: string | undefined): SectionId | null {
  if (!id) return null
  return ADMIN_ENTRIES.find((e) => e.id === id)?.id
    ?? ALIASES.get(id) ?? null
}

export function adminSectionHref(id: SectionId): string {
  return `/admin/${adminAreaOf(id).id}/${id}`
}

/** null means no page was requested (bare /admin). One segment is a page id, an area (its
 *  first page) or an old id; anything that is not a page opens System. */
export function adminSectionFromPath(path: string): SectionId | null {
  const clean = path.replace(/\/+$/, '')
  if (clean === '/admin') return null
  if (!clean.startsWith('/admin/')) return 'system'
  const parts = clean.slice('/admin/'.length).split('/')
  const group = ADMIN_NAV.find((g) => g.id === parts[0])
  if (parts.length === 1) {
    return ADMIN_ENTRIES.find((e) => e.id === parts[0])?.id ?? group?.entries[0].id ?? resolveAdminSection(parts[0]) ?? 'system'
  }
  return parts.length === 2 ? group?.entries.find((e) => e.id === parts[1])?.id ?? 'system' : 'system'
}
