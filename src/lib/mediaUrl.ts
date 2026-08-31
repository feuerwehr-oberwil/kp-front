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

/** Media URLs this app serves itself — the only ones with a thumbnail to ask for. */
const STORED = /^\/api\/media\/[0-9a-f-]+$/i

/**
 * The thumbnail for a stored photo URL; anything else comes back untouched.
 *
 * Untouched covers the cases that matter operationally: a picture taken offline is still a
 * `blob:` URL until its upload lands (lib/mediaQueue), and a row must show it immediately —
 * asking the server for a thumbnail of a file the server has never seen would leave a hole in
 * the Verlauf for as long as the tablet is off the network. The queue swaps in the `/api/media/`
 * URL when the upload completes and the chip picks up the small copy from the next render.
 */
export function thumbUrl(url: string | undefined): string | undefined {
  if (!url) return url
  const [path, query] = url.split('?', 2)
  if (!STORED.test(path)) return url
  return `${path}/thumb${query ? `?${query}` : ''}`
}
