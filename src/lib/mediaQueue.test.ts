import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { __resetIdbForTests } from './idb'
import {
  clearIncidentMedia,
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
