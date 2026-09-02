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
 * thumbnail for a `blob:` one; anything else comes back untouched.
 *
 * A `blob:` URL whose thumbnail has not been minted (or could not be) resolves to NOTHING, not to
 * the full picture: an empty chip until the next render is the safe failure, a full decode per
 * chip is the one that takes the tab down. The viewer a chip opens still gets the full URL.
 */
export function thumbUrl(url: string | undefined): string | undefined {
  if (!url) return url
  if (url.startsWith('blob:')) return localThumbs.get(url)
  const [path, query] = url.split('?', 2)
  if (!STORED.test(path)) return url
  return `${path}/thumb${query ? `?${query}` : ''}`
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
