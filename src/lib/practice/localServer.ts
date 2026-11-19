// SPIKE «Üben» (19.11.2026): a fake backend for the ONE practice incident of this device.
//
// lib/practice/installFetch hands it every request that names the practice id; it answers from
// IndexedDB (lib/idb) with the shapes of the real routes (src/lib/api/schema.d.ts), so
// IncidentWorkspace and its sync engines run unchanged. Only the semantics the client relies on:
//   · incident  GET → the meta; PATCH → merged (`is_archived` / `status` close it); DELETE → gone
//   · workspace GET → blob + rev; `?since=N` → 304 or the blob, `wait=1` parks until a save;
//               PUT (full, `/trupps`, `/record`) ALWAYS accepts and bumps the rev (one device,
//               no race to refuse); a range of revs that is only the asker's own saves is the
//               bodyless 304 with `X-Workspace-Rev` (the `writer` contract of pollWorkspaceSince)
//   · journal   GET `since_seq` (+ `wait`) → rows; POST → idempotent by row id, seqs ascending.
//               Patch rows (`patchOf`) are ordinary rows: the client folds them
//   · events    POST → appended with seq and a FAKE chain (`hash` = `practice-<seq>`); GET → all;
//               `verify` says intact; `snapshot` none; `samples` / `positions` / `objects` empty
//   · media     POST `/media` → the file kept in IndexedDB under a `practice-<incident>-…` id, so
//               `/api/media/<that id>` names the incident and is answered here too
//   · anything else (PDFs, print, links, presentation, alarm update, building card) → 501 with a
//               German {detail}: nothing that needs real server logic is faked
// Every answer carries `X-Practice: 1` (lib/api · rawFetch: a local answer says nothing about
// whether the SERVER is reachable).
//
// A RETIRED practice id (lib/practice/practiceMode · resetPractice) is answered 410 and nothing of
// it is stored: the page that was left may still send its teardown beacons.

import { idbDel, idbGet, idbKeys, idbSet, idbUpdate } from '../idb'
import type { IncidentFull } from '../api/incidents'
import type { In, Out } from '../api/wire'

type WorkspaceOut = Out<'WorkspaceOut'>
type JournalEntryOut = Out<'JournalEntryOut'>
type JournalPage = Out<'JournalPage'>
type EventOut = Out<'EventOut'>
type EventIn = In<'EventIn'>
type SnapshotOut = Out<'SnapshotOut'>
type Blob_ = Record<string, unknown>

/** The stored workspace: the blob, its rev, and which engine wrote each recent rev. */
interface StoredWorkspace { workspace: Blob_ | null; rev: number; writers: [rev: number, writer: string | null][] }
interface StoredMedia { blob: Blob; kind: string; name: string }

const WRITERS_KEEP = 200
const LONG_POLL_MS = 20_000
const NOT_HERE = 'Im Übungsmodus nicht verfügbar – die Übung bleibt auf diesem Gerät.'

const slot = (id: string, what: string) => `kp-practice-${id}:${what}`

// --- long-poll wake-ups (one tab: in memory is enough) ---------------------------------------
const waiters = new Map<string, Set<() => void>>()
function notify(topic: string): void {
  for (const w of [...(waiters.get(topic) ?? [])]) w()
}
/** Park until `topic` is notified, ~20 s pass, or `signal` aborts. Resolves either way. */
function park(topic: string, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    const set = waiters.get(topic) ?? new Set<() => void>()
    waiters.set(topic, set)
    const done = () => { clearTimeout(t); set.delete(done); signal?.removeEventListener('abort', done); resolve() }
    const t = setTimeout(done, LONG_POLL_MS)
    set.add(done)
    signal?.addEventListener('abort', done, { once: true })
  })
}

// --- responses ---------------------------------------------------------------------------------
const baseHeaders = (extra?: Record<string, string>) => ({ 'X-Practice': '1', ...extra })
function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: baseHeaders({ 'Content-Type': 'application/json', ...extra }) })
}
const empty = (status: number, extra?: Record<string, string>) => new Response(null, { status, headers: baseHeaders(extra) })
const refuse = (status: number, detail = NOT_HERE) => json({ detail }, status)

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const v: unknown = await req.json()
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch { return {} }
}
/** the last element (the app's lib target predates `Array.prototype.at`) */
const last = <T,>(xs: readonly T[]): T | undefined => xs[xs.length - 1]
const isRecord = (v: unknown): v is Blob_ => !!v && typeof v === 'object' && !Array.isArray(v)

// --- the incident ------------------------------------------------------------------------------
async function readMeta(id: string): Promise<IncidentFull | null> {
  return idbGet<IncidentFull>(slot(id, 'meta'))
}

/** Store the seed meta unless the incident already exists (App calls this at every boot). */
export async function ensurePracticeIncident(seed: IncidentFull): Promise<IncidentFull> {
  const have = await readMeta(seed.id)
  if (have) return have
  await idbSet(slot(seed.id, 'meta'), seed)
  return seed
}

/** The fields an IncidentPatch may set, applied like the server's `exclude_unset`. */
const PATCHABLE = ['type', 'priority', 'text', 'address', 'lat', 'lng', 'title', 'started_at', 'status', 'is_archived', 'is_exercise', 'report_done_at'] as const

function patched(meta: IncidentFull, body: Record<string, unknown>, now: string): IncidentFull {
  const next: IncidentFull = { ...meta, updated_at: now }
  for (const k of PATCHABLE) if (k in body) Object.assign(next, { [k]: body[k] })
  // the close: archived (Abschluss) or status «abgeschlossen» — the first close stays `closed_at`
  const closing = (body.is_archived === true || body.status === 'abgeschlossen') && !meta.is_archived && meta.status !== 'abgeschlossen'
  if (closing) {
    next.closed_at = meta.closed_at ?? now
    next.last_closed_at = now
    if (body.is_archived === true && !('status' in body)) next.status = 'abgeschlossen'
  }
  // the reopen
  if (body.is_archived === false && meta.is_archived) {
    next.status = 'offen'
  }
  return next
}

// --- the workspace -----------------------------------------------------------------------------
async function readWs(id: string): Promise<StoredWorkspace> {
  return (await idbGet<StoredWorkspace>(slot(id, 'ws'))) ?? { workspace: null, rev: 0, writers: [] }
}

async function writeWs(id: string, writer: string | null, change: (current: Blob_ | null) => Blob_): Promise<number> {
  let rev = 0
  await idbUpdate<StoredWorkspace>(slot(id, 'ws'), (cur) => {
    const base = cur ?? { workspace: null, rev: 0, writers: [] }
    rev = base.rev + 1
    return { workspace: change(base.workspace), rev, writers: [...base.writers, [rev, writer] as [number, string | null]].slice(-WRITERS_KEEP) }
  })
  notify(`ws:${id}`)
  return rev
}

/** Every rev in (since, rev] was written by `writer` — the asker already holds them. */
function onlyOwn(ws: StoredWorkspace, since: number, writer: string | null): boolean {
  if (!writer) return false
  const range = ws.writers.filter(([r]) => r > since)
  return range.length === ws.rev - since && range.every(([, w]) => w === writer)
}

async function workspaceRoute(id: string, req: Request, url: URL, sub: string): Promise<Response> {
  const meta = await readMeta(id)
  if (!meta) return refuse(404, 'Übung nicht gefunden')
  const open = !meta.is_archived && (meta.status === 'offen' || meta.status === 'in_arbeit')
  const life = { 'X-Incident-Open': open ? '1' : '0', ...(meta.last_closed_at ? { 'X-Incident-Closed-At': meta.last_closed_at } : {}) }
  if (req.method === 'GET' && sub === '') {
    const sinceRaw = url.searchParams.get('since')
    let ws = await readWs(id)
    if (sinceRaw === null) return json({ workspace: ws.workspace, workspace_rev: ws.rev } satisfies WorkspaceOut)
    const since = Number(sinceRaw)
    const writer = url.searchParams.get('writer')
    if (ws.rev <= since && url.searchParams.get('wait') === '1') {
      await park(`ws:${id}`, req.signal)
      ws = await readWs(id)
    }
    if (ws.rev <= since) return empty(304, life)
    if (onlyOwn(ws, since, writer)) return empty(304, { ...life, 'X-Workspace-Rev': String(ws.rev) })
    return json({ workspace: ws.workspace, workspace_rev: ws.rev } satisfies WorkspaceOut, 200, life)
  }
  if (req.method !== 'PUT') return refuse(405)
  const body = await readJson(req)
  const writer = req.headers.get('X-Workspace-Writer')
  let rev: number
  if (sub === '') {
    const blob = isRecord(body.workspace) ? body.workspace : {}
    rev = await writeWs(id, writer, () => blob)
  } else if (sub === '/trupps') {
    const trupps = Array.isArray(body.trupps) ? body.trupps : []
    rev = await writeWs(id, writer, (cur) => ({ ...(cur ?? {}), trupps }))
  } else if (sub === '/record') {
    // the real route keeps only RECORD_WORKSPACE_KEYS; here every key the slice carries
    const slice = isRecord(body.workspace) ? body.workspace : {}
    rev = await writeWs(id, writer, (cur) => ({ ...(cur ?? {}), ...slice }))
  } else {
    return refuse(404)
  }
  await idbUpdate<IncidentFull>(slot(id, 'meta'), (m) => (m ? { ...m, workspace_rev: rev } : m))
  return json({ workspace: null, workspace_rev: rev } satisfies WorkspaceOut)
}

// --- the Verlauf -------------------------------------------------------------------------------
async function readJournal(id: string): Promise<JournalEntryOut[]> {
  return (await idbGet<JournalEntryOut[]>(slot(id, 'journal'))) ?? []
}

async function journalRoute(id: string, req: Request, url: URL): Promise<Response> {
  if (req.method === 'GET') {
    const since = Number(url.searchParams.get('since_seq') ?? 0)
    let rows = (await readJournal(id)).filter((r) => r.seq > since)
    if (!rows.length && url.searchParams.get('wait') === '1') {
      await park(`journal:${id}`, req.signal)
      rows = (await readJournal(id)).filter((r) => r.seq > since)
    }
    return json({ entries: rows, latest_seq: last(rows)?.seq ?? since } satisfies JournalPage)
  }
  if (req.method !== 'POST') return refuse(405)
  const body = await readJson(req)
  const entries = (Array.isArray(body.entries) ? body.entries : []).filter(isRecord)
  let accepted: JournalEntryOut[] = []
  let latest = 0
  await idbUpdate<JournalEntryOut[]>(slot(id, 'journal'), (cur) => {
    const rows = cur ?? []
    const have = new Set(rows.map((r) => r.row.id))
    let seq = last(rows)?.seq ?? 0
    accepted = []
    for (const e of entries) {
      if (typeof e.id !== 'string' || have.has(e.id)) continue // replayed batch / duplicate
      have.add(e.id)
      const { via: _serverOnly, ...row } = e
      accepted.push({ seq: ++seq, row })
    }
    latest = seq
    return [...rows, ...accepted]
  })
  if (accepted.length) notify(`journal:${id}`)
  return json({ entries: accepted, latest_seq: latest } satisfies JournalPage, 201)
}

// --- the audit events --------------------------------------------------------------------------
async function eventsRoute(id: string, req: Request, sub: string, userId: string | null): Promise<Response> {
  if (sub === '/verify') {
    const n = ((await idbGet<EventOut[]>(slot(id, 'events'))) ?? []).length
    return json({ intact: true, broken_at_seq: null, count: n, head: n ? `practice-${n}` : undefined })
  }
  if (req.method === 'GET') return json((await idbGet<EventOut[]>(slot(id, 'events'))) ?? [])
  if (req.method !== 'POST') return refuse(405)
  const body = await readJson(req)
  const incoming = (Array.isArray(body.events) ? body.events : []).filter(isRecord) as EventIn[]
  const now = new Date().toISOString()
  let added: EventOut[] = []
  await idbUpdate<EventOut[]>(slot(id, 'events'), (cur) => {
    const rows = cur ?? []
    let seq = last(rows)?.seq ?? 0
    let prev = last(rows)?.hash ?? null
    added = incoming.map((e) => {
      seq += 1
      const hash = `practice-${seq}`
      const out: EventOut = {
        id: `${id}-ev-${seq}`, seq, occurred_at: e.occurred_at ?? now, recorded_at: now, source: 'practice',
        user_id: userId, op_type: e.op_type, payload_json: e.payload ?? null, prev_hash: prev, hash,
      }
      prev = hash
      return out
    })
    return [...rows, ...added]
  })
  return json(added, 201)
}

// --- media -------------------------------------------------------------------------------------
/** The media id the fake mints: it names the incident, so `/api/media/<id>` is routed here. */
const mediaIdFor = (incidentId: string, uploadId: string) => `practice-${incidentId}-${uploadId}`

async function mediaUpload(id: string, req: Request): Promise<Response> {
  let form: FormData
  try { form = await req.formData() } catch { return refuse(422, 'Datei fehlt') }
  const file = form.get('file')
  if (!(file instanceof Blob)) return refuse(422, 'Datei fehlt')
  const kind = String(form.get('kind') ?? 'file')
  const uploadId = String(form.get('upload_id') ?? Date.now().toString(36))
  const mid = mediaIdFor(id, uploadId.replace(/[^A-Za-z0-9_-]/g, ''))
  await idbSet(slot(id, `media:${mid}`), { blob: file, kind, name: file instanceof File ? file.name : 'upload' } satisfies StoredMedia)
  return json({ id: mid, url: `/api/media/${mid}`, kind }, 201)
}

async function mediaRead(incidentId: string, mid: string): Promise<Response> {
  const m = await idbGet<StoredMedia>(slot(incidentId, `media:${mid}`))
  if (!m) return refuse(404, 'Datei nicht gefunden')
  return new Response(m.blob, { status: 200, headers: baseHeaders({ 'Content-Type': m.blob.type || 'application/octet-stream' }) })
}

// --- the router --------------------------------------------------------------------------------
export interface PracticeContext {
  /** the practice incident this device works on now */
  id: string
  /** practice ids «Neu beginnen» retired — refused, never stored */
  retired: readonly string[]
  /** the signed-in account, stamped on audit events like the server does */
  userId?: string | null
}

/** Does this URL path belong to a practice incident (current or retired)? */
export function practiceTarget(pathname: string, ctx: PracticeContext): string | null {
  if (!pathname.startsWith('/api/')) return null
  for (const id of [ctx.id, ...ctx.retired]) if (pathname.includes(id)) return id
  return null
}

/** Answer one request for a practice incident. The caller has checked `practiceTarget`. */
export async function answerPractice(req: Request, ctx: PracticeContext): Promise<Response> {
  const url = new URL(req.url)
  const target = practiceTarget(url.pathname, ctx)
  if (!target) return refuse(404)
  if (target !== ctx.id) return refuse(410, 'Diese Übung wurde neu begonnen.')
  const id = target
  const media = /^\/api\/media\/([^/]+)$/.exec(url.pathname)
  if (media) return req.method === 'GET' ? mediaRead(id, media[1]) : refuse(405)
  const m = /^\/api\/incidents\/([^/]+)(\/.*)?$/.exec(url.pathname)
  if (!m || m[1] !== id) return refuse(404)
  const rest = m[2] ?? ''
  if (rest === '') {
    const meta = await readMeta(id)
    if (!meta) return refuse(404, 'Übung nicht gefunden')
    if (req.method === 'GET') return json(meta)
    if (req.method === 'PATCH') {
      const next = patched(meta, await readJson(req), new Date().toISOString())
      await idbSet(slot(id, 'meta'), next)
      notify(`ws:${id}`) // a parked follow hears the close (X-Incident-Open) at once
      return json(next)
    }
    if (req.method === 'DELETE') { await wipePracticeServer(id); return empty(204) }
    return refuse(405)
  }
  if (rest === '/workspace' || rest.startsWith('/workspace/')) return workspaceRoute(id, req, url, rest.slice('/workspace'.length))
  if (rest === '/journal') return journalRoute(id, req, url)
  if (rest === '/events' || rest === '/verify') return eventsRoute(id, req, rest === '/verify' ? '/verify' : '', ctx.userId ?? null)
  if (req.method === 'GET') {
    if (rest === '/snapshot') return json({ found: false, occurred_at: null, seq_at: null, workspace: null } satisfies SnapshotOut)
    if (rest === '/samples' || rest === '/positions' || rest === '/objects') return json([])
  }
  if (rest === '/media' && req.method === 'POST') return mediaUpload(id, req)
  // a position share of this device: accepted and forgotten (nobody else follows a practice)
  if (rest.startsWith('/positions')) return empty(204)
  return refuse(501)
}

/** Drop everything the fake holds for `id` (DELETE, and the tests). */
export async function wipePracticeServer(id: string): Promise<void> {
  const keys = await idbKeys(slot(id, ''))
  if (keys.ok) await Promise.all((keys.value ?? []).map((k) => idbDel(k)))
}
