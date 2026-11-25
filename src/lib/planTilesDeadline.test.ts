// Hunt 24.11.2026, performance F8: a manifest on a link that stalls without disconnecting kept
// the Plan's spinner up and the prewarm queue behind it. The fetch has a deadline; a timed-out
// manifest is evicted like any failure, so the next ask (and the pdf.js fallback) go on.
import { afterEach, expect, it, vi } from 'vitest'
import { MANIFEST_DEADLINE_MS, loadTileManifest } from './planTiles'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('gives up on a stalled manifest and asks again next time', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout')
  let calls = 0
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    calls += 1
    // a request that never answers – until its deadline aborts it
    return new Promise((_res, rej) => {
      const fail = () => rej(new DOMException('timeout', 'TimeoutError'))
      if (init.signal?.aborted) fail()
      else init.signal?.addEventListener('abort', fail)
    })
  })
  timeout.mockImplementation(() => AbortSignal.abort(new DOMException('timeout', 'TimeoutError')))
  const src = { base: '/api/reference/plan-1', version: 1, page: null }
  await expect(loadTileManifest(src)).rejects.toThrow()
  expect(timeout).toHaveBeenCalledWith(MANIFEST_DEADLINE_MS)
  await expect(loadTileManifest(src)).rejects.toThrow()
  expect(calls).toBe(2) // evicted, not held as a pending promise
})
