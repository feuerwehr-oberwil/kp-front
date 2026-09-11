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
  prewarmPlans: () => {},
  pdfWorkerUrl: () => null,
  // the chooser warms these the moment it opens (lib/georefSuggest reads them too)
  planMatcherImage: () => Promise.resolve(new Blob()),
  planPrintedMPerU: () => Promise.resolve(null),
}))
// Whether this SERVER can align automatically is a fact of the deployment, read synchronously
// off the config singleton — the rest of the module stays real.
const server = vi.hoisted(() => ({ autoAlign: true }))
vi.mock('../lib/deploymentConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/deploymentConfig')>()
  return {
    ...actual,
    getDeploymentConfig: () => ({
      ...actual.getDeploymentConfig(),
      integrations: { autoAlignConfigured: server.autoAlign },
    }),
  }
})

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
afterEach(() => { cleanup(); resetGeorefMode(); store.pairs = []; server.autoAlign = true })

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

/** `anchor` is the object/incident coordinate the CV matcher fetches its OSM buildings around;
 *  without one «Automatisch ausrichten» is not eligible whatever the server can do. */
const renderBoard = (activeId = 'modul2', readOnly = false, anchor: [number, number] | null = null) =>
  render(<>
    <Whiteboard
      plans={[modul, modul3, tafel]} activeId={activeId} annos={[]} onChange={() => {}}
      building={null} onSelectBuilding={() => {}} onAddFloor={() => {}} onRemoveFloor={() => {}}
      readOnly={readOnly} slimTools sym={sym} onRecent={() => {}} log={() => {}}
      hist={{}} setHist={() => {}} focus={null} georefAnchor={anchor}
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
      hist={{}} setHist={() => {}} focus={null} georefAnchor={null} planScale={planScale}
    />
    <Overlays />
  </>)

describe('the «Karte verknüpfen» chip', () => {
  it('offers the verb on a plan with no reference', () => {
    renderBoard()
    expect(screen.getByRole('button', { name: /Karte verknüpfen/ })).toBeTruthy()
  })

  it('never appears on a surface that cannot carry a reference (the Tafel)', () => {
    renderBoard('tafel')
    expect(screen.queryByRole('button', { name: /Karte verknüpfen/ })).toBeNull()
  })

  // ⚠️ The chip states ONE thing: that this sheet is tied to the map. The reading it used to
  // carry («Verknüpft · aus 2 Punkten», «Verknüpft · ⌀ 10.8 m») is a sentence in a row of
  // three-word pills, and a residual without «out of how many pairs» beside it means nothing.
  // The number lives in the Passung, one tap away, next to what to do about it.
  it('says «Verknüpft» and no more — the reading belongs to the Passung', () => {
    store.pairs = TWO
    renderBoard()
    expect(screen.getByText('Verknüpft')).toBeTruthy()
    expect(screen.queryByText(/aus 2 Punkten/)).toBeNull()
  })

  // «Ref. auto» is a reading, not a second calibration path — but a TAPPABLE one (29.08.): the
  // hover title never fires on the field iPad, so the chip explains itself the way «Verknüpft»
  // does, by opening the Passung. What it must never do is arm the manual scale calibration.
  it('uses the finished georeference as a scale reading that opens the Passung', () => {
    store.pairs = TWO
    renderBoard()
    const chip = screen.getByRole('button', { name: /Ref\. auto/ })
    expect(chip.getAttribute('title')).toContain('Ref. automatisch')
    fireEvent.click(chip)
    expect(screen.getByText('Passung')).toBeTruthy()
    expect(screen.queryByText('Zwei Punkte des Massstabs antippen')).toBeNull()
  })

  it('keeps georeference correction behind the separate linked-reference control', () => {
    store.pairs = TWO
    renderBoard()
    const reference = screen.getByRole('button', { name: 'Verknüpft' })
    expect(reference.getAttribute('title')).toBe('Referenz prüfen und korrigieren')
    fireEvent.click(reference)
    expect(screen.getByRole('button', { name: 'Dritten Punkt setzen' })).toBeTruthy()
  })

  it('keeps manual calibration available when no automatic reference scale exists', () => {
    renderBoard()
    fireEvent.click(screen.getByRole('button', { name: 'nicht kalibriert' }))
    expect(screen.getByText('Zwei Punkte des Massstabs antippen')).toBeTruthy()
  })

  it('offers to add points instead of claiming it will correct a calculated pair', () => {
    store.pairs = [...TWO, pair(0.5, 0.3, 7.5008, 47.4997)]
    renderBoard()
    fireEvent.click(screen.getByText('Verknüpft'))
    expect(screen.getByRole('button', { name: 'Punkte hinzufügen' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /korrigieren/ })).toBeNull()
  })

  it('arms the pairing mode, and the row then carries the instrument and nothing else', () => {
    renderBoard()
    fireEvent.click(screen.getByRole('button', { name: /Karte verknüpfen/ }))
    expect(georefSnapshot().planId).toBe('modul2')
    // the instruction has taken the chip's place — ONE indicator, where the finger already was.
    // The free-order sentence IS the instruction now: no per-point prompt, no fixed order.
    expect(screen.getByText(/Dieselbe Stelle auf Modul und Karte antippen/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Karte verknüpfen/ })).toBeNull()
    // ⚠️ «Schliessen», NOT «Abbrechen». Points are saved as they are placed, so leaving the mode
    // discards nothing — the word that promised otherwise is the bug this pins (27.08.).
    expect(screen.getByRole('button', { name: 'Schliessen' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Abbrechen' })).toBeNull()
  })

  // ⚠️ The feature the server may not HAVE. Its CV dependencies are an optional extra, and the
  // production image ships without them — the chooser then offered «Automatisch ausrichten» and
  // answered every press with «…ist auf diesem Server nicht eingerichtet», with nothing to turn
  // off (field report 09.09.2026). `/api/config` states the capability and the chip skips the
  // chooser entirely, exactly as on a sheet that was never eligible.
  it('offers the automatic path when the server can actually do it', () => {
    renderBoard('modul2', false, [7.5, 47.5])
    fireEvent.click(screen.getByRole('button', { name: /Karte verknüpfen/ }))
    expect(screen.getByRole('button', { name: /Automatisch ausrichten/ })).toBeTruthy()
    expect(georefSnapshot().planId).toBeNull() // the chooser first, nothing armed yet
  })

  it('never offers it on a server without the matcher — it arms the point flow instead', () => {
    server.autoAlign = false
    renderBoard('modul2', false, [7.5, 47.5])
    fireEvent.click(screen.getByRole('button', { name: /Karte verknüpfen/ }))
    expect(screen.queryByRole('button', { name: /Automatisch ausrichten/ })).toBeNull()
    expect(georefSnapshot().planId).toBe('modul2')
  })

  it('a viewer sees the reading but is given no way to arm it', () => {
    store.pairs = TWO
    renderBoard('modul2', true)
    const chip = screen.getByText('Verknüpft').closest('button')
    expect(chip?.disabled).toBe(true)
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

  it('shows the crosses with the Passung open — as inert marks, not as buttons', () => {
    store.pairs = TWO
    const { container } = renderBoard()
    fireEvent.click(screen.getByText('Verknüpft'))
    expect(screen.getByText('Passung')).toBeTruthy()
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
    fireEvent.click(screen.getByText('Verknüpft'))
    expect(container.querySelectorAll('[class*="qWarn"]')).toHaveLength(1)
    expect(screen.getByText(/auseinander/)).toBeTruthy() // the baseline, not the two-pairs note
  })

  it('returns to Passung when the transfer picker is cancelled', () => {
    store.pairs = TWO
    renderBoard()
    fireEvent.click(screen.getByText('Verknüpft'))
    fireEvent.click(screen.getByRole('button', { name: 'Übertragen' }))
    expect(screen.getByRole('heading', { name: /Passung übertragen/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }))
    expect(screen.getByText('Passung')).toBeTruthy()
  })

  it('keeps the transfer picker when replacing a linked target is cancelled', async () => {
    store.pairs = TWO
    renderBoard()
    fireEvent.click(screen.getByText('Verknüpft'))
    fireEvent.click(screen.getByRole('button', { name: 'Übertragen' }))
    fireEvent.click(screen.getByRole('button', { name: /Modul 3/ }))
    const confirm = await screen.findByRole('alertdialog')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Abbrechen' }))
    expect(await screen.findByRole('heading', { name: /Passung übertragen/ })).toBeTruthy()
    expect(screen.getByText('Passung')).toBeTruthy()
  })

  it('lets a confirmation consume Escape without closing its Passung parent', async () => {
    store.pairs = TWO
    renderBoard()
    fireEvent.click(screen.getByText('Verknüpft'))
    fireEvent.click(screen.getByRole('button', { name: 'Zurücksetzen' }))
    const confirm = await screen.findByRole('alertdialog')
    fireEvent.keyDown(confirm, { key: 'Escape' })
    expect(await screen.findByText('Passung')).toBeTruthy()
    expect(georefSnapshot().planId).toBeNull()
  })

  it('turns them back into controls the moment the mode is armed', () => {
    store.pairs = TWO
    const { container } = renderBoard()
    fireEvent.click(screen.getByText('Verknüpft'))
    fireEvent.click(screen.getByRole('button', { name: 'Dritten Punkt setzen' }))
    expect(georefSnapshot().planId).toBe('modul2')
    expect(capture(container)).not.toBeNull()
    expect(screen.getByRole('button', { name: /^Punkt 1 –/ })).toBeTruthy()
  })

  it('opens Deckung prüfen directly and keeps that action available with an unmatched point', () => {
    store.pairs = TWO
    renderBoard()
    fireEvent.click(screen.getByText('Verknüpft'))
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

  // ⚠️ The quality detail is behind the (i) — the status line stays one line, and the folded
  // card carries the pair count, the claimable ⌀ and the one instruction-shaped sentence.
  it('keeps the quality detail behind the (i), sticky once opened', () => {
    const previous = window.matchMedia
    window.matchMedia = ((q: string) => ({
      matches: q === PHONE_QUERY, media: q, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    try {
      act(() => georefDispatch({ type: 'start', planId: 'modul2', pairs: [], aspect: 1.5 }))
      render(<GeorefModeBars planLabel="Modul 2" />)
      expect(screen.queryByText('Zwei Punkte legen den Plan auf die Karte.')).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: 'Details zur Passung' }))
      expect(screen.getByText('Zwei Punkte legen den Plan auf die Karte.')).toBeTruthy()
    } finally {
      window.matchMedia = previous
    }
  })

  // A green lamp is the moment there is nothing left to ask for. «Punkt setzen» used to stay the
  // loud action through a measured, good fit, next to a «Fertig» in small text.
  it('makes «Fertig» the big action once the fit is measured and good', () => {
    const previous = window.matchMedia
    window.matchMedia = ((q: string) => ({
      matches: q === PHONE_QUERY, media: q, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    try {
      const three = [...TWO, pair(0.5, 0.3, 7.5008, 47.4997)]
      act(() => georefDispatch({ type: 'start', planId: 'modul2', pairs: three, aspect: 1.5 }))
      render(<GeorefModeBars planLabel="Modul 2" />)
      // …and adding a fourth is still there, one tap away, simply not what is being asked for
      const finish = screen.getByRole('button', { name: 'Fertig' })
      const add = screen.getByRole('button', { name: 'Punkt setzen' })
      expect(finish.className).toContain('primary')
      expect(add.className).not.toContain('primary')
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
describe('the Gebäude measures off its Grundriss, not off a hand calibration', () => {
  it('reads «Ref. auto» even with a stored calibration on the stack', () => {
    // ⚠️ `ar` must be the stack's own measure space (1 / TILE_AR) or isStale drops the
    // calibration before the precedence question is even asked — and the test proves nothing.
    renderStack({ gebaeude: { mPerU: 999, refM: 12, ar: 1 / TILE_AR } })
    expect(screen.getByRole('button', { name: /Ref\. auto/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /kalibrieren/i })).toBeNull()
  })

  it('names the Grundriss as the source — never the Kartenverknüpfung it has not got', () => {
    renderStack()
    const chip = screen.getByRole('button', { name: /Ref\. auto/ })
    expect(chip.getAttribute('title')).toBe('Ref. automatisch – Massstab aus dem Gebäudegrundriss')
  })

  // ⚠️ Deliberately still a button (29.08.): the hover title never fires on the field iPad, so the
  // tap is the only way to learn where the metres come from. What it must never do is arm a
  // manual calibration on top of the derived one.
  it('explains itself on tap without arming a calibration', () => {
    renderStack()
    fireEvent.click(screen.getByRole('button', { name: /Ref\. auto/ }))
    expect(screen.queryByText('Zwei Punkte des Massstabs antippen')).toBeNull()
  })
})
