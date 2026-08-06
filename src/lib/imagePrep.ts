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
    const bitmap = await loadBitmap(file)
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, w, h)
    if ('close' in bitmap) bitmap.close()
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', QUALITY))
    return blob ?? file
  } catch {
    return file
  }
}

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
