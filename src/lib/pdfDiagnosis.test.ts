import { describe, it, expect } from 'vitest'
import { classifyPdfError, type PdfFailContext } from './pdfDiagnosis'

// The whole point of this classifier is that the field report says WHY. These cases pin the
// distinctions that were indistinguishable before — above all «stale build» vs «offline», which
// look identical from the operator's chair and need opposite reactions (restart the app vs wait
// for signal).

const ctx = (over: Partial<PdfFailContext> = {}): PdfFailContext =>
  ({ workerStatus: 200, online: true, capability: null, chunkLoaded: true, ...over })

/** pdf.js v6 reports a document fetch that answered as a ResponseException carrying the status. */
const responseException = (status: number) =>
  Object.assign(new Error(`Unexpected server response (${status})`), { name: 'ResponseException', status })

describe('classifyPdfError', () => {
  it('reads a missing worker asset as a stale build, not as a network problem', () => {
    expect(classifyPdfError(new Error('Setting up fake worker failed'), ctx({ workerStatus: 404 })))
      .toEqual({ reason: 'stale', code: 'worker-404' })
  })

  it('reads an unreachable worker as offline', () => {
    expect(classifyPdfError(new Error('Setting up fake worker failed'), ctx({ workerStatus: null, online: false })))
      .toEqual({ reason: 'offline', code: 'worker-unreachable' })
  })

  it('separates a missing document from a dead session', () => {
    expect(classifyPdfError(responseException(404), ctx())).toEqual({ reason: 'missing', code: 'doc-404' })
    expect(classifyPdfError(responseException(401), ctx())).toEqual({ reason: 'denied', code: 'doc-401' })
  })

  it('keeps an odd server answer on the document, never blaming the worker', () => {
    // the fetch demonstrably reached the server, so a worker probe would only mislead
    expect(classifyPdfError(responseException(502), ctx({ workerStatus: 404 })))
      .toEqual({ reason: 'unknown', code: 'doc-502' })
  })

  it('reports the stall guard as a timeout', () => {
    expect(classifyPdfError(new Error('pdf load timeout'), ctx())).toEqual({ reason: 'timeout', code: 'timeout' })
  })

  it('blames the browser first — a missing API fails every document the same way', () => {
    expect(classifyPdfError(new TypeError('x'), ctx({ capability: 'no-withResolvers', workerStatus: 404 })))
      .toEqual({ reason: 'unsupported', code: 'no-withResolvers' })
  })

  it('tells a chunk that is gone from the server apart from one that is merely unreachable', () => {
    expect(classifyPdfError(new Error('Failed to fetch dynamically imported module'), ctx({ chunkLoaded: false })))
      .toEqual({ reason: 'stale', code: 'chunk-import' })
    expect(classifyPdfError(new Error('Failed to fetch dynamically imported module'), ctx({ chunkLoaded: false, online: false })))
      .toEqual({ reason: 'offline', code: 'chunk-import' })
  })
})
