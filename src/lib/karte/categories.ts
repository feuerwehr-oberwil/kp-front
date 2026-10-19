// Object categories — the station's own colours for its objects on «Karte & Objekte» (owner,
// 17.10.2026: «have points be colored manually (in the config) so that it's easier to differentiate
// buildings with keyboxes / plans, those with water plans, those with PV anlagen»).
//
// The rules live in the deployment config (`map.objectCategories`, edited in /admin › Karte, typed
// and validated by backend schemas.py · ObjectCategoryConfig). Ordered, FIRST MATCH WINS; a rule
// matches an object when every condition it names holds:
//   · `kinds`   — the object's kind is one of them (einsatzobjekt · objekt). `depot` (a key box) is
//                 RETIRED (owner, review round 3, 17.10.2026): an existing config naming it stays
//                 valid, and it never matches — a rule naming only `depot` matches nothing (it
//                 must not turn into a catch-all and paint every object).
//   · `modules` — one of the object's plan modules matches one of the globs (`modul5-pv*`)
// A rule naming neither matches everything (a catch-all at the end). An object no rule matches
// keeps today's look: red, grey without plans. No rules at all = today's look everywhere.
//
// Pure: the map (KarteApp) colours dots, tags and outlines with `categoryOf(…).color`, Ebenen gets
// one row per rule, and these functions are what the tests pin.

import type { StationObject } from '../api/stationReference'

export type ObjectKind = StationObject['kind']

export interface ObjectCategoryRule {
  id: string
  /** one string, or one per language (`{ de, fr, it, en }`) */
  label: string | Record<string, string>
  /** `#rrggbb` */
  color: string
  match?: { kinds?: (ObjectKind | 'depot')[] | null; modules?: string[] | null } | null
}

export interface ObjectCategory {
  id: string
  label: string
  color: string
  kinds: ObjectKind[] | null
  modules: RegExp[] | null
}

const HEX = /^#[0-9a-fA-F]{6}$/
const KINDS: readonly ObjectKind[] = ['einsatzobjekt', 'objekt']

/** `modul5-pv*` → /^modul5-pv.*$/i — `*` any run, `?` one character, everything else literal. */
export function globToRegExp(glob: string): RegExp {
  const body = glob.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${body}$`, 'i')
}

/** The label in the deployment's language, else German, else the first one given, else the id. */
export function categoryLabel(label: ObjectCategoryRule['label'] | null | undefined, lang: string, id: string): string {
  if (typeof label === 'string') return label.trim() || id
  if (label && typeof label === 'object') {
    const pick = label[lang] ?? label.de ?? Object.values(label)[0]
    if (typeof pick === 'string' && pick.trim()) return pick.trim()
  }
  return id
}

/** The config's rules as the map uses them. A rule without an id or a usable colour is dropped
 *  (the admin refuses to write one; a hand-edited document must not break the map), and an id
 *  used twice keeps its first rule. */
export function categoryRules(raw: readonly ObjectCategoryRule[] | null | undefined, lang = 'de'): ObjectCategory[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: ObjectCategory[] = []
  for (const r of raw) {
    if (!r || typeof r.id !== 'string' || !r.id.trim() || seen.has(r.id) || !HEX.test(r.color ?? '')) continue
    seen.add(r.id)
    const named = Array.isArray(r.match?.kinds) && r.match.kinds.length > 0
    // only retired kinds named (`[depot]`): an empty list, which matches nothing
    const kinds = named ? r.match!.kinds!.filter((k: string): k is ObjectKind => KINDS.includes(k as ObjectKind)) : null
    const mods = Array.isArray(r.match?.modules) ? r.match.modules.filter((m: unknown): m is string => typeof m === 'string' && !!m.trim()) : null
    out.push({
      id: r.id,
      label: categoryLabel(r.label, lang, r.id),
      color: r.color,
      kinds,
      modules: mods && mods.length ? mods.map(globToRegExp) : null,
    })
  }
  return out
}

/** The first rule the object matches, or null (= today's look). */
export function categoryOf(o: Pick<StationObject, 'kind' | 'plans'>, rules: readonly ObjectCategory[]): ObjectCategory | null {
  for (const r of rules) {
    if (r.kinds && !r.kinds.includes(o.kind)) continue
    if (r.modules && !o.plans.some((p) => !!p.module && r.modules!.some((re) => re.test(p.module!)))) continue
    return r
  }
  return null
}

/** object id → its category (only the objects that have one). */
export function categorize(objects: readonly StationObject[], rules: readonly ObjectCategory[]): Map<string, ObjectCategory> {
  const out = new Map<string, ObjectCategory>()
  if (!rules.length) return out
  for (const o of objects) {
    const c = categoryOf(o, rules)
    if (c) out.set(o.id, c)
  }
  return out
}

/** Readable text on a solid category colour: dark ink on light colours, white on dark ones
 *  (WCAG relative luminance, the 0.179 crossover). */
export function inkOn(hex: string): '#111418' | '#ffffff' {
  const n = parseInt(hex.slice(1), 16)
  const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
  return l > 0.179 ? '#111418' : '#ffffff'
}

// ── the admin's editor (admin/ObjectCategoriesCard) ──────────────────────────────────────────

/** «Photovoltaik / PV» → «photovoltaik-pv»: the id a new rule gets from its first name. */
export function categoryId(label: string, taken: readonly string[]): string {
  const base = label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'kategorie'
  let id = base
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`
  return id
}

/** The rules the server accepts — the rest is what the card warns about. */
export function writableRules(rows: readonly ObjectCategoryRule[]): ObjectCategoryRule[] {
  return rows.filter((r) => !!r.id && HEX.test(r.color ?? '') && !!categoryLabel(r.label, 'de', '').trim())
}
