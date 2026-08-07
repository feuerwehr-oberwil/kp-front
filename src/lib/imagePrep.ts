// Make a camera photo uploadable — for the Rapport-Beilagen (and anything else that takes a
// picture straight off a phone).
//
// Two things go wrong with a raw camera file, and both fail SILENTLY where it hurts most:
//   · the server accepts jpeg/png/webp only (api/media), and an iPhone hands over HEIC,
//   · a modern phone photo is 4–12 MB, over the upload cap a deployment sets (the demo: 5 MB).
// Either way the upload 4xx'd, the Beilage stayed a local blob: URL, and the printed Rapport
// quietly came out without the picture. Re-encoding here removes both causes at once.
//
// Downscaling is not a compromise for this job: a Beilage prints at ~180 mm wide, so ~2200 px on
// the long edge is already more than the paper can show. What matters is that the document stays
// READABLE, which is what the long edge buys.

/** Longest edge after preparation (px) — comfortably above what an A4 plate can print. */
const MAX_EDGE = 2200
/** JPEG quality — high enough for the small print on an ID card, small enough to upload. */
const QUALITY = 0.85

/** Longest edge for a photo attached to a Rückmeldung (px). Smaller than MAX_EDGE because this
 *  picture is never printed: it is looked at once, by one person, to see what the operator saw. */
const FEEDBACK_EDGE = 1600
/** Hard byte ceiling for a Rückmeldung photo. Mirrors backend/app/telemetry/photos.py ·
 *  MAX_PHOTO_BYTES, where the arithmetic behind the number is written out — the photo rides
 *  base64 inside ONE telemetry event, and two of them have to stay under what an ingest takes. */
export const FEEDBACK_PHOTO_MAX_BYTES = 360_000
/** Descending quality attempts. A photo of a screen compresses far better than a photo of a
 *  street, so most files are done at the first rung; the lower ones exist so a busy scene still
 *  gets through instead of being refused for being complicated. */
const FEEDBACK_QUALITIES = [0.8, 0.6, 0.45]

/** The types the backend accepts as a photo (mirrors api/media · _ALLOWED_PHOTO). */
const SERVER_OK = new Set(['image/jpeg', 'image/png', 'image/webp'])

/**
 * Re-encode `file` to a JPEG the server will take, scaled to at most MAX_EDGE on the long edge.
 *
 * Falls back to the ORIGINAL file whenever the browser can't decode it (an old browser meeting a
 * HEIC, a canvas that refuses) — the upload may then fail, but it fails the same way it did
 * before rather than dropping the picture here. A file that is already small and of an accepted
 * type is passed through untouched, so nothing is recompressed for no reason.
 */
export async function prepareUploadImage(file: Blob, maxEdge = MAX_EDGE): Promise<Blob> {
  const smallEnough = file.size <= 1_500_000
  if (smallEnough && SERVER_OK.has(file.type)) return file
  try {
    const canvas = await decodeToCanvas(file, maxEdge)
    if (!canvas) return file
    return (await encodeJpeg(canvas, QUALITY)) ?? file
  } catch {
    return file
  }
}

/**
 * Re-encode a photo the operator attached to a Rückmeldung, or give up saying so.
 *
 * Different contract from prepareUploadImage on purpose. That one falls back to the original
 * file, because a Beilage that fails to upload is visibly missing from the Rapport and the
 * operator can try again. This one has nowhere to fail visibly later: the photo travels inside
 * a telemetry event with a byte ceiling, and a file over that ceiling would be dropped on the
 * server, after the send button said it worked. So it either comes back small enough or comes
 * back `null`, and the sheet says so while the operator is still standing there.
 *
 * There is no pass-through for an already-small file either: the size is only half the reason
 * to re-encode. The other half is that the JPEG the canvas writes carries no EXIF, so the GPS
 * coordinates a phone stamps into the file it hands over do not leave the building — and a
 * position IS an Einsatzort, the exact class of data scrub.py exists to strip.
 */
export async function prepareFeedbackPhoto(
  file: Blob,
  maxBytes = FEEDBACK_PHOTO_MAX_BYTES,
): Promise<Blob | null> {
  try {
    const canvas = await decodeToCanvas(file, FEEDBACK_EDGE)
    if (!canvas) return null
    for (const quality of FEEDBACK_QUALITIES) {
      const blob = await encodeJpeg(canvas, quality)
      if (blob && blob.size <= maxBytes) return blob
    }
    return null
  } catch {
    return null
  }
}

/** Decode `file` and draw it into a canvas scaled to at most `maxEdge` on the long edge,
 *  preserving the aspect ratio. `null` when the browser gives us no 2d context. */
async function decodeToCanvas(file: Blob, maxEdge: number): Promise<HTMLCanvasElement | null> {
  const bitmap = await loadBitmap(file)
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(bitmap, 0, 0, w, h)
  if ('close' in bitmap) bitmap.close()
  return canvas
}

const encodeJpeg = (canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> =>
  new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality))

/** Decode via createImageBitmap (handles what the platform can decode, incl. HEIC on iOS),
 *  falling back to an <img> for browsers without it. */
async function loadBitmap(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') return createImageBitmap(file)
  const url = URL.createObjectURL(file)
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('decode failed'))
      img.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}
