// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { fitSimilarity } from '../lib/georef'
import { boardDrawingTwins, boardEntityTwins } from '../lib/georefTwins'
import type { Drawing, Entity } from '../types'
import { GeorefContentBoard } from './GeorefContentBoard'
import { appConfig } from '../config/appConfig'

afterEach(cleanup)

const fit = fitSimilarity([
  { plan: { x: 0, y: 0 }, lngLat: { lng: 7.5, lat: 47.5 } },
  { plan: { x: 1, y: 0 }, lngLat: { lng: 7.501, lat: 47.5 } },
], 1)!
const base = { layer: 'taktisch' as const, coord: [7.5005, 47.5] as [number, number] }

describe('broader Karte content on a Modul', () => {
  it('renders geometry, notes, shapes, Atemschutz markers and shared positions', () => {
    const entities: Entity[] = [
      { ...base, id: 'note', kind: 'note', label: 'Abschnitt West' },
      { ...base, id: 'shape', kind: 'shape', shape: 'square', sizeM: 20 },
      { ...base, id: 'team', kind: 'team', label: 'Trupp 2' },
      { ...base, id: 'person', kind: 'person', label: 'Muster Max', symbolSvg: '<svg viewBox="0 0 10 10" />', live: true },
    ]
    const drawings: Drawing[] = [{ id: 'line', kind: 'line', coords: [[7.5, 47.5], [7.5008, 47.5]], label: 'Leitung 1' }]
    const { container } = render(<GeorefContentBoard entities={boardEntityTwins(entities, fit)} drawings={boardDrawingTwins(drawings, fit)}
      fit={fit} planAspect={1} sW={800} sH={600} byName={{}} />)
    expect(screen.getByText('Abschnitt West')).toBeTruthy()
    expect(screen.getByText('Trupp 2')).toBeTruthy()
    expect(screen.getByText('Muster Max')).toBeTruthy()
    expect(screen.getByText('Leitung 1')).toBeTruthy()
    expect(container.querySelector('.shape-glyph')).toBeTruthy()
    expect(container.querySelector('polyline')).toBeTruthy()
  })

  it('keeps a mirrored Leitung its FKS voice: arrowhead, fork, tag, letters, Länge', () => {
    const drawings: Drawing[] = [
      {
        id: 'ltg', kind: 'line', coords: [[7.5, 47.5], [7.5008, 47.5]],
        arrow: true, teilstueck: true, content: 'S', lineNo: 1, marker: 'R', showDistance: true,
      },
      { id: 'ring', kind: 'circle', coords: [[7.5005, 47.5]], radiusM: 50 },
    ]
    const { container } = render(<GeorefContentBoard entities={[]} drawings={boardDrawingTwins(drawings, fit)}
      fit={fit} planAspect={1} sW={800} sH={600} byName={{}} />)
    expect(container.querySelector('.wb-arrowhead')).toBeTruthy()
    expect(container.querySelector('.line-fork')).toBeTruthy()
    expect(screen.getByText('1 · S')).toBeTruthy()          // the end tag
    expect(screen.getAllByText('R').length).toBeGreaterThan(0) // the —R— rhythm
    // the Länge is measured on the SOURCE geodesics — no plan calibration involved
    expect(container.querySelector('.wb-line-label')?.textContent).toMatch(/m ·/)
    // …and the Absperrkreis states its radius like the map does
    expect(screen.getByText('50 m')).toBeTruthy()
  })

  it('a selected Trupp twin wears the ORIGINAL\'s context bar, trail-locked trash included', () => {
    // round 7: tap selects (the original's grammar) — pill + wb-pill-acts appear in place of
    // the stacked workspace panel; every action writes the one map entity
    const onSelectTeam = vi.fn()
    const clearTrail = vi.fn()
    const acts = {
      rename: vi.fn(), pick: vi.fn(), color: vi.fn(), mark: vi.fn(), clearTrail,
      remove: vi.fn(), showTrupp: vi.fn(), toOriginal: vi.fn(),
    }
    const entities: Entity[] = [{ ...base, id: 'team', kind: 'team', label: 'Trupp 2', trail: [{ coord: base.coord, t: '15:34' }] }]
    const { rerender, container } = render(<GeorefContentBoard entities={boardEntityTwins(entities, fit)} drawings={[]}
      fit={fit} planAspect={1} sW={800} sH={600} byName={{}} interactive
      onOpenTeam={() => {}} teamActions={acts} onSelectTeam={onSelectTeam} selectedTeamId={null} />)
    const chip = screen.getByRole('button', { name: /Trupp 2/ })
    fireEvent.pointerDown(chip, { pointerId: 21, clientX: 100, clientY: 100 })
    fireEvent.pointerUp(chip, { pointerId: 21, clientX: 100, clientY: 100 })
    expect(onSelectTeam).toHaveBeenCalledWith('team')

    rerender(<GeorefContentBoard entities={boardEntityTwins(entities, fit)} drawings={[]}
      fit={fit} planAspect={1} sW={800} sH={600} byName={{}} interactive
      onOpenTeam={() => {}} teamActions={acts} onSelectTeam={onSelectTeam} selectedTeamId="team" />)
    expect(container.querySelector('.wb-pill-acts')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.whiteboard.markPosition }))
    expect(acts.mark).toHaveBeenCalledWith('team')
    // a recorded trail locks deletion — the trash offers the confirmed clear instead
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.whiteboard.deleteLocked }))
    expect(clearTrail).toHaveBeenCalledWith('team')
    expect(acts.remove).not.toHaveBeenCalled()
  })

  it('a mirrored Trupp chip answers a tap with the jump to its source marker', () => {
    const onOpenTeam = vi.fn()
    const entities: Entity[] = [{ ...base, id: 'team', kind: 'team', label: 'Trupp 2' }]
    render(<GeorefContentBoard entities={boardEntityTwins(entities, fit)} drawings={[]}
      fit={fit} planAspect={1} sW={800} sH={600} byName={{}} interactive onOpenTeam={onOpenTeam} />)
    const chip = screen.getByRole('button', { name: /Trupp 2/ })
    fireEvent.pointerDown(chip, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerUp(chip, { pointerId: 1, clientX: 100, clientY: 100 })
    expect(onOpenTeam).toHaveBeenCalledWith(expect.objectContaining({ id: 'team' }))
  })

  it('…and a drag past the deadzone moves the source, in the sheet\'s own space', () => {
    // dragging the mirrored chip used to pan the board under it — «Trupp markers cannot be moved»
    const onOpenTeam = vi.fn()
    const onMoveTeam = vi.fn()
    const entities: Entity[] = [{ ...base, id: 'team', kind: 'team', label: 'Trupp 2' }]
    render(<GeorefContentBoard entities={boardEntityTwins(entities, fit)} drawings={[]}
      fit={fit} planAspect={1} sW={800} sH={600} byName={{}} interactive onOpenTeam={onOpenTeam} onMoveTeam={onMoveTeam} />)
    const chip = screen.getByRole('button', { name: /Trupp 2/ })
    fireEvent.pointerDown(chip, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(chip, { pointerId: 1, clientX: 180, clientY: 100 }) // +80px on an 800px sheet = +0.1
    fireEvent.pointerUp(chip, { pointerId: 1, clientX: 180, clientY: 100 })
    const [entity, pt, phase] = onMoveTeam.mock.calls[onMoveTeam.mock.calls.length - 1]
    expect(phase).toBe('end')
    expect(entity.id).toBe('team')
    expect(pt.x).toBeCloseTo(0.5 + 0.1, 5)
    expect(onOpenTeam).not.toHaveBeenCalled() // a drag is not a tap
  })

  it('…but stays inert while a tool is armed', () => {
    const onOpenTeam = vi.fn()
    const entities: Entity[] = [{ ...base, id: 'team', kind: 'team', label: 'Trupp 2' }]
    render(<GeorefContentBoard entities={boardEntityTwins(entities, fit)} drawings={[]}
      fit={fit} planAspect={1} sW={800} sH={600} byName={{}} interactive={false} onOpenTeam={onOpenTeam} />)
    expect(screen.queryByRole('button', { name: /Trupp 2/ })).toBeNull()
  })

  it('a mirrored note answers the same tap and drag grammar as the chip (E7)', () => {
    const onOpenTeam = vi.fn()
    const onMoveTeam = vi.fn()
    const entities: Entity[] = [{ ...base, id: 'note', kind: 'note', label: 'Abschnitt West' }]
    render(<GeorefContentBoard entities={boardEntityTwins(entities, fit)} drawings={[]}
      fit={fit} planAspect={1} sW={800} sH={600} byName={{}} interactive onOpenTeam={onOpenTeam} onMoveTeam={onMoveTeam} />)
    const note = screen.getByRole('button', { name: /Abschnitt West/ })
    fireEvent.pointerDown(note, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerUp(note, { pointerId: 1, clientX: 100, clientY: 100 })
    expect(onOpenTeam).toHaveBeenCalledWith(expect.objectContaining({ id: 'note' }))
    fireEvent.pointerDown(note, { pointerId: 2, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(note, { pointerId: 2, clientX: 180, clientY: 100 })
    fireEvent.pointerUp(note, { pointerId: 2, clientX: 180, clientY: 100 })
    const [entity, pt, phase] = onMoveTeam.mock.calls[onMoveTeam.mock.calls.length - 1]
    expect(phase).toBe('end')
    expect(entity.id).toBe('note')
    expect(pt.x).toBeCloseTo(0.5 + 0.1, 5)
  })

  // GPS semantics: a shared responder position is somebody's self-report — its mirror never
  // offers a hit target, whatever handlers the surface passes (see the component's comment).
  it('keeps a shared responder position pointer-inert even on an interactive sheet', () => {
    const entities: Entity[] = [{ ...base, id: 'p1', kind: 'person', label: 'Muster Max', symbolSvg: '<svg viewBox="0 0 10 10" />', live: true }]
    render(<GeorefContentBoard entities={boardEntityTwins(entities, fit)} drawings={[]}
      fit={fit} planAspect={1} sW={800} sH={600} byName={{}} interactive onOpenTeam={() => {}} onMoveTeam={() => {}} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(document.querySelector<HTMLElement>('.ts')?.style.width).toBe('28px')
  })

  it('makes a mirrored line directly clickable and draggable, writing source coordinates', () => {
    const onOpenDrawing = vi.fn()
    const onDrawingCoords = vi.fn()
    const drawings: Drawing[] = [{ id: 'line', kind: 'line', coords: [[7.5, 47.5], [7.5008, 47.5]], label: 'Leitung 1' }]
    render(<GeorefContentBoard entities={[]} drawings={boardDrawingTwins(drawings, fit)}
      fit={fit} planAspect={1} sW={800} sH={600} byName={{}} interactive
      onOpenDrawing={onOpenDrawing} onDrawingCoords={onDrawingCoords} />)
    const line = screen.getByRole('button', { name: /Leitung 1/ })
    fireEvent.pointerDown(line, { pointerId: 7, clientX: 100, clientY: 100 })
    fireEvent.pointerUp(line, { pointerId: 7, clientX: 100, clientY: 100 })
    expect(onOpenDrawing).toHaveBeenCalledWith(expect.objectContaining({ id: 'line' }))

    fireEvent.pointerDown(line, { pointerId: 8, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(line, { pointerId: 8, clientX: 180, clientY: 100 })
    fireEvent.pointerUp(line, { pointerId: 8, clientX: 180, clientY: 100 })
    const [id, coords, phase] = onDrawingCoords.mock.calls[onDrawingCoords.mock.calls.length - 1]
    expect(id).toBe('line')
    expect(phase).toBe('end')
    expect(coords[0][0]).toBeGreaterThan(drawings[0].coords[0][0])
  })

  it('exposes source-backed vertex handles on the selected mirrored line', () => {
    const onDrawingCoords = vi.fn()
    const drawings: Drawing[] = [{ id: 'line', kind: 'line', coords: [[7.5, 47.5], [7.5008, 47.5]], label: 'Leitung 1' }]
    render(<GeorefContentBoard entities={[]} drawings={boardDrawingTwins(drawings, fit)}
      fit={fit} planAspect={1} sW={800} sH={600} byName={{}} interactive selectedDrawingId="line"
      onDrawingCoords={onDrawingCoords} />)
    const vertex = screen.getByTestId('twin-vertex-0')
    fireEvent.pointerDown(vertex, { pointerId: 9, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(vertex, { pointerId: 9, clientX: 140, clientY: 130 })
    fireEvent.pointerUp(vertex, { pointerId: 9, clientX: 140, clientY: 130 })
    const [id, coords, phase] = onDrawingCoords.mock.calls[onDrawingCoords.mock.calls.length - 1]
    expect(id).toBe('line')
    expect(phase).toBe('end')
    expect(coords[0]).not.toEqual(drawings[0].coords[0])
    expect(coords[1]).toEqual(drawings[0].coords[1])
  })

  it('freezes the overhanging axis instead of teleporting a line wider than the sheet', () => {
    // twins are kept on mere OVERLAP, so a hose line running past the Modul on both sides is
    // normal. Its clamp bounds invert — clamping through them used to jump the real Lage line
    // by half a sheet on the first move. The frozen axis must not leak into the other one.
    const onDrawingCoords = vi.fn()
    const drawings: Drawing[] = [{ id: 'wide', kind: 'line', coords: [[7.4994, 47.5], [7.5014, 47.5]], label: 'Leitung 1' }]
    render(<GeorefContentBoard entities={[]} drawings={boardDrawingTwins(drawings, fit)}
      fit={fit} planAspect={1} sW={800} sH={600} byName={{}} interactive
      onDrawingCoords={onDrawingCoords} />)
    const line = screen.getByRole('button', { name: /Leitung 1/ })
    fireEvent.pointerDown(line, { pointerId: 11, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(line, { pointerId: 11, clientX: 180, clientY: 160 }) // +80px x, +60px y
    fireEvent.pointerUp(line, { pointerId: 11, clientX: 180, clientY: 160 })
    const [, coords, phase] = onDrawingCoords.mock.calls[onDrawingCoords.mock.calls.length - 1]
    expect(phase).toBe('end')
    coords.forEach((c: [number, number], i: number) => {
      expect(c[0]).toBeCloseTo(drawings[0].coords[i][0], 9) // x overhangs → frozen
      expect(c[1]).not.toBeCloseTo(drawings[0].coords[i][1], 9) // y fits → still moves
    })
  })

  it('keeps an attached endpoint pinned through a whole-line drag and offers it no handle', () => {
    // moveLineBody parity: the endpoint is glued to its Karte target and re-resolves there —
    // translating its stored coord from the Plan would fork the two surfaces.
    const onDrawingCoords = vi.fn()
    const drawings: Drawing[] = [{
      id: 'att', kind: 'line', coords: [[7.5002, 47.5], [7.5008, 47.5]], label: 'Leitung 1',
      startAttachment: { target: { kind: 'object', id: 'hydrant' }, routing: 'direct' },
    }]
    render(<GeorefContentBoard entities={[]} drawings={boardDrawingTwins(drawings, fit)}
      fit={fit} planAspect={1} sW={800} sH={600} byName={{}} interactive selectedDrawingId="att"
      onDrawingCoords={onDrawingCoords} />)
    expect(screen.queryByTestId('twin-vertex-0')).toBeNull()
    expect(screen.getByTestId('twin-vertex-1')).toBeTruthy()
    const line = screen.getByRole('button', { name: 'Leitung 1' })
    fireEvent.pointerDown(line, { pointerId: 12, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(line, { pointerId: 12, clientX: 180, clientY: 100 })
    fireEvent.pointerUp(line, { pointerId: 12, clientX: 180, clientY: 100 })
    const [, coords] = onDrawingCoords.mock.calls[onDrawingCoords.mock.calls.length - 1]
    expect(coords[0]).toEqual(drawings[0].coords[0]) // pinned
    expect(coords[1][0]).toBeGreaterThan(drawings[0].coords[1][0]) // body moved
  })

  it('does not create a source edit for a steady tap on a mirrored vertex', () => {
    const onDrawingCoords = vi.fn()
    const drawings: Drawing[] = [{ id: 'line', kind: 'line', coords: [[7.5, 47.5], [7.5008, 47.5]], label: 'Leitung 1' }]
    render(<GeorefContentBoard entities={[]} drawings={boardDrawingTwins(drawings, fit)}
      fit={fit} planAspect={1} sW={800} sH={600} byName={{}} interactive selectedDrawingId="line"
      onDrawingCoords={onDrawingCoords} />)
    const vertex = screen.getByTestId('twin-vertex-0')
    fireEvent.pointerDown(vertex, { pointerId: 10, clientX: 100, clientY: 100 })
    fireEvent.pointerUp(vertex, { pointerId: 10, clientX: 100, clientY: 100 })
    expect(onDrawingCoords).not.toHaveBeenCalled()
  })
})
