import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EXIF_HEAD_BYTES, parseExif, readExif } from './exif'

// Real files written by Pillow (+ pillow-heif) — see fixtures/exif/gen.py for what each carries.
const fixture = (name: string) => new Uint8Array(readFileSync(`src/lib/fixtures/exif/${name}`))

describe('fixture photos', () => {
  it('reads position, altitude, heading, time and orientation from a JPEG', () => {
    const m = parseExif(fixture('gps-heading.jpg'))!
    expect(m.lat).toBeCloseTo(47.513889, 5)
    expect(m.lng).toBeCloseTo(7.556944, 5)
    expect(m.alt).toBeCloseTo(297.5, 3)
    expect(m.heading).toBeCloseTo(228.4, 3)
    expect(m.headingRef).toBe('T')
    expect(m.takenAt).toBe('2026-10-08T14:32:05+02:00')
    expect(m.orientation).toBe(6)
  })

  it('reads a position without a heading, and a time without an offset', () => {
    const m = parseExif(fixture('gps-only.jpg'))!
    expect(m.lat).toBeCloseTo(47.5139, 4)
    expect(m.lng).toBeCloseTo(7.5569, 4)
    expect(m.heading).toBeUndefined()
    expect(m.alt).toBeUndefined()
    expect(m.takenAt).toBe('2026-10-08T09:01:00')
  })

  it('signs the southern and western hemispheres, below-sea-level altitude, magnetic heading', () => {
    const m = parseExif(fixture('gps-sw-magnetic.jpg'))!
    expect(m.lat).toBeCloseTo(-33.8568, 4)
    expect(m.lng).toBeCloseTo(-151.2153, 4)
    expect(m.alt).toBeCloseTo(-12, 3)
    expect(m.heading).toBeCloseTo(12.5, 3)
    expect(m.headingRef).toBe('M')
  })

  it('has a time but no position when the GPS block is absent', () => {
    const m = parseExif(fixture('no-gps.jpg'))!
    expect(m.lat).toBeUndefined()
    expect(m.lng).toBeUndefined()
    expect(m.takenAt).toBe('2026-10-08T14:32:05+02:00')
  })

  it('is null for a JPEG with no EXIF at all', () => {
    expect(parseExif(fixture('no-exif.jpg'))).toBeNull()
  })

  it('reads the Exif item of a HEIC through meta › iinf/iloc', () => {
    const m = parseExif(fixture('gps-heading.heic'))!
    expect(m.lat).toBeCloseTo(47.513889, 4)
    expect(m.lng).toBeCloseTo(7.556944, 4)
    expect(m.heading).toBe(90)
  })

  it('never returns anything but position, heading, time and orientation (no Make/Model)', () => {
    const m = parseExif(fixture('gps-heading.jpg'))!
    expect(Object.keys(m).sort()).toEqual(['alt', 'headingRef', 'heading', 'lat', 'lng', 'orientation', 'takenAt'].sort())
  })

  it('reads a Blob (the picked File) the same way', async () => {
    const m = await readExif(new Blob([fixture('gps-heading.jpg')], { type: 'image/jpeg' }))
    expect(m?.lat).toBeCloseTo(47.513889, 5)
    expect(await readExif(new Blob([fixture('no-exif.jpg')]))).toBeNull()
    expect(await readExif(new Blob(['not an image']))).toBeNull()
  })
})

// ── hand-built TIFF, for the shapes a camera may write that Pillow does not ─────────────────

type Tag = { tag: number; type: number; values: number[] | string }

/** A minimal TIFF: IFD0 → (Exif IFD, GPS IFD), either byte order. */
function tiff(opts: { le: boolean; ifd0?: Tag[]; exif?: Tag[]; gps?: Tag[] }): Uint8Array {
  const buf = new ArrayBuffer(4096)
  const v = new DataView(buf)
  const le = opts.le
  v.setUint16(0, le ? 0x4949 : 0x4d4d)
  v.setUint16(2, 42, le)
  v.setUint32(4, 8, le)
  let heap = 1024 // out-of-line values go here
  const size: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }
  const writeIfd = (at: number, tags: Tag[]) => {
    v.setUint16(at, tags.length, le)
    tags.forEach((t, k) => {
      const e = at + 2 + k * 12
      const vals = typeof t.values === 'string' ? [...t.values].map((c) => c.charCodeAt(0)).concat([0]) : t.values
      const count = t.type === 5 || t.type === 10 ? vals.length / 2 : vals.length
      const bytes = size[t.type] * count
      v.setUint16(e, t.tag, le); v.setUint16(e + 2, t.type, le); v.setUint32(e + 4, count, le)
      let p = bytes <= 4 ? e + 8 : heap
      if (bytes > 4) { v.setUint32(e + 8, heap, le); heap += bytes + (bytes % 2) }
      for (const x of vals) {
        if (t.type === 1 || t.type === 2 || t.type === 7) { v.setUint8(p, x); p += 1 }
        else if (t.type === 3) { v.setUint16(p, x, le); p += 2 }
        else if (t.type === 4 || t.type === 5) { v.setUint32(p, x, le); p += 4 }
        else { v.setInt32(p, x, le); p += 4 }
      }
    })
    v.setUint32(at + 2 + tags.length * 12, 0, le)
  }
  const ifd0 = [...(opts.ifd0 ?? [])]
  if (opts.exif) ifd0.push({ tag: 0x8769, type: 4, values: [200] })
  if (opts.gps) ifd0.push({ tag: 0x8825, type: 4, values: [400] })
  writeIfd(8, ifd0)
  if (opts.exif) writeIfd(200, opts.exif)
  if (opts.gps) writeIfd(400, opts.gps)
  return new Uint8Array(buf, 0, heap)
}

/** Wrap a TIFF block as a JPEG: SOI, an APP0 (JFIF) first, then APP1 Exif, then SOS. */
function jpeg(t: Uint8Array, opts: { fill?: boolean } = {}): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]
  const len = t.length + 8
  const app1 = [...(opts.fill ? [0xff, 0xff] : []), 0xff, 0xe1, len >> 8, len & 255, 0x45, 0x78, 0x69, 0x66, 0, 0]
  return new Uint8Array([0xff, 0xd8, ...app0, ...app1, ...t, 0xff, 0xda, 0, 2, 0xff, 0xd9])
}

const R = (...pairs: number[]) => pairs // [num, den, num, den, …]
const OBERWIL = [
  { tag: 1, type: 2, values: 'N' }, { tag: 2, type: 5, values: R(47, 1, 30, 1, 5000, 100) },
  { tag: 3, type: 2, values: 'E' }, { tag: 4, type: 5, values: R(7, 1, 33, 1, 2500, 100) },
] satisfies Tag[]

describe('parser edge cases', () => {
  it('reads big-endian (Motorola, the iPhone layout) and little-endian alike', () => {
    for (const le of [true, false]) {
      const m = parseExif(jpeg(tiff({ le, gps: OBERWIL })))!
      expect(m.lat).toBeCloseTo(47.513889, 5)
      expect(m.lng).toBeCloseTo(7.556944, 5)
    }
  })

  it('accepts decimal minutes and decimal degrees (fewer than three components)', () => {
    const minutes = parseExif(jpeg(tiff({ le: false, gps: [
      { tag: 1, type: 2, values: 'N' }, { tag: 2, type: 5, values: R(47, 1, 308333, 10000, 0, 1) },
      { tag: 3, type: 2, values: 'E' }, { tag: 4, type: 5, values: R(7, 1, 334167, 10000) },
    ] })))!
    expect(minutes.lat).toBeCloseTo(47.513888, 4)
    expect(minutes.lng).toBeCloseTo(7.556945, 4)
    const decimal = parseExif(jpeg(tiff({ le: true, gps: [
      { tag: 1, type: 2, values: 'S' }, { tag: 2, type: 5, values: R(47513889, 1000000) },
      { tag: 3, type: 2, values: 'W' }, { tag: 4, type: 5, values: R(7556944, 1000000) },
    ] })))!
    expect(decimal.lat).toBeCloseTo(-47.513889, 5)
    expect(decimal.lng).toBeCloseTo(-7.556944, 5)
  })

  it('reads SRATIONAL components', () => {
    const m = parseExif(jpeg(tiff({ le: true, gps: [
      { tag: 1, type: 2, values: 'N' }, { tag: 2, type: 10, values: R(47, 1, 30, 1, 50, 1) },
      { tag: 3, type: 2, values: 'E' }, { tag: 4, type: 10, values: R(7, 1, 33, 1, 25, 1) },
      { tag: 0x11, type: 10, values: R(921, 10) },
    ] })))!
    expect(m.lat).toBeCloseTo(47.513889, 5)
    expect(m.heading).toBeCloseTo(92.1, 3)
  })

  it('refuses a heading outside 0–360 and wraps exactly 360 to 0', () => {
    const over = parseExif(jpeg(tiff({ le: true, gps: [...OBERWIL, { tag: 0x11, type: 5, values: R(4521, 10) }] })))!
    expect(over.heading).toBeUndefined()
    const full = parseExif(jpeg(tiff({ le: true, gps: [...OBERWIL, { tag: 0x11, type: 5, values: R(360, 1) }] })))!
    expect(full.heading).toBe(0)
  })

  it('drops a component with a zero denominator — no position rather than a wrong one', () => {
    const m = parseExif(jpeg(tiff({ le: true, gps: [
      { tag: 1, type: 2, values: 'N' }, { tag: 2, type: 5, values: R(47, 1, 30, 0, 50, 1) },
      { tag: 3, type: 2, values: 'E' }, { tag: 4, type: 5, values: R(7, 1, 33, 1, 25, 1) },
      { tag: 0x11, type: 5, values: R(90, 0) },
    ] })))!
    expect(m.lat).toBeUndefined()
    expect(m.lng).toBeUndefined()
    expect(m.heading).toBeUndefined()
  })

  it('treats 0/0 as no fix, and an out-of-range latitude as none', () => {
    const zero = parseExif(jpeg(tiff({ le: true, gps: [
      { tag: 1, type: 2, values: 'N' }, { tag: 2, type: 5, values: R(0, 1, 0, 1, 0, 1) },
      { tag: 3, type: 2, values: 'E' }, { tag: 4, type: 5, values: R(0, 1, 0, 1, 0, 1) },
    ] })))!
    expect(zero.lat).toBeUndefined()
    const far = parseExif(jpeg(tiff({ le: true, gps: [
      { tag: 1, type: 2, values: 'N' }, { tag: 2, type: 5, values: R(95, 1) },
      { tag: 3, type: 2, values: 'E' }, { tag: 4, type: 5, values: R(7, 1) },
    ] })))!
    expect(far.lat).toBeUndefined()
  })

  it('needs both coordinates — a latitude alone is no position', () => {
    const m = parseExif(jpeg(tiff({ le: true, gps: OBERWIL.slice(0, 2) })))!
    expect(m.lat).toBeUndefined()
    expect(m.lng).toBeUndefined()
  })

  it('reads a missing hemisphere ref as N/E', () => {
    const m = parseExif(jpeg(tiff({ le: true, gps: [OBERWIL[1], OBERWIL[3]] })))!
    expect(m.lat).toBeGreaterThan(47)
    expect(m.lng).toBeGreaterThan(7)
  })

  it('reads every orientation value and ignores a nonsensical one', () => {
    for (const o of [1, 3, 6, 8]) expect(parseExif(jpeg(tiff({ le: false, ifd0: [{ tag: 0x0112, type: 3, values: [o] }] })))?.orientation).toBe(o)
    expect(parseExif(jpeg(tiff({ le: false, ifd0: [{ tag: 0x0112, type: 3, values: [42] }] })))?.orientation).toBeUndefined()
  })

  it('falls back to DateTimeDigitized and ignores a zeroed date', () => {
    const dig = parseExif(jpeg(tiff({ le: true, exif: [{ tag: 0x9004, type: 2, values: '2026:10:08 03:00:00' }] })))!
    expect(dig.takenAt).toBe('2026-10-08T03:00:00')
    const zero = parseExif(jpeg(tiff({ le: true, exif: [{ tag: 0x9003, type: 2, values: '0000:00:00 00:00:00' }] })))!
    expect(zero.takenAt).toBeUndefined()
    const badOffset = parseExif(jpeg(tiff({ le: true, exif: [
      { tag: 0x9003, type: 2, values: '2026:10:08 03:00:00' }, { tag: 0x9011, type: 2, values: 'garbage' },
    ] })))!
    expect(badOffset.takenAt).toBe('2026-10-08T03:00:00')
  })

  it('tolerates 0xFF fill bytes before a marker', () => {
    expect(parseExif(jpeg(tiff({ le: true, gps: OBERWIL }), { fill: true }))?.lat).toBeCloseTo(47.513889, 5)
  })

  it('never throws on truncated or hostile input', () => {
    const good = jpeg(tiff({ le: false, gps: OBERWIL }))
    for (let cut = 0; cut < good.length; cut += 7) expect(() => parseExif(good.slice(0, cut))).not.toThrow()
    // an IFD offset pointing past the end, a value offset past the end
    const t = tiff({ le: true, gps: OBERWIL })
    new DataView(t.buffer).setUint32(4, 99999, true)
    expect(parseExif(jpeg(t))).toEqual({})
    expect(parseExif(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01]))).toBeNull()
    expect(parseExif(new Uint8Array(0))).toBeNull()
  })
})

// ── a HEIF whose Exif item lies past the head read ────────────────────────────────────────────

function heif(t: Uint8Array, pad: number): Uint8Array {
  const box = (type: string, body: number[]) => {
    const size = body.length + 8
    return [size >>> 24, (size >> 16) & 255, (size >> 8) & 255, size & 255, ...[...type].map((c) => c.charCodeAt(0)), ...body]
  }
  const s4 = (s: string) => [...s].map((c) => c.charCodeAt(0))
  const u32 = (n: number) => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]
  const ftyp = box('ftyp', [...s4('heic'), 0, 0, 0, 0, ...s4('mif1'), ...s4('heic')])
  const infe = box('infe', [2, 0, 0, 0, 0, 1, 0, 0, ...s4('Exif'), 0])
  const iinf = box('iinf', [0, 0, 0, 0, 0, 1, ...infe])
  const payload = [...u32(6), ...s4('Exif'), 0, 0, ...t]
  // iloc v0, offset_size 4, length_size 4, base_offset_size 0
  const ilocLen = 8 + 4 + 2 + 2 + 2 + 2 + 2 + 4 + 4
  const metaLen = 8 + 4 + iinf.length + ilocLen
  const offset = ftyp.length + metaLen + pad
  const iloc = box('iloc', [0, 0, 0, 0, 0x44, 0x00, 0, 1, 0, 1, 0, 0, 0, 1, ...u32(offset), ...u32(payload.length)])
  const meta = box('meta', [0, 0, 0, 0, ...iinf, ...iloc])
  const out = new Uint8Array(offset + payload.length)
  out.set([...ftyp, ...meta], 0)
  out.set(payload, offset)
  return out
}

describe('HEIF', () => {
  it('finds the Exif item inside the buffer', () => {
    expect(parseExif(heif(tiff({ le: false, gps: OBERWIL }), 100))?.lat).toBeCloseTo(47.513889, 5)
  })

  it('reads an Exif item past the head with one more targeted slice', async () => {
    const file = heif(tiff({ le: false, gps: OBERWIL }), EXIF_HEAD_BYTES + 10)
    expect(parseExif(file.slice(0, EXIF_HEAD_BYTES))).toBeNull()
    const m = await readExif(new Blob([file]))
    expect(m?.lat).toBeCloseTo(47.513889, 5)
  })
})
