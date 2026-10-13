import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { stripImageMetadata, type StripResult } from './stripMetadata'
import { parseExif } from './exif'

const fixture = (name: string) => new Uint8Array(readFileSync(`src/lib/fixtures/exif/${name}`))
const clean = (r: StripResult) => { if (r.kind !== 'clean') throw new Error(`expected clean, got ${r.kind}`); return r.bytes }
const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(Buffer.from(s, 'latin1'))

describe('JPEG', () => {
  it('drops EXIF (and with it the GPS fix) and keeps the image bytes', () => {
    const src = fixture('gps-only.jpg')
    const out = clean(stripImageMetadata(src, 'image/jpeg'))
    expect(parseExif(src)?.lat).toBeDefined()
    expect(parseExif(out)).toBeNull()
    expect(has(out, 'Exif')).toBe(false)
    expect(has(out, 'iPhone')).toBe(false) // Make/Model went with it
    // the scan is copied byte for byte: the tail from SOS on is identical
    const sos = (b: Uint8Array) => b.findIndex((v, k) => v === 0xff && b[k + 1] === 0xda)
    expect(Buffer.from(out.subarray(sos(out))).equals(Buffer.from(src.subarray(sos(src))))).toBe(true)
    expect([out[0], out[1], out[out.length - 2], out[out.length - 1]]).toEqual([0xff, 0xd8, 0xff, 0xd9])
  })

  it('leaves a file without metadata alone', () => {
    expect(stripImageMetadata(fixture('no-exif.jpg'), 'image/jpeg')).toEqual({ kind: 'unchanged' })
  })

  it('asks for a re-encode when the EXIF says the picture is rotated', () => {
    expect(parseExif(fixture('gps-heading.jpg'))?.orientation).toBe(6)
    expect(stripImageMetadata(fixture('gps-heading.jpg'), 'image/jpeg')).toEqual({ kind: 'reencode' })
  })

  it('cuts everything after the first EOI — an iPhone appends more JPEGs, each with EXIF', () => {
    const primary = fixture('no-exif.jpg')
    const appended = new Uint8Array([...primary, ...fixture('gps-only.jpg')])
    const out = clean(stripImageMetadata(appended, 'image/jpeg'))
    expect(Buffer.from(out).equals(Buffer.from(primary))).toBe(true)
  })

  it('keeps the ICC profile and the Adobe marker, drops COM and APP13', () => {
    const seg = (m: number, body: string) => { const b = Buffer.from(body, 'latin1'); return [0xff, m, (b.length + 2) >> 8, (b.length + 2) & 255, ...b] }
    const src = fixture('no-exif.jpg')
    const withSegs = new Uint8Array([0xff, 0xd8,
      ...seg(0xe2, 'ICC_PROFILE\0\x01\x01xyz'), ...seg(0xe2, 'MPF\0junk'), ...seg(0xee, 'Adobe\0\x64\0\0\0\0\x01'),
      ...seg(0xed, 'Photoshop 3.0\0IPTC owner'), ...seg(0xfe, 'shot by Max Muster'),
      ...src.subarray(2)])
    const out = clean(stripImageMetadata(withSegs, 'image/jpeg'))
    expect(has(out, 'ICC_PROFILE')).toBe(true)
    expect(has(out, 'Adobe')).toBe(true)
    expect(has(out, 'MPF')).toBe(false)
    expect(has(out, 'IPTC owner')).toBe(false)
    expect(has(out, 'Max Muster')).toBe(false)
  })

  it('asks for a re-encode on anything it cannot walk, and never throws', () => {
    expect(stripImageMetadata(new Uint8Array(1000), 'image/jpeg')).toEqual({ kind: 'reencode' })
    const good = fixture('gps-only.jpg')
    for (let cut = 0; cut < good.length; cut += 11) {
      const r = stripImageMetadata(good.slice(0, cut), 'image/jpeg')
      if (r.kind === 'clean') expect(parseExif(r.bytes)).toBeNull()
    }
  })
})

describe('PNG', () => {
  it('drops eXIf and the text chunks, keeps the image chunks valid', () => {
    const src = fixture('meta.png')
    expect(has(src, 'Max Muster')).toBe(true)
    const out = clean(stripImageMetadata(src, 'image/png'))
    for (const t of ['eXIf', 'tEXt', 'Max Muster', 'Wohnzimmer']) expect(has(out, t)).toBe(false)
    for (const t of ['IHDR', 'IDAT', 'IEND']) expect(has(out, t)).toBe(true)
  })

  it('leaves a plain PNG alone', () => {
    expect(stripImageMetadata(fixture('plain.png'), 'image/png')).toEqual({ kind: 'unchanged' })
  })
})

describe('WebP', () => {
  it('drops the EXIF chunk, clears its VP8X flag and fixes the RIFF size', () => {
    const src = fixture('meta.webp')
    const out = clean(stripImageMetadata(src, 'image/webp'))
    expect(has(out, 'EXIF')).toBe(false)
    expect(Buffer.from(out).readUInt32LE(4)).toBe(out.length - 8)
    const vp8x = Buffer.from(out).indexOf('VP8X')
    expect(out[vp8x + 8] & 0x08).toBe(0)
    expect(has(out, 'VP8 ')).toBe(true)
  })
})

it('asks for a re-encode for a type it does not know', () => {
  expect(stripImageMetadata(new Uint8Array(10), 'image/gif')).toEqual({ kind: 'reencode' })
})
