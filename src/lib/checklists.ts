// Checklists — a third working surface alongside Lage / Plan.
//
// Two checklist kinds with different behaviour:
//  • action / rapport — stateful, checkable task lists (FU phases, Lagerapport).
//    Ticking is timestamped, rides the workspace blob (offline cache + LWW sync),
//    and milestone ticks push a Verlauf row + an audit event.
//  • reference — read-only tactical guidance (the EL playbook), searchable and
//    keyword-indexed so a Divera alarm can auto-surface the matching tactics page.
//  • manual — an Anleitung (05.10.2026): read-only numbered steps for ONE device (Hebekissen,
//    Stromerzeuger), with optional warning/hint lines and step images. Never ticked, no state;
//    grouped by `device` in the picker. Its images are prefetched for offline (warmManualImages).
//
// Templates are STATION DATA served from the reference registry (`checklists:<id>` datasets,
// pushed by `admin_checklists` from the private data repo) — never bundled. The loader fetches
// them from /api/reference, caches them in IndexedDB for offline, and falls back to a bundled
// neutral example when a deployment has none. The per-incident tick state lives in the `Saved`
// blob (App.tsx). This file owns the schema, the loader, and the pure logic (progress, search,
// Divera match) so it stays unit-testable.

/*
 * **Anleitungen are a checklist kind, not a second pipeline** (05.10.2026). `kind: "manual"`
 * rides `checklists:<id>` + `checklists:<id>:p<N>` images, the same manifest, CLI, admin page and
 * SharePoint folder; format in [`docs/CONFIGURATION.md` §9f](docs/CONFIGURATION.md). It is READ,
 * never ticked: no tick state, no progress, nothing in the Verlauf/Rapport — tickable means
 * `isTickable` (action/rapport) only, so check new kind switches against it. The picker shows
 * them in their own «Anleitungen» group, one sub-head per `device` (`manualGroups`); the reader
 * is `ManualReader` (own CSS module). Step pictures are prefetched into the SW's
 * `checklist-assets` cache when the templates load (`warmManualImages`), because a manual is
 * opened when it is needed — offline, for the first time. A step image the manifest has no
 * asset for is refused by `admin_checklists validate`.
 */

import { apiGet } from './api'
import { readThrough } from './idb'
import genericAction from '../data/checklists/generic-action.json'

// --- template schema (matches the bundled JSON) ----------------------------------

/** `visit` = an Objektbesuch checklist (docs/object-visits.md): same distribution, answered on the
 *  Objektbesuche surface only — every INCIDENT surface leaves it out (`loadTemplates`). */
export type ChecklistKind = 'action' | 'reference' | 'rapport' | 'manual' | 'visit'

/** How a `visit` item is answered (docs/object-visits.md · «Checklist templates of kind visit»).
 *  Missing = `check`. Incident checklists ignore it: their items are ticked. */
export type ItemInput = 'check' | 'yesno' | 'text' | 'number' | 'choice' | 'photo'
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
  /** `visit` templates: the answer type (absent = `check`) */
  input?: ItemInput
  /** `visit` · `choice`: the options, by stable id */
  options?: { id: string; label: string }[]
  /** `visit` · `number`: the unit shown after the field («Stk.») */
  unit?: string
  /** `visit`: an unanswered required item asks «trotzdem abschliessen?» — nothing else */
  required?: boolean
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

/** One picture on an Anleitung step: an asset page (`checklists:<template>:p<page>`) — a photo or a
 *  page of the device's PDF manual exported as an image. */
export interface ManualImage { page: number; caption?: string }

/** One numbered step of an Anleitung. `warning` is the red line (what hurts people or the
 *  device), `hint` the quiet one (a tip). Both optional. */
export interface ManualStep {
  text: string
  /** sub-points of the step, in order («Becken 1 – grober Schmutz entfernen», …) — the second
   *  list level of the station's Word Anleitungen, kept as such rather than flattened into steps */
  details?: string[]
  warning?: string
  hint?: string
  images?: ManualImage[]
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
  /** manual templates: the device the Anleitung is for — the picker groups by it */
  device?: string
  /** manual templates: when the content was last checked («Stand»), `YYYY-MM-DD` */
  updated?: string
  /** manual templates: extra search words (model names, «Generator» for a Stromerzeuger) */
  keywords?: string[]
  /** manual templates */
  steps?: ManualStep[]
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

const rankKind = (k: ChecklistKind) => (k === 'manual' ? 2 : k === 'reference' ? 1 : 0)
// Sort by the config-driven `order` (from the manifest), then action/rapport before reference as
// a tiebreak for templates without an explicit order. The rail groups by kind, so this order
// governs both the Aufgaben list and the sequence of reference groups (Taktik, Grundlagen, …).
const sortTemplates = (ts: ChecklistTemplate[]) =>
  [...ts].sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || rankKind(a.kind) - rankKind(b.kind))

/** An empty list is no list: a registry with no `checklists:` datasets — and equally a cache
 *  entry that lost its contents — must fall through to the prior cache / bundled example. */
const hasTemplates = (v: unknown): v is ChecklistTemplate[] => Array.isArray(v) && v.length > 0

/** All checklist templates for this deployment, sorted action/rapport first then reference.
 *  Fetches the `checklists:` datasets from the reference registry, caches them for offline, and
 *  falls back to the last cache then the bundled neutral example. NEVER throws — a failed fetch
 *  (offline, fresh deployment) must never leave the Checkliste surface unusable, which is why
 *  this one overrides `readThrough`'s default «only silence falls back». */
export async function loadTemplates(): Promise<ChecklistTemplate[]> {
  const { value } = await readThrough<ChecklistTemplate[]>(
    CACHE_KEY,
    async () => {
      const list = await apiGet<{ id: string }[]>('/api/reference')
      const ids = (list ?? []).filter((d) => isChecklistTemplateId(d.id)).map((d) => d.id)
      const fetched = await Promise.all(
        ids.map((id) =>
          apiGet<unknown>(`/api/reference/${id}`)
            .then((j) => (isTemplate(j) ? j : null))
            .catch(() => null),
        ),
      )
      // ⚠️ An Objektbesuch checklist is not an Einsatz checklist: it shares the distribution
      // (`checklists:<id>`), never the surface (docs/object-visits.md). Left out HERE, before the
      // cache is written, so no incident surface can ever list one.
      return sortTemplates(fetched.filter((t): t is ChecklistTemplate => t !== null && t.kind !== 'visit'))
    },
    { validate: hasTemplates, fallback: () => FALLBACK, shouldFallback: () => true },
  )
  return value.filter((t) => t.kind !== 'visit')
}

/** The kinds that are ticked: everything that is neither read (reference, manual) nor a visit. */
export const isTickable = (t: ChecklistTemplate) => t.kind === 'action' || t.kind === 'rapport'

/** how long a warmed list is handed out before a newer one is asked for behind it */
export const TEMPLATES_FRESH_MS = 5 * 60_000
let warm: { at: number; list: Promise<ChecklistTemplate[]> } | null = null

/**
 * The templates WITHOUT the wait (20.09.2026). `loadTemplates` is network-first, and it was only
 * ever called when the Checkliste surface mounted – so the first thing the surface did, every
 * time it was opened, was wait for the registry; and an Einsatz whose Checkliste tab was first
 * opened offline had never cached anything at all. The workspace now warms this the moment an
 * Einsatz opens, and the surface reads what is already there.
 *
 * `list` is the answer in hand (the running or finished load – it resolves at once when warmed).
 * `newer` is set only when that answer is older than TEMPLATES_FRESH_MS: a background reload the
 * caller may apply when it lands, so a station that corrected a list mid-Einsatz still sees it.
 */
export function warmTemplates(now = Date.now()): { list: Promise<ChecklistTemplate[]>; newer: Promise<ChecklistTemplate[]> | null } {
  if (!warm) { warm = { at: now, list: loadTemplates() }; void warm.list.then(warmManualImages); return { list: warm.list, newer: null } }
  if (now - warm.at <= TEMPLATES_FRESH_MS) return { list: warm.list, newer: null }
  const stale = warm.list
  warm = { at: now, list: loadTemplates() }
  void warm.list.then(warmManualImages)
  return { list: stale, newer: warm.list }
}
/** test seam */
export function resetWarmTemplates() { warm = null }

/** Every image URL the read-only kinds show: an Anleitung's step images and a reference entry's
 *  diagrams. The templates are offline-cached as JSON; these are what `warmManualImages` fills. */
export function checklistImageUrls(templates: ChecklistTemplate[]): string[] {
  const urls = new Set<string>()
  for (const t of templates) {
    for (const step of t.kind === 'manual' ? t.steps ?? [] : []) {
      for (const img of step.images ?? []) urls.add(checklistAssetUrl(t.id, img.page))
    }
    for (const e of t.kind === 'reference' ? t.entries ?? [] : []) {
      for (const b of e.content ?? []) if (b.type === 'image') urls.add(checklistAssetUrl(t.id, b.page))
    }
  }
  return [...urls]
}

const imagesStarted = new Set<string>()

/**
 * Fetch every Anleitung step image (and playbook diagram) once in the background, so an
 * Anleitung opened for the first time in a cellar shows its pictures (05.10.2026). The JSON was
 * already offline (`loadTemplates`); the pictures were only cached once LOOKED at, which is the
 * wrong moment for a manual: you read it when you need it, not beforehand.
 *
 * The fetches only pass through the service worker, whose `checklist-assets` route keeps them
 * (vite.config) — same pattern as lib/planTilePrefetch. No controlling worker (dev server, first
 * visit), offline, or «Datensparmodus» → nothing fetched. One at a time; each URL once a session.
 */
export async function warmManualImages(templates: ChecklistTemplate[]): Promise<void> {
  if (typeof navigator === 'undefined' || typeof caches === 'undefined') return
  if (!navigator.serviceWorker?.controller) return
  if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true) return
  for (const url of checklistImageUrls(templates)) {
    if (imagesStarted.has(url)) continue
    if (!navigator.onLine) return
    imagesStarted.add(url)
    try {
      if (await caches.match(url)) continue
      await fetch(url, { credentials: 'same-origin' }).then((r) => r.arrayBuffer())
    } catch {
      imagesStarted.delete(url) // try again on the next warm
    }
  }
}
/** test seam */
export function resetWarmManualImages() { imagesStarted.clear() }

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

/**
 * Every reference entry whose `diveraKeywords` appear in an incident's title/type, most specific
 * keyword first — the tactics pages to surface for a Divera-sourced alarm.
 *
 * ⚠️ A list, not a single best match (31.08.). One Stichwort routinely has several answers:
 * «VU Strasse» is Verkehrsunfall AND E-Autobrand AND Ölspur auf Strasse, and which of the three
 * the Einsatz turns out to need is not knowable from the alarm text. Picking the longest keyword
 * and hiding the rest made the app look certain about something it cannot know, and the other
 * two were then only reachable by searching for a word the operator had to think of first.
 *
 * Ranked by keyword length (the most specific match leads), then by title so the order is a
 * property of the data rather than of the template load order. `limit` keeps the rail from
 * turning into a second list on a broad keyword like «Brand».
 */
export function matchDiveraEntries(
  templates: ChecklistTemplate[],
  incident: { title?: string; type?: string },
  limit = 4,
): RefEntry[] {
  const hay = norm(`${incident.title ?? ''} ${incident.type ?? ''}`)
  if (!hay.trim()) return []
  const hits: { entry: RefEntry; len: number }[] = []
  for (const e of allEntries(templates)) {
    let best = 0
    for (const kw of e.diveraKeywords ?? []) {
      const k = norm(kw)
      if (k && hay.includes(k)) best = Math.max(best, k.length)
    }
    if (best) hits.push({ entry: e, len: best })
  }
  hits.sort((a, b) => (b.len - a.len) || (a.entry.title < b.entry.title ? -1 : a.entry.title > b.entry.title ? 1 : 0))
  return hits.slice(0, limit).map((h) => h.entry)
}

// --- Anleitungen (kind: manual) ------------------------------------------------------

export interface DeviceGroup { device: string; manuals: ChecklistTemplate[] }

/** The Anleitungen matching a free-text query over title, device and keywords, grouped by
 *  device. Devices sort by name (Swiss German collation), manuals keep their template order —
 *  a station's «Aufbau» before «Abbau» is the station's call, made with `order`. */
export function manualGroups(templates: ChecklistTemplate[], query: string): DeviceGroup[] {
  const q = norm(query)
  const groups = new Map<string, ChecklistTemplate[]>()
  for (const t of templates) {
    if (t.kind !== 'manual') continue
    const device = (t.device ?? '').trim() || t.title
    if (q && ![t.title, device, t.subtitle ?? '', ...(t.keywords ?? [])].some((w) => norm(w).includes(q))) continue
    groups.set(device, [...(groups.get(device) ?? []), t])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'de-CH'))
    .map(([device, manuals]) => ({ device, manuals }))
}
