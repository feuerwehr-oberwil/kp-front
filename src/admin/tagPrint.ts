// The Atemschutz tags as a PDF (admin › Personal › «Tags drucken», 19.11.2026): one tag per
// active person – QR code left, Dienstgrad + name right – for «Scan» in the Trupp form
// (components/TagScan, lib/tagCode). Same lazy-chunk pattern as standingAsPdf: jsPDF + qrcode
// load only when the button is pressed, and the file downloads; the admin decides where it goes.
//
// SEVERAL FORMATS (owner, 19.11.2026: «multiple output formats including brother etc»), because
// the tags are blank plastic and who prints them is open: a shop / engraver wants one tag per
// page at its real size, an office printer an A4 sheet with cut lines, a Brother P-touch a page
// as wide as its tape. ⚠️ Every format draws the QR as VECTOR squares, never a bitmap: an engraver
// or a 180-dpi tape printer resamples a bitmap into mush, a vector stays square.
// ⚠️ …and the names are set in an EMBEDDED Unicode font (Liberation Sans Bold, shipped with
// pdfjs-dist), never jsPDF's built-in Helvetica: that one is WinAnsi only and turned «Šimůnek
// Łukasz» into «Šimonek Aukasz» (Sol review 19.11.2026) – a wrong name on an Atemschutz tag.

import { jsPDF } from 'jspdf'
import { create } from 'qrcode'
import tagFontUrl from 'pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf?url'
import { rankAbbr, rankDisplay } from '../lib/rank'
import { tagPayload } from '../lib/tagCode'

/** One printable tag: who, and what the QR says (the roster id). */
export interface TagPerson { id: string; name: string; rank?: string | null }

type Mm = number
interface Format {
  /** the PDF page, width × height in mm */
  page: [Mm, Mm]
  /** one tag on its page, or tags stacked on a sheet with cut lines */
  sheet: boolean
  /** the tag's size on a sheet; a single-tag page IS the tag */
  tag: [Mm, Mm]
  /** the height the printer can actually mark – a 36 mm tape prints ~27 mm of it */
  printable: Mm
}

export const TAG_FORMATS = {
  // the tag's real size: shops, UV print, engraving, and a label printer whose driver takes the page
  single: { page: [150, 35], sheet: false, tag: [150, 35], printable: 35 },
  // office printer: seven 150 × 35 tags under each other, dashed cut lines
  a4: { page: [210, 297], sheet: true, tag: [150, 35], printable: 35 },
  // Brother P-touch TZe tapes: page = tape width × tag length, content inside the printable band
  tape36: { page: [150, 36], sheet: false, tag: [150, 36], printable: 27 },
  tape24: { page: [110, 24], sheet: false, tag: [110, 24], printable: 18 },
} as const satisfies Record<string, Format>

export type TagFormat = keyof typeof TAG_FORMATS

const SHEET_MARGIN = 12
const SHEET_GAP = 4

/** Where each tag goes: page index and the tag's box in mm. Pure, so the paging is testable. */
export function tagBoxes(format: TagFormat, count: number): { page: number; x: Mm; y: Mm }[] {
  const f: Format = TAG_FORMATS[format]
  if (!f.sheet) return Array.from({ length: count }, (_, i) => ({ page: i, x: 0, y: 0 }))
  const [pw, ph] = f.page
  const [tw, th] = f.tag
  const perPage = Math.floor((ph - 2 * SHEET_MARGIN + SHEET_GAP) / (th + SHEET_GAP))
  return Array.from({ length: count }, (_, i) => ({
    page: Math.floor(i / perPage),
    x: (pw - tw) / 2,
    y: SHEET_MARGIN + (i % perPage) * (th + SHEET_GAP),
  }))
}

const PT_PER_MM = 72 / 25.4
const TAG_FONT = 'TagSans'

/** The TTF as jsPDF's virtual file system wants it: base64, built in chunks (a 137 KB font as one
 *  `String.fromCharCode(...bytes)` spread overflows the call stack). */
function base64(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes)
  let bin = ''
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** One tag into the box at (x, y): QR square on the left, rank over name on the right, both
 *  sized from the printable height so the 24 mm tape and the 35 mm tag read the same. */
function drawTag(doc: jsPDF, p: TagPerson, f: Format, x: Mm, y: Mm) {
  const [w, h] = f.tag
  const band = f.printable
  const top = y + (h - band) / 2
  const pad = band * 0.1
  const qrSize = band - 2 * pad

  const qr = create(tagPayload(p.id), { errorCorrectionLevel: 'Q' }).modules
  const cell = qrSize / qr.size
  doc.setFillColor(0, 0, 0)
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      // a hair of overlap so neighbouring squares never show a seam in a viewer
      if (qr.get(r, c)) doc.rect(x + pad + c * cell, top + pad + r * cell, cell + 0.01, cell + 0.01, 'F')
    }
  }

  const textX = x + pad + qrSize + pad * 1.5
  const textW = x + w - pad - textX
  // a key the station's list no longer has still prints, as the roster table shows it
  const rank = p.rank ? rankAbbr(p.rank) || rankDisplay(p.rank) : ''
  let nameSize = band * 0.3 * PT_PER_MM
  doc.setFont(TAG_FONT, 'bold').setFontSize(nameSize)
  // a long name shrinks to fit rather than run off the tag; it never wraps (one line reads at arm's length)
  while (doc.getTextWidth(p.name) > textW && nameSize > 6) doc.setFontSize(--nameSize)
  const nameY = top + band / 2 + (rank ? band * 0.14 : band * 0.06)
  doc.setTextColor(0, 0, 0).text(p.name, textX, nameY)
  if (rank) {
    doc.setFont(TAG_FONT, 'bold').setFontSize(band * 0.16 * PT_PER_MM).setTextColor(90, 90, 90)
    doc.text(rank, textX, nameY - band * 0.3)
  }
}

/** The PDF for `people` (sorted by name) in `format`, its names set in `font` (a TTF). */
export function buildTagsPdf(people: TagPerson[], format: TagFormat, font: ArrayBuffer): jsPDF {
  const f: Format = TAG_FORMATS[format]
  const sorted = [...people].sort((a, b) => a.name.localeCompare(b.name, 'de'))
  const [pw, ph] = f.page
  const orientation = pw > ph ? 'landscape' : 'portrait'
  const doc = new jsPDF({ unit: 'mm', format: [pw, ph], orientation })
  doc.addFileToVFS('tag-font.ttf', base64(font))
  doc.addFont('tag-font.ttf', TAG_FONT, 'bold')
  let page = 0
  tagBoxes(format, sorted.length).forEach((box, i) => {
    if (box.page > page) { doc.addPage([pw, ph], orientation); page = box.page }
    if (f.sheet) {
      doc.setDrawColor(170, 170, 170).setLineWidth(0.2).setLineDashPattern([1.5, 1.5], 0)
      doc.roundedRect(box.x, box.y, f.tag[0], f.tag[1], 2, 2, 'S')
      doc.setLineDashPattern([], 0)
    }
    drawTag(doc, sorted[i], f, box.x, box.y)
  })
  return doc
}

/** Build the tags PDF and download it (admin › Personal › «Tags drucken»). */
export async function downloadTags(people: TagPerson[], format: TagFormat): Promise<void> {
  const res = await fetch(tagFontUrl)
  if (!res.ok) throw new Error(`tag font: HTTP ${res.status}`)
  buildTagsPdf(people, format, await res.arrayBuffer()).save(`atemschutz-tags-${format}.pdf`)
}
