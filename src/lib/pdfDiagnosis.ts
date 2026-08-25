// Why a PDF failed to open, in a form a field report can carry.
//
// Until now every failure — a stale build, no signal, an expired session, a browser that cannot
// run pdf.js at all — rendered the same eight words: «PDF konnte nicht geladen werden.» A crew
// on an exercise can only report those eight words back, which is exactly what happened on
// 2026-08-25 (all PDFs failing on a few tablets, no pattern). This module turns the thrown thing
// into a reason the operator can act on plus a short code they can read out.
//
// ⚠️ The reason that matters most is `stale`. pdf.js' 1.2 MB worker ships as its OWN hashed
// asset (the `?url` import in PdfViewport), and the service worker runs `registerType: 'prompt'`
// — a tablet can sit on an old build for days, because an installed iOS app is never closed.
// Every other chunk is then served from that build's precache and the app looks perfectly
// healthy; the worker asset, however, is fetched from the SERVER, and the deploy that replaced
// it deleted the old hash. So: 404 on the worker → pdf.js falls back to a main-thread import of
// the same missing URL → EVERY PDF in the app fails, and only on the devices that have not
// restarted. `vite.config.ts` now precaches `.mjs` too, which closes the hole for builds from
// then on; this classifier is what tells us if it ever reopens.

/** What to tell the operator. One sentence each, in `copy.pdf.reason`. */
export type PdfFailReason =
  | 'stale'       // the running build's assets are gone from the server → restart the app
  | 'offline'     // nothing cached and no way to fetch it
  | 'missing'     // the document itself is gone (404)
  | 'denied'      // session no longer valid (401/403)
  | 'timeout'     // request accepted but never finished
  | 'unsupported' // this browser cannot run pdf.js at all
  | 'unknown'

/** Reason + a short technical code (`worker-404`, `doc-401`, `no-withResolvers`, …). */
export type PdfFailure = { reason: PdfFailReason; code: string }

/** Everything the classifier needs to know about the world, so it stays pure and testable. */
export interface PdfFailContext {
  /** HTTP status of the pdf.js worker asset, or `null` when the request never completed. */
  workerStatus: number | null
  /** `false` only when the browser is CERTAIN it is offline (`navigator.onLine === false`). */
  online: boolean
  /** Name of a browser API pdf.js needs and this one lacks, from `missingPdfCapability()`. */
  capability: string | null
  /** Whether the pdfjs chunk + worker URL ever loaded. `false` means the JS itself is gone. */
  chunkLoaded: boolean
}

/** APIs pdf.js v6 (and our own rasterizer) hard-depend on. An in-app WebView or an iPad stuck
 *  below iOS 17.4 has no `Promise.withResolvers`, and pdf.js constructs one per document — so
 *  every PDF throws a bare TypeError that tells nobody anything. Named, they become a sentence. */
export function missingPdfCapability(): string | null {
  // probed, not called — the repo targets ES2021, so `Promise.withResolvers` is not in lib
  if (typeof (Promise as { withResolvers?: unknown }).withResolvers !== 'function') return 'no-withResolvers'
  if (typeof Worker === 'undefined') return 'no-worker'
  if (typeof createImageBitmap !== 'function') return 'no-createImageBitmap'
  return null
}

/** The pdf.js error shapes we read fields off. `ResponseException` (v6) carries the HTTP status
 *  of the DOCUMENT fetch; everything else we go by name. */
type PdfError = { name?: unknown; message?: unknown; status?: unknown }

const asPdfError = (err: unknown): PdfError => (typeof err === 'object' && err !== null ? (err as PdfError) : {})

/** Pure classifier — see `diagnosePdfFailure` for the wired-up version. */
export function classifyPdfError(err: unknown, ctx: PdfFailContext): PdfFailure {
  // A browser that cannot run pdf.js fails EVERY way at once; say that first, whatever was thrown.
  if (ctx.capability) return { reason: 'unsupported', code: ctx.capability }

  const e = asPdfError(err)
  const name = typeof e.name === 'string' ? e.name : ''
  const message = typeof e.message === 'string' ? e.message : String(err ?? '')

  if (message.includes('pdf load timeout')) return { reason: 'timeout', code: 'timeout' }

  // The document fetch itself answered — the worker is fine, the file or the session is not.
  const status = typeof e.status === 'number' ? e.status : null
  if (name === 'ResponseException' && status !== null) {
    if (status === 404) return { reason: 'missing', code: 'doc-404' }
    if (status === 401 || status === 403) return { reason: 'denied', code: `doc-${status}` }
    if (status === 0) return { reason: 'offline', code: 'doc-0' }
    return { reason: 'unknown', code: `doc-${status}` }
  }
  if (name === 'InvalidPDFException') return { reason: 'missing', code: 'doc-invalid' }
  if (name === 'PasswordException') return { reason: 'denied', code: 'doc-password' }

  // The pdfjs chunk never even resolved: the JS the running build points at is no longer served.
  if (!ctx.chunkLoaded) return ctx.online ? { reason: 'stale', code: 'chunk-import' } : { reason: 'offline', code: 'chunk-import' }

  // Nothing above explained it, so ask the worker asset whether it still exists.
  if (ctx.workerStatus === null) return { reason: 'offline', code: 'worker-unreachable' }
  if (ctx.workerStatus >= 400) return { reason: 'stale', code: `worker-${ctx.workerStatus}` }

  return { reason: 'unknown', code: name ? name.replace(/Exception$/, '').toLowerCase().slice(0, 24) : 'error' }
}

/**
 * Classify a failure, probing the worker asset only when nothing cheaper explained it.
 *
 * ⚠️ The probe is a GET, not a HEAD: workbox's precache route only answers GET requests, so a
 * HEAD would miss the cache, go to the network, and report a precached worker as missing the
 * moment a tablet is offline — the exact false alarm this is meant to rule out. The body is
 * cancelled straight away, and the whole thing only ever runs on the error path.
 */
export async function diagnosePdfFailure(err: unknown, workerUrl: string | null): Promise<PdfFailure> {
  const online = typeof navigator === 'undefined' || navigator.onLine !== false
  const capability = missingPdfCapability()
  const base = { online, capability, chunkLoaded: workerUrl !== null }

  // Skip the network round-trip whenever the cheap facts already decide it — including a
  // document fetch that answered with something odd (`doc-500`): the worker is provably fine
  // there, so probing it would only mislabel a server problem as a stale build.
  const cheap = classifyPdfError(err, { ...base, workerStatus: 200 })
  if (cheap.reason !== 'unknown' || cheap.code.startsWith('doc-') || !workerUrl) return cheap

  return classifyPdfError(err, { ...base, workerStatus: await probeWorker(workerUrl) })
}

/** Memoised per worker URL — a board with several plans fails several times at once. */
const probes = new Map<string, Promise<number | null>>()

async function probeWorker(url: string): Promise<number | null> {
  let p = probes.get(url)
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch(url, { credentials: 'same-origin' })
        void res.body?.cancel().catch(() => {})
        return res.status
      } catch {
        return null // never reached the server at all
      }
    })()
    // a probe that failed on a flaky radio must not be replayed forever
    void p.then((s) => { if (s === null) probes.delete(url) })
    probes.set(url, p)
  }
  return p
}
