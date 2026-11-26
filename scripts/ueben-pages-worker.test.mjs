import { describe, expect, it } from 'vitest'
import worker, { parseRange } from './ueben-pages-worker.mjs'

const bytes = (n) => Uint8Array.from({ length: n }, (_, i) => i % 256)
/** A body that arrives in chunks of `size` bytes, as the asset server streams it. */
const chunked = (data, size) => new ReadableStream({
  start(c) {
    for (let i = 0; i < data.length; i += size) c.enqueue(data.subarray(i, i + size))
    c.close()
  },
})
/** The Pages asset server as the worker meets it: a streamed body, no Content-Length. */
const assets = (data, headers = {}) => ({
  fetch: async () => new Response(chunked(data, 7), { headers: { 'Content-Type': 'video/mp4', ...headers } }),
})
const get = (range) => new Request('https://kp-ueben.pages.dev/front/a.mp4', { headers: range ? { Range: range } : {} })

describe('parseRange', () => {
  it('reads the three single-range forms and clamps the end to the file', () => {
    expect(parseRange('bytes=0-1', 100)).toEqual({ start: 0, end: 1 })
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
  })

  it('serves the whole file for no or several ranges, and refuses one past the end', () => {
    expect(parseRange(null, 100)).toBe('whole')
    expect(parseRange('bytes=0-1,5-6', 100)).toBe('whole')
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=9-3', 100)).toBe('unsatisfiable')
  })
})

describe('worker', () => {
  it('answers a Range request with 206 and the asked bytes, across chunk borders', async () => {
    const data = bytes(1000)
    const mid = await worker.fetch(get('bytes=5-23'), { ASSETS: assets(data) })
    expect([...new Uint8Array(await mid.arrayBuffer())]).toEqual([...data.subarray(5, 24)])
    const res = await worker.fetch(get('bytes=0-1'), { ASSETS: assets(data) })
    expect(res.status).toBe(206)
    expect(Object.fromEntries(['content-range', 'content-length', 'accept-ranges', 'content-type'].map((h) => [h, res.headers.get(h)]))).toEqual({
      'content-range': 'bytes 0-1/1000', 'content-length': '2', 'accept-ranges': 'bytes', 'content-type': 'video/mp4',
    })
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0, 1])
  })

  it('serves the whole file without a range, and 416 past the end', async () => {
    const data = bytes(10)
    const whole = await worker.fetch(get(), { ASSETS: assets(data) })
    expect([whole.status, whole.headers.get('accept-ranges'), (await whole.arrayBuffer()).byteLength]).toEqual([200, 'bytes', 10])
    const several = await worker.fetch(get('bytes=0-1,4-5'), { ASSETS: assets(data) })
    expect(several.status).toBe(200)
    const past = await worker.fetch(get('bytes=10-'), { ASSETS: assets(data) })
    expect([past.status, past.headers.get('content-range')]).toEqual([416, 'bytes */10'])
  })

  it('leaves a compressed answer alone', async () => {
    const res = await worker.fetch(get('bytes=0-1'), { ASSETS: assets(bytes(10), { 'Content-Encoding': 'br' }) })
    expect(res.status).toBe(200)
  })
})
