import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { __resetIdbForTests } from './idb'
import {
  clearIncidentMedia,
  clearUploadedMedia,
  enqueueMedia,
  flushMediaQueue,
  listMediaQueue,
  mediaQueueId,
  sameQueue,
  type MediaUploader,
} from './mediaQueue'

const INC = 'inc1'
const blob = (s = 'x') => new Blob([s], { type: 'text/plain' })

// most tests want the network "up" so a rejecting uploader counts as a real server failure
function setOnline(v: boolean) {
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: v }, configurable: true })
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  __resetIdbForTests()
  setOnline(true)
})

describe('mediaQueue', () => {
  it('enqueues a captured blob and lists it as pending', async () => {
    await enqueueMedia(INC, 'e1', 'photo', blob(), 'photo-e1', '2026-07-01T10:00:00Z')
    const q = await listMediaQueue(INC)
    expect(q).toHaveLength(1)
    expect(q[0]).toMatchObject({ id: mediaQueueId('e1', 'photo'), rowId: 'e1', kind: 'photo', status: 'pending', attempts: 0 })
  })

  it('a re-capture for the same row+kind replaces the prior entry', async () => {
    await enqueueMedia(INC, 'e1', 'photo', blob('old'), 'p', '2026-07-01T10:00:00Z')
    await enqueueMedia(INC, 'e1', 'photo', blob('new'), 'p', '2026-07-01T10:05:00Z')
    const q = await listMediaQueue(INC)
    expect(q).toHaveLength(1)
    expect(await q[0].blob.text()).toBe('new')
  })

  it('several photos on ONE row all survive the queue', async () => {
    // keying photos per row made each capture evict the previous one: three pictures taken
    // offline left two of them destroyed, with no error anywhere
    await enqueueMedia(INC, 'e1', 'photo', blob('one'), 'p', '2026-07-01T10:00:00Z', 'blob:one')
    await enqueueMedia(INC, 'e1', 'photo', blob('two'), 'p', '2026-07-01T10:00:01Z', 'blob:two')
    await enqueueMedia(INC, 'e1', 'photo', blob('three'), 'p', '2026-07-01T10:00:02Z', 'blob:three')

    const q = await listMediaQueue(INC)
    expect(q).toHaveLength(3)
    expect(await Promise.all(q.map((i) => i.blob.text()))).toEqual(['one', 'two', 'three'])
    // and each knows which picture of the row it stands for, so the upload swaps the right one
    expect(q.map((i) => i.localUrl)).toEqual(['blob:one', 'blob:two', 'blob:three'])
  })

  it('a re-recorded voice memo still supersedes the old one', async () => {
    await enqueueMedia(INC, 'e1', 'audio', blob('old'), 'a', '2026-07-01T10:00:00Z')
    await enqueueMedia(INC, 'e1', 'audio', blob('new'), 'a', '2026-07-01T10:05:00Z')
    const q = await listMediaQueue(INC)
    expect(q).toHaveLength(1)
    expect(await q[0].blob.text()).toBe('new')
  })

  it('flush reports which picture each upload replaces', async () => {
    await enqueueMedia(INC, 'e1', 'photo', blob(), 'p', '2026-07-01T10:00:00Z', 'blob:one')
    const upload: MediaUploader = vi.fn(async () => ({ url: 'https://srv/photo' }))
    const out = await flushMediaQueue(INC, upload)
    expect(out.uploaded[0].localUrl).toBe('blob:one')
  })

  it('flush uploads pending items, removes them, and reports the server URLs', async () => {
    await enqueueMedia(INC, 'e1', 'photo', blob(), 'p', '2026-07-01T10:00:00Z')
    await enqueueMedia(INC, 'e2', 'audio', blob(), 'a', '2026-07-01T10:01:00Z')
    const upload: MediaUploader = vi.fn(async (_i, _b, kind) => ({ url: `https://srv/${kind}` }))

    const out = await flushMediaQueue(INC, upload)

    expect(upload).toHaveBeenCalledTimes(2)
    expect(out.uploaded).toEqual([
      { id: mediaQueueId('e1', 'photo'), rowId: 'e1', kind: 'photo', url: 'https://srv/photo' },
      { id: mediaQueueId('e2', 'audio'), rowId: 'e2', kind: 'audio', url: 'https://srv/audio' },
    ])
    expect(await listMediaQueue(INC)).toHaveLength(0) // drained
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

    await flushMediaQueue(INC, upload) // attempt 1 → pending
    expect((await listMediaQueue(INC))[0]).toMatchObject({ status: 'pending', attempts: 1 })
    await flushMediaQueue(INC, upload) // attempt 2 → pending
    expect((await listMediaQueue(INC))[0]).toMatchObject({ status: 'pending', attempts: 2 })
    await flushMediaQueue(INC, upload) // attempt 3 → failed
    expect((await listMediaQueue(INC))[0]).toMatchObject({ status: 'failed', attempts: 3, lastError: 'server' })
  })

  it('partial flush: the good item drains, the failing one stays', async () => {
    await enqueueMedia(INC, 'ok', 'photo', blob(), 'p', '2026-07-01T10:00:00Z')
    await enqueueMedia(INC, 'bad', 'audio', blob(), 'a', '2026-07-01T10:01:00Z')
    const upload: MediaUploader = vi.fn(async (_i, _b, kind) => {
      if (kind === 'audio') throw new ApiError(500, 'nope')
      return { url: 'https://srv/photo' }
    })

    const out = await flushMediaQueue(INC, upload)

    expect(out.uploaded.map((u) => u.rowId)).toEqual(['ok'])
    const q = await listMediaQueue(INC)
    expect(q).toHaveLength(1)
    expect(q[0].rowId).toBe('bad')
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
    expect(q.map((i) => i.localUrl)).toEqual(['blob:second'])
    expect(out.remaining.map((i) => i.localUrl)).toEqual(['blob:second'])
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
    expect(await q[0].blob.text()).toBe('new')
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
    expect(await listMediaQueue(INC)).toEqual([])
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
    expect(sameQueue(one, [{ ...one[0], status: 'failed' as const }])).toBe(false)
    expect(sameQueue(one, [{ ...one[0], attempts: 2 }])).toBe(false)
  })
})

// ⚠️ The Abschluss archives the incident and used to drop this queue outright — which is right
// once everything is on the server, and destructive in the case that actually happens: offline at
// Einsatzende, with photos and voice memos still pending. That deleted exactly the media the
// Rapport had promised to send «bei Verbindung».
describe('clearUploadedMedia (what an archive is allowed to throw away)', () => {
  it('drops an empty queue and says nothing was kept', async () => {
    await enqueueMedia(INC, 'e1', 'photo', blob(), 'photo-e1', '2026-07-01T10:00:00Z')
    const upload: MediaUploader = async () => ({ url: '/media/e1.jpg' })
    await flushMediaQueue(INC, upload)

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
