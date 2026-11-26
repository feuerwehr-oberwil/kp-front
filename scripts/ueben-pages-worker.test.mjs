import { describe, expect, it } from 'vitest'
import worker, { ifRangeHolds, parseRange } from './ueben-pages-worker.mjs'

const bytes = (n) => Uint8Array.from({ length: n }, (_, i) => i % 256)
/** A body that arrives in chunks of `size` bytes, as the asset server streams it. */
const chunked = (data, size) => new ReadableStream({
  start(c) {
    for (let i = 0; i < data.length; i += size) c.enqueue(data.subarray(i, i + size))
    c.close()
  },
})
/** The Pages asset server as the worker meets it: a streamed body, no Content-Length; the
 *  folder's catalogue.json states the video's size. Counts how many bytes were read. */
const assets = (data, headers = {}) => {
  const env = {
    read: 0,
    ASSETS: {
      fetch: async (req) => {
        if (new URL(req.url).pathname.endsWith('/catalogue.json')) {
          return Response.json({ chapters: [{ clips: [{ video: 'a.mp4', bytes: data.length }] }] })
        }
        const counted = chunked(data, 7).pipeThrough(new TransformStream({ transform(c, out) { env.read += c.length; out.enqueue(c) } }))
        return new Response(counted, { headers: { 'Content-Type': 'video/mp4', ETag: '"v1"', ...headers } })
      },
    },
  }
  return env
}
const get = (headers = {}, path = '/front/a.mp4') => new Request(`https://kp-ueben.pages.dev${path}`, { headers })

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

describe('ifRangeHolds', () => {
  const h = new Headers({ ETag: '"v1"', 'Last-Modified': 'Thu, 26 Nov 2026 08:00:00 GMT' })
  it('holds for the current strong ETag or date only', () => {
    expect([null, '"v1"', 'Thu, 26 Nov 2026 08:00:00 GMT'].map((v) => ifRangeHolds(v, h))).toEqual([true, true, true])
    expect(['"v0"', 'W/"v1"', 'Wed, 25 Nov 2026 08:00:00 GMT'].map((v) => ifRangeHolds(v, h))).toEqual([false, false, false])
  })
})

describe('worker', () => {
  it('answers a Range request with 206 from the catalogue size, reading only up to the span', async () => {
    const data = bytes(1000)
    const env = assets(data)
    const res = await worker.fetch(get({ Range: 'bytes=5-23' }), env)
    expect(res.status).toBe(206)
    expect(Object.fromEntries(['content-range', 'content-length', 'accept-ranges', 'content-type'].map((h) => [h, res.headers.get(h)]))).toEqual({
      'content-range': 'bytes 5-23/1000', 'content-length': '19', 'accept-ranges': 'bytes', 'content-type': 'video/mp4',
    })
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...data.subarray(5, 24)])
    expect(env.read).toBeLessThan(100)
  })

  it('serves the whole video without a range, for several ranges and for a stale If-Range', async () => {
    for (const headers of [{}, { Range: 'bytes=0-1,4-5' }, { Range: 'bytes=0-1', 'If-Range': '"v0"' }]) {
      const res = await worker.fetch(get(headers), assets(bytes(10)))
      expect([res.status, res.headers.get('accept-ranges'), (await res.arrayBuffer()).byteLength]).toEqual([200, 'bytes', 10])
    }
  })

  it('answers 416 past the end', async () => {
    const res = await worker.fetch(get({ Range: 'bytes=10-' }), assets(bytes(10)))
    expect([res.status, res.headers.get('content-range')]).toEqual([416, 'bytes */10'])
  })

  it('leaves everything but a plain video alone', async () => {
    const json = await worker.fetch(get({ Range: 'bytes=0-1' }, '/front/catalogue.json'), assets(bytes(10)))
    expect([json.status, json.headers.get('accept-ranges')]).toEqual([200, null])
    const packed = await worker.fetch(get({ Range: 'bytes=0-1' }), assets(bytes(10), { 'Content-Encoding': 'br' }))
    expect(packed.status).toBe(200)
  })
})
