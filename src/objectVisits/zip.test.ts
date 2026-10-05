import { describe, expect, it } from 'vitest'
import { buildZip, crc32 } from './zip'

/** Read a STORE zip back through its central directory — enough to prove the format. */
async function readZip(blob: Blob): Promise<Record<string, string>> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  const dv = new DataView(buf.buffer)
  const end = buf.length - 22
  expect(dv.getUint32(end, true)).toBe(0x06054b50)
  const count = dv.getUint16(end + 10, true)
  let at = dv.getUint32(end + 16, true)
  const out: Record<string, string> = {}
  const dec = new TextDecoder()
  for (let i = 0; i < count; i++) {
    expect(dv.getUint32(at, true)).toBe(0x02014b50)
    const size = dv.getUint32(at + 20, true)
    const nameLen = dv.getUint16(at + 28, true)
    const local = dv.getUint32(at + 42, true)
    const name = dec.decode(buf.slice(at + 46, at + 46 + nameLen))
    expect(dv.getUint32(local, true)).toBe(0x04034b50)
    const lName = dv.getUint16(local + 26, true)
    const data = buf.slice(local + 30 + lName, local + 30 + lName + size)
    expect(crc32(data)).toBe(dv.getUint32(at + 16, true))
    out[name] = dec.decode(data)
    at += 46 + nameLen
  }
  return out
}

describe('buildZip', () => {
  it('crc32 matches the reference value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })
  it('writes entries a reader finds again, UTF-8 names included', async () => {
    const zip = buildZip([
      { name: 'besuch.json', data: '{"a":1}' },
      { name: 'fotos/01 Schlüsselhülse (1a2b).jpg', data: new Uint8Array([0xff, 0xd8, 0xff]) },
    ])
    expect(zip.type).toBe('application/zip')
    const files = await readZip(zip)
    expect(Object.keys(files)).toEqual(['besuch.json', 'fotos/01 Schlüsselhülse (1a2b).jpg'])
    expect(files['besuch.json']).toBe('{"a":1}')
  })
})
