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
//
// ⚠️ Every decode in this file runs through ONE lane (lib/serialQueue). A decode is the full
// bitmap of the camera file (~48 MB for 12 MP) plus a canvas, and a ten-photo multi-select used to
// start ten of them in the same tick — enough to have an iPhone's tab killed before the first
// upload began. One at a time, the peak is one picture.

import { serialQueue } from './serialQueue'

const decodeLane = serialQueue()

/** Longest edge after preparation (px) — comfortably above what an A4 plate can print. */
const MAX_EDGE = 2200
/** JPEG quality — high enough for the small print on an ID card, small enough to upload. */
const QUALITY = 0.85

/** Longest edge of a session thumbnail (px) — a Verlauf chip is 40 CSS px, a map marker 56,
 *  so 160 device px covers a 3× phone with room to spare. */
const THUMB_EDGE = 160
/** JPEG quality of a thumbnail — it is looked at, never printed. */
const THUMB_QUALITY = 0.7

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
  return decodeLane(async () => {
    try {
      const canvas = await decodeToCanvas(file, maxEdge)
      if (!canvas) return file
      return (await encodeJpeg(canvas, QUALITY)) ?? file
    } catch {
      return file
    }
  })
}

/**
 * A small JPEG of `file` for the chips and markers of THIS session — the picture a Verlauf row
 * shows while its upload has not landed and the server has no thumbnail to ask for
 * (lib/mediaUrl · thumbUrl). Same decode as the upload, at chip size; rejects when the browser
 * cannot decode the file, and the caller then shows nothing rather than the full picture.
 */
export function localThumb(file: Blob, edge = THUMB_EDGE): Promise<Blob> {
  return decodeLane(async () => {
    const canvas = await decodeToCanvas(file, edge)
    const blob = canvas && (await encodeJpeg(canvas, THUMB_QUALITY))
    if (!blob) throw new Error('thumbnail failed')
    return blob
  })
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
