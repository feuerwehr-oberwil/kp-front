// Stable admin destinations, their area, and old bookmarks. Keep every page in exactly one
// area. The bare /admin entry may resume a device preference; explicit unknown paths must not.
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

const ALIASES: Record<string, SectionId> = {
  karte: 'identitaet', journal: 'rapport', uebersicht: 'system',
  statistik: 'links', erfassung: 'links', einsatzlink: 'zugaenge',
}

/** Old device preferences and single-segment /admin bookmarks share the same aliases. */
export function resolveAdminSection(id: string | undefined): SectionId | null {
  if (!id) return null
  const entry = ADMIN_NAV.flatMap((g) => g.entries).find((e) => e.id === id)
  return entry?.id ?? (Object.prototype.hasOwnProperty.call(ALIASES, id) ? ALIASES[id] : null)
}

export function adminSectionHref(id: SectionId): string {
  const group = ADMIN_NAV.find((g) => g.entries.some((e) => e.id === id))
  if (!group) throw new Error(`Unknown admin section: ${id}`)
  return `/admin/${group.id}/${id}`
}

/** null means no page was requested. Invalid explicit paths safely open System. */
export function adminSectionFromPath(path: string): SectionId | null {
  const clean = path.replace(/\/+$/, '')
  if (clean === '/admin') return null
  if (!clean.startsWith('/admin/')) return 'system'
  const parts = clean.slice('/admin/'.length).split('/')
  if (parts.length === 1) return resolveAdminSection(parts[0]) ?? 'system'
  const group = ADMIN_NAV.find((g) => g.id === parts[0])
  return parts.length === 2 ? group?.entries.find((e) => e.id === parts[1])?.id ?? 'system' : 'system'
}
