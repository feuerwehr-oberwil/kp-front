// Checklists — a third working surface alongside Lage / Plan.
//
// Two checklist kinds with different behaviour:
//  • action / rapport — stateful, checkable task lists (FU phases, Lagerapport).
//    Ticking is timestamped, rides the workspace blob (offline cache + LWW sync),
//    and milestone ticks push a Verlauf row + an audit event.
//  • reference — read-only tactical guidance (the EL playbook), searchable and
//    keyword-indexed so a Divera alarm can auto-surface the matching tactics page.
//
// Templates are STATION DATA served from the reference registry (`checklists:<id>` datasets,
// pushed by `admin_checklists` from the private data repo) — never bundled. The loader fetches
// them from /api/reference, caches them in IndexedDB for offline, and falls back to a bundled
// neutral example when a deployment has none. The per-incident tick state lives in the `Saved`
// blob (App.tsx). This file owns the schema, the loader, and the pure logic (progress, search,
// Divera match) so it stays unit-testable.

import { apiGet } from './api'
import { idbGet, idbSet } from './idb'
import genericAction from '../data/checklists/generic-action.json'

// --- template schema (matches the bundled JSON) ----------------------------------

export type ChecklistKind = 'action' | 'reference' | 'rapport'
export type HazardColor = 'red' | 'orange' | 'green' | 'yellow' | 'blue'

export interface Item {
  id: string
  text: string
  /** subtle condition tag, e.g. "bei Grossereignis" — shown, never auto-applied */
  when?: string
  /** deep-link affordance into an existing surface (best-effort wiring in App) */
  action?: 'journal' | 'plan' | 'draw' | null
  /** ticking this pushes a Verlauf row + audit event; non-milestones stay silent */
  milestone?: boolean
}

export interface Branch {
  id: string
  title: string
  items: Item[]
}

export interface Phase {
  id: string
  title: string
  role?: string
  note?: string
  items: Item[]
  /** mutually-exclusive role branches (e.g. FU "ohne C-FU" vs "mit C-FU") */
  branches?: Branch[]
}

export type ContentBlock =
  | { type: 'heading'; text: string }
  | { type: 'bullet'; text: string; emphasis?: 'red' | 'bold'; level?: number }
  | { type: 'note'; text: string }
  | { type: 'image'; page: number; caption?: string }
  /** tabular reference data (Gewichte/Flussraten, Aufgebotskonzept) — rows of cells,
   *  optional header row. Kept as strings; the renderer lays them out as a real table. */
  | { type: 'table'; head?: string[]; rows: string[][]; caption?: string }

export interface RefEntry {
  id: string
  title: string
  keywords: string[]
  /** keywords matched against a Divera incident title/type for auto-surface */
  diveraKeywords?: string[]
  hazardColor?: HazardColor
  content: ContentBlock[]
}

export interface ChecklistTemplate {
  id: string
  kind: ChecklistKind
  title: string
  subtitle?: string
  version: number
  source: string
  /** rail sort order, stamped from the manifest by admin_checklists — the station's single
   *  place to reorder checklists. Absent → sorts last (then action/rapport before reference). */
  order?: number
  /** action / rapport templates */
  phases?: Phase[]
  /** reference templates */
  entries?: RefEntry[]
}

// --- per-incident tick state (lives in the Saved workspace blob) ------------------

/** One tick: presence in `ticks` = checked. Records when + who. */
export interface Tick { t: string; by?: string }

export interface TemplateState {
  /** itemId → tick. Absence = unchecked. */
  ticks: Record<string, Tick>
  /** phaseId → chosen branch id (ohne / mit C-FU) */
  activeBranch?: Record<string, string>
}

/** templateId → its tick state. Rides the existing offline-cache / sync / LWW. */
export type ChecklistState = Record<string, TemplateState>

// --- loader ----------------------------------------------------------------------

const CACHE_KEY = 'kp-front-checklists'

// Neutral, product-default fallback (bundled, like demoIncident.ts) — shown only when a
// deployment has no checklist datasets yet, or when offline with an empty cache. It keeps the
// Checkliste surface teaching-not-empty out of the box; real station checklists override it the
// moment `admin_checklists` populates the registry.
const FALLBACK: ChecklistTemplate[] = [genericAction as ChecklistTemplate]

function isTemplate(v: unknown): v is ChecklistTemplate {
  if (!v || typeof v !== 'object') return false
  const t = v as Record<string, unknown>
  return typeof t.id === 'string' && typeof t.kind === 'string' && typeof t.title === 'string'
}

/** A `checklists:` reference dataset id is a template (`checklists:fu-aktion`) unless it carries
 *  a further colon segment, which marks a diagram asset (`checklists:el-playbook:p12`). */
export function isChecklistTemplateId(id: string): boolean {
  return id.startsWith('checklists:') && !id.slice('checklists:'.length).includes(':')
}

/** Registry URL for a reference template's diagram asset (a source-PDF page). */
export function checklistAssetUrl(templateId: string, page: number): string {
  return `/api/reference/checklists:${templateId}:p${page}`
}

const rankKind = (k: ChecklistKind) => (k === 'reference' ? 1 : 0)
// Sort by the config-driven `order` (from the manifest), then action/rapport before reference as
// a tiebreak for templates without an explicit order. The rail groups by kind, so this order
// governs both the Aufgaben list and the sequence of reference groups (Taktik, Grundlagen, …).
const sortTemplates = (ts: ChecklistTemplate[]) =>
  [...ts].sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || rankKind(a.kind) - rankKind(b.kind))

async function readCache(): Promise<ChecklistTemplate[] | null> {
  const v = await idbGet<ChecklistTemplate[]>(CACHE_KEY)
  return Array.isArray(v) && v.length ? v : null
}

/** All checklist templates for this deployment, sorted action/rapport first then reference.
 *  Fetches the `checklists:` datasets from the reference registry, caches them for offline, and
 *  falls back to the last cache then the bundled neutral example. NEVER throws — a failed fetch
 *  (offline, fresh deployment) must never leave the Checkliste surface unusable. */
export async function loadTemplates(): Promise<ChecklistTemplate[]> {
  try {
    const list = await apiGet<{ id: string }[]>('/api/reference')
    const ids = (list ?? []).filter((d) => isChecklistTemplateId(d.id)).map((d) => d.id)
    const fetched = await Promise.all(
      ids.map((id) =>
        apiGet<unknown>(`/api/reference/${id}`)
          .then((j) => (isTemplate(j) ? j : null))
          .catch(() => null),
      ),
    )
    const tpls = fetched.filter((t): t is ChecklistTemplate => t !== null)
    if (tpls.length) {
      const sorted = sortTemplates(tpls)
      void idbSet(CACHE_KEY, sorted) // durable copy for offline boot
      return sorted
    }
    // registry has no checklist datasets → prefer a prior cache, else the bundled fallback
    return (await readCache()) ?? FALLBACK
  } catch {
    // network / server failure — fall back to the cached copy (offline tablet), else the example
    return (await readCache()) ?? FALLBACK
  }
}

// --- pure logic (unit-tested) ----------------------------------------------------

/** Items of a phase that are live given the chosen branch (if any). When a phase
 *  declares branches, only the selected branch's items count (plus the phase's own
 *  base items); with no selection yet, only the base items count. */
export function phaseItems(phase: Phase, activeBranchId?: string): Item[] {
  const base = phase.items ?? []
  if (!phase.branches?.length) return base
  const branch = phase.branches.find((b) => b.id === activeBranchId)
  return branch ? [...base, ...branch.items] : base
}

export interface Progress { done: number; total: number; pct: number }

function progressOf(items: Item[], ticks: Record<string, Tick>): Progress {
  const total = items.length
  const done = items.reduce((n, it) => n + (ticks[it.id] ? 1 : 0), 0)
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 }
}

/** Per-phase progress, honouring the active branch. */
export function phaseProgress(phase: Phase, state: TemplateState): Progress {
  return progressOf(phaseItems(phase, state.activeBranch?.[phase.id]), state.ticks ?? {})
}

/** Overall progress across all phases (live items only). */
export function templateProgress(template: ChecklistTemplate, state: TemplateState): Progress {
  const phases = template.phases ?? []
  let done = 0
  let total = 0
  for (const p of phases) {
    const pr = phaseProgress(p, state)
    done += pr.done
    total += pr.total
  }
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 }
}

const norm = (s: string) => s.toLowerCase().trim()

/** Filter reference entries by a free-text query over title + keywords. Empty
 *  query returns all entries unchanged. */
export function searchEntries(entries: RefEntry[], query: string): RefEntry[] {
  const q = norm(query)
  if (!q) return entries
  return entries.filter((e) => {
    if (norm(e.title).includes(q)) return true
    return (e.keywords ?? []).some((k) => norm(k).includes(q))
  })
}

/** All reference entries across every reference template, flattened. */
export function allEntries(templates: ChecklistTemplate[]): RefEntry[] {
  return templates.filter((t) => t.kind === 'reference').flatMap((t) => t.entries ?? [])
}

/** Given an incident's title and/or type, find the reference entry whose
 *  `diveraKeywords` best matches (a token of the keyword appears in the text).
 *  Used to auto-surface the right tactics page for a Divera-sourced alarm. */
export function matchDiveraEntry(
  templates: ChecklistTemplate[],
  incident: { title?: string; type?: string },
): RefEntry | null {
  const hay = norm(`${incident.title ?? ''} ${incident.type ?? ''}`)
  if (!hay.trim()) return null
  let best: RefEntry | null = null
  let bestLen = 0
  for (const e of allEntries(templates)) {
    for (const kw of e.diveraKeywords ?? []) {
      const k = norm(kw)
      if (k && hay.includes(k) && k.length > bestLen) {
        best = e
        bestLen = k.length // prefer the longest (most specific) keyword match
      }
    }
  }
  return best
}
