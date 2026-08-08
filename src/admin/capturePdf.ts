// PDF generators for the Erfassung admin section (lazy-loaded chunk with jsPDF):
// the A4 Erfassungs-Poster (QR) and the A4 Erfassungsblatt (paper fallback, generated
// from the CURRENT roster + Mittel catalogue). Downloads a file — no print dialog, no
// popup: the admin picks when and where to print the stack.

import { jsPDF } from 'jspdf'
import { toDataURL } from 'qrcode'
import { appConfig } from '../config/appConfig'

const A4 = { w: 210, h: 297 }
const M = 14 // page margin (mm)

export async function downloadPosterPdf(url: string, stationName: string): Promise<void> {
  const C = appConfig.copy.admin.erfassung
  const qr = await toDataURL(url, { width: 1024, margin: 1 })
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const cx = A4.w / 2

  doc.setFont('helvetica', 'normal').setFontSize(14).setTextColor(90)
  doc.text(stationName, cx, 28, { align: 'center' })
  doc.setFont('helvetica', 'bold').setFontSize(34).setTextColor(20)
  doc.text(C.posterHead, cx, 42, { align: 'center' })

  // «kein Login, keine App» sits directly under the head, above the QR: the reluctance this
  // poster has to overcome is "what will this thing want from me", and it has to be answered
  // before the code is scanned, not in the steps below it.
  doc.setFont('helvetica', 'normal').setFontSize(13).setTextColor(110)
  doc.text(C.posterHint, cx, 51, { align: 'center' })

  const qrSize = 120
  doc.addImage(qr, 'PNG', cx - qrSize / 2, 58, qrSize, qrSize)

  doc.setFontSize(15).setTextColor(20)
  const steps = [C.posterStep1, C.posterStep2, C.posterStep3]
  steps.forEach((s, i) => {
    const y = 200 + i * 12
    doc.setFont('helvetica', 'bold').text(`${i + 1}.`, M + 14, y)
    doc.setFont('helvetica', 'normal').text(s, M + 22, y, { maxWidth: A4.w - 2 * M - 30 })
  })

  // the division of labour, so nobody scanning feels responsible for the whole rapport
  doc.setFontSize(11).setTextColor(110)
  doc.text(C.posterFoot, cx, 200 + steps.length * 12 + 8, { align: 'center', maxWidth: A4.w - 2 * M - 10 })

  doc.setFontSize(8).setTextColor(130)
  doc.text(url, cx, A4.h - 12, { align: 'center', maxWidth: A4.w - 2 * M })
  doc.save('erfassungs-poster.pdf')
}

interface SheetInput {
  stationName: string
  names: string[]
  catalogue: { label: string; unit?: string }[]
  /** station alarm groups (config alarms.groups) — Alarmierzeit stubs; empty = row hidden */
  groups?: { id: string; label: string; color?: string | null }[]
  /** station vehicles (config fleet.vehicles) — Ausrückzeit stubs; empty = row hidden */
  vehicles?: { id: string; label: string }[]
  /** Partnerorganisationen presets (config report.partnerOrgs); empty = row hidden */
  partnerOrgs?: string[]
}

export function downloadSheetPdf({ stationName, names, catalogue, groups = [], vehicles = [], partnerOrgs = [] }: SheetInput): void {
  const C = appConfig.copy.admin.erfassung
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const colW = (A4.w - 2 * M - 6) / 2 // two columns with a 6mm gutter
  const col2X = M + colW + 6
  const rowHZ = 6.5 // Zeiten-grid row height (a `__:__` stub, nothing to write on the line)
  const GAP = 5 // uniform gap between sections
  let y = 0

  const dotted = (x1: number, yy: number, x2: number) => {
    doc.setLineDashPattern([0.8, 0.8], 0).setDrawColor(150).line(x1, yy, x2, yy)
    doc.setLineDashPattern([], 0)
  }
  // 12.5pt bold + a solid dark rule — the Einsatzrapport's own section heading (report_pdf ·
  // styles «h2»). The two documents are read one after the other, so a heading that is a point
  // smaller here made the paper twin look like a different form.
  const heading = (t: string) => {
    doc.setFont('helvetica', 'bold').setFontSize(12.5).setTextColor(20)
    doc.text(t, M, y)
    doc.setDrawColor(40).setLineWidth(0.4).line(M, y + 1.4, A4.w - M, y + 1.4)
    y += 7
  }
  const ensure = (need: number) => {
    if (y + need > A4.h - 12) { doc.addPage(); y = M }
  }

  // --- header --------------------------------------------------------------------------
  y = 18
  doc.setFont('helvetica', 'bold').setFontSize(16).setTextColor(20)
  doc.text(C.sheetHead, M, y)
  doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(110)
  doc.text(stationName, M, y + 5)
  y += 12

  const field = (label: string, x: number, w: number, yy: number) => {
    doc.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(60)
    doc.text(`${label}:`, x, yy)
    dotted(x + doc.getTextWidth(`${label}:`) + 2, yy + 0.6, x + w)
  }
  // ⚠️ ONE write-in texture, the Einsatzrapport's: a fine dotted leader. A time in a FIELD is
  // written on one like everything else — that is how the rapport prints an unrecorded
  // Alarmierung (report_pdf · the Details box) — so the old `__:__` stub is gone from the
  // header, the roster and the Rückmeldung. The one place it survives is the Alarmierungs-/
  // Ausrückzeiten grid, where the rapport prints it too: there the stub IS the column.
  // Details box — the full paper-form header (canonical form, stats-integration.md
  // Table A). Long-hand fields (Einsatz, Adresse, Kontaktperson, Eigentümer) get FULL
  // lines; date/times/EL/Gerettete are short. 8 mm row pitch = space to actually write.
  const wFull = A4.w - 2 * M - 6
  const wThird = (A4.w - 2 * M - 18) / 3
  // ⚠️ The frame is hung 6mm above the FIRST BASELINE, not 4. A 9.5pt cap is 3.4mm tall, so at
  // 4 the «E» of «Einsatz» stood 1.6mm under the border and the top row read as if it had been
  // ruled through. The bottom edge is unchanged (‑6 + 51 = ‑4 + 49), so nothing below moves.
  doc.setDrawColor(40).setLineWidth(0.4).rect(M, y - 6, A4.w - 2 * M, 51)
  field(C.sheetIncident, M + 3, wFull, y + 1)
  field(C.sheetAdresse, M + 3, wFull, y + 9)
  field(C.sheetDate, M + 3, wThird, y + 17)
  field(C.sheetAlarm, M + 6 + wThird, wThird, y + 17)
  field(C.sheetEnde, M + 9 + 2 * wThird, wThird, y + 17)
  field(C.sheetKontakt, M + 3, wFull, y + 25)
  field(C.sheetEigentuemer, M + 3, wFull, y + 33)
  field(C.sheetEl, M + 3, colW - 3, y + 41)
  field(C.sheetGerettete, col2X, colW - 3, y + 41)
  y += 49 + GAP

  // compact checkbox rows (Kategorie / Partner): fixed column raster, tick-off only.
  // `writeInLast` turns the trailing item into a write-in row — a ticked box, a label and a
  // dotted leader for the organisation nobody put on the list, which is exactly how the
  // rapport ends its Partner table (report_pdf · _partner_table).
  const checkRow = (items: string[], cols: number, writeInLast = false) => {
    const cw = (A4.w - 2 * M) / cols
    const rh = 5.6
    ensure(Math.ceil(items.length / cols) * rh + 2)
    items.forEach((label, i) => {
      const x = M + (i % cols) * cw
      const yy = y + Math.floor(i / cols) * rh
      doc.setDrawColor(40).setLineWidth(0.35).rect(x, yy - 3, 3.4, 3.4)
      doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(20)
      const write = writeInLast && i === items.length - 1
      const text = write ? `${label}:` : (doc.splitTextToSize(label, cw - 7)[0] as string)
      doc.text(text, x + 5, yy)
      if (write) dotted(x + 5 + doc.getTextWidth(text) + 2, yy + 0.6, x + cw - 4)
    })
    y += Math.ceil(items.length / cols) * rh + GAP
  }

  // Alarmierungs-/Ausrückzeiten — groups left, vehicles right, `__:__` stub per row
  // (rows from deployment config; both lists empty → section omitted entirely)
  if (groups.length > 0 || vehicles.length > 0) {
    const zItems = [
      ...groups.map((g) => (g.color ? `${g.label} (${g.color})` : g.label)),
      ...vehicles.map((v) => v.label),
    ]
    const zCols = 3
    const zRowsN = Math.ceil(zItems.length / zCols)
    const cwZ = (A4.w - 2 * M) / zCols
    ensure(7 + zRowsN * rowHZ + 2)
    heading(C.sheetZeiten)
    const zeitStub = (x: number, yy: number, label: string) => {
      doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(110)
      doc.text('__:__', x, yy)
      doc.setTextColor(20)
      doc.text(doc.splitTextToSize(label, cwZ - 16)[0] as string, x + 11.5, yy)
    }
    zItems.forEach((label, i) => {
      const col = Math.floor(i / zRowsN)
      const row = i % zRowsN
      zeitStub(M + col * cwZ, y + row * rowHZ, label)
    })
    y += zRowsN * rowHZ + GAP
  }

  // The blank sheet is the PAPER TWIN of the Einsatzrapport, so it runs in the rapport's own
  // section order (backend/app/report_pdf.py): Zeiten → Bemerkungen → Personal → Material →
  // Partner → Unterschriften. It used to put Material and Partner before the roster, so
  // transferring a filled-in sheet into the app meant reading the two documents out of step.
  // --- Notizen ---------------------------------------------------------------------------
  // 8 mm between write-in rules — the rapport's own Kurzbericht pitch (report_pdf ·
  // write_lines), which is what the transferred text will be set in
  ensure(7 + 5 * 8)
  heading(C.sheetNotizen)
  for (let i = 0; i < 5; i += 1) {
    dotted(M, y + 4.5, A4.w - M)
    y += 8
  }
  // ⚠️ A section heading is drawn on its BASELINE, and 12.5pt bold rises 4.4mm above it — so
  // the 1mm left here put «Personal / Anwesenheit» hard against the last write-in rule, with
  // the rule reading as an underline of the heading. The loop already leaves 3.5mm of its own.
  y += GAP + 1

  // --- Anwesenheit: two columns, checkbox + name + von–bis stubs -------------------------
  // The roster FLOWS, exactly as it does on the Einsatzrapport: it is the longest block on the
  // sheet, and keeping it together pushed a village-sized Wehr onto a third sheet the moment the
  // section order matched the rapport's. Chunked by what fits on the page rather than split
  // mid-column, so the two columns always belong to the same chunk and read top-to-bottom.
  // Row pitch and the von–bis geometry follow the rapport's roster (report_pdf ·
  // _personal_table): two write-in rules of equal width with the dash between them, so the
  // dash sits at ONE x down the whole column and each end has room for «02.08. 14:41» rather
  // than for a 7pt stub nobody can write on.
  const rowH = 6.8
  const dashW = 4
  const endW = 13
  const timeW = 2 * endW + dashW
  const entries = [...names, ...Array.from({ length: 2 }, () => '')] // blanks for guests
  ensure(7 + 3 * rowH) // a heading with fewer than three rows under it is an orphan
  heading(C.sheetPersonen)
  let rest = entries
  while (rest.length > 0) {
    const fits = Math.max(1, Math.floor((A4.h - 12 - y) / rowH)) * 2
    const chunk = rest.slice(0, fits)
    rest = rest.slice(fits)
    const perCol = Math.ceil(chunk.length / 2)
    const startY = y
    chunk.forEach((n, i) => {
      const col = i < perCol ? 0 : 1
      const x = col === 0 ? M : col2X
      const yy = startY + (i % perCol) * rowH
      const xTime = x + colW - timeW
      doc.setDrawColor(40).setLineWidth(0.35).rect(x, yy - 3.2, 3.6, 3.6)
      doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(20)
      if (n) doc.text(doc.splitTextToSize(n, xTime - x - 8)[0] as string, x + 5.5, yy)
      else dotted(x + 5.5, yy + 0.4, xTime - 3)
      dotted(xTime, yy + 0.4, xTime + endW)
      doc.setFontSize(8.5).setTextColor(110)
      doc.text('–', xTime + endW + dashW / 2, yy, { align: 'center' })
      dotted(xTime + endW + dashW, yy + 0.4, x + colW)
    })
    y = startY + perCol * rowH
    if (rest.length > 0) { doc.addPage(); y = M }
  }
  y += GAP

  // --- Material: two columns, label + amount stub, alphabetical (2026-07-18) -------------
  ensure(14)
  heading(C.sheetMaterial)
  const mats = [...catalogue].sort((a, b) => a.label.localeCompare(b.label, 'de-CH'))
  // ⚠️ Amount and unit are two COLUMNS, as on the rapport (report_pdf · _mittel_table): as one
  // `______ Stk` string it was the unit that landed on the shared right edge, so every rule
  // began where its unit happened to start — «Stk» at one x, «Sack» at another, and a lone «l»
  // read as a stray glyph hanging off a line.
  const rowHM = 6.8
  const unitW = 10
  const amtW = 14
  const perColM = Math.ceil(mats.length / 2)
  ensure(perColM * rowHM + 4)
  const startM = y
  mats.forEach((c, i) => {
    const col = i < perColM ? 0 : 1
    const x = col === 0 ? M : col2X
    const yy = startM + (i % perColM) * rowHM
    const xAmt = x + colW - unitW - amtW
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(20)
    doc.text(doc.splitTextToSize(c.label, xAmt - x - 4)[0] as string, x, yy)
    dotted(xAmt, yy + 0.4, xAmt + amtW)
    doc.setFontSize(8.5).setTextColor(110)
    doc.text(c.unit || appConfig.mittel.defaultUnit, xAmt + amtW + 2, yy)
  })
  y = startM + perColM * rowHM + GAP

  if (partnerOrgs.length > 0) {
    heading(C.sheetPartner)
    checkRow([...partnerOrgs, C.sheetPartnerOther], 3, true)
  }

  // --- Rückmeldung ELZ (who reported back to dispatch, when) ------------------------------
  ensure(16)
  heading(C.sheetRueckmeldung)
  field(C.sheetName, M, colW - 3, y + 2)
  field(C.sheetZeit, col2X, colW - 3, y + 2)
  y += 6 + GAP

  // --- signatures (keep the block together) ----------------------------------------------
  // Both signatures carry their own «Ort, Datum», exactly like the rapport's Unterschriften
  // block (report_pdf · sig): the two sheets are signed by the same two people on the same day
  // and one of them was missing the date line the other one has.
  ensure(22)
  heading(C.sheetSignatures)
  const sigW = (A4.w - 2 * M - 6) * 0.4
  const sig = (label: string, yy: number) => {
    field(C.sheetOrtDatum, M, sigW, yy)
    field(label, M + sigW + 6, A4.w - M - (M + sigW + 6), yy)
  }
  sig(C.sheetEl, y + 3)
  sig(C.sheetKdt, y + 14)
  y += 20

  const pages = doc.getNumberOfPages()
  for (let i = 1; i <= pages; i += 1) {
    doc.setPage(i)
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(140)
    doc.text(`${i} / ${pages}`, A4.w - M, A4.h - 8, { align: 'right' })
  }
  doc.save('erfassungsblatt.pdf')
}
