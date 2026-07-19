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

  const qrSize = 128
  doc.addImage(qr, 'PNG', cx - qrSize / 2, 54, qrSize, qrSize)

  doc.setFont('helvetica', 'normal').setFontSize(15).setTextColor(20)
  const steps = [C.posterStep1, C.posterStep2, C.posterStep3]
  steps.forEach((s, i) => {
    const y = 200 + i * 12
    doc.setFont('helvetica', 'bold').text(`${i + 1}.`, M + 14, y)
    doc.setFont('helvetica', 'normal').text(s, M + 22, y, { maxWidth: A4.w - 2 * M - 30 })
  })

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
  const rowHZ = 7 // Zeiten-grid row height
  const GAP = 5 // uniform gap between sections
  let y = 0

  const dotted = (x1: number, yy: number, x2: number) => {
    doc.setLineDashPattern([0.8, 0.8], 0).setDrawColor(150).line(x1, yy, x2, yy)
    doc.setLineDashPattern([], 0)
  }
  const heading = (t: string) => {
    doc.setFont('helvetica', 'bold').setFontSize(11.5).setTextColor(20)
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
  // time slots are ALWAYS the same __:__ stub (uniform across header, grid, Rückmeldung)
  const timeField = (label: string, x: number, yy: number) => {
    doc.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(60)
    doc.text(`${label}:`, x, yy)
    doc.setTextColor(110)
    doc.text('__:__', x + doc.getTextWidth(`${label}:`) + 2, yy)
  }
  // Details box — the full paper-form header (canonical form, stats-integration.md
  // Table A). Long-hand fields (Einsatz, Adresse, Kontaktperson, Eigentümer) get FULL
  // lines; date/times/EL/Gerettete are short. 8 mm row pitch = space to actually write.
  const wFull = A4.w - 2 * M - 6
  const wThird = (A4.w - 2 * M - 18) / 3
  doc.setDrawColor(40).setLineWidth(0.4).rect(M, y - 4, A4.w - 2 * M, 49)
  field(C.sheetIncident, M + 3, wFull, y + 1)
  field(C.sheetAdresse, M + 3, wFull, y + 9)
  field(C.sheetDate, M + 3, wThird, y + 17)
  timeField(C.sheetAlarm, M + 6 + wThird, y + 17)
  timeField(C.sheetEnde, M + 9 + 2 * wThird, y + 17)
  field(C.sheetKontakt, M + 3, wFull, y + 25)
  field(C.sheetEigentuemer, M + 3, wFull, y + 33)
  field(C.sheetEl, M + 3, colW - 3, y + 41)
  field(C.sheetGerettete, col2X, colW - 3, y + 41)
  y += 49 + GAP

  // compact checkbox rows (Kategorie / Partner): fixed column raster, tick-off only
  const checkRow = (items: string[], cols: number) => {
    const cw = (A4.w - 2 * M) / cols
    const rh = 5.6
    ensure(Math.ceil(items.length / cols) * rh + 2)
    items.forEach((label, i) => {
      const x = M + (i % cols) * cw
      const yy = y + Math.floor(i / cols) * rh
      doc.setDrawColor(40).setLineWidth(0.35).rect(x, yy - 3, 3.4, 3.4)
      doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(20)
      doc.text(doc.splitTextToSize(label, cw - 7)[0] as string, x + 5, yy)
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

  if (partnerOrgs.length > 0) {
    heading(C.sheetPartner)
    checkRow([...partnerOrgs, `${C.sheetPartnerOther}: ________________`], 3)
  }

  // --- Material: two columns, label + amount stub, alphabetical (2026-07-18) -------------
  ensure(14)
  heading(C.sheetMaterial)
  const mats = [...catalogue].sort((a, b) => a.label.localeCompare(b.label, 'de-CH'))
  const rowHM = 6.6
  const perColM = Math.ceil(mats.length / 2)
  ensure(perColM * rowHM + 4)
  const startM = y
  mats.forEach((c, i) => {
    const col = i < perColM ? 0 : 1
    const x = col === 0 ? M : col2X
    const yy = startM + (i % perColM) * rowHM
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(20)
    doc.text(doc.splitTextToSize(c.label, colW - 30)[0] as string, x, yy)
    doc.setTextColor(110)
    doc.text(`______ ${c.unit || 'Stk'}`, x + colW - 24, yy)
  })
  y = startM + perColM * rowHM + GAP

  // --- Notizen ---------------------------------------------------------------------------
  ensure(7 + 5 * 8)
  heading(C.sheetNotizen)
  for (let i = 0; i < 5; i += 1) {
    dotted(M, y + 5, A4.w - M)
    y += 9
  }
  y += GAP - 4

  // --- Anwesenheit: two columns, checkbox + name + von–bis stubs -------------------------
  const rowH = 6.4
  const entries = [...names, ...Array.from({ length: 2 }, () => '')] // blanks for guests
  const perCol = Math.ceil(entries.length / 2)
  const colHeight = perCol * rowH
  ensure(7 + colHeight + 4) // heading + block together — no orphaned heading at a page foot
  heading(C.sheetPersonen)
  const startY = y
  entries.forEach((n, i) => {
    const col = i < perCol ? 0 : 1
    const x = col === 0 ? M : col2X
    const yy = startY + (i % perCol) * rowH
    doc.setDrawColor(40).setLineWidth(0.35).rect(x, yy - 3.2, 3.6, 3.6)
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(20)
    if (n) doc.text(doc.splitTextToSize(n, colW - 26)[0] as string, x + 5.5, yy)
    else dotted(x + 5.5, yy + 0.4, x + colW - 22)
    doc.setFontSize(7).setTextColor(150)
    doc.text('__:__ – __:__', x + colW - 19, yy)
  })
  y = startY + colHeight + GAP

  // --- Rückmeldung ELZ (who reported back to dispatch, when) ------------------------------
  ensure(16)
  heading(C.sheetRueckmeldung)
  field(C.sheetName, M, colW - 3, y + 2)
  timeField(C.sheetZeit, col2X, y + 2)
  y += 6 + GAP

  // --- signatures (keep the block together) ----------------------------------------------
  ensure(22)
  heading(C.sheetSignatures)
  const sig = (label: string, yy: number) => {
    doc.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(60)
    doc.text(`${label}:`, M, yy)
    dotted(M + 40, yy + 0.6, A4.w - M)
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
