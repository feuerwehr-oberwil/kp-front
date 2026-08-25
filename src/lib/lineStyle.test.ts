import { describe, expect, it } from 'vitest'
import { resolveLinePreset, vertexHandleIndices, evenIndices, rdpIndices, FREEHAND_SIMPLIFY_PX, MAX_VERTEX_HANDLES, HANDLE_MIN_SPACING_PX } from './lineStyle'

// resolveLinePreset is the ONE preset bundle both drawing surfaces (Lage map + Plan whiteboard)
// apply — this pins the coercion so they can't drift. The default presets are the app's stock
// freihand / pfeil / rettungsachse (appConfig.drawing.linePresets).
describe('resolveLinePreset', () => {
  it('clears arrow/marker/distance for Freihand (empty flags → undefined, not false/"")', () => {
    // switching back to Freihand must REMOVE a previous preset's arrow/marker, not persist falsy noise
    expect(resolveLinePreset('freihand')).toEqual({
      arrow: undefined,
      marker: undefined,
      showDistance: undefined,
      dashed: undefined,
    })
  })

  it('sets the arrow for Pfeil and leaves marker/distance cleared', () => {
    const p = resolveLinePreset('pfeil')
    expect(p.arrow).toBe(true)
    expect(p.marker).toBeUndefined()
    expect(p.showDistance).toBeUndefined()
    expect(p.dashed).toBe(false)
  })

  it('carries the R marker + dash for Rettungsachse', () => {
    const p = resolveLinePreset('rettungsachse')
    expect(p.arrow).toBe(true)
    expect(p.marker).toBe('R')
    expect(p.dashed).toBe(true)
  })

  it('falls back to the current dash when the preset does not own dashed (Freihand)', () => {
    // Freihand carries no `dashed`, so the line/dock value is kept…
    expect(resolveLinePreset('freihand', true).dashed).toBe(true)
    expect(resolveLinePreset('freihand', false).dashed).toBe(false)
    // …but a preset that DOES own dashed wins over the current value
    expect(resolveLinePreset('rettungsachse', false).dashed).toBe(true)
    expect(resolveLinePreset('pfeil', true).dashed).toBe(false)
  })

  it('defaults unknown ids to the first preset (Freihand)', () => {
    expect(resolveLinePreset('nope')).toEqual(resolveLinePreset('freihand'))
  })
})

// The vertex-handle cap. Before 25.08. it was a hard switch — a line above MAX_VERTEX_HANDLES
// points showed NO grips at all, so a 66-point freehand «Zeichnung» could not be reshaped. These
// pin the graceful version: a subset that keeps both ends, never crowds two pads together, and
// grows as the surface is zoomed in (the input is pixel space, so zoom IS the spacing).
describe('vertexHandleIndices', () => {
  /** a straight horizontal path of `n` points, `step` px apart */
  const path = (n: number, step: number): [number, number][] =>
    Array.from({ length: n }, (_, i) => [i * step, 0])

  it('leaves an ordinary node line completely untouched', () => {
    expect(vertexHandleIndices(path(6, 40))).toEqual([0, 1, 2, 3, 4, 5])
    // exactly at the budget is still every point
    expect(vertexHandleIndices(path(MAX_VERTEX_HANDLES, 40))).toHaveLength(MAX_VERTEX_HANDLES)
  })

  it('still offers handles above the budget (the regression) — ends included', () => {
    const idx = vertexHandleIndices(path(66, 40))
    expect(idx.length).toBeGreaterThan(1)
    expect(idx.length).toBeLessThanOrEqual(MAX_VERTEX_HANDLES)
    expect(idx[0]).toBe(0)
    expect(idx[idx.length - 1]).toBe(65)
  })

  it('never shows two pads closer than the minimum spacing', () => {
    const px = path(66, 40)
    const idx = vertexHandleIndices(px)
    for (let k = 1; k < idx.length - 1; k++) {
      const [ax] = px[idx[k - 1]], [bx] = px[idx[k]]
      expect(Math.abs(bx - ax)).toBeGreaterThanOrEqual(HANDLE_MIN_SPACING_PX)
    }
  })

  it('densifies as the surface is zoomed in and thins as it is zoomed out', () => {
    // the SAME 66-point stroke, drawn at three zoom levels (px spacing 2 / 10 / 40)
    const far = vertexHandleIndices(path(66, 2)).length
    const mid = vertexHandleIndices(path(66, 10)).length
    const near = vertexHandleIndices(path(66, 40)).length
    expect(far).toBeLessThan(mid)
    expect(mid).toBeLessThan(near)
    expect(near).toBeLessThanOrEqual(MAX_VERTEX_HANDLES)
  })

  it('caps a long line at the budget even when every point is far apart', () => {
    expect(vertexHandleIndices(path(500, 500)).length).toBeLessThanOrEqual(MAX_VERTEX_HANDLES)
  })

  it('returns ascending, unique indices', () => {
    const idx = vertexHandleIndices(path(200, 3))
    expect([...new Set(idx)]).toEqual(idx)
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
  })
})

describe('evenIndices', () => {
  it('is identity below the count and keeps both ends above it', () => {
    expect(evenIndices(5, 10)).toEqual([0, 1, 2, 3, 4])
    const idx = evenIndices(100, 5)
    expect(idx).toEqual([0, 25, 50, 74, 99])
  })

  it('handles the degenerate sizes', () => {
    expect(evenIndices(0)).toEqual([])
    expect(evenIndices(1)).toEqual([0])
  })
})

/**
 * Freihand-Vereinfachung — was beim Loslassen eines Strichs passiert (useMapCanvasGestures ·
 * Whiteboard.inkUp). Ein von Hand gezogener Schlauch kommt als ~66 Punkte an: ein Sample pro
 * Pointer-Event, mit Zittern auf jedem und dichten Klumpen dort, wo der Finger kurz zögert –
 * also fast immer am Anfang und am Ende. Als Geometrie ist das brauchbar, als BEDIENBARE Linie
 * nicht: die Knoten liegen übereinander, und keiner davon lässt sich einzeln greifen.
 */
const jitteryStroke = (): [number, number][] => {
  // ein deterministischer «Handstrich»: langes Bein, Knick, zweites Bein, ±1.5 px Zittern und
  // ease-in/ease-out-Tempo, damit an beiden Enden echte Klumpen entstehen
  let seed = 7
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5 }
  return Array.from({ length: 66 }, (_, i) => {
    const u = i / 65, s = u * u * (3 - 2 * u)
    const x = s < 0.5 ? s * 2 * 220 : 220 + (s - 0.5) * 2 * 30
    const y = s < 0.5 ? 40 + s * 2 * 20 : 60 + (s - 0.5) * 2 * 180
    return [x + rnd() * 3, y + rnd() * 3] as [number, number]
  })
}
/** Grösster Abstand eines Rohpunkts von der vereinfachten Linie — die eigentliche Zusage von RDP. */
const maxDeviation = (raw: [number, number][], kept: [number, number][]) => Math.max(...raw.map(([px, py]) => {
  let best = Infinity
  for (let i = 1; i < kept.length; i++) {
    const [ax, ay] = kept[i - 1], [bx, by] = kept[i]
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-12
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2))
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)))
  }
  return best
}))
const polyLength = (p: [number, number][]) => p.reduce((a, _, i) => (i ? a + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]) : 0), 0)

describe('rdpIndices — Freihand-Vereinfachung', () => {
  it('keeps the ends and everything of a line that is already sparse', () => {
    expect(rdpIndices([], 3)).toEqual([])
    expect(rdpIndices([[0, 0]], 3)).toEqual([0])
    expect(rdpIndices([[0, 0], [10, 0]], 3)).toEqual([0, 1])
    // a point sitting ON the straight run is redundant; both ends never are
    expect(rdpIndices([[0, 0], [5, 0], [10, 0]], 3)).toEqual([0, 2])
  })

  it('turns a 66-point hand-drawn stroke into a handful of grabbable nodes', () => {
    const raw = jitteryStroke()
    const kept = rdpIndices(raw, FREEHAND_SIMPLIFY_PX).map((i) => raw[i])
    expect(raw.length).toBe(66)
    expect(kept.length).toBeLessThanOrEqual(8)      // was 66 pads piled on each other
    expect(kept.length).toBeGreaterThanOrEqual(3)   // the bend survives — it IS the shape
    expect(kept[0]).toEqual(raw[0])
    expect(kept[kept.length - 1]).toEqual(raw[raw.length - 1])
  })

  it('stays within the tolerance it promises, so the drawn shape still reads true', () => {
    const raw = jitteryStroke()
    const kept = rdpIndices(raw, FREEHAND_SIMPLIFY_PX).map((i) => raw[i])
    expect(maxDeviation(raw, kept)).toBeLessThanOrEqual(FREEHAND_SIMPLIFY_PX)
    // the measured length moves a little — cutting the tremor out shortens the path. A couple of
    // percent on a 400 px stroke is the tremor, not the hose.
    expect(polyLength(kept) / polyLength(raw)).toBeGreaterThan(0.94)
    expect(polyLength(kept) / polyLength(raw)).toBeLessThanOrEqual(1)
  })

  it('trades points for tolerance monotonically — a bigger epsilon never keeps more', () => {
    const raw = jitteryStroke()
    const counts = [1, 2, 3.5, 6].map((eps) => rdpIndices(raw, eps).length)
    expect(counts).toEqual([...counts].sort((a, b) => b - a))
    expect(counts[0]).toBeGreaterThan(counts[counts.length - 1])
  })
})
