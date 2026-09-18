/**
 * The BYTES of a PDF, fetched once per revision and kept.
 *
 * pdf.js will happily fetch a document itself — hand `getDocument` a URL and it opens the file
 * over the network. That is exactly what it did here until 18.09.2026, and it cost a re-download
 * of a whole Referenz-PDF (an «RWA» sheet on an Einsatzobjekt is tens of megabytes) on every
 * cold open: pdf.js asks with RANGE requests, the server answers `206 Partial Content`, and a
 * 206 is not a response any HTTP cache — nor the service worker's Workbox route, which only
 * stores `200` — is allowed to keep. So nothing was ever cached, offline the sheet was simply
 * gone, and on a tablet radio every reopen paid the full transfer again.
 *
 * One plain `GET` of the whole file fixes all three: it is a cacheable `200`, the service worker
 * stores it under the reference rule, and this module keeps the bytes resident for the session
 * so the second open does not even reach the worker.
 *
 * ⚠️ REVISION semantics are untouched, because the URL carries them: a replaced plan is a new
 * `plan_revisions` row and therefore a new `?v=N`, i.e. a different key here and a different
 * entry in every cache below us. Only a URL that names its revision may be answered from the
 * HTTP cache without revalidating — see `pinnedPdfVersion`.
 *
 * ⚠️ The buffer handed to pdf.js is TRANSFERRED to its worker (detached), so every reader gets
 * its own copy and the cached original stays usable for the next open.
 */
import { ByteBudgetCache } from './byteBudgetCache'
import { smallMemoryDevice } from './pdfRenderBudget'

/** The cache key of a PDF URL: the `#page=N` fragment names a page of the SAME bytes
 *  (lib/whiteboard · pdfPageOf), so it must never split the download. */
export const pdfBytesKey = (url: string) => url.replace(/#.*$/, '')

/**
 * The exact revision a reference URL pins (`/api/reference/plan%3Ax?v=3` → 3), or null when it
 * names «whatever is current».
 *
 * A pinned URL is IMMUTABLE by construction — `plans · store_plan` writes new bytes as a new
 * version — so its bytes may be served from any cache without asking the server. An unpinned one
 * may change under the same address and is therefore always revalidated.
 */
export function pinnedPdfVersion(url: string): number | null {
  const q = pdfBytesKey(url).split('?')[1]
  if (!q) return null
  for (const part of q.split('&')) {
    const [k, v] = part.split('=')
    if (k === 'v' && /^\d+$/.test(v ?? '')) return Number(v)
  }
  return null
}

/** The HTTP cache mode one PDF URL deserves: a pinned revision may be read straight out of the
 *  cache, an unpinned address has to be revalidated (ETag/Last-Modified → a cheap 304). */
export const pdfFetchCacheMode = (url: string): RequestCache =>
  pinnedPdfVersion(url) == null ? 'no-cache' : 'force-cache'

/** What the resident PDF downloads may weigh together. A phone/tablet-class device gets the
 *  small budget for the same reason every other raster cache here does (pdfRenderBudget). */
const BUDGET_SMALL = 48 * 1024 * 1024
const BUDGET_DESKTOP = 192 * 1024 * 1024
const bytesBudget = () => (smallMemoryDevice() ? BUDGET_SMALL : BUDGET_DESKTOP)

const bytesCache = new ByteBudgetCache<Uint8Array>(bytesBudget, (b) => b.byteLength)

/** The bytes of one PDF — from memory, else from the HTTP/service-worker cache, else the net.
 *  A failed fetch drops out of the cache on its own, so «Erneut laden» really retries. */
export function loadPdfBytes(url: string): Promise<Uint8Array> {
  const key = pdfBytesKey(url)
  const held = bytesCache.get(key)
  if (held) return held
  const promise = fetch(key, { credentials: 'same-origin', cache: pdfFetchCacheMode(key) }).then(async (res) => {
    if (!res.ok) throw new Error(`pdf fetch ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  })
  bytesCache.set(key, promise)
  return promise
}

/** A private copy for pdf.js, which transfers (and thereby detaches) what it is given. */
export const pdfDataCopy = (bytes: Uint8Array): Uint8Array => bytes.slice()

/** Forget one document's bytes — the «Erneut laden» path, which must start from a real fetch. */
export function dropPdfBytes(url: string): void {
  bytesCache.delete(pdfBytesKey(url))
}

/** Bytes currently resident, for tests and diagnostics. */
export const pdfBytesResident = () => bytesCache.bytes
