// «Üben» clips: the Cloudflare Pages worker (advanced mode) that scripts/ueben-publish.mjs copies
// into the deploy dir as `_worker.js`. It serves every static file as Pages would, and answers a
// Range request with 206 – Pages' own asset server ignores Range (a full 200, checked 26.11.2026),
// and Safari on iPhone and iPad plays no video without byte ranges. Self-contained: no imports.

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

export default {
  /** @param {Request} request @param {{ ASSETS: { fetch: (r: Request) => Promise<Response> } }} env */
  async fetch(request, env) {
    const res = await env.ASSETS.fetch(request)
    // only a plain, whole file is ours to slice
    if (request.method !== 'GET' || res.status !== 200 || res.headers.has('Content-Encoding')) return res
    const headers = new Headers(res.headers)
    headers.set('Accept-Ranges', 'bytes')
    if (parseRange(request.headers.get('Range'), Infinity) === 'whole') return new Response(res.body, { status: 200, headers })
    // the asset server streams without a Content-Length, so the size is only known once read –
    // a file is at most 25 MiB (Pages' limit), and the slice below is a view, not a copy
    const file = new Uint8Array(await res.arrayBuffer())
    const range = parseRange(request.headers.get('Range'), file.length)
    if (range === 'unsatisfiable') {
      headers.set('Content-Range', `bytes */${file.length}`)
      headers.delete('Content-Length')
      return new Response(null, { status: 416, headers })
    }
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${file.length}`)
    headers.set('Content-Length', String(range.end - range.start + 1))
    return new Response(file.subarray(range.start, range.end + 1), { status: 206, headers })
  },
}
