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

it('a tab whose write failed does not put back a capture the other tab has uploaded since', async () => {
  Object.defineProperty(globalThis.navigator, 'locks', { value: new FakeLocks(), configurable: true })
  const a = await tabWithStorage()
  const b = await tabModule()
  const id = 'receipt-inc'
  await a.queue.enqueueMedia(id, 'r1', 'photo', new Blob(['one']), 'one.jpg', '2026-11-25T10:00:00Z', 'blob:one')
  vi.spyOn(a.idb, 'idbSet').mockResolvedValueOnce(false).mockResolvedValueOnce(false)
  await a.queue.flushMediaQueue(id, async () => { throw new Error('offline') })
  vi.restoreAllMocks()
  await b.flushMediaQueue(id, async () => ({ url: '/api/media/1' })) // B, holding the lock now, sends it
  const upload = vi.fn(async () => ({ url: '/api/media/2' }))
  await a.queue.flushMediaQueue(id, upload)
  expect(upload).not.toHaveBeenCalled()
  const stored = await (await tabModule()).listMediaQueue(id)
  expect(stored).toEqual([expect.objectContaining({ status: 'uploaded', url: '/api/media/1' })])
})

it('a capture whose cross-tab lock is refused waits in memory, never written unlocked', async () => {
  const refuse = { request: () => Promise.reject(new DOMException('Document is not fully active', 'InvalidStateError')) }
  Object.defineProperty(globalThis.navigator, 'locks', { value: refuse, configurable: true })
  const a = await tabModule()
  const id = 'refused-inc'
  expect(await a.enqueueMedia(id, 'r1', 'photo', new Blob(['one']), 'one.jpg', '2026-11-25T10:00:00Z', 'blob:one')).toBe(false)
  expect(await a.listMediaQueue(id)).toEqual([expect.objectContaining({ rowId: 'r1', status: 'pending' })])
  expect(a.isMediaQueueDurable(id)).toBe(false)
  Reflect.deleteProperty(globalThis.navigator, 'locks')
  expect(await (await tabModule()).listMediaQueue(id)).toEqual([])
})

it('a memo held after a refused lock does not replace the newer one the other tab stored', async () => {
  const refuse = { request: () => Promise.reject(new DOMException('Document is not fully active', 'InvalidStateError')) }
  Object.defineProperty(globalThis.navigator, 'locks', { value: refuse, configurable: true })
  const a = await tabModule()
  const b = await tabModule()
  const id = 'held-memo-inc'
  await a.enqueueMedia(id, 'r1', 'audio', new Blob(['old']), 'old.webm', '2026-11-25T10:00:00Z')
  Object.defineProperty(globalThis.navigator, 'locks', { value: new FakeLocks(), configurable: true })
  await b.enqueueMedia(id, 'r1', 'audio', new Blob(['new']), 'new.webm', '2026-11-25T10:05:00Z')
  const sent: string[] = []
  await a.flushMediaQueue(id, async (_i, blob) => { sent.push(await blob.text()); return { url: '/api/media/3' } })
  expect(sent).toEqual(['new'])
})

// The back-off on a dead link (27.11.2026): each miss grows a capture's pause, and the server
// answering again gives it one early try. That signal can reach the tab that took the edit lock
// while the tab that lost it is still in a flush of the same capture: the try waits for that
// flush, sends once, and the other tab's late miss does not undo the receipt.
it('an early try while the other tab is still flushing waits, sends once and keeps its receipt', async () => {
  Object.defineProperty(globalThis.navigator, 'locks', { value: new FakeLocks(), configurable: true })
  const a = await tabModule()
  const b = await tabModule()
  const id = 'early-inc'
  await a.enqueueMedia(id, 'r1', 'audio', new Blob(['memo']), 'memo.webm', '2026-11-27T10:00:00Z')
  await a.flushMediaQueue(id, async () => { throw new Error('offline') }) // a miss: its pause runs
  let sending = 0
  let most = 0
  const send = () => { most = Math.max(most, ++sending) }
  let missA!: () => void
  const flushA = a.flushMediaQueue(id, () => {
    send()
    return new Promise((_, reject) => { missA = () => { sending--; reject(new Error('offline')) } })
  }, { due: 'online' })
  await vi.waitFor(() => expect(missA).toBeTypeOf('function'))
  const sendB = vi.fn(async () => { send(); sending--; return { url: '/api/media/5' } })
  const flushB = b.flushMediaQueue(id, sendB, { due: 'reachable' })
  await new Promise((r) => setTimeout(r, 20))
  expect(sendB).not.toHaveBeenCalled() // B waits for A's flush
  missA()
  await Promise.all([flushA, flushB])
  expect(sendB).toHaveBeenCalledOnce()
  expect(most).toBe(1)
  const stored = await (await tabModule()).listMediaQueue(id)
  expect(stored).toEqual([expect.objectContaining({ status: 'uploaded', url: '/api/media/5' })])
})
