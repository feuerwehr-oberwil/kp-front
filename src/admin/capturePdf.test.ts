// Render smoke for the Erfassungsblatt (the paper twin of the digital record): the full
// Oberwil-sized config must produce a valid PDF without throwing, and stay a compact
// tick-off sheet (≤3 A4 pages with a 66-name roster — 2 without the guest lines' spill).
// Set CAPTURE_PDF_OUT=/some/dir to also write the rendered PDF for eyeballing.

import { describe, expect, it, vi } from 'vitest'
import { jsPDF } from 'jspdf'
import { downloadSheetPdf } from './capturePdf'

const OBERWIL_LIKE = {
  stationName: 'Feuerwehr Musterdorf',
  names: Array.from({ length: 66 }, (_, i) => `Mustermann${String(i + 1).padStart(2, '0')} Vorname`),
  catalogue: [
    'Wassersauger', 'Tauchpumpe klein', 'Tauchpumpe gross', 'Atemschutzgeräte', 'Exhauster',
    'Schaumleitung', 'Handlöscher', 'Wespenspray', 'Hochleistungslüfter', 'Generator',
    'Kettensäge', 'Rettungssäge', 'Wärmebildkamera', 'Rettungsschere / Spreizer',
  ].map((label) => ({ label, unit: 'Stk' })),
  groups: [
    { id: 'g2', label: 'Gr. 2', color: 'Rot' }, { id: 'g3', label: 'Gr. 3', color: 'Grün' },
    { id: 'g4', label: 'Gr. 4', color: 'Blau' }, { id: 'g5', label: 'Gr. 5', color: 'Gelb' },
    { id: 'g6', label: 'Gr. 6', color: 'Alle' }, { id: 'g7', label: 'Gr. 7', color: 'HöSi' },
    { id: 'wkh', label: 'Gr. 8', color: 'WKH' }, { id: 'tgp', label: 'Gr. 9', color: 'Tag. Pikett' },
  ],
  vehicles: [
    { id: 'tlf', label: 'TLF' }, { id: 'pio', label: 'Pio' }, { id: 'modulwagen', label: 'Modulwagen' },
    { id: 'trawa', label: 'TraWa' }, { id: 'mawa', label: 'MaWa' },
  ],
  partnerOrgs: ['Polizei', 'Sanität', 'Abschleppdienst', 'Stützpunkt', 'ADL / HRF'],
}

describe('downloadSheetPdf', () => {
  const renderPages = (input: Parameters<typeof downloadSheetPdf>[0]): number => {
    let pages = 0
    // jsPDF copies API members onto each instance at construction — patch the API slot
    // (node has no browser download path for the real save()).
    const api = jsPDF.API as unknown as Record<string, unknown>
    const orig = api.save
    api.save = function (this: jsPDF, name: string) {
      pages = this.getNumberOfPages()
      const out = process.env.CAPTURE_PDF_OUT
      if (out) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('node:fs').writeFileSync(`${out}/${name}`, Buffer.from(this.output('arraybuffer')))
      }
    }
    try {
      downloadSheetPdf(input)
    } finally {
      api.save = orig
    }
    return pages
  }

  it('renders the full canonical form for an Oberwil-sized station on exactly 2 pages', () => {
    // page 1: Details/Zeiten/Partner/Material/Notizen · page 2: roster/Rückmeldung/Visum —
    // the layout of the proven manual template (2 A4 = one duplex sheet)
    expect(renderPages(OBERWIL_LIKE)).toBe(2)
  })

  it('empty config lists → the compact sheet (no Zeiten/Partner/Kategorie rows)', () => {
    // a 66-name roster spans a full page on its own, so 3 pages is the floor here too
    // (unchanged from the pre-expansion sheet at this roster size)
    const pages = renderPages({
      stationName: 'X', names: OBERWIL_LIKE.names, catalogue: OBERWIL_LIKE.catalogue,
    })
    expect(pages).toBeGreaterThanOrEqual(1)
    expect(pages).toBeLessThanOrEqual(2)
  })
})
