import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import * as idb from './idb'
import { __resetIdbForTests } from './idb'
import {
  __resetMediaQueueForTests,
  clearIncidentMedia,
  clearUploadedMedia,
  enqueueMedia,
  flushMediaQueue,
  isMediaQueueDurable,
  isReceipt,
  listMediaQueue,
  mediaQueueId,
  retireMediaReceipts,
  sameQueue,
  type MediaCapture,
  type MediaQueueItem,
  type MediaUploader,
} from './mediaQueue'
import { mediaSyncStatus } from './useMediaQueue'

const INC = 'inc1'
const blob = (s = 'x') => new Blob([s], { type: 'text/plain' })
/** the entry as a capture (bytes aboard) — fails the test on a receipt */
const capture = (item: MediaQueueItem): MediaCapture => {
  if (isReceipt(item)) throw new Error(`expected a capture, got the receipt for ${item.url}`)
  return item
}

// most tests want the network "up" so a rejecting uploader counts as a real server failure
function setOnline(v: boolean) {
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: v }, configurable: true })
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  __resetIdbForTests()
  __resetMediaQueueForTests()
  setOnline(true)
  vi.restoreAllMocks()
})

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('mediaQueue', () => {
  it('enqueues a captured blob and lists it as pending', async () => {
    await enqueueMedia(INC, 'e1', 'photo', blob(), 'photo-e1', '2026-07-01T10:00:00Z')
    const q = await listMediaQueue(INC)
    expect(q).toHaveLength(1)
    expect(q[0]).toMatchObject({ id: mediaQueueId('e1', 'photo'), rowId: 'e1', kind: 'photo', status: 'pending', attempts: 0 })
  })

  it('keeps an attachment target through persistence and successful upload', async () => {
    await enqueueMedia(INC, 'att1', 'photo', blob('damage'), 'damage.jpg', '2026-10-25T10:00:00Z', 'blob:damage', 'attachment')
    __resetMediaQueueForTests() // simulate a reload: metadata and bytes come from storage
    const queued = await listMediaQueue(INC)
    expect(queued[0]).toMatchObject({ rowId: 'att1', target: 'attachment', localUrl: 'blob:damage' })
    expect(await capture(queued[0]).blob.text()).toBe('damage')
    expect(mediaSyncStatus(queued, true)).toBe('pending')
    const result = await flushMediaQueue(INC, async () => ({ url: '/api/media/damage' }))
    expect(result.uploaded[0]).toMatchObject({ rowId: 'att1', target: 'attachment', url: '/api/media/damage' })
    // …and so does its receipt, so the replay links the Beilage, never a Verlauf row
    __resetMediaQueueForTests()
    expect(await listMediaQueue(INC)).toMatchObject([{ rowId: 'att1', target: 'attachment', status: 'uploaded', url: '/api/media/damage' }])
  })

  it('a re-capture for the same row+kind replaces the prior entry', async () => {
    await enqueueMedia(INC, 'e1', 'photo', blob('old'), 'p', '2026-07-01T10:00:00Z')
    await enqueueMedia(INC, 'e1', 'photo', blob('new'), 'p', '2026-07-01T10:05:00Z')
    const q = await listMediaQueue(INC)
    expect(q).toHaveLength(1)
    expect(await capture(q[0]).blob.text()).toBe('new')
  })

  it('several photos on ONE row all survive the queue', async () => {
    // keying photos per row made each capture evict the previous one: three pictures taken
    // offline left two of them destroyed, with no error anywhere
    await enqueueMedia(INC, 'e1', 'photo', blob('one'), 'p', '2026-07-01T10:00:00Z', 'blob:one')
    await enqueueMedia(INC, 'e1', 'photo', blob('two'), 'p', '2026-07-01T10:00:01Z', 'blob:two')
    await enqueueMedia(INC, 'e1', 'photo', blob('three'), 'p', '2026-07-01T10:00:02Z', 'blob:three')

    const q = await listMediaQueue(INC)
    expect(q).toHaveLength(3)
    expect(await Promise.all(q.map((i) => capture(i).blob.text()))).toEqual(['one', 'two', 'three'])
    // and each knows which picture of the row it stands for, so the upload swaps the right one
    expect(q.map((i) => i.localUrl)).toEqual(['blob:one', 'blob:two', 'blob:three'])
  })

  it('a re-recorded voice memo still supersedes the old one', async () => {
    await enqueueMedia(INC, 'e1', 'audio', blob('old'), 'a', '2026-07-01T10:00:00Z')
    await enqueueMedia(INC, 'e1', 'audio', blob('new'), 'a', '2026-07-01T10:05:00Z')
    const q = await listMediaQueue(INC)
    expect(q).toHaveLength(1)
    expect(await capture(q[0]).blob.text()).toBe('new')
  })

  it('flush reports which picture each upload replaces', async () => {
    await enqueueMedia(INC, 'e1', 'photo', blob(), 'p', '2026-07-01T10:00:00Z', 'blob:one')
    const upload: MediaUploader = vi.fn(async () => ({ url: 'https://srv/photo' }))
    const out = await flushMediaQueue(INC, upload)
    expect(out.uploaded[0].localUrl).toBe('blob:one')
  })

  it('flush uploads pending items, turns each into a receipt (server URL, no bytes) and reports them', async () => {
    await enqueueMedia(INC, 'e1', 'photo', blob(), 'p', '2026-07-01T10:00:00Z')
    await enqueueMedia(INC, 'e2', 'audio', blob(), 'a', '2026-07-01T10:01:00Z')
    const upload: MediaUploader = vi.fn(async (_i, _b, kind) => ({ url: `https://srv/${kind}` }))

    const out = await flushMediaQueue(INC, upload)

    expect(upload).toHaveBeenCalledTimes(2)
    expect(out.uploaded).toEqual([
      { id: mediaQueueId('e1', 'photo'), rowId: 'e1', kind: 'photo', url: 'https://srv/photo' },
      { id: mediaQueueId('e2', 'audio'), rowId: 'e2', kind: 'audio', url: 'https://srv/audio' },
    ])
    // the link is still owed: what survives a reload is the receipt, the bytes are gone
    __resetMediaQueueForTests()
    const q = await listMediaQueue(INC)
    expect(q).toMatchObject([
      { rowId: 'e1', status: 'uploaded', url: 'https://srv/photo' },
      { rowId: 'e2', status: 'uploaded', url: 'https://srv/audio' },
    ])
    expect(q.some((i) => 'blob' in i)).toBe(false)
  })

  it('never uploads a receipt again, not even on an explicit retry', async () => {
    await enqueueMedia(INC, 'e1', 'photo', blob(), 'p', '2026-07-01T10:00:00Z', 'blob:one')
    const upload: MediaUploader = vi.fn(async () => ({ url: 'https://srv/photo' }))
    await flushMediaQueue(INC, upload)
    expect((await flushMediaQueue(INC, upload, { retry: true })).uploaded).toEqual([])
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('retires only the receipt it is handed — a capture queued again under the same id stays', async () => {
    await enqueueMedia(INC, 'e1', 'audio', blob('old'), 'a', '2026-07-01T10:00:00Z')
    await flushMediaQueue(INC, vi.fn(async () => ({ url: 'https://srv/old' })))
    const [receipt] = (await listMediaQueue(INC)).filter(isReceipt)
    await enqueueMedia(INC, 'e1', 'audio', blob('new'), 'a', '2026-07-01T10:05:00Z') // re-recorded
    expect(await retireMediaReceipts(INC, [receipt])).toBe(true)
    const q = await listMediaQueue(INC)
    expect(q).toMatchObject([{ status: 'pending' }])
    expect(await capture(q[0]).blob.text()).toBe('new')

    await flushMediaQueue(INC, vi.fn(async () => ({ url: 'https://srv/new' })))
    await retireMediaReceipts(INC, (await listMediaQueue(INC)).filter(isReceipt))
    expect(await listMediaQueue(INC)).toEqual([])
  })

  it('keeps an item pending on a network failure without burning an attempt', async () => {
    await enqueueMedia(INC, 'e1', 'photo', blob(), 'p', '2026-07-01T10:00:00Z')
    const upload: MediaUploader = vi.fn(async () => { throw new ApiError(0, 'Netzwerkfehler') })

    const out = await flushMediaQueue(INC, upload)

    expect(out.uploaded).toHaveLength(0)
    const q = await listMediaQueue(INC)
    expect(q[0]).toMatchObject({ status: 'pending', attempts: 0 })
  })

  it('offline navigator keeps items pending even if the uploader throws a non-network error', async () => {
    setOnline(false)
    await enqueueMedia(INC, 'e1', 'photo', blob(), 'p', '2026-07-01T10:00:00Z')
    const upload: MediaUploader = vi.fn(async () => { throw new Error('boom') })

    await flushMediaQueue(INC, upload)

    expect((await listMediaQueue(INC))[0]).toMatchObject({ status: 'pending', attempts: 0 })
  })

  it('flips to failed after repeated server rejections while online', async () => {
    await enqueueMedia(INC, 'e1', 'photo', blob(), 'p', '2026-07-01T10:00:00Z')
    const upload: MediaUploader = vi.fn(async () => { throw new ApiError(500, 'server') })

    await flushMediaQueue(INC, upload, { retry: true }) // attempt 1 → pending
    expect((await listMediaQueue(INC))[0]).toMatchObject({ status: 'pending', attempts: 1 })
    await flushMediaQueue(INC, upload, { retry: true }) // attempt 2 → pending
    expect((await listMediaQueue(INC))[0]).toMatchObject({ status: 'pending', attempts: 2 })
    await flushMediaQueue(INC, upload, { retry: true }) // attempt 3 → failed
    expect((await listMediaQueue(INC))[0]).toMatchObject({ status: 'failed', attempts: 3, lastError: 'server' })
  })

  it('partial flush: the good item becomes a receipt, the failing one stays a capture', async () => {
    await enqueueMedia(INC, 'ok', 'photo', blob(), 'p', '2026-07-01T10:00:00Z')
    await enqueueMedia(INC, 'bad', 'audio', blob(), 'a', '2026-07-01T10:01:00Z')
    const upload: MediaUploader = vi.fn(async (_i, _b, kind) => {
      if (kind === 'audio') throw new ApiError(500, 'nope')
      return { url: 'https://srv/photo' }
    })

    const out = await flushMediaQueue(INC, upload)

    expect(out.uploaded.map((u) => u.rowId)).toEqual(['ok'])
    expect((await listMediaQueue(INC)).map((i) => [i.rowId, i.status])).toEqual([['ok', 'uploaded'], ['bad', 'pending']])
  })

  it('clearIncidentMedia drops the whole queue', async () => {
    await enqueueMedia(INC, 'e1', 'photo', blob(), 'p', '2026-07-01T10:00:00Z')
    await clearIncidentMedia(INC)
    expect(await listMediaQueue(INC)).toHaveLength(0)
  })

  it('queues are isolated per incident', async () => {
    await enqueueMedia('a', 'e1', 'photo', blob(), 'p', '2026-07-01T10:00:00Z')
    await enqueueMedia('b', 'e1', 'photo', blob(), 'p', '2026-07-01T10:00:00Z')
    await clearIncidentMedia('a')
    expect(await listMediaQueue('a')).toHaveLength(0)
    expect(await listMediaQueue('b')).toHaveLength(1)
  })
})

// ⚠️ The queue is ONE IDB value per incident, and it always has more than one writer: a composer
// row with three photos fires three uploads at once (each enqueues on failure), and a flush used
// to hold its snapshot across every awaited upload and then write it back over whatever had been
// captured in the meantime. Both lost captures without an error anywhere (23.09.2026).
describe('mediaQueue under concurrency', () => {
  /** An uploader that parks every call until the test lets it go. */
  function gatedUploader() {
    const gates: (() => void)[] = []
    const started: string[] = []
    const upload: MediaUploader = vi.fn(async (_i, b) => {
      started.push(await b.text())
      await new Promise<void>((r) => gates.push(r))
      return { url: `https://srv/${started.length}` }
    })
    const release = () => gates.splice(0).forEach((g) => g())
    const waitStarted = async (n: number) => { while (started.length < n) await new Promise((r) => setTimeout(r, 0)) }
    return { upload, release, waitStarted }
  }

  it('parallel enqueues all land', async () => {
    await Promise.all(['one', 'two', 'three', 'four', 'five'].map((t, i) =>
      enqueueMedia(INC, 'e1', 'photo', blob(t), 'p', `2026-07-01T10:00:0${i}Z`, `blob:${t}`)))
    const q = await listMediaQueue(INC)
    expect(q.map((i) => i.localUrl).sort()).toEqual(['blob:five', 'blob:four', 'blob:one', 'blob:three', 'blob:two'])
  })

  it('a capture enqueued while a flush is uploading survives the flush', async () => {
    await enqueueMedia(INC, 'e1', 'photo', blob('first'), 'p', '2026-07-01T10:00:00Z', 'blob:first')
    const { upload, release, waitStarted } = gatedUploader()
    const flushing = flushMediaQueue(INC, upload)
    await waitStarted(1)
    // the enqueue is NOT held behind the upload: it is stored before the upload settles
    await enqueueMedia(INC, 'e2', 'photo', blob('second'), 'p', '2026-07-01T10:00:05Z', 'blob:second')
    expect((await listMediaQueue(INC)).map((i) => i.localUrl)).toEqual(['blob:first', 'blob:second'])
    release()
    const out = await flushing

    expect(out.uploaded.map((u) => u.localUrl)).toEqual(['blob:first'])
    const q = await listMediaQueue(INC)
    expect(q.map((i) => [i.localUrl, i.status])).toEqual([['blob:first', 'uploaded'], ['blob:second', 'pending']])
    expect(out.remaining).toEqual(q)
  })

  it('a voice memo re-recorded during the flush is not dropped with the old upload', async () => {
    await enqueueMedia(INC, 'e1', 'audio', blob('old'), 'a', '2026-07-01T10:00:00Z')
    const { upload, release, waitStarted } = gatedUploader()
    const flushing = flushMediaQueue(INC, upload)
    await waitStarted(1)
    await enqueueMedia(INC, 'e1', 'audio', blob('new'), 'a', '2026-07-01T10:00:00Z')
    release()
    await flushing

    const q = await listMediaQueue(INC)
    expect(q).toHaveLength(1)
    expect(await capture(q[0]).blob.text()).toBe('new')
    expect(q[0]).toMatchObject({ status: 'pending', attempts: 0 })
  })

  it('a failed attempt is written onto the current queue, not over it', async () => {
    await enqueueMedia(INC, 'bad', 'audio', blob('bad'), 'a', '2026-07-01T10:00:00Z')
    let letGo!: () => void
    const upload: MediaUploader = vi.fn(async () => {
      await new Promise<void>((r) => { letGo = r })
      throw new ApiError(500, 'nope')
    })
    const flushing = flushMediaQueue(INC, upload)
    while (!letGo) await new Promise((r) => setTimeout(r, 0))
    await enqueueMedia(INC, 'late', 'photo', blob('late'), 'p', '2026-07-01T10:00:09Z', 'blob:late')
    letGo()
    await flushing

    const q = await listMediaQueue(INC)
    expect(q.map((i) => [i.rowId, i.attempts])).toEqual([['bad', 1], ['late', 0]])
  })

  it('two flushes at once upload each item once', async () => {
    await enqueueMedia(INC, 'e1', 'photo', blob('one'), 'p', '2026-07-01T10:00:00Z', 'blob:one')
    await enqueueMedia(INC, 'e2', 'photo', blob('two'), 'p', '2026-07-01T10:00:01Z', 'blob:two')
    const upload: MediaUploader = vi.fn(async () => ({ url: 'https://srv/x' }))
    const [a, b] = await Promise.all([flushMediaQueue(INC, upload), flushMediaQueue(INC, upload)])

    expect(upload).toHaveBeenCalledTimes(2)
    expect(a.uploaded.length + b.uploaded.length).toBe(2)
    expect((await listMediaQueue(INC)).map((i) => i.status)).toEqual(['uploaded', 'uploaded'])
  })
})

// ⚠️ A refused queue write used to be ignored (23.09.2026): the capture read as queued, lived only
// in the tab, and nothing said so. And a queue that could not be READ was taken for an empty one,
// so the next capture was written over every capture already stored.
describe('mediaQueue · a capture the device could not store', () => {
  it('reports the refused write, keeps the capture in memory, and still uploads it', async () => {
    const write = vi.spyOn(idb, 'idbSet').mockResolvedValue(false)
    expect(await enqueueMedia(INC, 'e1', 'photo', blob('held'), 'p', '2026-07-01T10:00:00Z', 'blob:held')).toBe(false)
    expect(isMediaQueueDurable(INC)).toBe(false)
    expect((await listMediaQueue(INC)).map((i) => i.localUrl)).toEqual(['blob:held'])

    const upload: MediaUploader = vi.fn(async () => ({ url: 'https://srv/held' }))
    const out = await flushMediaQueue(INC, upload)
    expect(out.uploaded.map((u) => u.localUrl)).toEqual(['blob:held'])
    expect(isMediaQueueDurable(INC)).toBe(false) // the receipt is held in memory too
    await retireMediaReceipts(INC, (await listMediaQueue(INC)).filter(isReceipt))
    expect(isMediaQueueDurable(INC)).toBe(true) // nothing is left that needs storing
    write.mockRestore()
  })

  it('writes what it held as soon as a later write lands', async () => {
    const write = vi.spyOn(idb, 'idbSet').mockResolvedValueOnce(false)
    expect(await enqueueMedia(INC, 'e1', 'photo', blob('one'), 'p', '2026-07-01T10:00:00Z', 'blob:one')).toBe(false)
    expect(await enqueueMedia(INC, 'e2', 'photo', blob('two'), 'p', '2026-07-01T10:00:01Z', 'blob:two')).toBe(true)
    write.mockRestore()
    expect(isMediaQueueDurable(INC)).toBe(true)
    __resetMediaQueueForTests() // a reload: only what was stored comes back
    expect((await listMediaQueue(INC)).map((i) => i.localUrl)).toEqual(['blob:one', 'blob:two'])
  })

  it('never writes a new capture over a stored queue it could not read', async () => {
    await enqueueMedia(INC, 'e1', 'photo', blob('stored'), 'p', '2026-07-01T10:00:00Z', 'blob:stored')
    const read = vi.spyOn(idb, 'idbRead').mockResolvedValueOnce({ ok: false, error: new Error('io') })
    const write = vi.spyOn(idb, 'idbSet')
    expect(await enqueueMedia(INC, 'e2', 'photo', blob('new'), 'p', '2026-07-01T10:00:05Z', 'blob:new')).toBe(false)
    expect(write).not.toHaveBeenCalled()
    read.mockRestore()
    // the next read answers: both are there, and the next write stores both
    expect((await listMediaQueue(INC)).map((i) => i.localUrl)).toEqual(['blob:stored', 'blob:new'])
    expect(await enqueueMedia(INC, 'e3', 'audio', blob('a'), 'a', '2026-07-01T10:00:09Z')).toBe(true)
    __resetMediaQueueForTests()
    expect((await listMediaQueue(INC)).map((i) => i.rowId)).toEqual(['e1', 'e2', 'e3'])
  })
})

describe('mediaSyncStatus (the queue in the shared sync status)', () => {
  const item = (status: 'pending' | 'failed') => ({ id: 'x', incidentId: INC, rowId: 'r', kind: 'photo' as const, blob: blob(), filename: 'p', createdAt: '', attempts: 0, status })
  it('is synced with nothing queued, pending while captures or receipts wait, error when refused, storage when unstored', () => {
    expect(mediaSyncStatus([], true)).toBe('synced')
    expect(mediaSyncStatus([item('pending')], true)).toBe('pending')
    expect(mediaSyncStatus([{ id: 'y', incidentId: INC, rowId: 'r', kind: 'photo', filename: 'p', createdAt: '', attempts: 0, status: 'uploaded', url: '/media/x' }], true)).toBe('pending')
    expect(mediaSyncStatus([item('pending'), item('failed')], true)).toBe('error')
    expect(mediaSyncStatus([item('failed')], false)).toBe('storage')
  })
})

describe('sameQueue (re-render loop guard)', () => {
  // identical content must compare equal so the React binding keeps the previous state
  // identity (an unconditional setItems drove an App-wide render->flush->IDB loop)
  it('is true for two empty lists and for identical content', async () => {
    expect(sameQueue([], [])).toBe(true)
    await enqueueMedia(INC, 'e1', 'photo', blob(), 'p', '2026-07-01T10:00:00Z')
    const a = await listMediaQueue(INC)
    const b = await listMediaQueue(INC)
    expect(a).not.toBe(b)
    expect(sameQueue(a, b)).toBe(true)
  })

  it('is false when an item, its status, or its attempt count differs', async () => {
    await enqueueMedia(INC, 'e1', 'photo', blob(), 'p', '2026-07-01T10:00:00Z')
    const one = await listMediaQueue(INC)
    expect(sameQueue(one, [])).toBe(false)
    expect(sameQueue(one, [{ ...capture(one[0]), status: 'failed' as const }])).toBe(false)
    expect(sameQueue(one, [{ ...one[0], attempts: 2 }])).toBe(false)
  })
})

// ⚠️ The Abschluss archives the incident and used to drop this queue outright — which is right
// once everything is on the server, and destructive in the case that actually happens: offline at
// Einsatzende, with photos and voice memos still pending. That deleted exactly the media the
// Rapport had promised to send «bei Verbindung».
describe('clearUploadedMedia (what an archive is allowed to throw away)', () => {
  it('keeps an unlinked receipt, then drops the empty queue and says nothing was kept', async () => {
    await enqueueMedia(INC, 'e1', 'photo', blob(), 'photo-e1', '2026-07-01T10:00:00Z')
    const upload: MediaUploader = async () => ({ url: '/media/e1.jpg' })
    await flushMediaQueue(INC, upload)
    expect(await clearUploadedMedia(INC)).toBe(1) // the link is not acknowledged yet

    await retireMediaReceipts(INC, (await listMediaQueue(INC)).filter(isReceipt))
    expect(await clearUploadedMedia(INC)).toBe(0)
    expect(await listMediaQueue(INC)).toEqual([])
  })

  it('keeps a queue that still holds something, and reports how much', async () => {
    setOnline(false)
    await enqueueMedia(INC, 'e1', 'photo', blob(), 'photo-e1', '2026-07-01T10:00:00Z')
    await enqueueMedia(INC, 'e2', 'audio', blob(), 'audio-e2', '2026-07-01T10:05:00Z')
    const upload: MediaUploader = async () => { throw new ApiError(0, 'offline') }
    await flushMediaQueue(INC, upload)

    expect(await clearUploadedMedia(INC)).toBe(2)
    // …and it is still there for the next time the incident is opened
    expect(await listMediaQueue(INC)).toHaveLength(2)
  })

  it('is a no-op on an incident that never queued anything', async () => {
    expect(await clearUploadedMedia('never-used')).toBe(0)
  })
})


it('retains actual bytes in memory when only the JSON storage fallback is available', async () => {
  const stored = new Map<string, string>()
  vi.stubGlobal('indexedDB', undefined)
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  })
  __resetIdbForTests()
  const durable = await enqueueMedia(INC, 'binary', 'photo', blob('original bytes'), 'p.jpg', '')
  expect(durable).toBe(false)
  expect(isMediaQueueDurable(INC)).toBe(false)
  const [item] = await listMediaQueue(INC)
  expect(await capture(item).blob.text()).toBe('original bytes')
  expect(stored.has('kp-idb-fb:kp-front-mediaq-' + INC)).toBe(false)
  const upload = vi.fn(async () => ({ url: '/api/media/saved' }))
  expect((await flushMediaQueue(INC, upload)).uploaded).toHaveLength(1)
})

it('backs off automatic uploads, stops after three rejections, and allows an explicit retry', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  await enqueueMedia(INC, 'bad', 'audio', blob(), 'voice', '')
  const upload = vi.fn().mockRejectedValue(new ApiError(413, 'too large'))
  for (let attempt = 1; attempt <= 3; attempt++) {
    await flushMediaQueue(INC, upload)
    await flushMediaQueue(INC, upload)
    expect(upload).toHaveBeenCalledTimes(attempt)
    vi.setSystemTime(Date.now() + 60_000)
  }
  await flushMediaQueue(INC, upload)
  expect(upload).toHaveBeenCalledTimes(3)
  upload.mockResolvedValue({ url: '/api/media/saved' })
  expect((await flushMediaQueue(INC, upload, { retry: true })).uploaded).toHaveLength(1)
})

// a backend down for a while (a deploy) must not leave captures waiting for a tap – retries are
// safe since every attempt carries the upload id
it.each([502, 503, 504])('keeps retrying a %i by itself, one attempt per growing, capped pause', async (status) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  await enqueueMedia(INC, 'restart', 'audio', blob(), 'voice', '')
  const upload = vi.fn<MediaUploader>().mockRejectedValue(new ApiError(status, 'down'))
  const pauses: number[] = []
  for (let step = 1; step <= 8; step++) {
    await flushMediaQueue(INC, upload)
    await flushMediaQueue(INC, upload) // before the pause is over: no second attempt
    expect(upload).toHaveBeenCalledTimes(step)
    const [item] = await listMediaQueue(INC)
    expect(item).toMatchObject({ status: 'pending', attempts: step })
    pauses.push(item.retryAt! - Date.now())
    vi.setSystemTime(item.retryAt!)
  }
  expect(pauses[1]).toBeGreaterThan(pauses[0])
  expect(Math.max(...pauses)).toBeLessThanOrEqual(330_000) // 5 min + 10 % jitter
  expect(pauses[pauses.length - 1]).toBeGreaterThanOrEqual(270_000)
  upload.mockResolvedValue({ url: '/api/media/saved' })
  expect((await flushMediaQueue(INC, upload)).uploaded).toHaveLength(1)
})

// a retry after a lost response must be recognisable as the same capture (api/media · upload_id)
it('sends the same upload id on every attempt of one capture – the one its direct upload used', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  await enqueueMedia(INC, 'r', 'photo', blob(), 'p', '', 'blob:x', undefined, 'mq-direct-1')
  const upload = vi.fn<MediaUploader>().mockRejectedValueOnce(new ApiError(504, 'timeout')).mockResolvedValue({ url: '/api/media/m' })
  await flushMediaQueue(INC, upload)
  vi.setSystemTime(Date.now() + 60_000)
  await flushMediaQueue(INC, upload)
  expect(upload.mock.calls.map((c) => c[4])).toEqual(['mq-direct-1', 'mq-direct-1'])
})

// «No answer at all» (a WLAN that routes nowhere, a cellar) must back off like the docs say,
// without ever counting toward `failed` (perf sweep 26.11.2026).
describe('mediaQueue · no answer at all', () => {
  const noAnswer = () => vi.fn<MediaUploader>().mockRejectedValue(new ApiError(0, 'Netzwerkfehler'))
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.spyOn(Math, 'random').mockReturnValue(0.5) // no jitter
  })

  it('doubles the pause from 5 s to the 5 min cap and never ends failed', async () => {
    await enqueueMedia(INC, 'cellar', 'photo', blob(), 'p', '')
    const upload = noAnswer()
    const pauses: number[] = []
    for (let step = 1; step <= 10; step++) {
      await flushMediaQueue(INC, upload)
      await flushMediaQueue(INC, upload) // before the pause is over: no second attempt
      expect(upload).toHaveBeenCalledTimes(step)
      const [item] = await listMediaQueue(INC)
      expect(item).toMatchObject({ status: 'pending', attempts: 0, misses: step })
      pauses.push(item.retryAt! - Date.now())
      vi.setSystemTime(item.retryAt!)
    }
    expect(pauses).toEqual([5, 10, 20, 40, 80, 160, 300, 300, 300, 300].map((s) => s * 1000))
  })

  it('rewrites the queue (Blobs included) at most 8 times in 10 minutes', async () => {
    await enqueueMedia(INC, 'cellar', 'photo', blob(), 'p', '')
    const writes = vi.spyOn(idb, 'idbSet')
    const upload = noAnswer()
    const end = Date.now() + 600_000
    for (;;) {
      await flushMediaQueue(INC, upload)
      const [item] = await listMediaQueue(INC)
      if (item.retryAt! > end) break
      vi.setSystemTime(item.retryAt!)
    }
    expect(writes.mock.calls.length).toBeLessThanOrEqual(8)
  })

  it('resets the pause on any server answer, while the upload id stays the same', async () => {
    await enqueueMedia(INC, 'cellar', 'photo', blob(), 'p', '', undefined, undefined, 'mq-1')
    const upload = noAnswer()
    for (let step = 0; step < 4; step++) {
      await flushMediaQueue(INC, upload)
      vi.setSystemTime((await listMediaQueue(INC))[0].retryAt!)
    }
    upload.mockRejectedValueOnce(new ApiError(503, 'down'))
    await flushMediaQueue(INC, upload)
    const [item] = await listMediaQueue(INC)
    expect(item).toMatchObject({ status: 'pending', attempts: 1 })
    expect(capture(item).misses).toBeUndefined()
    expect(item.retryAt! - Date.now()).toBe(10_000) // one counted attempt, as before
    expect(new Set(upload.mock.calls.map((c) => c[4]))).toEqual(new Set(['mq-1']))
  })

  it('treats an entry stored without the count (an older build) as count 0', async () => {
    const old = { id: 'e1:audio', incidentId: INC, rowId: 'e1', kind: 'audio', filename: 'v', createdAt: '', attempts: 0, status: 'pending', blob: blob(), retryAt: Date.now() - 1 }
    await idb.idbSet(`kp-front-mediaq-${INC}`, [old])
    await flushMediaQueue(INC, noAnswer())
    const [item] = await listMediaQueue(INC)
    expect(item).toMatchObject({ status: 'pending', attempts: 0, misses: 1 })
    expect(item.retryAt! - Date.now()).toBe(5_000)
  })

  it('a `due` flush tries waiting captures at once, but leaves failed ones for a tap', async () => {
    const entry = { incidentId: INC, filename: 'f', createdAt: '', blob: blob() }
    await idb.idbSet(`kp-front-mediaq-${INC}`, [
      { ...entry, id: 'cellar:photo', rowId: 'cellar', kind: 'photo', status: 'pending', attempts: 0, misses: 7, retryAt: Date.now() + 299_000 },
      { ...entry, id: 'bad:audio', rowId: 'bad', kind: 'audio', status: 'failed', attempts: 3, retryAt: Date.now() - 1 },
    ])
    const upload = vi.fn<MediaUploader>().mockResolvedValue({ url: '/api/media/m' })
    expect((await flushMediaQueue(INC, upload)).uploaded).toEqual([])
    const out = await flushMediaQueue(INC, upload, { due: 'reachable' })
    expect(out.uploaded.map((u) => u.rowId)).toEqual(['cellar'])
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('an upload that keeps failing gets one early try, however often the server answers others', async () => {
    await enqueueMedia(INC, 'big', 'photo', blob(), 'p', '')
    const upload = noAnswer()
    await flushMediaQueue(INC, upload) // a miss: 5 s pause
    for (let poll = 0; poll < 5; poll++) await flushMediaQueue(INC, upload, { due: 'reachable' }) // answered polls
    expect(upload).toHaveBeenCalledTimes(2)
    // a backend down for uploads re-arms onReachable as well: still no early re-send
    vi.setSystemTime((await listMediaQueue(INC))[0].retryAt!)
    upload.mockRejectedValueOnce(new ApiError(503, 'down'))
    await flushMediaQueue(INC, upload)
    for (let poll = 0; poll < 5; poll++) await flushMediaQueue(INC, upload, { due: 'reachable' })
    expect(upload).toHaveBeenCalledTimes(3)
    expect((await listMediaQueue(INC))[0]).toMatchObject({ status: 'pending', attempts: 1 })
  })

  it('the browser\'s `online` event still tries at once after an early try missed', async () => {
    await enqueueMedia(INC, 'big', 'photo', blob(), 'p', '')
    const upload = noAnswer()
    await flushMediaQueue(INC, upload)
    await flushMediaQueue(INC, upload, { due: 'reachable' }) // early try, misses again
    await flushMediaQueue(INC, upload, { due: 'reachable' })
    expect(upload).toHaveBeenCalledTimes(2)
    upload.mockResolvedValue({ url: '/api/media/m' })
    expect((await flushMediaQueue(INC, upload, { due: 'online' })).uploaded).toHaveLength(1)
  })

  it('an `online` try that misses does not use up the reachable try', async () => {
    await enqueueMedia(INC, 'big', 'photo', blob(), 'p', '')
    const upload = noAnswer()
    await flushMediaQueue(INC, upload) // a miss: the pause runs
    await flushMediaQueue(INC, upload, { due: 'online' }) // the browser says online, the upload still gets no answer
    expect(upload).toHaveBeenCalledTimes(2)
    upload.mockResolvedValue({ url: '/api/media/m' })
    expect((await flushMediaQueue(INC, upload, { due: 'reachable' })).uploaded).toHaveLength(1)
  })

  it('a flush that tries nothing does not write the queue again', async () => {
    await enqueueMedia(INC, 'big', 'photo', blob(), 'p', '')
    const upload = noAnswer()
    await flushMediaQueue(INC, upload) // a miss: the pause runs
    await flushMediaQueue(INC, upload, { due: 'reachable' }) // the one early try
    const write = vi.spyOn(idb, 'idbSet')
    const before = await listMediaQueue(INC)
    for (let poll = 0; poll < 5; poll++) expect((await flushMediaQueue(INC, upload, { due: 'reachable' })).remaining).toEqual(before)
    await flushMediaQueue(INC, upload) // the timer, before the pause is over
    expect(upload).toHaveBeenCalledTimes(2)
    expect(write).not.toHaveBeenCalled()
  })
})
