import { describe, expect, it } from 'vitest'
import { drawingEditChanges, drawingLogName } from './drawingEdit'
import type { Drawing } from '../types'

const line = (over: Partial<Drawing>): Drawing => ({
  id: 'd1', kind: 'line', coords: [[7.5, 47.4], [7.51, 47.41]], ...over,
})

// The same gap entityEditChanges closed for symbols: a Leitung's meaning-bearing attributes
// used to change the Kroki without a Verlauf row.
describe('drawingEditChanges (the Verlauf line for editing a drawing)', () => {
  it('names the Inhalt letter as the word it means', () => {
    expect(drawingEditChanges(line({}), line({ content: 'S' }))).toEqual(['Inhalt: Schaum'])
    expect(drawingEditChanges(line({ content: 'S' }), line({ content: 'H' }))).toEqual(['Inhalt: Hydroschild'])
  })

  it('unsetting the Inhalt is Wasser, not a cleared field', () => {
    expect(drawingEditChanges(line({ content: 'S' }), line({}))).toEqual(['Inhalt: Wasser'])
  })

  it('carries the Leitungs-Nummer — the identity the Atemschutzüberwachung reads', () => {
    expect(drawingEditChanges(line({}), line({ lineNo: 3 }))).toEqual(['Leitung Nr.: 3'])
    expect(drawingEditChanges(line({ lineNo: 3 }), line({}))).toEqual(['Leitung Nr. geleert'])
  })

  it('names the Stockwerk the line works on, same wording as a symbol', () => {
    expect(drawingEditChanges(line({}), line({ floorTag: 2 }))).toEqual(['Stockwerk 2. OG'])
    expect(drawingEditChanges(line({ floorTag: 2 }), line({ floorTag: 0 }))).toEqual(['Stockwerk EG'])
    expect(drawingEditChanges(line({ floorTag: -1 }), line({}))).toEqual(['Stockwerk entfernt'])
  })

  it('reports the Abschluss as one statement, whatever combination of flags carries it', () => {
    expect(drawingEditChanges(line({}), line({ arrow: true }))).toEqual(['Abschluss: Pfeil'])
    expect(drawingEditChanges(line({ arrow: true }), line({ arrow: true, arrowStop: true })))
      .toEqual(['Abschluss: Pfeil mit Stopp'])
    expect(drawingEditChanges(line({ arrow: true }), line({ teilstueck: true })))
      .toEqual(['Abschluss: Teilstück'])
    expect(drawingEditChanges(line({ arrow: true, arrowStop: true }), line({})))
      .toEqual(['Abschluss: Keiner'])
  })

  it('stays silent on styling and geometry — arranging the picture is not an event', () => {
    const prev = line({ color: '#f00', width: 4, dashed: false, label: 'alt' })
    const next = line({
      color: '#00f', width: 8, dashed: true, coords: [[7.6, 47.5]],
      // the label writes its OWN row (useMapDrawing · noteDrawingLabel) — no duplicate here
      label: 'neu', labelDx: 12, labelAt: [7.6, 47.5], endDx: 3, marker: 'R',
      showDistance: true, locked: true, fillOpacity: 0.5,
    })
    expect(drawingEditChanges(prev, next)).toEqual([])
  })

  it('an unchanged drawing produces no lines', () => {
    const d = line({ content: 'S', lineNo: 1, floorTag: 2, arrow: true })
    expect(drawingEditChanges(d, { ...d })).toEqual([])
  })
})

describe('drawingLogName', () => {
  it('prefers the label, else names the kind', () => {
    expect(drawingLogName(line({ label: 'Sammelplatz' }))).toBe('Sammelplatz')
    expect(drawingLogName(line({}))).toBe('Linie')
    expect(drawingLogName({ id: 'a1', kind: 'area', coords: [] })).toBe('Fläche')
    expect(drawingLogName({ id: 'c1', kind: 'circle', coords: [] })).toBe('Absperrkreis')
  })

  // An unlabelled line reports the preset it was drawn with, so «Rettungsachse gezeichnet» and
  // «Rettungsachse gelöscht» are the same object — before 31.08. both ends said «Zeichnung».
  it('names an unlabelled line by its preset', () => {
    expect(drawingLogName(line({ arrow: true }))).toBe('Pfeil')
    expect(drawingLogName(line({ arrow: true, marker: 'R' }))).toBe('Rettungsachse')
    expect(drawingLogName(line({ arrow: true, marker: 'R', dashed: false }))).toBe('Rettungsachse')
  })

  it('lets a typed label beat the preset', () => {
    expect(drawingLogName(line({ arrow: true, marker: 'R', label: 'Fluchtweg Ost' }))).toBe('Fluchtweg Ost')
  })
})
