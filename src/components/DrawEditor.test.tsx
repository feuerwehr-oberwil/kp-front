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
  onPreset: noop, onColor: noop, onWidth: noop, onDashed: noop, onLabel: noop,
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

// The Einsatzleiter must be able to ask how long the Leitung is without being able to move it:
// read-only keeps every number and drops every control.
// The presets are the ONE way to reach Rettungsachse/Pfeil on either surface: both tool docks
// deleted their own picker on the stated promise that the style is chosen in this editor, and
// `onPreset` was then declared, passed by both callers — and never rendered.
describe('line presets', () => {
  const P = appConfig.drawing.linePresets
  const rettung = P.find((p) => p.id === 'rettungsachse')!

  it('offers every preset on a line and applies the tapped one', () => {
    const onPreset = vi.fn()
    render(<DrawEditor {...base} drawing={{ kind: 'line' }} onPreset={onPreset} />)
    expect(screen.getByText(appConfig.copy.drawingEditor.preset)).toBeTruthy()
    for (const p of P) expect(screen.getByRole('button', { name: p.label })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: rettung.label }))
    expect(onPreset).toHaveBeenCalledWith(rettung.id)
  })

  it('lights the preset the line already wears — and none once it was hand-tuned', () => {
    const { container } = render(<DrawEditor {...base} drawing={{ kind: 'line', arrow: true, marker: 'R' }} />)
    expect(container.querySelector('.de-preset.on')?.textContent).toBe(rettung.label)
    cleanup()
    const tuned = render(<DrawEditor {...base} drawing={{ kind: 'line', arrow: false, marker: 'X' }} />)
    expect(tuned.container.querySelector('.de-preset.on')).toBeNull()
  })

  it('is a LINE control — an Absperrkreis has no preset row', () => {
    render(<DrawEditor {...base} drawing={{ kind: 'circle', radiusM: 100 }} />)
    expect(screen.queryByText(appConfig.copy.drawingEditor.preset)).toBeNull()
  })
})

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
