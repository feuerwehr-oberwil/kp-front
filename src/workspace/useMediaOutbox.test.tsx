// @vitest-environment jsdom
// Audit F06 (26.10.2026): an upload that lands must end as ONE link on its Verlauf row (or its
// Rapport-Beilage), however the page dies on the way — the real media queue, its React binding,
// this hook and a real JournalStore over a fake server, a fake workspace save and a fake
// IndexedDB that outlive each «session».
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SyncStatus } from '../lib/incidents'
import type { ReportAttachment, TimelineEvent } from '../types'

const disk = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  hang: (_key: string): boolean => false,
  /** a read that has to wait for this (a slow IndexedDB on a cold start) */
  held: null as { key: string; until: Promise<void> } | null,
}))
const server = vi.hoisted(() => ({ rows: [] as { seq: number; row: TimelineEvent }[], down: false, uploads: 0 }))
const upload = vi.hoisted(() => vi.fn(async () => ({ url: `/media/up-${++server.uploads}` })))

vi.mock('../lib/idb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/idb')>()),
  idbRead: async (key: string) => {
    if (disk.held?.key === key) await disk.held.until
    return { ok: true, value: disk.store.get(key) ?? null }
  },
  // a hung write never lands: the page is killed before IndexedDB commits it
  idbSet: async (key: string, value: unknown) => {
    if (disk.hang(key)) return new Promise<boolean>(() => {})
    disk.store.set(key, value)
    return true
  },
  idbDel: async (key: string) => { disk.store.delete(key) },
  idbKeys: async (prefix: string) => ({ ok: true, value: [...disk.store.keys()].filter((k) => k.startsWith(prefix)) }),
}))
vi.mock('../lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/api')>()
  const offline = () => new real.ApiError(0, 'offline')
  return {
    ...real,
    apiBeacon: () => {},
    apiGet: async (path: string) => {
      if (server.down) throw offline()
      const since = Number(/since_seq=(\d+)/.exec(path)?.[1] ?? 0)
      return { entries: server.rows.filter((r) => r.seq > since), latest_seq: server.rows.length }
    },
    apiPost: async (_path: string, body: { entries: TimelineEvent[] }) => {
      if (server.down) throw offline()
      for (const row of body.entries) if (!server.rows.some((r) => r.row.id === row.id)) server.rows.push({ seq: server.rows.length + 1, row })
      const sent = new Set(body.entries.map((r) => r.id))
      return { entries: server.rows.filter((r) => sent.has(r.row.id)), latest_seq: server.rows.length }
    },
  }
})
vi.mock('../lib/incidents', () => ({ uploadMedia: upload }))
vi.mock('../lib/mediaUrl', () => ({ forgetLocalThumb: vi.fn(), mintLocalThumb: async () => {} }))

import { JournalStore } from '../lib/journalStore'
import { __resetMediaQueueForTests, enqueueMedia, flushMediaQueue, type MediaQueueItem } from '../lib/mediaQueue'
import { rowPhotos } from '../lib/verlauf'
import { useMediaOutbox } from './useMediaOutbox'

const INC = 'f06'
const QUEUE = `kp-front-mediaq-${INC}`
const AT = '2026-10-26T10:00:00.000Z'
/** a photo row with one picture on the server and a second one captured offline */
const ROW: TimelineEvent = { id: 'r1', t: '10:00', at: AT, icon: 'photo', text: '', kind: 'photo', photoUrls: ['/media/a', 'blob:cap'] }

/** The store's change callback as a version to re-render on — what useJournal's nonce does. */
function watch(store: JournalStore) {
  const listeners = new Set<() => void>()
  let version = 0
  store.onChange = () => { version++; listeners.forEach((l) => l()) }
  return { subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }, version: () => version }
}

/** The workspace's wiring of this hook, over a real JournalStore (what useJournal hands it) and
 *  the Beilagen state with its save effect (useWorkspaceDoc + useIncidentSync). */
function useWorkspace(store: JournalStore, watched: ReturnType<typeof watch>, workspace: FakeWorkspace) {
  const version = useSyncExternalStore(watched.subscribe, watched.version)
  // re-read on every change, like useJournal (`version` is the change counter)
  const rows = useMemo(() => (version >= 0 ? store.display() : []), [store, version])
  const [attachments, setAttachments] = useState(() => (disk.store.get(ATTACHMENTS) as ReportAttachment[] | undefined) ?? [])
  // the same blob a second time is not a save (useIncidentSync)
  const saved = useRef(JSON.stringify(attachments))
  useEffect(() => {
    const body = JSON.stringify(attachments)
    if (body === saved.current) return
    saved.current = body
    workspace.save(attachments)
  }, [attachments, workspace])
  const outbox = useMediaOutbox({
    swapPhoto: (id, from, to) => store.swapPhoto(id, from, to),
    // useRowMediaUpload · swapAttachmentMedia: a deleted Beilage is never recreated
    swapAttachmentMedia: (id, url) => setAttachments((list) => list.map((a) => (a.id === id ? { ...a, url } : a))),
    overlayRow: (id, fields) => store.overlaySession(id, fields),
    patchRow: (id, fields) => store.appendPatch(id, fields),
    incidentMeta: { id: INC }, canWriteRecord: true, closedRefusedTotal: 0, exportedClosedRefused: 0,
    recordsSyncStatus: store.syncStatus, syncWorkspaceNow: async () => {},
    journal: { rows, getStatus: () => store.syncStatus, rowShown: (id) => store.rowShown(id), retry: () => store.retry(), flush: () => store.flush() },
    auditDelivery: { retry: async () => {}, getStatus: () => 'synced' },
    sync: workspace, flushEvents: async () => {},
  })
  return { ...outbox, attachments }
}

/** Session 0: the row is on the server and in the device's journal cache, its second picture queued. */
async function seed() {
  const store = new JournalStore(INC, false)
  await store.init([])
  store.append(ROW)
  await store.flush()
  await waitFor(() => expect(server.rows.map((r) => r.row.id)).toEqual(['r1']))
  store.dispose()
  await enqueueMedia(INC, 'r1', 'photo', new Blob(['jpg']), 'photo-r1', AT, 'blob:cap')
}

/** A fresh page: nothing of the last one survives but the fake disk and the server. */
async function open({ awaitJournal = true } = {}) {
  __resetMediaQueueForTests()
  const store = new JournalStore(INC, false)
  const watched = watch(store)
  const workspace = new FakeWorkspace()
  const init = store.init([])
  if (awaitJournal) await init
  const page = renderHook(() => useWorkspace(store, watched, workspace))
  return { store, page, workspace, kill: () => { page.unmount(); store.dispose() } }
}

const ATTACHMENTS = 'workspace-attachments'

/** The workspace's save engine as far as this hook sees it (WorkspaceSync): a save is owed until
 *  it is pushed, and only a push puts the Beilagen on disk — a page killed before loses it. */
class FakeWorkspace {
  hasUnsynced = false
  syncStatus: SyncStatus = 'synced'
  private owed: ReportAttachment[] = []
  save(list: ReportAttachment[]) { this.owed = list; this.hasUnsynced = true; this.syncStatus = 'pending' }
  push() { disk.store.set(ATTACHMENTS, this.owed); this.hasUnsynced = false; this.syncStatus = 'synced' }
}

const storedQueue = () => (disk.store.get(QUEUE) as MediaQueueItem[] | undefined) ?? []
const photosOf = (store: JournalStore) => rowPhotos(store.display().find((r) => r.id === 'r1') ?? {})
/** the server's patch rows for r1 — each one link */
const patchesOnServer = () => server.rows.filter((r) => r.row.patchOf === 'r1')

async function settled(store: JournalStore, page: { result: { current: ReturnType<typeof useWorkspace> } }) {
  await waitFor(() => {
    expect(storedQueue()).toEqual([])
    expect(page.result.current.media.syncStatus).toBe('synced')
    expect(store.syncStatus).toBe('synced')
  })
}

beforeEach(async () => {
  Object.assign(URL, { createObjectURL: () => 'blob:restored', revokeObjectURL: () => {} })
  await seed()
  upload.mockClear()
})
afterEach(() => {
  cleanup()
  disk.store.clear()
  disk.hang = () => false
  disk.held = null
  server.rows = []
  server.down = false
  server.uploads = 0
  __resetMediaQueueForTests()
})

it('killed after the upload answered, before the queue write: the capture uploads again and links once', async () => {
  disk.hang = (key) => key === QUEUE
  const first = await open()
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
  await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
  first.kill()
  disk.hang = () => false
  // nothing was written: still the capture, bytes and all
  expect(storedQueue()).toMatchObject([{ status: 'pending', localUrl: 'blob:cap' }])

  const second = await open()
  await settled(second.store, second.page)
  // the server holds the bytes twice (no idempotent upload by capture id), the row links one
  expect(upload).toHaveBeenCalledTimes(2)
  expect(patchesOnServer()).toHaveLength(1)
  expect(photosOf(second.store)).toEqual(['/media/a', '/media/up-2'])
})

it('killed after the receipt was stored, before the link: the next start links it without uploading again', async () => {
  await flushMediaQueue(INC, upload) // the page dies right after this write
  const [receipt] = storedQueue()
  expect(receipt).toMatchObject({ status: 'uploaded', url: '/media/up-1', rowId: 'r1' })
  expect(receipt).not.toHaveProperty('blob')

  // the Verlauf loads only after the first replay ran: the replay must wait for the row, not
  // patch a list it cannot see (that would hide /media/a)
  let release!: () => void
  disk.held = { key: `kp-journal-${INC}`, until: new Promise<void>((r) => { release = r }) }
  const next = await open({ awaitJournal: false })
  await act(async () => { await next.page.result.current.media.replayReceipts() })
  expect(patchesOnServer()).toHaveLength(0)
  release()
  await settled(next.store, next.page)
  expect(upload).toHaveBeenCalledTimes(1)
  expect(patchesOnServer()).toHaveLength(1)
  expect(photosOf(next.store)).toEqual(['/media/a', '/media/up-1'])
})

it('killed after the link, before the receipt was retired: the replay does not link again', async () => {
  server.down = true // the Verlauf cannot deliver the patch, so the receipt has to stay
  const first = await open()
  await waitFor(() => {
    const cached = disk.store.get(`kp-journal-${INC}`) as { outbox: TimelineEvent[] } | undefined
    expect(cached?.outbox.filter((r) => r.patchOf === 'r1')).toHaveLength(1)
  })
  // replayed on every Verlauf change meanwhile — still one patch, still «not saved»
  await act(async () => { await first.page.result.current.media.replayReceipts() })
  expect(first.store.recoveryData().entries.filter((r) => r.patchOf === 'r1')).toHaveLength(1)
  expect(storedQueue()).toMatchObject([{ status: 'uploaded', url: '/media/up-1' }])
  expect(first.page.result.current.media).toMatchObject({ syncStatus: 'pending', pendingCount: 0, receiptCount: 1 })
  first.kill()

  server.down = false
  const second = await open()
  await settled(second.store, second.page)
  expect(patchesOnServer()).toHaveLength(1)
  expect(photosOf(second.store)).toEqual(['/media/a', '/media/up-1'])
})

it('an entry stored by a build before receipts (no rev, no state) still uploads and links once', async () => {
  const blob = new Blob(['jpg'])
  disk.store.set(QUEUE, [{ id: 'r1:photo:blob:cap', incidentId: INC, rowId: 'r1', kind: 'photo', blob, filename: 'photo-r1', createdAt: AT, attempts: 0, status: 'pending', localUrl: 'blob:cap' }])
  const page = await open()
  await settled(page.store, page.page)
  expect(upload).toHaveBeenCalledTimes(1)
  expect(patchesOnServer()).toHaveLength(1)
  expect(photosOf(page.store)).toEqual(['/media/a', '/media/up-1'])
})

it('a Beilage links through the workspace, never the Verlauf, and its receipt waits for the workspace save', async () => {
  disk.store.delete(QUEUE) // only the Beilage is queued here
  disk.store.set(ATTACHMENTS, [{ id: 'att1', url: 'blob:att-cap', at: AT }])
  await enqueueMedia(INC, 'att1', 'photo', new Blob(['jpg']), 'damage.jpg', AT, 'blob:att-cap', 'attachment')

  const first = await open()
  // restored onto the Beilage, then uploaded and swapped — the save it owes is not pushed yet
  await waitFor(() => expect(first.page.result.current.attachments).toEqual([{ id: 'att1', url: '/media/up-1', at: AT }]))
  await act(async () => { await first.page.result.current.media.replayReceipts() })
  expect(storedQueue()).toMatchObject([{ status: 'uploaded', url: '/media/up-1', target: 'attachment', rowId: 'att1' }])
  expect(first.page.result.current.media.syncStatus).toBe('pending')
  first.kill() // the workspace save never landed: the disk still has the dead session URL

  const second = await open()
  await waitFor(() => expect(second.page.result.current.attachments[0].url).toBe('/media/up-1'))
  await act(async () => { await second.page.result.current.media.replayReceipts() })
  expect(storedQueue()).toHaveLength(1) // swapped again, but the save is still owed
  second.workspace.push()
  await act(async () => { await second.page.result.current.media.replayReceipts() })
  await settled(second.store, second.page)
  expect(disk.store.get(ATTACHMENTS)).toEqual([{ id: 'att1', url: '/media/up-1', at: AT }])
  expect(upload).toHaveBeenCalledTimes(1)
  // nothing of it went near the Verlauf
  expect(server.rows.some((r) => r.row.patchOf === 'att1')).toBe(false)
  expect(second.store.recoveryData().entries).toEqual([])
})

it('retracting the only photo row while its picture is queued: the receipt links nothing and retires once synced', async () => {
  // (review of F06: the visible rows went empty and the replay waited for a load forever)
  const page = await open()
  act(() => { page.store.appendPatch('r1', { retracted: true }) })
  await settled(page.store, page.page)
  expect(upload).toHaveBeenCalledTimes(1)
  // the retraction is the row's only patch: no picture went onto the retracted row
  expect(patchesOnServer().map((r) => r.row.retracted)).toEqual([true])
})
