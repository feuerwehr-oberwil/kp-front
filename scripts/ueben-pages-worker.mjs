// «Üben» clips: the Cloudflare Pages worker (advanced mode) that scripts/ueben-publish.mjs copies
// into the deploy dir as `_worker.js`. It serves every static file as Pages would, and answers a
// Range request for an .mp4 with 206 – Pages' own asset server ignores Range (a full 200,
// checked 26.11.2026), and Safari on iPhone and iPad plays no video without byte ranges.
// The asset server streams without a Content-Length, so a video's size comes from its folder's
// catalogue.json (`bytes`); only the asked span is streamed on, nothing is buffered.
// Self-contained: no imports.
/* global FixedLengthStream -- the Workers runtime has it, Node (the tests) does not */

/**
 * The inclusive byte range a `Range` header asks for in a file of `size` bytes: `{ start, end }`,
 * `'whole'` for a header we do not slice by (none, not bytes, several ranges), or `'unsatisfiable'`.
 * @param {string | null} header
 * @param {number} size
 */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '')
  if (!m || (m[1] === '' && m[2] === '')) return 'whole'
  if (m[1] === '') {
    // «bytes=-500»: the last 500 bytes
    const n = Number(m[2])
    return n > 0 && size > 0 ? { start: Math.max(size - n, 0), end: size - 1 } : 'unsatisfiable'
  }
  const start = Number(m[1])
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  return start < size && start <= end ? { start, end } : 'unsatisfiable'
}

/** Whether an `If-Range` validator still names this file: no header, the same strong ETag, or the
 *  same Last-Modified. Anything else – a replaced video – gets the whole file (RFC 9110 13.1.5). */
export function ifRangeHolds(ifRange, headers) {
  if (ifRange === null) return true
  const v = ifRange.trim()
  if (v.startsWith('W/')) return false
  if (v.startsWith('"')) return v === headers.get('ETag')
  return v === headers.get('Last-Modified')
}

/**
 * The bytes `start`…`end` (inclusive) of a stream; the source is cancelled once `end` is passed.
 * @param {ReadableStream<Uint8Array>} body
 */
export function sliceStream(body, start, end) {
  let pos = 0
  return body.pipeThrough(new TransformStream({
    transform(chunk, out) {
      const from = Math.max(start - pos, 0)
      const to = Math.min(end + 1 - pos, chunk.length)
      if (from < to) out.enqueue(chunk.subarray(from, to))
      pos += chunk.length
      if (pos > end) out.terminate()
    },
  }))
}

/** A video's byte count from the catalogue next to it, or undefined. */
async function videoBytes(env, url) {
  const res = await env.ASSETS.fetch(new Request(new URL('catalogue.json', url)))
  if (!res.ok) return undefined
  const name = url.pathname.slice(url.pathname.lastIndexOf('/') + 1)
  const catalogue = await res.json().catch(() => undefined)
  const bytes = catalogue?.chapters?.flatMap((c) => c.clips).find((k) => k.video === name)?.bytes
  return Number.isInteger(bytes) ? bytes : undefined
}

export default {
  /** @param {Request} request @param {{ ASSETS: { fetch: (r: Request) => Promise<Response> } }} env */
  async fetch(request, env) {
    const url = new URL(request.url)
    const res = await env.ASSETS.fetch(request)
    // only a plain, whole video is ours to slice
    if (request.method !== 'GET' || !url.pathname.endsWith('.mp4') || res.status !== 200 || !res.body || res.headers.has('Content-Encoding')) return res
    const headers = new Headers(res.headers)
    headers.set('Accept-Ranges', 'bytes')
    const whole = () => new Response(res.body, { status: 200, headers })
    const header = request.headers.get('Range')
    // the size is not needed to tell a single range from none
    if (parseRange(header, Number.MAX_SAFE_INTEGER) === 'whole' || !ifRangeHolds(request.headers.get('If-Range'), res.headers)) return whole()
    const length = res.headers.get('Content-Length')
    const size = length === null ? await videoBytes(env, url) : Number(length)
    if (size === undefined) return whole()
    const range = parseRange(header, size)
    if (range === 'unsatisfiable') {
      await res.body.cancel()
      headers.set('Content-Range', `bytes */${size}`)
      headers.delete('Content-Length')
      return new Response(null, { status: 416, headers })
    }
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
    headers.set('Content-Length', String(range.end - range.start + 1))
    const span = sliceStream(res.body, range.start, range.end)
    // Workers send a plain stream chunked; a FixedLengthStream keeps the Content-Length
    const body = typeof FixedLengthStream === 'function' ? span.pipeThrough(new FixedLengthStream(range.end - range.start + 1)) : span
    return new Response(body, { status: 206, headers })
  },
}
