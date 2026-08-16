// Station data written from the browser: Einsatzobjekte + their Modul-PDFs, and the
// Checklisten-Vorlagen. Deliberately NOT routed through src/lib/api/objects.ts or
// src/lib/api/reference.ts — those are the FIELD app's read paths (offline-resilient,
// IndexedDB-cached). The admin surface owns its own thin write client over src/lib/api.ts,
// the same split RosterView already uses (src/admin/rosterApi.ts).
//
// Every endpoint here already existed and had no caller: `POST/PUT /api/objects`,
// `PUT /api/objects/{id}/plans/{module}`, `PUT /api/reference/{id}` and
// `POST /api/reference/checklists/prune`.
import { apiGet, apiPost, apiPut, apiUpload } from '../lib/api'
import type { ObjectWithPlans, ReferenceDataset } from '../lib/incidents'

// ─── Einsatzobjekt ids ─────────────────────────────────────────────────────────

/** Namespace of `object_id_for_key` — backend/app/admin_objects.py:105.
 *
 *  ⚠️ NEVER change it, on either side. It is half of what makes a `key` mean the same
 *  Einsatzobjekt next year as it does today; the value below is
 *  `uuid5(NAMESPACE_URL, 'https://kp-front.ch/einsatzobjekte')` and is pinned by a test. */
const OBJECT_KEY_NAMESPACE = '83709794-eeeb-56cc-9dd5-db08acfff55e'

/**
 * The key normalisation of `object_id_for_key` (admin_objects.py:121), in the browser:
 * collapse whitespace, then case-fold.
 *
 * ⚠️ Python's `str.casefold()` is not `String.toLowerCase()`. The one difference that a Swiss
 * fire service actually meets is ß → ss ('Straßenmeisterei' and 'Strassenmeisterei' are the
 * same object), so it is spelled out; the remaining divergences (final sigma, Cherokee) cannot
 * occur in a station's own key. The derived id is shown in the form so a mismatch is visible
 * rather than silent.
 */
export function normaliseObjectKey(key: string): string {
  return key.trim().split(/\s+/).join(' ').toLowerCase().replace(/ß/g, 'ss')
}

/** Thrown when the page cannot derive an id because the browser withholds WebCrypto —
 *  i.e. the deployment is served over plain http from something other than localhost.
 *  Carries its own German message; the form shows it instead of a generic failure. */
export class InsecureContextError extends Error {}

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16))

/**
 * The stable object UUID for a station's own `key` — the SAME uuid5 the CLI derives, so an
 * object created here and an `admin_objects` manifest entry carrying the same `key` address
 * one object rather than two. Never make a person type a UUID (admin_objects.py:108-124).
 *
 * uuid5 = SHA-1 over (namespace bytes ‖ UTF-8 name), first 16 bytes, version 5 + RFC-4122
 * variant stamped in. Async because WebCrypto's digest is.
 */
export async function objectIdForKey(key: string): Promise<string> {
  const name = normaliseObjectKey(key)
  if (!name) throw new Error("object 'key' must not be empty")
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new InsecureContextError('WebCrypto unavailable (insecure context)')
  const ns = hexToBytes(OBJECT_KEY_NAMESPACE.replace(/-/g, ''))
  const nameBytes = new TextEncoder().encode(name)
  const buf = new Uint8Array(ns.length + nameBytes.length)
  buf.set(ns)
  buf.set(nameBytes, ns.length)
  const b = new Uint8Array(await subtle.digest('SHA-1', buf)).slice(0, 16)
  b[6] = (b[6] & 0x0f) | 0x50 // version 5
  b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// ─── Einsatzobjekte ────────────────────────────────────────────────────────────

/** The writable half of an Einsatzobjekt (backend ObjectIn).
 *
 *  ⚠️ `source_key` is NOT here because `ObjectIn` does not carry it: the key the scheduled
 *  Planspeicher-Abgleich matches on (`ObjectSite.source_key`, plans.py:370) can only be set by
 *  `admin_objects`. `PUT /api/objects/{id}` leaves it untouched, so editing here never clears
 *  a key the CLI wrote — but it cannot create one either. The page says so. */
export interface ObjectInput {
  name: string
  address: string | null
  lat: number | null
  lng: number | null
  source_note: string | null
}

/** What the upsert answers: `ObjectOut`, i.e. the object WITHOUT its plans. */
export type SavedObject = Omit<ObjectWithPlans, 'plans' | 'distance_m'>

/** Create-or-update by id — `PUT /api/objects/{id}` upserts, so the same call serves both the
 *  new object (id derived from its key) and every later correction. */
export const saveObject = (id: string, body: ObjectInput) =>
  apiPut<SavedObject>(`/api/objects/${encodeURIComponent(id)}`, body)

/** Upload one Modul-PDF. Writes `plan:<object>:<module>` — the id is derived from the module,
 *  so re-uploading a corrected sheet REPLACES the plan and bumps its version instead of adding
 *  a second one (backend/app/plans.py · store_plan). No `sha256` is sent: the digest is only
 *  required of a machine publish, and objects.py:143-147 spells out why a person picking a file
 *  in this form is deliberately exempt. */
export function uploadPlan(objectId: string, module: string, file: File) {
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('source_note', file.name)
  return apiUpload<ReferenceDataset>(
    `/api/objects/${encodeURIComponent(objectId)}/plans/${encodeURIComponent(module)}`,
    form,
    'PUT',
  )
}

// ─── Checklisten ───────────────────────────────────────────────────────────────

/** `checklists:<slug>` = a template; `checklists:<slug>:p<N>` = one diagram image of a
 *  reference playbook. Mirrors `_checklist_role` (backend/app/api/reference.py:33-41). */
export const checklistSlug = (datasetId: string): string | null =>
  datasetId.startsWith('checklists:') ? datasetId.slice('checklists:'.length).split(':')[0] : null

export const isChecklistTemplateDataset = (datasetId: string): boolean =>
  datasetId.startsWith('checklists:') && !datasetId.slice('checklists:'.length).includes(':')

/** One template row on the page: the dataset plus the diagram assets filed under its slug. */
export interface ChecklistRow {
  dataset: ReferenceDataset
  slug: string
  assets: ReferenceDataset[]
}

/** Group every `checklists:*` dataset into template rows. Assets whose template is missing are
 *  returned separately — they are exactly the ghosts a rename leaves behind, and a page that
 *  silently hides them cannot offer to clear them. */
export function groupChecklists(datasets: ReferenceDataset[]): {
  rows: ChecklistRow[]
  orphanAssets: ReferenceDataset[]
} {
  const templates = datasets.filter((d) => isChecklistTemplateDataset(d.id))
  const assets = datasets.filter((d) => checklistSlug(d.id) !== null && !isChecklistTemplateDataset(d.id))
  const bySlug = new Map(templates.map((t) => [checklistSlug(t.id) as string, t]))
  const rows = [...bySlug.entries()]
    .map(([slug, dataset]) => ({
      slug,
      dataset,
      assets: assets.filter((a) => checklistSlug(a.id) === slug).sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug))
  return { rows, orphanAssets: assets.filter((a) => !bySlug.has(checklistSlug(a.id) as string)) }
}

export const listReferenceDatasets = () => apiGet<ReferenceDataset[]>('/api/reference')

/** PUT a checklist template or diagram to `/api/reference/{id}`. The server re-validates the
 *  template shape (`_validate_checklist_template`) and answers 422 on a malformed one. */
export function uploadChecklistFile(
  datasetId: string,
  file: Blob,
  filename: string,
  opts: { title?: string; sourceNote?: string } = {},
) {
  const form = new FormData()
  form.append('file', file, filename)
  if (opts.title) form.append('title', opts.title)
  if (opts.sourceNote) form.append('source_note', opts.sourceNote)
  return apiUpload<ReferenceDataset>(`/api/reference/${encodeURIComponent(datasetId)}`, form, 'PUT')
}

/**
 * Delete checklist datasets — via the SAME door `admin_checklists load` uses, because it is the
 * only one there is: the reference registry has no DELETE. `POST /api/reference/checklists/prune`
 * keeps exactly the ids it is handed and removes every other `checklists:*` dataset.
 *
 * ⚠️ That makes the keep-list, not the delete-list, the payload — so it MUST be built from a
 * listing read moments before (see `deleteChecklist`), or a template uploaded from a second
 * browser tab in between would be pruned as collateral.
 */
export const pruneChecklists = (keep: string[]) =>
  apiPost<{ pruned: string[] }>('/api/reference/checklists/prune', keep)

/** Ids that make up one template row — the template plus its diagrams. */
export const checklistRowIds = (row: ChecklistRow): string[] => [row.dataset.id, ...row.assets.map((a) => a.id)]

/**
 * Remove the named checklist datasets: re-read the registry, then keep everything else. The
 * re-read is the point — see `pruneChecklists`. Returns what the server actually deleted.
 */
export async function deleteChecklistDatasets(ids: string[]): Promise<{ pruned: string[] }> {
  const doomed = new Set(ids)
  const fresh = await listReferenceDatasets()
  const keep = fresh.filter((d) => checklistSlug(d.id) !== null && !doomed.has(d.id)).map((d) => d.id)
  return pruneChecklists(keep)
}

// ─── checklist template validation (client-side mirror) ────────────────────────

const TEMPLATE_KINDS = ['action', 'rapport', 'reference'] as const
export type ParsedChecklistKind = (typeof TEMPLATE_KINDS)[number]

export interface ParsedChecklist {
  id: string
  kind: ParsedChecklistKind
  title: string
  order: number | null
  /** phases (action/rapport) or entries (reference) — whichever the template carries */
  sections: number
  /** the parsed document, so the caller can stamp `order` back in before uploading */
  raw: Record<string, unknown>
}

/**
 * Parse + check a template BEFORE uploading it. The server does this too
 * (`_validate_checklist_template`, api/reference.py:44-64) and is the authority; this exists so
 * the operator learns that a file is the wrong one without a round trip, and so the page can
 * show the id it is about to write under. Error strings come from the caller's copy catalogue.
 */
export function parseChecklistTemplate(
  text: string,
  msg: {
    notJson: string
    notObject: string
    fieldMissing: string
    badKind: string
    needsPhasesOrEntries: string
    badId: string
  },
): { ok: true; value: ParsedChecklist } | { ok: false; error: string } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, error: msg.notJson }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: msg.notObject }
  const tpl = data as Record<string, unknown>
  for (const field of ['id', 'kind', 'title'] as const) {
    const v = tpl[field]
    if (typeof v !== 'string' || !v.trim()) return { ok: false, error: msg.fieldMissing.replace('{field}', field) }
  }
  const kind = tpl.kind as string
  if (!(TEMPLATE_KINDS as readonly string[]).includes(kind)) return { ok: false, error: msg.badKind.replace('{kind}', kind) }
  const id = (tpl.id as string).trim()
  // the dataset id is `checklists:<id>`, so a colon in the id would forge an asset id
  if (id.includes(':') || /\s/.test(id)) return { ok: false, error: msg.badId }
  // exactly one of them, same rule as the server: phases → action/rapport, entries → reference
  const phases = Array.isArray(tpl.phases) ? tpl.phases : []
  const entries = Array.isArray(tpl.entries) ? tpl.entries : []
  if (Boolean(phases.length) === Boolean(entries.length)) return { ok: false, error: msg.needsPhasesOrEntries }
  return {
    ok: true,
    value: {
      id,
      kind: kind as ParsedChecklistKind,
      title: (tpl.title as string).trim(),
      order: typeof tpl.order === 'number' ? tpl.order : null,
      sections: phases.length || entries.length,
      raw: tpl,
    },
  }
}

/** The bytes to upload: the parsed template with the chosen rail `order` stamped in — the same
 *  thing `_template_bytes` (admin_checklists.py:230-235) does, so a browser upload and a manifest
 *  push produce the same stored document. */
export function checklistUploadBlob(parsed: ParsedChecklist, order: number): Blob {
  return new Blob([JSON.stringify({ ...parsed.raw, order }, null, 2)], { type: 'application/json' })
}
