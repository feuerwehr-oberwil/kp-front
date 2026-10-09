// Read WHERE, WHICH WAY and WHEN a photo was taken out of its EXIF block — and nothing else.
//
// Why this exists: lib/imagePrep re-encodes every photo through a canvas before upload, and a
// canvas carries no metadata. That is what we want for the picture (no camera serial, no owner
// name on the server), but it also threw away the one thing that makes a photo a PLACE: its GPS
// fix and the compass bearing of the lens. So the position is read here, from the original file,
// before the re-encode — and lib/photoGeo keeps it beside the photo on the Verlauf row.
//
// A tiny local parser on purpose (owner, 08.10.2026: no new packages). It reads JPEG (APP1
// «Exif») and HEIF/HEIC (the `Exif` item located through `meta › iinf/iloc`), walks the TIFF
// structure in either byte order, and returns only: latitude/longitude (+ altitude), the image
// direction and DateTimeOriginal. Orientation is read for completeness (the re-encode bakes it:
// createImageBitmap applies EXIF orientation by default) but never stored.
//
// ⚠️ It never throws. A photo is the operator's evidence; a malformed EXIF block must cost the
// position, never the picture — every read is bounds-checked and a broken file is `null`.
//
// What a phone actually hands a web page (researched 08.10.2026, not yet confirmed on a device
// in the field):
//   · iPhone, CAMERA via `<input capture>`: WebKit converts the shot to JPEG and strips the GPS
//     block UNCONDITIONALLY (WebKit bug 263192). No position, whatever the settings.
//   · iPhone, photo LIBRARY: since iOS 17 the picker has «Optionen › Ortsangaben»; with it on, the
//     JPEG Safari delivers (HEIC is transcoded because we ask for image/*) keeps GPS and the
//     image direction. With it off (the default), no position (WebKit bug 257534).
//   · Android Chrome: camera shots carry GPS only when the camera app's location tag is on;
//     the system photo picker may redact location. Unverified per device.
// So the reliable field recipe on an iPhone is: shoot with the Kamera app, attach from the
// library with «Ortsangaben» on. A photo without a position simply offers nothing.

export interface ExifPhotoMeta {
  lat?: number
  lng?: number
  /** metres above sea level (negative below), when the GPS block carries it */
  alt?: number
  /** GPSImgDirection: the bearing the lens pointed at, degrees clockwise from north [0, 360) */
  heading?: number
  /** 'T' true north, 'M' magnetic north (~3° apart in Switzerland — not corrected) */
  headingRef?: 'T' | 'M'
  /** DateTimeOriginal as an ISO-like local time, with the offset when the file states one */
  takenAt?: string
  /** EXIF orientation 1–8 (read, never stored) */
  orientation?: number
}

/** How much of the file's head is read: a JPEG's APP1 is ≤ 64 KB and sits at the start. */
export const EXIF_HEAD_BYTES = 256 * 1024
/** A HEIF Exif item larger than this is not a metadata block we want to read. */
const MAX_HEIF_EXIF = 1024 * 1024
/** Guard against a looping or absurd IFD. */
const MAX_IFD_ENTRIES = 1000

type Bytes = Uint8Array

const fourcc = (b: Bytes, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])

/** Parse the metadata of a JPEG or HEIF held in `buf` (the file, or at least its head). */
export function parseExif(buf: ArrayBuffer | Bytes): ExifPhotoMeta | null {
  try {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
    const tiff = isJpeg(b) ? jpegTiff(b) : isHeif(b) ? heifTiff(b) : null
    return tiff ? parseTiff(b, tiff.start, tiff.end) : null
  } catch {
    return null
  }
}

/**
 * Read the photo metadata of a picked file. Reads the head only; a HEIF whose Exif item lies
 * past it is read with one more targeted slice. `null` when there is no readable EXIF.
 */
export async function readExif(file: Blob): Promise<ExifPhotoMeta | null> {
  try {
    const head = new Uint8Array(await file.slice(0, EXIF_HEAD_BYTES).arrayBuffer())
    if (isJpeg(head)) return parseExif(head)
    if (!isHeif(head)) return null
    const loc = heifExifLocation(head)
    if (!loc) return null
    if (loc.offset + loc.length <= head.length) return parseExif(head)
    if (loc.length > MAX_HEIF_EXIF || loc.offset + loc.length > file.size) return null
    const item = new Uint8Array(await file.slice(loc.offset, loc.offset + loc.length).arrayBuffer())
    const tiff = exifItemTiff(item, 0, item.length)
    return tiff ? parseTiff(item, tiff.start, tiff.end) : null
  } catch {
    return null
  }
}

// ── JPEG ─────────────────────────────────────────────────────────────────────────────────────

const isJpeg = (b: Bytes) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8

/** Walk the JPEG markers to the APP1 «Exif\0\0» segment. Stops at SOS: metadata precedes the scan. */
function jpegTiff(b: Bytes): { start: number; end: number } | null {
  let i = 2
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null
    let m = b[i + 1]
    // fill bytes: any number of 0xFF may pad before a marker
    while (m === 0xff && i + 2 < b.length) { i++; m = b[i + 1] }
    i += 2
    if (m === 0xd9 || m === 0xda) return null
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) continue // standalone, no length
    if (i + 2 > b.length) return null
    const len = (b[i] << 8) | b[i + 1]
    if (len < 2) return null
    if (m === 0xe1 && len >= 8 && fourcc(b, i + 2) === 'Exif' && b[i + 6] === 0 && b[i + 7] === 0) {
      return { start: i + 8, end: Math.min(b.length, i + len) }
    }
    i += len
  }
  return null
}

// ── HEIF / HEIC (ISO base media file format) ─────────────────────────────────────────────────

const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'avif'])

function isHeif(b: Bytes): boolean {
  if (b.length < 16 || fourcc(b, 4) !== 'ftyp') return false
  const size = u32be(b, 0)
  if (HEIF_BRANDS.has(fourcc(b, 8))) return true
  for (let i = 16; i + 4 <= Math.min(size, b.length); i += 4) if (HEIF_BRANDS.has(fourcc(b, i))) return true
  return false
}

const u16be = (b: Bytes, at: number) => (b[at] << 8) | b[at + 1]
const u32be = (b: Bytes, at: number) => ((b[at] << 24) >>> 0) + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3])
function uNbe(b: Bytes, at: number, n: number): number {
  if (n === 0) return 0
  if (n === 2) return u16be(b, at)
  if (n === 4) return u32be(b, at)
  if (n === 8) return u32be(b, at) * 2 ** 32 + u32be(b, at + 4)
  throw new Error('bad int size')
}

interface Box { type: string; start: number; body: number; end: number }

/** The boxes directly inside [from, to). A size running past `to` ends the walk. */
function boxes(b: Bytes, from: number, to: number): Box[] {
  const out: Box[] = []
  let i = from
  while (i + 8 <= to) {
    let size = u32be(b, i)
    const type = fourcc(b, i + 4)
    let body = i + 8
    if (size === 1) { if (i + 16 > to) break; size = uNbe(b, i + 8, 8); body = i + 16 }
    else if (size === 0) size = to - i
    if (size < body - i) break
    const end = i + size
    out.push({ type, start: i, body, end: Math.min(end, to) })
    if (end > to) break
    i = end
  }
  return out
}

/** Where the `Exif` item's payload lies in the file, from `meta › iinf` + `meta › iloc`. */
function heifExifLocation(b: Bytes): { offset: number; length: number } | null {
  const meta = boxes(b, 0, b.length).find((x) => x.type === 'meta')
  if (!meta) return null
  const kids = boxes(b, meta.body + 4, meta.end) // `meta` is a FullBox: version + flags first
  const iinf = kids.find((x) => x.type === 'iinf')
  const iloc = kids.find((x) => x.type === 'iloc')
  if (!iinf || !iloc) return null

  // iinf: FullBox, entry_count (u16 for v0, u32 after), then `infe` boxes
  const iv = b[iinf.body]
  let exifId: number | null = null
  for (const infe of boxes(b, iinf.body + 4 + (iv === 0 ? 2 : 4), iinf.end)) {
    if (infe.type !== 'infe') continue
    const v = b[infe.body]
    if (v < 2) continue // v0/v1 carry no item_type
    const idAt = infe.body + 4
    const id = v === 2 ? u16be(b, idAt) : u32be(b, idAt)
    const typeAt = idAt + (v === 2 ? 2 : 4) + 2 // + item_protection_index
    if (typeAt + 4 <= infe.end && fourcc(b, typeAt) === 'Exif') { exifId = id; break }
  }
  if (exifId == null) return null

  // iloc: FullBox; nibble sizes; per item its extents.
  // ⚠️ Every count and size here is the FILE's word, so none of them may drive a loop: a crafted
  // box with zero-byte fields and extent_count 0xFFFF made the walk spin for seconds on the main
  // thread (review of #304). The sizes must be the ones the spec allows, the extents are skipped
  // by arithmetic rather than iterated, and nothing is read past the box's end.
  const v = b[iloc.body]
  if (v > 2) return null
  let p = iloc.body + 4
  if (p + 2 > iloc.end) return null
  const offSize = b[p] >> 4, lenSize = b[p] & 15, baseSize = b[p + 1] >> 4
  const idxSize = v === 1 || v === 2 ? b[p + 1] & 15 : 0
  if (![offSize, lenSize, baseSize, idxSize].every((n) => n === 0 || n === 4 || n === 8)) return null
  p += 2
  const idSize = v < 2 ? 2 : 4
  if (p + idSize > iloc.end) return null
  const count = uNbe(b, p, idSize)
  p += idSize
  const extentSize = idxSize + offSize + lenSize
  const head = idSize + (v === 1 || v === 2 ? 2 : 0) + 2 + baseSize + 2
  for (let n = 0; n < count; n++) {
    if (p + head > iloc.end) return null
    const id = uNbe(b, p, idSize)
    p += idSize
    let method = 0
    if (v === 1 || v === 2) { method = u16be(b, p) & 15; p += 2 }
    p += 2 // data_reference_index
    const base = uNbe(b, p, baseSize); p += baseSize
    const extents = u16be(b, p); p += 2
    if (p + extents * extentSize > iloc.end) return null
    const first = extents > 0
      ? { offset: base + uNbe(b, p + idxSize, offSize), length: uNbe(b, p + idxSize + offSize, lenSize) }
      : null
    p += extents * extentSize
    // construction_method 0 = a file offset; 1 (idat) / 2 (item) are not where cameras put it
    if (id === exifId) return method === 0 && first && first.length > 0 ? first : null
  }
  return null
}

function heifTiff(b: Bytes): { start: number; end: number } | null {
  const loc = heifExifLocation(b)
  if (!loc || loc.offset + loc.length > b.length) return null
  return exifItemTiff(b, loc.offset, loc.offset + loc.length)
}

/** A HEIF Exif item: u32 offset to the TIFF header (skipping an «Exif\0\0» prefix), then TIFF. */
function exifItemTiff(b: Bytes, from: number, to: number): { start: number; end: number } | null {
  if (from + 4 > to) return null
  const start = from + 4 + u32be(b, from)
  return start + 8 <= to ? { start, end: to } : null
}

// ── TIFF / EXIF ──────────────────────────────────────────────────────────────────────────────

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8 }

interface Entry { type: number; count: number; at: number }

function parseTiff(b: Bytes, start: number, end: number): ExifPhotoMeta | null {
  if (end - start < 8) return null
  const view = new DataView(b.buffer, b.byteOffset + start, end - start)
  const order = view.getUint16(0)
  const le = order === 0x4949 ? true : order === 0x4d4d ? false : null
  if (le == null || view.getUint16(2, le) !== 42) return null
  const len = view.byteLength

  const u16 = (at: number) => view.getUint16(at, le)
  const u32 = (at: number) => view.getUint32(at, le)

  /** Read one IFD into tag → entry (the value's location resolved, bounds-checked). */
  const ifd = (at: number): Map<number, Entry> => {
    const out = new Map<number, Entry>()
    if (at < 8 || at + 2 > len) return out
    const n = u16(at)
    if (n > MAX_IFD_ENTRIES) return out
    for (let k = 0; k < n; k++) {
      const e = at + 2 + k * 12
      if (e + 12 > len) break
      const type = u16(e + 2), count = u32(e + 4)
      const size = (TYPE_SIZE[type] ?? 0) * count
      if (!size) continue
      const valueAt = size <= 4 ? e + 8 : u32(e + 8)
      if (valueAt + size > len) continue
      out.set(u16(e), { type, count, at: valueAt })
    }
    return out
  }

  const ascii = (e: Entry | undefined): string | undefined => {
    if (!e || (e.type !== 2 && e.type !== 7)) return undefined
    let s = ''
    for (let k = 0; k < e.count; k++) {
      const c = view.getUint8(e.at + k)
      if (c === 0) break
      s += String.fromCharCode(c)
    }
    return s.trim() || undefined
  }
  const int = (e: Entry | undefined): number | undefined => {
    if (!e) return undefined
    if (e.type === 1 || e.type === 7) return view.getUint8(e.at)
    if (e.type === 3) return u16(e.at)
    if (e.type === 4) return u32(e.at)
    if (e.type === 9) return view.getInt32(e.at, le)
    return undefined
  }
  /** RATIONAL / SRATIONAL components (also tolerates a SHORT/LONG writer). A zero denominator
   *  makes the component NaN, which fails every range check downstream. */
  const rationals = (e: Entry | undefined): number[] => {
    if (!e) return []
    const out: number[] = []
    for (let k = 0; k < Math.min(e.count, 4); k++) {
      if (e.type === 5 || e.type === 10) {
        const at = e.at + k * 8
        const num = e.type === 5 ? u32(at) : view.getInt32(at, le)
        const den = e.type === 5 ? u32(at + 4) : view.getInt32(at + 4, le)
        out.push(den === 0 ? NaN : num / den)
      } else if (e.type === 3) out.push(u16(e.at + k * 2))
      else if (e.type === 4) out.push(u32(e.at + k * 4))
    }
    return out
  }

  const ifd0 = ifd(u32(4))
  const meta: ExifPhotoMeta = {}
  const orientation = int(ifd0.get(0x0112))
  if (orientation != null && orientation >= 1 && orientation <= 8) meta.orientation = orientation

  const exifAt = int(ifd0.get(0x8769))
  if (exifAt) {
    const ex = ifd(exifAt)
    const taken = isoTime(ascii(ex.get(0x9003)) ?? ascii(ex.get(0x9004)), ascii(ex.get(0x9011)) ?? ascii(ex.get(0x9012)))
    if (taken) meta.takenAt = taken
  }

  const gpsAt = int(ifd0.get(0x8825))
  if (gpsAt) {
    const g = ifd(gpsAt)
    const lat = degrees(rationals(g.get(2)), ascii(g.get(1)), 'S')
    const lng = degrees(rationals(g.get(4)), ascii(g.get(3)), 'W')
    // 0/0 is «no fix written yet», not a place in the Gulf of Guinea
    if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)) {
      meta.lat = lat
      meta.lng = lng
      const [alt] = rationals(g.get(6))
      if (Number.isFinite(alt)) meta.alt = int(g.get(5)) === 1 ? -alt : alt
    }
    const [dir] = rationals(g.get(0x11))
    if (Number.isFinite(dir) && dir >= 0 && dir <= 360) {
      meta.heading = dir % 360
      const ref = ascii(g.get(0x10))?.toUpperCase()
      if (ref === 'T' || ref === 'M') meta.headingRef = ref
    }
  }
  return meta
}

/** [deg, min, sec] (any prefix of it; some writers put decimal degrees in the first) → signed. */
function degrees(parts: number[], ref: string | undefined, negative: 'S' | 'W'): number | null {
  if (!parts.length || parts.some((v) => !Number.isFinite(v) || v < 0)) return null
  const [d, m = 0, s = 0] = parts
  const v = d + m / 60 + s / 3600
  return ref?.toUpperCase().startsWith(negative) ? -v : v
}

/** «2026:10:08 14:32:05» (+ «+02:00») → «2026-10-08T14:32:05+02:00». Blank/zero dates → undefined. */
function isoTime(raw: string | undefined, offset: string | undefined): string | undefined {
  const m = raw?.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!m || m[1] === '0000' || m[2] === '00') return undefined
  const off = offset?.match(/^[+-]\d{2}:\d{2}$/) ? offset : ''
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${off}`
}
