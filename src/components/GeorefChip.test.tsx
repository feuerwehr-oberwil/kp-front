// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { BuildingDoc, PlanDocument } from '../types'
import type { SymbolsApi } from '../lib/useSymbols'
import type { GeorefPair } from '../lib/georef'

// The station document is a synchronous singleton fed by a boot fetch — stubbed so the surface
// can be rendered against a plan that IS georeferenced without a network anywhere near it.
const store = vi.hoisted(() => ({ pairs: [] as GeorefPair[] }))
vi.mock('../lib/stationPlanScale', () => ({
  georefForPlan: () => (store.pairs.length ? { pairs: store.pairs } : null),
  saveGeoref: vi.fn(() => Promise.resolve()),
  resolvePlanScale: () => undefined,
  getStationPlanScales: () => ({ default: null, byPlan: {}, georefByPlan: {} }),
  subscribeStationPlanScales: vi.fn(() => () => {}),
  refreshStationPlanScales: vi.fn(() => Promise.resolve()),
}))
// the PDF stack is the heaviest dependency in the app and irrelevant here
vi.mock('./PdfViewport', () => ({
  PdfViewport: () => <canvas />,
}))
vi.mock('../lib/pdfRaster', () => ({
  prewarmPlans: () => {},
  pdfWorkerUrl: () => null,
}))

import { Whiteboard } from './Whiteboard'
import { PHONE_QUERY } from '../lib/useIsPhone'
import { georefDispatch, georefSnapshot, registerGeorefPhoneTarget, resetGeorefMode } from '../lib/georefMode'
import { GeorefModeBars } from './GeorefMode'
import { Overlays } from '../lib/ui'
import { TILE_AR } from '../lib/whiteboard'

class RO { observe() {} unobserve() {} disconnect() {} }

beforeAll(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= RO
  // jsdom has neither pointer capture nor a layout engine — the capture layer needs both
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.releasePointerCapture ??= () => {}
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})
afterEach(() => { cleanup(); resetGeorefMode(); store.pairs = [] })

const modul: PlanDocument = {
  id: 'modul2', code: 'Modul 2', title: 'Übersicht', subtitle: '', imageUrl: 'modul2.pdf',
  orientation: 'landscape', georefKey: 'object:o1:plan:modul2',
}
const modul3: PlanDocument = {
  id: 'modul3', code: 'Modul 3', title: 'Detail', subtitle: '', imageUrl: 'modul3.pdf',
  orientation: 'landscape', georefKey: 'object:o1:plan:modul3',
}
const tafel: PlanDocument = {
  id: 'tafel', code: 'Tafel', title: 'Leeres Blatt', subtitle: '', imageUrl: '', orientation: 'landscape',
}
const gebaeude: PlanDocument = {
  id: 'gebaeude', code: 'Gebäude', title: 'Stockwerke', subtitle: '', imageUrl: '', orientation: 'portrait',
  floorStack: true,
}
/** a square footprint traced off the Geoportal: one src unit spans 40 m, so the stack's scale is
 *  derivable from geometry alone — no pairs, no residual, nothing anybody had to type in. */
const HAUS: BuildingDoc = {
  ring: [[0, 0], [1, 0], [1, 1], [0, 1]],
  rings: [[[0, 0], [1, 0], [1, 1], [0, 1]]],
  src: [[[0, 0], [1, 0], [1, 1], [0, 1]]],
  ringAspect: 1,
  floors: [0, 1],
  geo: { origin: [7.5, 47.5], spanM: 40 },
}
const sym: SymbolsApi = { ready: false, error: false, reload: () => {}, order: [], symbols: [], byName: {} }

const pair = (x: number, y: number, lng: number, lat: number): GeorefPair =>
  ({ plan: { x, y }, lngLat: { lng, lat }, kind: 'gesetzt' })
/** two references ~130 m apart — a solvable fit that is still «aus 2 Punkten» */
const TWO = [pair(0.2, 0.2, 7.5, 47.5), pair(0.8, 0.8, 7.5015, 47.4991)]

const renderBoard = (activeId = 'modul2', readOnly = false) =>
  render(<>
    <Whiteboard
      plans={[modul, modul3, tafel]} activeId={activeId} annos={[]} onChange={() => {}}
      building={null} onSelectBuilding={() => {}} onAddFloor={() => {}} onRemoveFloor={() => {}}
      readOnly={readOnly} slimTools sym={sym} onRecent={() => {}} log={() => {}}
      hist={{}} setHist={() => {}} focus={null}
    />
    <Overlays />
  </>)

/** the Gebäude floor-stack, optionally carrying a calibration somebody typed in by hand */
const renderStack = (planScale: Record<string, { mPerU: number; refM: number; ar: number }> = {}) =>
  render(<>
    <Whiteboard
      plans={[modul, gebaeude]} activeId="gebaeude" annos={[]} onChange={() => {}}
      building={HAUS} onSelectBuilding={() => {}} onAddFloor={() => {}} onRemoveFloor={() => {}}
      slimTools sym={sym} onRecent={() => {}} log={() => {}}
      hist={{}} setHist={() => {}} focus={null} planScale={planScale}
    />
    <Overlays />
  </>)

/** the bar's ONE chip (sweep 28.10.2026 #8): the Objekt, with the lamp, opening the Plan sheet */
const objectChip = () => screen.getByRole('button', { name: /Objekt, Karte und Massstab/ })
const openSheet = () => fireEvent.click(objectChip())
const sheet = () => screen.getByRole('group', { name: 'Plan · Modul 2' })
const fact = (name: RegExp) => within(sheet()).getByRole('region', { name })

describe('the Plan sheet behind the Objekt chip', () => {
  it('is the bar\'s only chip: no Massstab or Karte pills beside it, one lamp', () => {
    store.pairs = TWO
    const { container } = renderBoard()
    expect(container.querySelectorAll('.wb-botleft .wb-lamp')).toHaveLength(1)
    expect(screen.queryByText('Verknüpft')).toBeNull()
    expect(screen.queryByText('Ref. auto')).toBeNull()
    expect(objectChip().getAttribute('aria-expanded')).toBe('false')
  })

  it('offers «Karte verknüpfen» on a plan with no reference, and it arms the point flow', () => {
    renderBoard()
    openSheet()
    expect(within(fact(/^Karte: nicht verknüpft/)).getByText(/legt den Plan auf die Karte/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Karte verknüpfen' }))
    expect(georefSnapshot().planId).toBe('modul2')
    // the row carries the instrument and nothing else — ONE indicator, where the finger already
    // was. The free-order sentence IS the instruction: no per-point prompt, no fixed order.
    expect(screen.getByText(/Dieselbe Stelle auf Modul und Karte antippen/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Objekt, Karte und Massstab/ })).toBeNull()
    // ⚠️ «Schliessen», NOT «Abbrechen». Points are saved as they are placed, so leaving the mode
    // discards nothing — the word that promised otherwise is the bug this pins (27.08.).
    expect(screen.getByRole('button', { name: 'Schliessen' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Abbrechen' })).toBeNull()
  })

  it('never appears on a surface that cannot carry a reference (the Tafel)', () => {
    renderBoard('tafel')
    expect(screen.queryByRole('button', { name: /Objekt, Karte und Massstab/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Karte verknüpfen/ })).toBeNull()
  })

  // A linked sheet shows the Passung INLINE under «Karte» – no drill-down (owner, 28.10.)
  it('shows a linked plan\'s Passung inline, with its actions', () => {
    store.pairs = TWO
    renderBoard()
    openSheet()
    const karte = fact(/^Karte: Verknüpft/)
    expect(within(karte).getByText('aus 2 Punkten')).toBeTruthy()
    expect(within(karte).getByRole('button', { name: 'Dritten Punkt setzen' })).toBeTruthy()
    expect(within(karte).getByRole('button', { name: 'Deckung prüfen' })).toBeTruthy()
    expect(within(karte).getByRole('button', { name: 'Zurücksetzen' })).toBeTruthy()
  })

  it('offers to add points instead of claiming it will correct a calculated pair', () => {
    store.pairs = [...TWO, pair(0.5, 0.3, 7.5008, 47.4997)]
    renderBoard()
    openSheet()
    expect(screen.getByRole('button', { name: 'Punkte hinzufügen' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /korrigieren/ })).toBeNull()
  })

  // «Ref. auto» is a READING: the metres come from the link, and the sheet must never offer a
  // second, competing manual calibration on top of it
  it('reads the scale off the link and offers no calibration on top of it', () => {
    store.pairs = TWO
    renderBoard()
    openSheet()
    const massstab = fact(/^Massstab: Ref\. auto/)
    expect(within(massstab).getByText(/aus der Kartenverknüpfung/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /kalibrieren/i })).toBeNull()
  })

  // the hand calibration is a tap away in the sheet (and through Messen, as ever); calibrating,
  // the row is the instrument and a tap on it stops
  it('calibrates by hand from the sheet, the row carrying the instruction meanwhile', () => {
    renderBoard()
    openSheet()
    expect(fact(/^Massstab: nicht kalibriert/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Massstab kalibrieren' }))
    expect(screen.queryByRole('group', { name: 'Plan · Modul 2' })).toBeNull()
    const instrument = screen.getByRole('button', { name: 'Zwei Punkte des Massstabs antippen' })
    fireEvent.click(instrument)
    expect(screen.queryByRole('button', { name: 'Zwei Punkte des Massstabs antippen' })).toBeNull()
    expect(objectChip()).toBeTruthy()
  })

  it('keeps the hand calibration reachable through Messen too', () => {
    renderBoard()
    fireEvent.click(screen.getAllByRole('button', { name: 'Messen' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Massstab kalibrieren' }))
    expect(screen.getAllByText('Zwei Punkte des Massstabs antippen').length).toBeGreaterThan(0)
  })

  // A locked session (el, Führungsansicht, viewer, replay) keeps the READING — tone and words —
  // with none of the actions: an unchecked automatic fit must never look like a checked one.
  it('a locked session reads the sheet but is given no way to change it', () => {
    store.pairs = TWO
    renderBoard('modul2', true)
    openSheet()
    expect(fact(/^Karte: Verknüpft/)).toBeTruthy()
    expect(fact(/^Massstab: Ref\. auto/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Dritten Punkt setzen' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Zurücksetzen' })).toBeNull()
    expect(screen.queryByRole('button', { name: /kalibrieren/i })).toBeNull()
  })
})

// ⚠️ The regression this file exists for. A cross is a 26px glyph with a 44px touch pad sitting
// above every annotation; when the mode is NOT armed it must be a mark, never a control, or the
// plan's own symbols stop responding to taps wherever a reference happens to be.
describe('an idle georeference never intercepts the board', () => {
  const capture = (c: HTMLElement) => c.querySelector('[class*="capture"]')
  const crosses = (c: HTMLElement) => c.querySelectorAll('[class*="cross"]')

  it('draws no capture layer and no crosses at all while the chip is closed', () => {
    store.pairs = TWO
    const { container } = renderBoard()
    expect(capture(container)).toBeNull()
    expect(crosses(container)).toHaveLength(0)
  })

  it('shows the crosses with the sheet open — as inert marks, not as buttons', () => {
    store.pairs = TWO
    const { container } = renderBoard()
    openSheet()
    expect(sheet()).toBeTruthy()
    // …and THERE the reading is spelled out, once
    expect(screen.getByText('aus 2 Punkten')).toBeTruthy()
    expect(crosses(container)).toHaveLength(2)
    // no cross is focusable, tappable or announced — and still no capture layer over the sheet
    expect(screen.queryByRole('button', { name: /^Punkt 1 –/ })).toBeNull()
    expect(capture(container)).toBeNull()
    for (const el of crosses(container)) expect(el.tagName).toBe('SPAN')
  })

  // ⚠️ ONE warning box, never a stack. Two pairs a few metres apart raise BOTH «zwei Paare lösen
  // exakt» and «die Punkte liegen nur x m auseinander»; the panel is four lines tall and two
  // amber blocks under it are a wall nobody reads. The one that can be ACTED on wins.
  it('shows a single warning even when several stand', () => {
    store.pairs = [pair(0.2, 0.2, 7.5, 47.5), pair(0.24, 0.22, 7.50004, 47.49997)]
    const { container } = renderBoard()
    openSheet()
    expect(container.querySelectorAll('[class*="qWarn"]')).toHaveLength(1)
    expect(screen.getByText(/auseinander/)).toBeTruthy() // the baseline, not the two-pairs note
  })

  it('returns to Passung when the transfer picker is cancelled', () => {
    store.pairs = TWO
    renderBoard()
    openSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Übertragen' }))
    expect(screen.getByRole('heading', { name: /Passung übertragen/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }))
    expect(sheet()).toBeTruthy()
  })

  it('keeps the transfer picker when replacing a linked target is cancelled', async () => {
    store.pairs = TWO
    renderBoard()
    openSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Übertragen' }))
    fireEvent.click(screen.getByRole('button', { name: /Modul 3/ }))
    const confirm = await screen.findByRole('alertdialog')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Abbrechen' }))
    expect(await screen.findByRole('heading', { name: /Passung übertragen/ })).toBeTruthy()
    // under the open picker the sheet is aria-hidden, so it is found by its words, not its role
    expect(screen.getByText('Plan · Modul 2')).toBeTruthy()
  })

  it('lets a confirmation consume Escape without closing its Passung parent', async () => {
    store.pairs = TWO
    renderBoard()
    openSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Zurücksetzen' }))
    const confirm = await screen.findByRole('alertdialog')
    fireEvent.keyDown(confirm, { key: 'Escape' })
    expect(await screen.findByRole('group', { name: 'Plan · Modul 2' })).toBeTruthy()
    expect(georefSnapshot().planId).toBeNull()
  })

  it('turns them back into controls the moment the mode is armed', () => {
    store.pairs = TWO
    const { container } = renderBoard()
    openSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Dritten Punkt setzen' }))
    expect(georefSnapshot().planId).toBe('modul2')
    expect(capture(container)).not.toBeNull()
    expect(screen.getByRole('button', { name: /^Punkt 1 –/ })).toBeTruthy()
  })

  it('opens Deckung prüfen directly and keeps that action available with an unmatched point', () => {
    store.pairs = TWO
    renderBoard()
    openSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Deckung prüfen' }))
    expect(georefSnapshot().check).toBe(true)

    act(() => georefDispatch({ type: 'check', on: false }))
    act(() => georefDispatch({ type: 'planTap', pt: { x: 0.4, y: 0.4 } }))
    expect(georefSnapshot().slots.filter((sl) => !sl.map)).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Deckung prüfen' })).toBeTruthy()
  })
})

describe('leaving Deckung prüfen', () => {
  it('uses the coverage return path on Escape instead of abandoning its parent', () => {
    georefDispatch({ type: 'start', planId: 'modul2', pairs: TWO, aspect: 1.5, check: true, returnToQuality: true })
    render(<GeorefModeBars />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(georefSnapshot().check).toBe(false)
    expect(georefSnapshot().checkReturn).toBe('quality')
    expect(georefSnapshot().planId).toBe('modul2')
  })
})

describe('the phone can start a pair on either surface', () => {
  it('commits the fixed Plan target only through the explicit action', () => {
    const previous = window.matchMedia
    window.matchMedia = ((q: string) => ({
      matches: q === PHONE_QUERY, media: q, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    try {
      act(() => georefDispatch({ type: 'start', planId: 'modul2', pairs: [], aspect: 1.5 }))
      const unregister = registerGeorefPhoneTarget('plan', () => ({ x: 0.45, y: 0.35 }))
      render(<GeorefModeBars planLabel="Modul 2" />)
      fireEvent.click(screen.getByRole('button', { name: 'Punkt setzen' }))
      expect(georefSnapshot().slots).toEqual([{ plan: { x: 0.45, y: 0.35 }, kind: 'gesetzt' }])
      unregister()
    } finally {
      window.matchMedia = previous
    }
  })

  // ⚠️ The steps live behind the STATUS (sweep 27.10.2026 #13, the owner's pick «A»): the slim
  // bar is one row, and the status «0/2 Paare ⓘ» opens exactly what to do, naming the plan.
  it('opens the steps behind the status, naming the plan, sticky once opened', () => {
    const previous = window.matchMedia
    window.matchMedia = ((q: string) => ({
      matches: q === PHONE_QUERY, media: q, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    try {
      act(() => georefDispatch({ type: 'start', planId: 'modul2', pairs: [], aspect: 1.5 }))
      render(<GeorefModeBars planLabel="Wasser" />)
      expect(screen.queryByText(/dieselbe Stelle unter das Fadenkreuz/)).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: /^0\/2 Paare – So wird verknüpft/ }))
      expect(screen.getByText(/auf «Wasser» unter das Fadenkreuz/)).toBeTruthy()
      expect(screen.getByText(/dieselbe Stelle unter das Fadenkreuz/)).toBeTruthy()
      // a point placed does not snap the steps shut
      const unregister = registerGeorefPhoneTarget('plan', () => ({ x: 0.45, y: 0.35 }))
      fireEvent.click(screen.getByRole('button', { name: 'Punkt setzen' }))
      expect(screen.getByText(/dieselbe Stelle unter das Fadenkreuz/)).toBeTruthy()
      unregister()
    } finally {
      window.matchMedia = previous
    }
  })

  // «Schliessen» turns into «Fertig» the moment two pairs stand; «+» stays one tap away for the
  // optional third point the steps offer as a check.
  it('turns the exit into «Fertig» once two pairs link the plan', () => {
    const previous = window.matchMedia
    window.matchMedia = ((q: string) => ({
      matches: q === PHONE_QUERY, media: q, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    try {
      act(() => georefDispatch({ type: 'start', planId: 'modul2', pairs: TWO, aspect: 1.5 }))
      render(<GeorefModeBars planLabel="Modul 2" />)
      expect(screen.getByRole('button', { name: /^2\/2 Verknüpft/ })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Fertig' }))
      expect(georefSnapshot().planId).toBeNull()
    } finally {
      window.matchMedia = previous
    }
  })

  it('switches to Karte before any Modul point exists and records a map-first half', () => {
    const previous = window.matchMedia
    window.matchMedia = ((q: string) => ({
      matches: q === PHONE_QUERY, media: q, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    try {
      act(() => georefDispatch({ type: 'start', planId: 'modul2', pairs: [], aspect: 1.5 }))
      render(<GeorefModeBars planLabel="Modul 2" />)
      const switcher = screen.getByRole('group', { name: /Karte verknüpfen/ })
      fireEvent.click(within(switcher).getByRole('button', { name: 'Karte' }))
      expect(georefSnapshot().want).toBe('map')
      const unregister = registerGeorefPhoneTarget('map', () => ({ lng: 7.5, lat: 47.5 }))
      fireEvent.click(screen.getByRole('button', { name: 'Punkt setzen' }))
      expect(georefSnapshot().slots).toEqual([{ map: { lng: 7.5, lat: 47.5 }, kind: 'gesetzt' }])
      unregister()
    } finally {
      window.matchMedia = previous
    }
  })
})

// ⚠️ The rule the whole armed mode stands on: a TAP places a point, and everything else pans the
// sheet exactly as it does with no mode running. The pure fold is covered in
// lib/georefMode.test.ts; this drives the real capture layer, because the bug that prompted it
// («pan a few hundred px, release, get a point you never asked for») lives in the wiring.
describe('the armed plan surface places on a tap and pans on a drag', () => {
  const BOARD = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) }

  const arm = () => {
    const r = renderBoard()
    openSheet()
    fireEvent.click(screen.getByRole('button', { name: /Karte verknüpfen/ }))
    const board = r.container.querySelector('.wb-board') as HTMLElement
    board.getBoundingClientRect = () => BOARD as DOMRect
    const capture = r.container.querySelector('[class*="capture"]') as HTMLElement
    return { ...r, capture }
  }
  const at = (x: number, y: number) => ({ pointerId: 1, clientX: x, clientY: y, isPrimary: true })

  it('a desktop still tap opens a point and leaves the sheet in front of the operator', () => {
    const { capture } = arm()
    fireEvent.pointerDown(capture, at(400, 300))
    fireEvent.pointerUp(capture, at(401, 301))
    expect(georefSnapshot().slots).toEqual([{ plan: { x: 401 / 800, y: 301 / 600 }, kind: 'gesetzt' }])
    // ⚠️ NOT 'map'. The mode used to send the phone to the map after every single plan tap;
    // the queue is what replaced that, and the hop is a button now (copy · georef.goMap).
    expect(georefSnapshot().want).toBe('plan')
  })

  it('a phone tap only aims or pans; it never commits without Punkt setzen', () => {
    const previous = window.matchMedia
    window.matchMedia = ((q: string) => ({
      matches: q === PHONE_QUERY, media: q, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    try {
      const { capture } = arm()
      fireEvent.pointerDown(capture, at(400, 300))
      fireEvent.pointerUp(capture, at(400, 300))
      expect(georefSnapshot().slots).toEqual([])
    } finally {
      cleanup()
      window.matchMedia = previous
    }
  })

  it('a pan places nothing — not even one that ends exactly where it started', () => {
    const { capture } = arm()
    fireEvent.pointerDown(capture, at(400, 300))
    for (const x of [430, 520, 640, 700, 520, 400]) fireEvent.pointerMove(capture, at(x, 300))
    fireEvent.pointerUp(capture, at(400, 300))
    expect(georefSnapshot().slots).toEqual([])
    expect(georefSnapshot().planId).toBe('modul2') // …and the mode is still armed
  })

  it('a two-finger gesture places nothing, however still the first finger was', () => {
    const { capture } = arm()
    fireEvent.pointerDown(capture, at(400, 300))
    fireEvent.pointerDown(capture, { pointerId: 2, clientX: 500, clientY: 300 })
    fireEvent.pointerUp(capture, { pointerId: 2, clientX: 500, clientY: 300 })
    fireEvent.pointerUp(capture, at(400, 300))
    expect(georefSnapshot().slots).toEqual([])
  })

  it('places point after point without re-arming — the third one has to be cheap', () => {
    const { capture } = arm()
    for (const x of [200, 600, 400]) {
      fireEvent.pointerDown(capture, at(x, 300))
      fireEvent.pointerUp(capture, at(x, 300))
      expect(georefSnapshot().slots.filter((sl) => !sl.map)).toHaveLength(1)
      // the map half of the pair, dispatched the way the map surface would
      georefDispatch({ type: 'mapTap', lngLat: { lng: 7.5 + x / 100000, lat: 47.5 } })
    }
    expect(georefSnapshot().pairs).toHaveLength(3)
    expect(georefSnapshot().planId).toBe('modul2')
  })

  it('ignores a tap on the grey around the sheet — only the plan can carry a reference', () => {
    const { capture } = arm()
    fireEvent.pointerDown(capture, at(900, 300))
    fireEvent.pointerUp(capture, at(900, 300))
    expect(georefSnapshot().slots).toEqual([])
  })
})

// The Gebäude was traced off a footprint that arrived WITH its ground size (geo.spanM, from the
// Geoportal), so its metres are measured rather than believed. A stored hand calibration used to
// outrank that — and the one document that never needs calibrating was the one offering
// «Neu kalibrieren». (11.09.)
// ⚠️ The row on a phone is ONE line (owner, 18.09.2026), and since sweep 28.10.2026 (#8) it holds
// ONE lamp for link and scale together. If that lamp ever goes missing, or claims green while the
// sheet behind it is amber, a phone operator cannot tell a measured sheet from an unreferenced one.
describe('the Objekt chip\'s lamp — the worse of Karte and Massstab', () => {
  const lamp = (el: HTMLElement) => el.querySelector('.wb-lamp')?.getAttribute('data-tone')
  const factLamp = (name: RegExp) => lamp(fact(name))

  // sweep K10 (29.09.2026): «not yet» is grey, never red at rest
  it('is grey while the sheet has neither scale nor reference', () => {
    renderBoard()
    expect(lamp(objectChip())).toBe('grey')
  })

  // two pairs solve EXACTLY, so the fit is unmeasured — and the scale derived from it inherits
  // that doubt rather than presenting itself as measured metres
  it('goes amber once an unchecked two-point fit stands — and so do both facts in the sheet', () => {
    store.pairs = TWO
    renderBoard()
    expect(lamp(objectChip())).toBe('amber')
    openSheet()
    expect(factLamp(/^Karte:/)).toBe('amber')
    expect(factLamp(/^Massstab:/)).toBe('amber')
  })

  it('goes green once a third point has measured the fit', () => {
    store.pairs = [...TWO, pair(0.5, 0.3, 7.5008, 47.4997)]
    renderBoard()
    expect(lamp(objectChip())).toBe('green')
  })

  // the words are not on the bar any more, so they have to survive where a screen reader can reach
  it('keeps what the lamp is about in the chip\'s label', () => {
    renderBoard()
    expect(objectChip().getAttribute('aria-label')).toBe('Kein Objekt – Objekt, Karte und Massstab')
  })
})

describe('the Gebäude measures off its Grundriss, not off a hand calibration', () => {
  const buildingChip = () => screen.getByRole('button', { name: /Gebäude und Massstab/ })
  const stackSheet = () => { fireEvent.click(buildingChip()); return screen.getByRole('group', { name: 'Plan · Gebäude' }) }

  it('carries the lamp on the building chip, green: the scale is its own footprint', () => {
    renderStack()
    expect(buildingChip().querySelector('.wb-lamp')?.getAttribute('data-tone')).toBe('green')
  })

  it('has no Karte section, and names the Grundriss as the scale\'s source', () => {
    renderStack()
    const sh = stackSheet()
    expect(within(sh).queryByRole('region', { name: /^Karte:/ })).toBeNull()
    const massstab = within(sh).getByRole('region', { name: /^Massstab: Ref\. auto/ })
    expect(within(massstab).getByText(/aus dem Gebäudegrundriss/)).toBeTruthy()
  })

  it('reads «Ref. auto» even with a stored calibration on the stack, and offers no calibration', () => {
    // ⚠️ `ar` must be the stack's own measure space (1 / TILE_AR) or isStale drops the
    // calibration before the precedence question is even asked — and the test proves nothing.
    renderStack({ gebaeude: { mPerU: 999, refM: 12, ar: 1 / TILE_AR } })
    const sh = stackSheet()
    expect(within(sh).getByRole('region', { name: /^Massstab: Ref\. auto/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /kalibrieren/i })).toBeNull()
  })
})
