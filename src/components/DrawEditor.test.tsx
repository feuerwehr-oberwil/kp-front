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
  onDelete: noop, onClose: noop,
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

  // D3 (24.09.2026): while an end follows a vehicle, the editor LEADS with it — how long, how far,
  // and the way back — and the same end shows no second set of controls under «Verbindungen».
  it('a following end: «Zurück auf Stand …», «Folgen stoppen», «Am Einsatzort lösen», «Hier lösen (Spur behalten)»', () => {
    const onRouting = vi.fn(), onDetach = vi.fn(), onRevertGps = vi.fn(), onDetachHere = vi.fn()
    const gps = { state: 'continuous' as const, confirmedAt: [8, 47] as [number, number], lastSafe: [8.01, 47.01] as [number, number],
      before: { coords: [[7.99, 46.99], [8, 47]] as [number, number][], routing: 'direct' as const, state: 'paused' as const, confirmedAt: [8, 47] as [number, number], lastSafe: [8, 47] as [number, number], at: '2026-09-23T20:31:00.000Z' } }
    render(<DrawEditor {...base}
      drawing={{ kind: 'line', endAttachment: { target: { kind: 'object', id: 'gps-3', live: true }, routing: 'trace', gps } }}
      attachmentLabels={{ end: 'TLF' }}
      gpsInfo={{ end: { line: 'Leitung 1', vehicle: 'TLF', since: '20:31', distance: '1.1 km', onSite: true } }}
      onRouting={onRouting} onDetach={onDetach} onRevertGps={onRevertGps} onDetachHere={onDetachHere} />)
    expect(screen.getByText('Leitung 1 · folgt TLF seit 20:31')).toBeTruthy()
    expect(screen.getByText('jetzt 1.1 km entfernt')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Zurück auf Stand am Einsatzort (20:31)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Folgen stoppen' }))
    fireEvent.click(screen.getByRole('button', { name: 'Am Einsatzort lösen' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hier lösen (Spur behalten)' }))
    expect(onRevertGps).toHaveBeenCalledWith('end')
    expect(onRouting).toHaveBeenCalledWith('end', 'direct')
    expect(onDetach).toHaveBeenCalledWith('end')
    expect(onDetachHere).toHaveBeenCalledWith('end')
    // one place per question: no second detach or route row for this end
    expect(screen.getAllByRole('button', { name: /lösen/ })).toHaveLength(2)
    expect(screen.queryByText('GPS folgt aktiv')).toBeNull()
  })

  it('a STOPPED end reads «Folgen gestoppt» and offers «Weiter folgen» instead of «Folgen stoppen»', () => {
    const onRouting = vi.fn()
    render(<DrawEditor {...base}
      drawing={{ kind: 'line', endAttachment: { target: { kind: 'object', id: 'gps-3', live: true }, routing: 'direct', gps: { state: 'paused', confirmedAt: [8, 47], lastSafe: [8.01, 47.01] } } }}
      gpsInfo={{ end: { line: 'Leitung 1', vehicle: 'TLF', distance: '1.1 km', stopped: true, onSite: false } }}
      onRouting={onRouting} onDetach={noop} onDetachHere={noop} />)
    expect(screen.getByText('Leitung 1 · Folgen gestoppt · TLF')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Weiter folgen' }))
    expect(onRouting).toHaveBeenCalledWith('end', 'trace')
  })

  it('a trace WITHOUT a kept on-site line: no way back, and nothing says «Einsatzort»', () => {
    render(<DrawEditor {...base}
      drawing={{ kind: 'line', endAttachment: { target: { kind: 'object', id: 'gps-3', live: true }, routing: 'trace', gps: { state: 'continuous', confirmedAt: [8, 47], lastSafe: [8.01, 47.01] } } }}
      gpsInfo={{ end: { line: 'Linie', vehicle: 'TLF', distance: '1.1 km', onSite: false } }}
      onRouting={noop} onDetach={noop} onRevertGps={noop} onDetachHere={noop} />)
    expect(screen.getByText('Linie · folgt TLF')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Zurück auf Stand/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Einsatzort/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Hier lösen (Spur behalten)' })).toBeTruthy()
  })

  it('a paused GPS end that never traced (no block) lets go «Am Einsatzort»', () => {
    const onDetach = vi.fn()
    render(<DrawEditor {...base}
      drawing={{ kind: 'line', endAttachment: { target: { kind: 'object', id: 'gps-3', live: true }, routing: 'direct', gps: { state: 'paused', confirmedAt: [8, 47], lastSafe: [8, 47] } } }}
      onRouting={noop} onDetach={onDetach} />)
    expect(screen.queryByText('Hier lösen')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Am Einsatzort lösen' }))
    expect(onDetach).toHaveBeenCalledWith('end')
  })

  it('uses the reviewed indirect-removal consequence copy', () => {
    expect(fillTemplate(appConfig.copy.drawingEditor.removeConnectedMessage, { n: 2 })).toBe('2 Linien werden gelöst.')
  })
})

// Measuring a line AFTER it was drawn: before this the length was only reachable by re-drawing
// the line with the Messen tool, and the Höhenprofil not at all.
describe('Messung on an already drawn line', () => {
  const D = appConfig.copy.drawingEditor

  // collapsed since 15.09.: the group is one row until opened, then length, hose count AND the
  // Höhenprofil come at once – no second toggle inside
  it('states length + hose count once the group is opened', () => {
    render(<DrawEditor {...base} drawing={{ kind: 'line' }} lengthM={412} />)
    expect(screen.queryByText('412 m')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: D.measurement }))
    expect(screen.getByText('412 m')).toBeTruthy()
    expect(screen.getByText(String(hoseCount(412)))).toBeTruthy() // incl. the configured reserve
  })

  it('fetches the Höhenprofil only when the group is opened (no swisstopo request on selection)', () => {
    const fetchMock = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    render(<DrawEditor {...base} drawing={{ kind: 'line' }} lengthM={412} profileCoords={[[7.5, 47.5], [7.51, 47.51]]} />)
    expect(screen.getByRole('button', { name: D.measurement })).toHaveProperty('ariaExpanded', 'false')
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: D.measurement }))
    // the request is debounced (useLineProfile); the profile block is already up and loading
    expect(screen.getByText(appConfig.copy.measure.profile)).toBeTruthy()
    expect(screen.getByText(appConfig.copy.measure.profileLoading)).toBeTruthy()
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
    fireEvent.click(screen.getByRole('button', { name: D.measurement }))
    expect(screen.queryByText(appConfig.copy.measure.profile)).toBeNull()
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
    fireEvent.click(screen.getByRole('button', { name: D.measurement }))
    expect(screen.getByText('412 m')).toBeTruthy()
    expect(screen.getByText(appConfig.copy.measure.profile)).toBeTruthy()
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
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.drawingEditor.measurement }))
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
