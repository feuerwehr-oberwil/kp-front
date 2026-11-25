// Two tabs of one browser, one Einsatz's media queue (hunt 24.11.2026, the offline-sync F1 family):
// each tab is its own module instance – its own lanes and IndexedDB connection – over the one
// store, as in a browser. A tab that lost the edit lock can still be retiring receipts while the
// tab that took it stores a capture; neither write may undo the other.
import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { FakeLocks } from './webLocks.test-utils'

type Queue = typeof import('./mediaQueue')
async function tabModule(): Promise<Queue> {
  vi.resetModules()
  return import('./mediaQueue')
}
/** …with that tab's own storage module, to make one of its writes fail */
async function tabWithStorage() {
  const queue = await tabModule()
  return { queue, idb: await import('./idb') }
}

afterEach(() => { Reflect.deleteProperty(globalThis.navigator, 'locks') })

it('a receipt retired in one tab while the other stores a capture keeps the capture', async () => {
  Object.defineProperty(globalThis.navigator, 'locks', { value: new FakeLocks(), configurable: true })
  const a = await tabModule()
  const b = await tabModule()
  const id = 'tabs-inc'
  await a.enqueueMedia(id, 'r1', 'photo', new Blob(['one']), 'one.jpg', '2026-11-25T10:00:00Z', 'blob:one')
  await a.flushMediaQueue(id, async () => ({ url: '/api/media/1' }))
  const receipts = (await a.listMediaQueue(id)).filter(a.isReceipt)
  expect(receipts).toHaveLength(1)
  // the same moment in both tabs: B stores a new photo, A retires the linked receipt
  await Promise.all([
    b.enqueueMedia(id, 'r2', 'photo', new Blob(['two']), 'two.jpg', '2026-11-25T10:01:00Z', 'blob:two'),
    a.retireMediaReceipts(id, receipts),
  ])
  const stored = await (await tabModule()).listMediaQueue(id)
  expect(stored.map((i) => i.rowId)).toEqual(['r2'])
})

it('a tab whose write failed does not undo a voice memo the other tab re-recorded since', async () => {
  Object.defineProperty(globalThis.navigator, 'locks', { value: new FakeLocks(), configurable: true })
  const a = await tabWithStorage()
  const b = await tabModule()
  const id = 'memo-inc'
  await a.queue.enqueueMedia(id, 'r1', 'audio', new Blob(['old']), 'old.webm', '2026-11-25T10:00:00Z')
  // A's flush answers «offline» and its write-back fails: A now holds the queue in memory
  vi.spyOn(a.idb, 'idbSet').mockResolvedValueOnce(false).mockResolvedValueOnce(false)
  await a.queue.flushMediaQueue(id, async () => { throw new Error('offline') })
  expect(a.queue.isMediaQueueDurable(id)).toBe(false)
  vi.restoreAllMocks()
  // the edit lock moved: B re-records the memo of the same row
  await b.enqueueMedia(id, 'r1', 'audio', new Blob(['new']), 'new.webm', '2026-11-25T10:05:00Z')
  const sent: string[] = []
  await a.queue.flushMediaQueue(id, async (_i, blob) => { sent.push(await blob.text()); return { url: '/api/media/9' } })
  expect(sent).toEqual(['new'])
  const stored = await (await tabModule()).listMediaQueue(id)
  expect(stored).toEqual([expect.objectContaining({ createdAt: '2026-11-25T10:05:00Z' })])
})
