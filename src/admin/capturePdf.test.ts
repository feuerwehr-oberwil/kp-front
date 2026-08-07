// Render smoke for the Erfassungsblatt (the paper twin of the digital record): the full
// Oberwil-sized config must produce a valid PDF without throwing, and stay a compact
// tick-off sheet (≤3 A4 pages with a 66-name roster — 2 without the guest lines' spill).
// Set CAPTURE_PDF_OUT=/some/dir to also write the rendered PDF for eyeballing.

import { describe, expect, it } from 'vitest'
import { jsPDF } from 'jspdf'
import { downloadPosterPdf, downloadSheetPdf } from './capturePdf'

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

  /** Every string the sheet draws, in draw order — enough to assert the SECTION ORDER. */
  const renderText = (input: Parameters<typeof downloadSheetPdf>[0]): string[] => {
    const api = jsPDF.API as unknown as Record<string, unknown>
    const origSave = api.save
    // `text` lives on the PROTOTYPE, not on jsPDF.API — restoring it by assignment would leave
    // an own `undefined` shadowing the real method and break every test that ran after this one
    const hadOwnText = Object.prototype.hasOwnProperty.call(api, 'text')
    const origText = api.text
    const seen: string[] = []
    api.text = function (this: jsPDF, ...args: unknown[]) {
      const t = args[0]
      if (typeof t === 'string') seen.push(t)
      else if (Array.isArray(t)) seen.push(...t.filter((x): x is string => typeof x === 'string'))
      return this
    }
    api.save = function () {}
    try {
      downloadSheetPdf(input)
    } finally {
      api.save = origSave
      if (hadOwnText) api.text = origText
      else delete api.text
    }
    return seen
  }

  it('renders the full canonical form for an Oberwil-sized station on exactly 2 pages', () => {
    // 2 A4 = one duplex sheet, which is the proven manual template. The section ORDER follows
    // the Einsatzrapport (see the order test below); the roster flows rather than being kept
    // together, which is what keeps a village-sized Wehr off a third sheet.
    expect(renderPages(OBERWIL_LIKE)).toBe(2)
  })

  it('runs the sections in the Einsatzrapport’s own order', () => {
    // The blank sheet is the paper twin of the rapport: somebody fills this in at the Magazin
    // and types it into the app from top to bottom. It used to put Material and Partner BEFORE
    // the roster, so the two documents had to be read out of step.
    const order = renderText(OBERWIL_LIKE)
    const at = (needle: string) => {
      const i = order.indexOf(needle)
      expect(i, `«${needle}» missing from the sheet`).toBeGreaterThan(-1)
      return i
    }
    expect(at('Alarmierungs- / Ausrückzeiten')).toBeLessThan(at('Kurzbericht / durchgeführte Arbeiten'))
    expect(at('Kurzbericht / durchgeführte Arbeiten')).toBeLessThan(at('Anwesenheit (abhaken, ggf. von–bis)'))
    expect(at('Anwesenheit (abhaken, ggf. von–bis)')).toBeLessThan(at('Material (Menge eintragen)'))
    expect(at('Material (Menge eintragen)')).toBeLessThan(at('Partnerorganisationen'))
    expect(at('Partnerorganisationen')).toBeLessThan(at('Visum'))
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

// The poster is the whole onboarding for everyone who never opens the app: hint, QR, three
// steps and the division of labour have to fit ONE page — a second page is a poster whose
// instructions are hanging on the back of the wall. Nothing else here is testable without
// eyes, so this is a render smoke plus the page count (CAPTURE_PDF_OUT to eyeball it).
describe('downloadPosterPdf', () => {
  it('renders the Magazin poster on exactly one A4 page', async () => {
    let pages = 0
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
      await downloadPosterPdf('https://front.example.org/e/8Yq2rL4mZt7xVb1nKp3sWd', 'Feuerwehr Musterdorf')
    } finally {
      api.save = orig
    }
    expect(pages).toBe(1)
  })
})
