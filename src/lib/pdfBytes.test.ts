import { afterEach, describe, expect, it, vi } from 'vitest'
import { dropPdfBytes, loadPdfBytes, pdfBytesKey, pdfFetchCacheMode, pinnedPdfVersion } from './pdfBytes'

/* The two rules that decide whether a PDF may be answered from a cache: the `#page=N` fragment
 * names a page of the SAME bytes, and a `?v=N` names an immutable revision. */
describe('pdfBytesKey', () => {
  it('drops the page fragment — every sheet of one PDF is one download', () => {
    expect(pdfBytesKey('/api/reference/plan%3Ax?v=2#page=3')).toBe('/api/reference/plan%3Ax?v=2')
    expect(pdfBytesKey('/api/reference/plan%3Ax?v=2')).toBe('/api/reference/plan%3Ax?v=2')
  })

  it('keeps the query — the revision is part of the identity', () => {
    expect(pdfBytesKey('/api/reference/plan%3Ax?v=2')).not.toBe(pdfBytesKey('/api/reference/plan%3Ax?v=3'))
  })
})

describe('pinnedPdfVersion', () => {
  it('reads the pinned revision', () => {
    expect(pinnedPdfVersion('/api/reference/plan%3Ax?v=3')).toBe(3)
    expect(pinnedPdfVersion('/api/reference/plan%3Ax?bbox=1,2,3,4&v=12#page=2')).toBe(12)
  })

  it('is null without one — that address may change under the same name', () => {
    expect(pinnedPdfVersion('/api/reference/plan%3Ax')).toBeNull()
    expect(pinnedPdfVersion('/api/reference/plan%3Ax?version=3')).toBeNull()
    expect(pinnedPdfVersion('/api/reference/plan%3Ax?v=')).toBeNull()
    expect(pinnedPdfVersion('/api/reference/plan%3Ax?v=neu')).toBeNull()
  })
})

describe('pdfFetchCacheMode', () => {
  it('reads a pinned revision straight out of the cache and revalidates an unpinned one', () => {
    expect(pdfFetchCacheMode('/api/reference/plan%3Ax?v=3')).toBe('force-cache')
    expect(pdfFetchCacheMode('/api/reference/plan%3Ax')).toBe('no-cache')
  })
})

/** A load that HANGS (tablet radio limbo) and is given up on: its pending promise must leave the
 *  cache with it, or every automatic re-attempt awaits the same dead request and only the manual
 *  «Erneut laden» ever recovers (components/PdfViewport · the stall guard calls this). */
describe('dropPdfBytes on a pending load', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('lets the next attempt fetch afresh instead of joining the hung one', async () => {
    const url = '/api/reference/plan%3Ahang?v=1'
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn((u: string) => {
      calls.push(u)
      // the first request never answers; the second does
      return calls.length === 1
        ? new Promise<Response>(() => {})
        : Promise.resolve({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as Response)
    }))
    const hung = loadPdfBytes(url)
    void hung.catch(() => {})
    // the same URL while it is in flight is still ONE download…
    expect(loadPdfBytes(url)).toBe(hung)
    expect(calls).toHaveLength(1)
    // …until the stall guard drops it
    dropPdfBytes(url)
    const fresh = loadPdfBytes(url)
    expect(fresh).not.toBe(hung)
    expect(calls).toHaveLength(2)
    expect(await fresh).toEqual(new Uint8Array([1, 2, 3]))
    dropPdfBytes(url)
  })
})
