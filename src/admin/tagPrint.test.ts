import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { buildTagsPdf, tagBoxes } from './tagPrint'

describe('tagBoxes', () => {
  it('puts one tag on each page for the single and tape formats', () => {
    for (const f of ['single', 'tape36', 'tape24'] as const) {
      expect(tagBoxes(f, 3).map((b) => b.page)).toEqual([0, 1, 2])
    }
  })

  it('stacks seven 35 mm tags on an A4 page, inside the margins', () => {
    const boxes = tagBoxes('a4', 15)
    expect(boxes.map((b) => b.page)).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 2])
    const last = boxes[6]
    expect(last.y + 35).toBeLessThanOrEqual(297 - 12)
    expect(boxes[7].y).toBe(boxes[0].y)
    expect(boxes[0].x).toBe(30) // 150 mm centred on 210 mm
  })
})

describe('buildTagsPdf', () => {
  it('prints a name outside WinAnsi as written, not as Helvetica would mangle it', async () => {
    const font = readFileSync(createRequire(import.meta.url).resolve('pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf'))
    const name = 'Šimůnek Łukasz'
    const doc = buildTagsPdf([{ id: 'p1', name, rank: null }], 'single', font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength))
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const pdf = await getDocument({ data: new Uint8Array(doc.output('arraybuffer')) }).promise
    const text = (await (await pdf.getPage(1)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join('')
    expect(text).toContain(name)
  })
})
