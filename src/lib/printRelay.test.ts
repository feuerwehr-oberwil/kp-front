import { afterEach, describe, expect, it, vi } from 'vitest'
import { cancelPrint, capturePrintTransport, editorPrintTransport, enqueuePrint, fetchPrintStatus } from './printRelay'

const jsonResponse = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as Response

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('print transports', () => {
  it('editor transport uses the kiosk-cookie routes', () => {
    const t = editorPrintTransport('')
    expect(t.statusUrl).toBe('/api/print/status')
    expect(t.enqueueUrl('inc-1')).toBe('/api/incidents/inc-1/report/print')
    expect(t.cancelUrl('job-1')).toBe('/api/print-jobs/job-1')
    expect(t.headers).toBeUndefined()
  })

  it('capture transport uses the poster-token routes + header', () => {
    const t = capturePrintTransport('tok-123')
    expect(t.statusUrl).toBe('/api/capture/print/status')
    expect(t.enqueueUrl('inc-1')).toBe('/api/capture/incidents/inc-1/report/print')
    expect(t.cancelUrl('job-1')).toBe('/api/capture/print-jobs/job-1')
    expect(t.headers).toEqual({ 'X-Capture-Token': 'tok-123' })
  })

  it('escapes ids in urls', () => {
    const t = editorPrintTransport('')
    expect(t.enqueueUrl('a/b')).toBe('/api/incidents/a%2Fb/report/print')
  })
})

describe('fetchPrintStatus', () => {
  it('maps the backend shape', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ available: true, online: false })))
    expect(await fetchPrintStatus(editorPrintTransport(''))).toEqual({ available: true, online: false })
  })

  it('returns null on http error or network failure (button stays hidden)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, false, 403)))
    expect(await fetchPrintStatus(editorPrintTransport(''))).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await fetchPrintStatus(editorPrintTransport(''))).toBeNull()
  })
})

describe('enqueuePrint / cancelPrint', () => {
  it('posts the payload as a form field and resolves the job id', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ job_id: 'j1', status: 'queued' }))
    vi.stubGlobal('fetch', fetchMock)
    const id = await enqueuePrint(editorPrintTransport(''), 'inc-1', { a: 1 })
    expect(id).toBe('j1')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/incidents/inc-1/report/print')
    expect(init.method).toBe('POST')
    expect((init.body as FormData).get('payload')).toBe('{"a":1}')
  })

  it('throws on non-2xx enqueue (fail-closed backend)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, false, 403)))
    await expect(enqueuePrint(editorPrintTransport(''), 'inc-1', {})).rejects.toThrow('403')
  })

  it('cancel resolves false once the job is no longer queued (409)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, false, 409)))
    expect(await cancelPrint(editorPrintTransport(''), 'j1')).toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 'cancelled' })))
    expect(await cancelPrint(editorPrintTransport(''), 'j1')).toBe(true)
  })
})
