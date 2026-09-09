// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DrawEditor } from './DrawEditor'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { hoseCount } from '../lib/geo'

afterEach(cleanup)

const noop = () => {}
const base = {
  pointCount: 2,
  onColor: noop, onWidth: noop, onDashed: noop, onLabel: noop,
  onMarker: noop, onArrow: noop, onShowDistance: noop, onRadius: noop,
  onFillOpacity: noop, onDelete: noop, onClose: noop,
}

describe('shared magnetic connection controls', () => {
  it('shows both parties, touch actions, routing state and detach', () => {
    const onRouting = vi.fn(), onDetach = vi.fn(), onFocusAttachment = vi.fn()
    render(<DrawEditor {...base}
      drawing={{ kind: 'line', startAttachment: { target: { kind: 'object', id: 'pump' }, routing: 'direct' }, endAttachment: { target: { kind: 'line', id: 'l2', endpoint: 'end' }, routing: 'trace', port: 2 } }}
      attachmentLabels={{ start: 'TLF 1', end: 'Leitung 2' }}
      onRouting={onRouting} onDetach={onDetach} onFocusAttachment={onFocusAttachment} />)
    expect(screen.getByText('TLF 1')).toBeTruthy(); expect(screen.getByText('Leitung 2')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Spur' })[0])
    fireEvent.click(screen.getAllByRole('button', { name: 'Verbindung lösen' })[1])
    fireEvent.click(screen.getByRole('button', { name: /TLF 1/ })) // tap the target chip to fly there
    expect(onRouting).toHaveBeenCalledWith('start', 'trace')
    expect(onDetach).toHaveBeenCalledWith('end')
    expect(onFocusAttachment).toHaveBeenCalledWith('start')
  })

  it('uses the reviewed indirect-removal consequence copy', () => {
    expect(fillTemplate(appConfig.copy.drawingEditor.removeConnectedMessage, { n: 2 })).toBe('2 Linien werden gelöst.')
  })
})

// Measuring a line AFTER it was drawn: before this the length was only reachable by re-drawing
// the line with the Messen tool, and the Höhenprofil not at all.
describe('Messung on an already drawn line', () => {
  const D = appConfig.copy.drawingEditor

  it('states length + hose count without any operator action', () => {
    render(<DrawEditor {...base} drawing={{ kind: 'line' }} lengthM={412} />)
    expect(screen.getByText(D.measurement)).toBeTruthy()
    expect(screen.getByText('412 m')).toBeTruthy()
    expect(screen.getByText(String(hoseCount(412)))).toBeTruthy() // incl. the configured reserve
  })

  it('keeps the Höhenprofil collapsed until asked (no swisstopo request on selection)', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<DrawEditor {...base} drawing={{ kind: 'line' }} lengthM={412} profileCoords={[[7.5, 47.5], [7.51, 47.51]]} />)
    expect(screen.getByRole('button', { name: appConfig.copy.measure.profile })).toHaveProperty('ariaExpanded', 'false')
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('has no Messung section on an area or an uncalibrated plan line', () => {
    render(<DrawEditor {...base} drawing={{ kind: 'area' }} lengthM={412} />)
    expect(screen.queryByText(D.measurement)).toBeNull()
    cleanup()
    render(<DrawEditor {...base} drawing={{ kind: 'line' }} lengthM={null} />)
    expect(screen.queryByText(D.measurement)).toBeNull()
  })

  it('offers no Höhenprofil where there is no height data (the Plan)', () => {
    render(<DrawEditor {...base} drawing={{ kind: 'line' }} lengthM={412} />)
    expect(screen.queryByRole('button', { name: appConfig.copy.measure.profile })).toBeNull()
  })
})

/* No preset row since 09.09. («das ganze Stil-Ding»): a line's decoration is assembled from the
 * raw controls — Abschluss, Stil (solid/dash/Ketten), the letter field. The Verlauf still names
 * the known combinations (lib/lineStyle · lineStyleName), which drawingEdit.test pins. */
describe('no preset row', () => {
  it('renders no preset chips on a line — the raw controls are the way in', () => {
    render(<DrawEditor {...base} drawing={{ kind: 'line' }} />)
    // (.de-preset itself lives on — the content letters and routing chips wear it)
    for (const p of appConfig.drawing.linePresets) {
      expect(screen.queryByRole('button', { name: p.label })).toBeNull()
    }
  })
})

// The Einsatzleiter must be able to ask how long the Leitung is without being able to move it:
// read-only keeps every number and drops every control.
describe('read-only (viewer / Führungsansicht)', () => {
  const D = appConfig.copy.drawingEditor

  it('keeps the numbers a locked surface is opened FOR', () => {
    render(<DrawEditor {...base} readOnly drawing={{ kind: 'line' }} lengthM={412} profileCoords={[[7.5, 47.5], [7.51, 47.51]]} />)
    expect(screen.getByText(D.measurement)).toBeTruthy()
    expect(screen.getByText('412 m')).toBeTruthy()
    expect(screen.getByRole('button', { name: appConfig.copy.measure.profile })).toBeTruthy()
  })

  it('drops every control that would change the shape', () => {
    render(<DrawEditor {...base} readOnly drawing={{ kind: 'line', label: 'Angriff Ost' }} lengthM={412}
      onToggleLock={noop} onEnding={noop} onContent={noop} />)
    expect(screen.queryByText(D.color)).toBeNull()
    expect(screen.queryByText(D.width)).toBeNull()
    expect(screen.queryByText(D.ending)).toBeNull()
    expect(screen.queryByText(D.showOnMap)).toBeNull() // «Auf Karte» writes to the drawing
    expect(screen.queryByRole('button', { name: new RegExp(appConfig.copy.delete) })).toBeNull()
    expect(screen.queryByRole('button', { name: new RegExp(D.lock) })).toBeNull()
    expect(document.querySelector('input')).toBeNull() // Text/Marker are read, not typed
    expect(screen.getByText('Angriff Ost')).toBeTruthy() // …but the shape's own name still reads
  })

  it('states what an Absperrkreis covers, not just its radius', () => {
    render(<DrawEditor {...base} readOnly drawing={{ kind: 'circle', radiusM: 100 }} areaM2={31416} perimeterM={628} />)
    expect(screen.getByText(appConfig.copy.measure.area)).toBeTruthy()
    expect(screen.getByText(appConfig.copy.measure.perimeter)).toBeTruthy()
    expect(screen.getByText('628 m')).toBeTruthy()
  })
})

// A Leitung goes into a Keller as often as up a Treppe — the storey stepper reads the same as
// the Geschoss rows in the symbol panel (ContextPanel · Stepper `seedOnDec`).
describe('Stockwerk on a Leitung', () => {
  const line = { kind: 'line' as const }

  it('seeds EG (0) on the first tap of −, then steps into the Untergeschosse', () => {
    const onFloorTag = vi.fn()
    const { rerender } = render(<DrawEditor {...base} drawing={line} onFloorTag={onFloorTag} />)
    fireEvent.pointerDown(screen.getByLabelText('weniger'))
    expect(onFloorTag).toHaveBeenCalledWith(0)
    rerender(<DrawEditor {...base} drawing={{ ...line, floorTag: 0 }} onFloorTag={onFloorTag} />)
    fireEvent.pointerDown(screen.getByLabelText('weniger'))
    expect(onFloorTag).toHaveBeenLastCalledWith(-1)
  })

  it('takes a typed Untergeschoss', () => {
    const onFloorTag = vi.fn()
    render(<DrawEditor {...base} drawing={line} onFloorTag={onFloorTag} />)
    fireEvent.click(screen.getByTitle(appConfig.copy.stepper.typeToEnter))
    const input = screen.getByRole('textbox', { name: appConfig.copy.drawingEditor.floorTag }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '-1' } })
    fireEvent.blur(input)
    expect(onFloorTag).toHaveBeenCalledWith(-1)
  })
})



// «Abschluss» is four pictures. A hold used to answer with the NAME, which the picture already
// gives; the consequence — Entwicklungsgrenze, and a deleted Teilstück letting its lines go — is
// what a name cannot carry. Delivered through the app's own bubble (data-holdexplain), the same
// way the Typ letters in this sheet are explained.
describe('the Abschluss options explain themselves', () => {
  it('carries the consequence on each option, in the bubble and not as a native title', () => {
    const C = appConfig.copy.drawingEditor
    render(<DrawEditor {...base} drawing={{ kind: 'line' }} onEnding={noop} onMarker={noop} />)
    const teil = screen.getByRole('button', { name: C.endingTeilstueckWhat })
    expect(teil.getAttribute('data-holdexplain')).not.toBeNull()
    // ⚠️ no `title`, or the native tooltip arrives a second later and says it twice
    expect(teil.getAttribute('title')).toBeNull()
    // …and it says WHAT the thing is; the delete consequence lives in `removeEMessage`, shown at
    // the moment a Teilstück is actually deleted
    expect(C.endingTeilstueckWhat).toMatch(/Anschlüssen/)
    expect(C.endingArrowStopWhat).toMatch(/Entwicklungsgrenze/)
    expect(C.removeEMessage).toMatch(/gelöst/)

    // the Strichart pictures answer the same way — «welche Seite zeigen die Zähne»
    const teeth = screen.getByRole('button', { name: C.lineHalteliniUp })
    expect(teeth.getAttribute('data-holdexplain')).not.toBeNull()
    expect(teeth.getAttribute('title')).toBeNull()
  })
})

// The Fläche IS the Abschnitt (FKS Einsatzführung 3.5.2): Leiter + Auftrag live on the shape.
// Offered only where the caller passes the handlers — the Lage; a Plan sketch passes none.
describe('Abschnitt on a Fläche', () => {
  const D = appConfig.copy.drawingEditor

  it('offers Leiter + Auftrag on an area, and commits the Auftrag once on blur', () => {
    const onLeiter = vi.fn(), onAuftrag = vi.fn()
    render(<DrawEditor {...base} drawing={{ kind: 'area' }}
      onAbschnittLeiter={onLeiter} onAbschnittAuftrag={onAuftrag} people={['Oblt Steiner']} />)
    expect(screen.getByText(D.abschnittLeiter)).toBeTruthy()
    const input = screen.getByPlaceholderText(D.abschnittAuftragPlaceholder)
    fireEvent.change(input, { target: { value: 'Brandbekämpfung Trakt B' } })
    expect(onAuftrag).not.toHaveBeenCalled() // one undo step, one record row — never per keystroke
    fireEvent.blur(input)
    expect(onAuftrag).toHaveBeenCalledWith('Brandbekämpfung Trakt B')
  })

  it('clears via an emptied field, as undefined', () => {
    const onAuftrag = vi.fn()
    render(<DrawEditor {...base} drawing={{ kind: 'area', abschnittAuftrag: 'alt' }} onAbschnittAuftrag={onAuftrag} />)
    const input = screen.getByPlaceholderText(D.abschnittAuftragPlaceholder)
    fireEvent.change(input, { target: { value: '  ' } })
    fireEvent.blur(input)
    expect(onAuftrag).toHaveBeenCalledWith(undefined)
  })

  it('stays hidden on a line, and on an area without handlers (the Plan)', () => {
    render(<DrawEditor {...base} drawing={{ kind: 'line' }} onAbschnittLeiter={vi.fn()} />)
    expect(screen.queryByText(D.abschnittLeiter)).toBeNull()
    cleanup()
    render(<DrawEditor {...base} drawing={{ kind: 'area' }} />)
    expect(screen.queryByText(D.abschnittLeiter)).toBeNull()
  })

  it('shows the FKS Richtwert above four Abschnitte — a hint, never a gate', () => {
    render(<DrawEditor {...base} drawing={{ kind: 'area' }} onAbschnittLeiter={vi.fn()} abschnittCount={5} />)
    expect(screen.getByText(D.abschnittMaxHint)).toBeTruthy()
  })

  it('states Leiter + Auftrag read-only for the Führungsansicht', () => {
    render(<DrawEditor {...base} drawing={{ kind: 'area', abschnittLeiter: 'Oblt Steiner', abschnittAuftrag: 'Wasserversorgung' }} readOnly />)
    expect(screen.getByText('Oblt Steiner')).toBeTruthy()
    expect(screen.getByText('Wasserversorgung')).toBeTruthy()
  })
})
