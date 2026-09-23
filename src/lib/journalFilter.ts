import type { PlanDocument, TimelineEvent } from '../types'
import { appConfig } from '../config/appConfig'
import { journalDisc } from './report'

// The Verlauf drawer's filter (feat 37 · option B, 23.09.2026): which rows a set of ticked
// categories keeps. It invents NO taxonomy. Every row already has exactly one Bereich —
// `report · journalArea`, the word the Rapport prints in its «Bereich» column — and the screen
// already names it in the row's disc (`journalDisc`, which says «Karte» where the paper says
// «Kroki»). The filter offers those same words, so what a row is called in the legend, on the
// disc's title and on paper is what it is called here.
//
// ⚠️ Because every row has exactly ONE category, the ticks form one facet and OR together. The
// menu shows them in two groups («Art des Eintrags» · «Bereich») only because they answer two
// different questions a reader asks; ANDing the groups would always be empty (a row is never
// both «Auftrag» and «Trupps»), which is why they are not the Anwesenheit's two facets.
//
// Nothing here is stored. The selection is per-opening of the drawer, like the search it
// combines with (Journal · `search`), and never reaches the workspace or another device.

/** What kind of category a row falls in. A plan is one kind with many members — its label
 *  (`planLabel`: «M6 EG», «Tafel») is part of the key. */
export type JournalCategoryKind =
  | 'manual' | 'auftrag' | 'sofort' | 'pendenz'
  | 'map' | 'plan' | 'anwesenheit' | 'atemschutz' | 'mittel' | 'checklist' | 'rapport' | 'system'

/** The two groups of the menu. «Art» is what a PERSON wrote and how they meant it; «Bereich» is
 *  where in the app a row came from. */
export type JournalCategoryGroup = 'art' | 'bereich'

export interface JournalCategory {
  /** stable across locales — the plan's label is part of it, since each plan is its own entry */
  key: string
  kind: JournalCategoryKind
  /** the word the menu, the strip and the legend show */
  label: string
  group: JournalCategoryGroup
}

export interface JournalFacet extends JournalCategory {
  /** rows of this category among the rows COUNTED (see `journalFacets`) */
  count: number
}

/** The menu's order. «Art» first, in the composer's own order, then the Bereiche in the
 *  legend's order (Journal · legendEntries) — the reader who learned one reads the other. */
const ORDER: JournalCategoryKind[] = [
  'manual', 'auftrag', 'sofort', 'pendenz',
  'map', 'plan', 'anwesenheit', 'atemschutz', 'mittel', 'rapport', 'checklist', 'system',
]
const ART: ReadonlySet<JournalCategoryKind> = new Set(['manual', 'auftrag', 'sofort', 'pendenz'])

/** The one category a row falls in. Read at call time, so the resolved locale applies. */
export function journalCategory(e: TimelineEvent, plans: PlanDocument[]): JournalCategory {
  const disc = journalDisc(e, plans)
  const kind = kindOf(disc)
  const key = kind === 'plan' ? `plan:${disc.label}` : kind
  return { key, kind, label: disc.label, group: ART.has(kind) ? 'art' : 'bereich' }
}

/** journalDisc's label back to its kind. ⚠️ The two drawing surfaces are told by the disc's
 *  TINT, never by the word: a plan's label is whatever its author called it, and a plan named
 *  «Rapport» must not land in the Rapport. Everything else is one of the fixed copy words. */
function kindOf(disc: { label: string; surface: 'map' | 'plan' | null }): JournalCategoryKind {
  if (disc.surface === 'map') return 'map'
  if (disc.surface === 'plan') return 'plan'
  const J = appConfig.copy.journal
  const R = appConfig.copy.report
  switch (disc.label) {
    case J.entryTypes.auftrag: return 'auftrag'
    case J.entryTypes.sofort: return 'sofort'
    case J.noteChip: return 'pendenz'
    case R.areaManual: return 'manual'
    case R.areaAnwesenheit: return 'anwesenheit'
    case R.areaAtemschutz: return 'atemschutz'
    case R.areaMittel: return 'mittel'
    case R.areaChecklist: return 'checklist'
    case R.areaRapport: return 'rapport'
    case R.areaSystem: return 'system'
  }
  // journalArea's own fallback for a plan row whose plan is gone (planFallback) arrives without
  // the tint — it is still a plan row, and says so under its own word
  return 'plan'
}

/** Every row's category, once — the drawer re-renders on every store nonce, and the facets, the
 *  counts and the list all ask the same question of the same rows. Keyed by row id. */
export function journalCategories(events: readonly TimelineEvent[], plans: PlanDocument[]): Map<string, JournalCategory> {
  return new Map(events.map((e) => [e.id, journalCategory(e, plans)] as const))
}

/** The word a kind is shown under, for a tick whose rows are no longer in the list. */
function kindLabel(kind: JournalCategoryKind): string {
  const J = appConfig.copy.journal
  const R = appConfig.copy.report
  const words: Record<JournalCategoryKind, string> = {
    manual: R.areaManual, auftrag: J.entryTypes.auftrag, sofort: J.entryTypes.sofort, pendenz: J.noteChip,
    map: J.surfaceMap, plan: J.surfacePlan, anwesenheit: R.areaAnwesenheit, atemschutz: R.areaAtemschutz,
    mittel: R.areaMittel, checklist: R.areaChecklist, rapport: R.areaRapport, system: R.areaSystem,
  }
  return words[kind]
}

/**
 * The menu's rows: every category that occurs in `all`, plus any `selected` key that no longer
 * does (so a tick can always be taken back), each counted over `counted`.
 *
 * ⚠️ Two lists on purpose. The ROWS come from the whole Verlauf, so typing a search does not make
 * menu rows appear and vanish under the finger; the COUNTS come from what the search keeps, so
 * «Trupps 8» says how many rows ticking it would show right now. A category the search has
 * emptied stays, at 0.
 */
export function journalFacets(
  all: readonly TimelineEvent[],
  counted: readonly TimelineEvent[],
  cats: ReadonlyMap<string, JournalCategory>,
  selected: ReadonlySet<string> = new Set(),
): JournalFacet[] {
  const byKey = new Map<string, JournalFacet>()
  for (const e of all) {
    const c = cats.get(e.id)
    if (c && !byKey.has(c.key)) byKey.set(c.key, { ...c, count: 0 })
  }
  for (const e of counted) {
    const c = cats.get(e.id)
    if (!c) continue
    const f = byKey.get(c.key)
    if (f) f.count += 1
    else byKey.set(c.key, { ...c, count: 1 })
  }
  // a tick whose rows are all gone — the record is append-only, so in practice a plan renamed
  // while the drawer was open: keep its row, or there is no way left to untick it
  for (const key of selected) {
    if (byKey.has(key)) continue
    const kind: JournalCategoryKind = key.startsWith('plan:') ? 'plan' : (key as JournalCategoryKind)
    const label = kind === 'plan' ? key.slice('plan:'.length) : kindLabel(kind)
    byKey.set(key, { key, kind, label, group: ART.has(kind) ? 'art' : 'bereich', count: 0 })
  }
  return [...byKey.values()].sort((a, b) =>
    ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind)
    || a.label.localeCompare(b.label, 'de', { numeric: true }))
}

/** Does this row survive the ticks. Nothing ticked keeps everything — «alle», the same contract
 *  as a blank query. */
export function matchesJournalCategories(
  e: TimelineEvent, selected: ReadonlySet<string>, cats: ReadonlyMap<string, JournalCategory>,
): boolean {
  if (selected.size === 0) return true
  const c = cats.get(e.id)
  return !!c && selected.has(c.key)
}
