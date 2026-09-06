// The small copy of a stored picture — for list chips and map markers, never for the viewer.
//
// ⚠️ This is a crash fix, not a nicety (31.08.). A browser decodes the whole image whatever box
// it is painted in, and an uploaded photo is capped at 2200 px on the long edge (lib/imagePrep),
// i.e. ~14 MB of bitmap each. The Verlauf draws every picture of an Einsatz at ~40 px and the
// Lage draws photo markers at 56 px, so a dozen pictures cost ~170 MB of decoded image for
// ~30 kB of visible pixels. An iPhone's WebKit content process is killed well before that —
// «A problem repeatedly occurred», reported from the field while the same Einsatz ran fine on
// the tablets and on a desktop, which have several times the budget.
//
// The server renders and stores the small copy on first request (api/media · get_media_thumb).
// A picture that has not reached the server yet gets a SESSION thumbnail instead (below).

import { localThumb } from './imagePrep'

/** Media URLs this app serves itself — the only ones with a thumbnail to ask for. */
const STORED = /^\/api\/media\/[0-9a-f-]+$/i

// A synced row carries whatever URL another device wrote — data, not a place the browser may go.
// The base is only a sentinel for parsing relative candidates; its origin is what a same-origin
// path resolves to, and anything that resolves elsewhere («//host/…», «/\host/…») smuggled a host.
const RELATIVE_BASE = 'https://relative.invalid'

/**
 * `url`, if it may be handed to the browser as an href: a same-origin path (starts with «/», and
 * not the protocol-relative «//») or an absolute http(s) URL. Everything else — javascript:,
 * data:, blob:, vbscript:, a scheme smuggled behind whitespace or control characters — comes back
 * `undefined`, and the caller renders its chip without the link. Judged by `URL` parsing, i.e. by
 * the same rules the browser would resolve the href with, not by string guessing. Defence in
 * depth: the server validates media URLs on ingest, this guards the render sinks against rows
 * written before it did.
 */
export function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined
  // absolute with an explicit scheme? http(s) may pass as written, any other scheme may not
  let abs: URL | undefined
  try { abs = new URL(url) } catch { /* no scheme — a relative candidate, judged below */ }
  if (abs) return abs.protocol === 'http:' || abs.protocol === 'https:' ? url : undefined
  try {
    const u = new URL(url, RELATIVE_BASE)
    // resolving off the sentinel origin means the «relative» URL named its own host
    if (u.origin !== RELATIVE_BASE) return undefined
    // …and what stayed on it must LITERALLY start with «/»: a fragment, a bare relative
    // segment, or leading whitespace/controls the parser would forgive are all things the
    // app's own URLs never carry — rejecting them is the fail-closed side of this check.
    return url.startsWith('/') ? url : undefined
  } catch {
    return undefined
  }
}

/**
 * Session thumbnails for pictures that are still `blob:` URLs, keyed by the full picture's
 * object URL: a photo taken offline (lib/mediaQueue), one staged in the composer, a Beilage
 * whose upload has not landed. The server has never seen these, so there is nothing to ask it
 * for — and the chip pointed at the full object URL is exactly the decode that killed the tab
 * (02.09.: every offline photo, re-minted at full size on every launch while the device stayed
 * offline). Never persisted: like every `blob:` URL it dies with the session.
 */
const localThumbs = new Map<string, string>()

/**
 * The thumbnail for a photo URL — the server's small copy for a stored picture, the session
 * thumbnail for a `blob:` one.
 *
 * A `blob:` URL whose thumbnail has not been minted (or could not be) resolves to NOTHING, not to
 * the full picture: an empty chip until the next render is the safe failure, a full decode per
 * chip is the one that takes the tab down. The viewer a chip opens still gets the full URL.
 *
 * ⚠️ Anything that is neither this app's own media store nor an explicit https address ALSO
 * resolves to nothing. This URL lands in an `<img>` on every open device of the Einsatz, so a
 * row-supplied URL passed through untouched would make every operator's device call whatever
 * address the row carries — an IP beacon aimed at the whole crew. Same empty-chip failure as a
 * missing session thumbnail; the ingest validation on the server is the other half.
 */
export function thumbUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  if (url.startsWith('blob:')) return localThumbs.get(url)
  const safe = safeHref(url)
  if (!safe) return undefined
  const [path, query] = safe.split('?', 2)
  if (STORED.test(path)) return `${path}/thumb${query ? `?${query}` : ''}`
  // the store's other shapes (an already-built …/thumb URL) stay as they are
  if (path.startsWith('/api/media/')) return safe
  // https only — an http image would leak in cleartext and is mixed content on the app anyway
  return /^https:/i.test(safe) ? safe : undefined
}

/**
 * Mint the session thumbnail for `fullUrl` (an object URL of `file`) so `thumbUrl(fullUrl)` has
 * something to show. Decodes on the shared lane (lib/imagePrep), one picture at a time. Never
 * throws: a file the browser cannot decode simply gets no thumbnail.
 */
export async function mintLocalThumb(fullUrl: string, file: Blob): Promise<void> {
  try {
    const blob = await localThumb(file)
    forgetLocalThumb(fullUrl) // a second mint for the same picture must not leak the first
    localThumbs.set(fullUrl, URL.createObjectURL(blob))
  } catch {
    // no thumbnail — thumbUrl() shows nothing for this picture
  }
}

/** Revoke and forget the session thumbnail of `fullUrl` — once the picture is on the server, or
 *  its object URL is being revoked. A URL without one is a no-op. */
export function forgetLocalThumb(fullUrl: string): void {
  const thumb = localThumbs.get(fullUrl)
  if (!thumb) return
  URL.revokeObjectURL(thumb)
  localThumbs.delete(fullUrl)
}
