// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { BoardAnno, BuildingDoc, PlanDocument } from '../types'
import type { SymbolsApi } from '../lib/useSymbols'

// The OSM sheet fetches live footprints from the backend; the surface's CONTRACT is what is
// under test, so the outline component is stubbed down to the one thing it does — report how it
// was armed, and hand a picked footprint back.
const osm = vi.hoisted(() => ({ calls: [] as { interactive?: boolean }[] }))
const lastArmed = () => osm.calls[osm.calls.length - 1]?.interactive
vi.mock('./OsmOutline', () => ({
  OsmOutline: (p: { interactive?: boolean; onPick?: (src: [number, number][][], deg: number) => void }) => {
    osm.calls.push({ interactive: p.interactive })
    return <button onClick={() => p.onPick?.([[[0, 0], [1, 0], [1, 1]]], 0)}>Umriss</button>
  },
  prefetchOutlines: () => {},
}))

import { Whiteboard } from './Whiteboard'

class RO { observe() {} unobserve() {} disconnect() {} }

beforeAll(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= RO
  // jsdom has no matchMedia; pinned to «not a phone» (the rail is a side rail, not a bottom bar).
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})
afterEach(() => { cleanup(); osm.calls.length = 0 })

const umrisse: PlanDocument = {
  id: 'osm', code: 'Umrisse', title: 'Gebäudeumrisse', subtitle: '', imageUrl: '',
  orientation: 'landscape', osm: { center: [7.6, 47.5], radiusM: 250 },
}
const tafel: PlanDocument = {
  id: 'tafel', code: 'Tafel', title: 'Leeres Blatt', subtitle: '', imageUrl: '', orientation: 'landscape',
}
const sym: SymbolsApi = { ready: false, order: [], symbols: [], byName: {} }
// an annotation somebody drew on the Umrisse sheet BEFORE it became selection-only
const oldNote: BoardAnno = { id: 'a1', kind: 'text', x: 0.4, y: 0.4, floor: 0, text: 'Alte Notiz' }

const gebaeudeDoc: PlanDocument = {
  id: 'gebaeude', code: 'Gebäude', title: 'Geschosse (Skizze)', subtitle: '', imageUrl: '',
  orientation: 'portrait', icon: 'floors', floorStack: true,
}
const aBuilding: BuildingDoc = {
  ring: [[0, 0], [1, 0], [1, 1], [0, 1]], ringAspect: 1, floors: [0],
}

const renderBoard = (activeId: string, annos: BoardAnno[] = [], readOnly = false, building: BuildingDoc | null = null) => {
  const onSelectBuilding = vi.fn()
  const onBuildingFace = vi.fn()
  render(<Whiteboard
    plans={[umrisse, gebaeudeDoc, tafel]}
    activeId={activeId}
    annos={annos}
    onChange={() => {}}
    building={building}
    onSelectBuilding={onSelectBuilding}
    onBuildingFace={onBuildingFace}
    onAddFloor={() => {}}
    onRemoveFloor={() => {}}
    readOnly={readOnly}
    slimTools
    sym={sym}
    onRecent={() => {}}
    log={() => {}}
    hist={{}}
    setHist={() => {}}
    focus={null}
  />)
  return { onSelectBuilding, onBuildingFace }
}

// «Umrisse» exists to pick the building that becomes the Gebäude view. A tool that could only
// annotate a live OSM backdrop is a tool that lies, so the whole drawing apparatus is gone here —
// deliberately NOT the Lage↔Plan parity the other plan surfaces keep.
describe('the Umrisse surface', () => {
  const CREATE_TOOLS = ['Linie', 'Fläche', 'Notiz', 'Trupp', 'Mehrfach']

  it('offers no tool at all — not even the read-only Auswahl · Messen rail', () => {
    renderBoard('osm')
    for (const label of [...CREATE_TOOLS, 'Auswahl', 'Messen']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull()
    }
  })

  it('keeps every tool on the Tafel — the rail is missing because of the SURFACE, not the build', () => {
    renderBoard('tafel')
    for (const label of CREATE_TOOLS) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy()
    }
  })

  it('still picks a building — the one interaction the sheet is for', () => {
    const { onSelectBuilding } = renderBoard('osm')
    expect(lastArmed()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Umriss' }))
    expect(onSelectBuilding).toHaveBeenCalled()
  })

  it('does not pick for a locked/viewer session — that pick would rewrite the Gebäude', () => {
    renderBoard('osm', [], true)
    expect(lastArmed()).toBe(false)
  })

  it('still renders what was drawn here before the rule — the board is a synced document', () => {
    renderBoard('osm', [oldNote])
    expect(screen.getByText('Alte Notiz')).toBeTruthy()
  })
})

// ── The ONE «Gebäude» tile ──────────────────────────────────────────────────────────────────
// The rail lists the outline picker and the floor stack as one entry that morphs, so the way
// from one face to the other is a chip in the bottom-left row — and it exists exactly where
// there is somewhere to go. A door onto nothing would be worse than no door.
describe('the door between the two faces of the Gebäude tile', () => {
  const OTHER = 'Anderes Gebäude wählen'
  const BACK = 'Zurück zum Gebäude'

  it('offers no way back while no building has been picked yet', () => {
    renderBoard('osm')
    expect(screen.queryByRole('button', { name: OTHER })).toBeNull()
    expect(screen.queryByRole('button', { name: BACK })).toBeNull()
  })

  it('sends the floor stack to the picker', () => {
    const { onBuildingFace } = renderBoard('gebaeude', [], false, aBuilding)
    fireEvent.click(screen.getByRole('button', { name: OTHER }))
    expect(onBuildingFace).toHaveBeenCalledWith('pick')
  })

  it('sends the picker back to the stack it already has', () => {
    const { onBuildingFace } = renderBoard('osm', [], false, aBuilding)
    fireEvent.click(screen.getByRole('button', { name: BACK }))
    expect(onBuildingFace).toHaveBeenCalledWith('stack')
  })

  // Pure navigation between two surfaces — it mutates nothing, so a locked/viewer session keeps it.
  it('stays for a locked session', () => {
    renderBoard('gebaeude', [], true, aBuilding)
    expect(screen.getByRole('button', { name: OTHER })).toBeTruthy()
  })
})
