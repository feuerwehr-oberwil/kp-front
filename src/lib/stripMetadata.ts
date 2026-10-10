// Take a picture's metadata OFF before it is uploaded — without re-encoding it.
//
// lib/imagePrep passes a small JPEG/PNG/WebP straight through (nothing to gain by recompressing
// it), and that pass-through used to upload the file AS IT CAME: with its whole EXIF block — the
// GPS fix of wherever it was taken, the camera's serial number, the owner name some cameras
// write — onto a server every device and every Rapport reads from (review of #304). What the app
// wants from the metadata is read BEFORE this (lib/exif · lib/photoGeo, from the original file)
// and kept on the record in the reduced form it chose; the picture itself goes up clean.
//
// Lossless and byte-level: the image data is copied untouched, only metadata containers go.
//   · JPEG: every APPn except APP0 (JFIF), APP2 «ICC_PROFILE» and APP14 «Adobe» (the colour
//     transform a CMYK file needs to decode right), and every COM. EXIF and XMP both live in
//     APP1, IPTC in APP13.
//   · PNG: eXIf, tEXt, zTXt, iTXt, tIME. Chunk CRCs cover only their own chunk, so dropping one
//     leaves the rest valid.
//   · WebP: the EXIF and XMP chunks, their two VP8X flags, and the RIFF size.
//
// ⚠️ A JPEG whose EXIF says it is ROTATED (orientation ≠ 1) cannot lose that block without
// turning the picture on its side, so it answers `reencode` — the canvas path bakes the rotation
// in and keeps no metadata. So does anything this file cannot walk with confidence: the canvas is
// the safe way out, never «upload it as it was».

import { parseExif } from './exif'

export type StripResult =
  /** nothing to take off — upload the file as it is */
  | { kind: 'unchanged' }
  /** the same picture without its metadata */
  | { kind: 'clean'; bytes: Uint8Array }
  /** cannot be cleaned losslessly — re-encode through the canvas instead */
  | { kind: 'reencode' }

export function stripImageMetadata(b: Uint8Array, type: string): StripResult {
  try {
    if (type === 'image/jpeg') return stripJpeg(b)
    if (type === 'image/png') return stripPng(b)
    if (type === 'image/webp') return stripWebp(b)
    return { kind: 'reencode' }
  } catch {
    return { kind: 'reencode' }
  }
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n))

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

// ── JPEG ─────────────────────────────────────────────────────────────────────────────────────

function stripJpeg(b: Uint8Array): StripResult {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return { kind: 'reencode' }
  const o = parseExif(b)?.orientation
  if (o != null && o !== 1) return { kind: 'reencode' }
  const keep: Uint8Array[] = [b.subarray(0, 2)]
  let dropped = false
  let i = 2
  // ── the header: segments up to the first scan ──
  while (true) {
    if (i + 4 > b.length || b[i] !== 0xff) return { kind: 'reencode' }
    while (b[i + 1] === 0xff && i + 2 < b.length) i++ // fill bytes
    const m = b[i + 1]
    if (m === 0xda) break // SOS
    if (m === 0xd9) return { kind: 'reencode' } // EOI before any scan: not a picture we understand
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { keep.push(b.subarray(i, i + 2)); i += 2; continue }
    const len = (b[i + 2] << 8) | b[i + 3]
    const end = i + 2 + len
    if (len < 2 || end > b.length) return { kind: 'reencode' }
    const isMeta = (m >= 0xe0 && m <= 0xef) || m === 0xfe
    const keepIt = !isMeta || m === 0xe0
      || (m === 0xe2 && ascii(b, i + 4, 12) === 'ICC_PROFILE\0')
      || (m === 0xee && ascii(b, i + 4, 5) === 'Adobe')
    if (keepIt) keep.push(b.subarray(i, end))
    else dropped = true
    i = end
  }
  // ── the image: scans (and the tables between progressive ones) up to EOI ──
  // ⚠️ …and NOTHING after it. An iPhone appends further JPEGs past the first EOI (the HDR gain
  // map, a depth map) — each with its own APP1 — and a pass that only cleaned the header would
  // upload those as they came.
  const scanFrom = i
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) { i++; continue }
    const m = b[i + 1]
    if (m === 0x00 || m === 0xff || (m >= 0xd0 && m <= 0xd7)) { i += m === 0xff ? 1 : 2; continue } // stuffing, fill, RST
    if (m === 0xd9) { i += 2; break }
    // a marker segment between scans (DHT, SOS, DRI, …): skip it by its length
    if (i + 4 > b.length) return { kind: 'reencode' }
    const len = (b[i + 2] << 8) | b[i + 3]
    if (len < 2 || i + 2 + len > b.length) return { kind: 'reencode' }
    if ((m >= 0xe0 && m <= 0xef) || m === 0xfe) return { kind: 'reencode' } // metadata inside the image: not ours to splice
    i += 2 + len
  }
  if (!dropped && i >= b.length) return { kind: 'unchanged' }
  keep.push(b.subarray(scanFrom, Math.min(i, b.length)))
  return { kind: 'clean', bytes: join(keep) }
}

// ── PNG ──────────────────────────────────────────────────────────────────────────────────────

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const PNG_META = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME'])

function stripPng(b: Uint8Array): StripResult {
  if (b.length < 8 || PNG_SIG.some((v, k) => b[k] !== v)) return { kind: 'reencode' }
  const keep: Uint8Array[] = [b.subarray(0, 8)]
  let dropped = false
  let i = 8
  while (i < b.length) {
    if (i + 12 > b.length) return { kind: 'reencode' }
    const len = ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3])
    const type = ascii(b, i + 4, 4)
    const end = i + 12 + len
    if (end > b.length) return { kind: 'reencode' }
    if (PNG_META.has(type)) dropped = true
    else keep.push(b.subarray(i, end))
    i = end
    if (type === 'IEND') break
  }
  return dropped ? { kind: 'clean', bytes: join(keep) } : { kind: 'unchanged' }
}

// ── WebP (RIFF) ──────────────────────────────────────────────────────────────────────────────

function stripWebp(b: Uint8Array): StripResult {
  if (b.length < 20 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return { kind: 'reencode' }
  const le32 = (at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0
  const keep: Uint8Array[] = []
  let dropped = false
  let i = 12
  while (i < b.length) {
    if (i + 8 > b.length) return { kind: 'reencode' }
    const type = ascii(b, i, 4)
    const len = le32(i + 4)
    const end = i + 8 + len + (len & 1) // chunks are padded to an even size
    if (end > b.length + (len & 1)) return { kind: 'reencode' }
    if (type === 'EXIF' || type === 'XMP ') dropped = true
    else keep.push(b.slice(i, Math.min(end, b.length)))
    i = end
  }
  if (!dropped) return { kind: 'unchanged' }
  const vp8x = keep.find((c) => ascii(c, 0, 4) === 'VP8X')
  if (vp8x) vp8x[8] &= ~(0x08 | 0x04) // the «has EXIF» and «has XMP» flags
  const body = join(keep)
  const head = new Uint8Array(12)
  head.set(b.subarray(0, 12))
  const size = body.length + 4
  head[4] = size & 255; head[5] = (size >> 8) & 255; head[6] = (size >> 16) & 255; head[7] = (size >>> 24) & 255
  return { kind: 'clean', bytes: join([head, body]) }
}
