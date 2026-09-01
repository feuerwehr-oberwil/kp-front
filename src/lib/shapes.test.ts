import { describe, expect, it } from 'vitest'
import { ROTATION_ASPECT_MIN, ROTATION_MAX_M, ROTATION_W_M, SHAPE_TWO_POINT, rotationBox, rotationRun, rotationWidth, SHAPE_AXIS_GRIPS, SHAPE_DEFS, SHAPE_FREE_ASPECT, SHAPE_MIN_M, SHAPE_MIN_N, SHAPE_ORDER, SHAPE_STROKE_DEFAULT, SQUARE_FILL_DEFAULT, rotationInner, rotationViewBox, shapeAspect, shapeAspectMax, shapeStrokeFactor, squareInner, squareViewBox } from './shapes'
import type { ShapeKind } from '../types'

describe('SHAPE_ORDER / SHAPE_DEFS', () => {
  it('lists the shape kinds in pick order', () => {
    expect(SHAPE_ORDER).toEqual(['arrow', 'cloud', 'square', 'rotation'])
  })

  it('has a def for every kind in the order, and vice-versa', () => {
    const defKeys = Object.keys(SHAPE_DEFS) as ShapeKind[]
    expect(defKeys.sort()).toEqual([...SHAPE_ORDER].sort())
  })

  it('every def carries a hex colour and positive default sizes (map metres + plan fraction)', () => {
    for (const k of SHAPE_ORDER) {
      expect(SHAPE_DEFS[k].defaultColor).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(SHAPE_DEFS[k].defaultSizeM).toBeGreaterThan(0)
      expect(SHAPE_DEFS[k].defaultSizeN).toBeGreaterThan(0)
      expect(SHAPE_DEFS[k].defaultSizeN).toBeLessThan(1)
    }
  })

  it('keeps the tuned per-shape defaults (smoke larger/grey, arrow blue, box red)', () => {
    expect(SHAPE_DEFS.arrow).toEqual({ defaultColor: '#1f6feb', defaultSizeM: 45, defaultSizeN: 0.1 })
    expect(SHAPE_DEFS.cloud).toEqual({ defaultColor: '#6b7280', defaultSizeM: 80, defaultSizeN: 0.18 })
    expect(SHAPE_DEFS.square).toEqual({ defaultColor: '#e8392b', defaultSizeM: 45, defaultSizeN: 0.1 })
    // the smoke cloud starts larger than the arrow/box — on both surfaces
    expect(SHAPE_DEFS.cloud.defaultSizeM).toBeGreaterThan(SHAPE_DEFS.arrow.defaultSizeM)
    expect(SHAPE_DEFS.cloud.defaultSizeN).toBeGreaterThan(SHAPE_DEFS.arrow.defaultSizeN)
  })
})

// The Rotation loop is a shuttle RUN between two places, so it is a stretchable shape rather than
// a symbol dropped at a point (FKS Vegetationsbrand S. 52/53, decision 01.09.).
describe('the Rotation loop', () => {
  // Dragging the corner back through the centre used to invert the loop into a thin vertical
  // sliver with the arrows pointing at each other — a shape that means nothing.
  it('can never be taller than it is long', () => {
    expect(shapeAspect('rotation', 4)).toBeLessThanOrEqual(1)
    expect(shapeAspect('rotation', 0.9)).toBe(0.9)
    // …while the shapes that legitimately stand upright still may
    expect(shapeAspect('square', 4)).toBe(4)
  })

  it('starts long and flat, and stretches freely', () => {
    expect(SHAPE_FREE_ASPECT.rotation).toBe(true)
    expect(SHAPE_DEFS.rotation.defaultAspect).toBeLessThan(1)
    expect(SHAPE_DEFS.rotation.defaultSizeM).toBeGreaterThan(SHAPE_DEFS.cloud.defaultSizeM)
  })

  // ⚠️ Every other shape is capped at 500 m. A Wasserpendel between the Weiher and the
  // Brandstelle is kilometres, and that cap was why the only way to make the loop long was to
  // make it enormous in both axes (MapMarkers · shapeMove keeps the width and stretches this).
  it('may be drawn far past the 500 m every other shape is capped at', () => {
    expect(ROTATION_MAX_M).toBeGreaterThan(5000)
  })

  it('falls back to its own default aspect, not to square', () => {
    expect(shapeAspect('rotation', undefined)).toBe(SHAPE_DEFS.rotation.defaultAspect)
    expect(shapeAspect('rotation', 0.8)).toBe(0.8)
    // …and an aspect-locked kind still ignores both
    expect(shapeAspect('arrow', 0.4)).toBe(1)
  })

  // ⚠️ The glyph is painted with preserveAspectRatio="none". Its viewBox therefore has to MATCH
  // the aspect, or one unit of y is `asp` units of x — which came out as a fat-ended outline and
  // flattened arrowheads exactly when the loop is long, which is always.
  it('matches its viewBox to the aspect, so the units stay square', () => {
    expect(rotationViewBox(0.25)).toBe('0 0 100 25.00')
    expect(rotationViewBox(1)).toBe('0 0 100 100.00')
  })

  // ⚠️ Everything inside is a PURE FRACTION of the loop's height, with no absolute floor. A user
  // unit is width/100, and the box's px width grows with the run — so h is constant in px as the
  // loop lengthens, and a fraction of h is constant too. An absolute clamp is the opposite: it
  // pins a number of UNITS, which grows with the run. That is what gave a long Rotation a fat
  // outline and arrowheads the size of a vehicle («nur länger, gleiche Strichstärke», 01.09.).
  it('draws the outline at the drawn-line width it was given, whatever the shape is doing', () => {
    // ⚠️ THE contract (01.09.): a Form's outline is the same 3 · 5 · 8 px a Zeichnung has, and
    // resizing the shape moves its length and width and nothing else. Units render
    // `units × boxPx / 100` px, so that product must come back as the width asked for — at any
    // aspect, at any box size, on either grip.
    const sw = (svg: string) => Number(/stroke-width="([\d.]+)"/.exec(svg)![1])
    const px = (asp: number, boxPx: number, w?: number) => sw(rotationInner('#1f6feb', asp, undefined, w, boxPx)) * boxPx / 100
    for (const asp of [0.08, 0.32, 0.7, 1]) {
      for (const boxPx of [120, 400, 1500]) {
        for (const want of [3, SHAPE_STROKE_DEFAULT, 8]) {
          // …as long as the loop is tall enough to hold the line; a sliver clamps, and that has
          // its own test below
          if (boxPx * asp * 0.5 < want) continue
          expect(px(asp, boxPx, want)).toBeCloseTo(want, 1)
        }
      }
    }
  })

  it('does the same for the Rechteck', () => {
    const sw = (svg: string) => Number(/stroke-width="([\d.]+)"/.exec(svg)![1])
    for (const asp of [0.4, 1, 3]) {
      for (const boxPx of [90, 300, 900]) {
        expect(sw(squareInner('#e8392b', asp, 8, boxPx)) * boxPx / 100).toBeCloseTo(8, 1)
      }
    }
  })

  it('ties the direction heads to the stroke, and never lets one outgrow the loop', () => {
    const head = (asp: number, boxPx: number) => {
      const svg = rotationInner('#1f6feb', asp, undefined, undefined, boxPx)
      const m = /<path d="M ([\d.-]+) ([\d.-]+) L ([\d.-]+)/.exec(svg)!
      return Number(m[3]) - Number(m[1])
    }
    // a long thin run: the head is bounded by the loop's own height, not by the stroke
    expect(head(0.05, 800)).toBeLessThanOrEqual(100 * 0.05)
    // …and a stocky one keeps a head proportional to the line weight
    expect(head(1, 300)).toBeGreaterThan(0)
  })

  it('keeps the outline inside the shape even when it is dragged to a sliver', () => {
    const sw = (svg: string) => Number(/stroke-width="([\d.]+)"/.exec(svg)![1])
    for (const asp of [0.02, 0.05]) {
      // a 5px line on a box only a few px tall cannot be honoured — it would paint over itself
      expect(sw(rotationInner('#1f6feb', asp, undefined, 8, 60))).toBeLessThanOrEqual(100 * asp * 0.5 + 0.01)
      expect(sw(squareInner('#e8392b', asp, 8, 60))).toBeLessThanOrEqual(100 * asp * 0.5 + 0.01)
    }
  })

  it('draws the loop and both directions in the shape’s own colour', () => {
    const svg = rotationInner('#e8392b', 0.3)
    expect(svg).toContain('stroke="#e8392b"')
    expect((svg.match(/fill="#e8392b"/g) ?? []).length).toBe(2) // one head per leg
  })
})


// A Form is a pre-shaped AREA: one line width, the same on all four sides however the box is
// stretched, and settable in the same three steps a drawn Fläche uses.
describe('Rechteck geometry', () => {
  const sw = (svg: string) => Number(/stroke-width="([\d.]+)"/.exec(svg)![1])

  it('matches its viewBox to the aspect, so a unit of y is a unit of x', () => {
    // ⚠️ THE fix: on a square 0..100 viewBox drawn `preserveAspectRatio="none"` into a stretched
    // box, one stroke-width came out fat on the verticals and a hairline top and bottom.
    expect(squareViewBox(1)).toBe('0 0 100 100.00')
    expect(squareViewBox(0.25)).toBe('0 0 100 25.00')
    expect(squareViewBox(4)).toBe('0 0 100 400.00')
  })

  it('keeps the whole outline inside the box at any stretch', () => {
    for (const asp of [0.02, 0.25, 1, 4, 5]) {
      const m = /x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(squareInner('#1f6feb', asp))!
      const [x, y, w, h] = m.slice(1).map(Number)
      expect(w).toBeGreaterThan(0)
      expect(h).toBeGreaterThan(0)
      expect(x + w).toBeLessThanOrEqual(100)
      expect(y + h).toBeLessThanOrEqual(100 * asp + 0.01)
    }
  })

  it('falls back to the icon weight with no pixel box, and the middle step changes nothing', () => {
    // a picker cell and the editor's header tile have no meaningful «box width» to match a
    // drawn line against, so they keep the weight these glyphs have always been drawn at
    expect(shapeStrokeFactor(undefined)).toBe(1)
    expect(shapeStrokeFactor(SHAPE_STROKE_DEFAULT)).toBe(1)
    expect(squareInner('#1f6feb', 1, SHAPE_STROKE_DEFAULT)).toBe(squareInner('#1f6feb', 1))
    expect(rotationInner('#1f6feb', 0.3, undefined, SHAPE_STROKE_DEFAULT)).toBe(rotationInner('#1f6feb', 0.3))
    expect(sw(squareInner('#1f6feb', 1, 8))).toBeGreaterThan(sw(squareInner('#1f6feb', 1, 3)))
  })
})

describe('axis grips', () => {
  it('gives a Rechteck one grip per axis, and the Rauch its diagonal corner', () => {
    expect(SHAPE_AXIS_GRIPS.square).toBe(true)
    // …and a Rotation none at all any more: it is dragged by its two ENDS, which set its length
    // and its bearing together, and its width follows the run (SHAPE_TWO_POINT)
    expect(SHAPE_AXIS_GRIPS.rotation).toBe(false)
    // a plume is pulled into shape, not given a width and a height
    expect(SHAPE_AXIS_GRIPS.cloud).toBe(false)
    // …and a Pfeil keeps its proportions, so it has one size and no axes at all
    expect(SHAPE_AXIS_GRIPS.arrow).toBe(false)
  })

  it('caps a Rotation at square — a run may never be taller than it is long', () => {
    expect(shapeAspectMax('rotation')).toBe(1)
    expect(shapeAspectMax('square')).toBe(5)
  })
})

describe('the smallest a shape may be dragged', () => {
  // ⚠️ The unit IS the point (01.09.). A screen-pixel floor was tried and reverted: it clamps the
  // rendered size, so the GROUND size it leaves behind depends on the zoom the drag happened at,
  // and one zoom step in lets the same drag continue past the floor it just refused.
  it('is ground truth, not screen pixels — every kind starts well above it', () => {
    expect(SHAPE_MIN_M).toBeGreaterThan(0)
    expect(SHAPE_MIN_N).toBeGreaterThan(0)
    for (const kind of SHAPE_ORDER) {
      expect(SHAPE_DEFS[kind].defaultSizeM).toBeGreaterThan(SHAPE_MIN_M)
      expect(SHAPE_DEFS[kind].defaultSizeN).toBeGreaterThan(SHAPE_MIN_N)
    }
  })

  it('leaves room to shrink before it bites', () => {
    // a floor that sits just under the default would make the minus button a no-op on first press
    expect(SHAPE_MIN_M * 2).toBeLessThan(Math.min(...SHAPE_ORDER.map((k) => SHAPE_DEFS[k].defaultSizeM)))
  })
})

// A Rechteck is a Fläche that came pre-shaped, so it answers the fill question the same way.
describe('Rechteck fill', () => {
  it('washes at the given opacity, and keeps the old default when none was chosen', () => {
    expect(squareInner('#e8392b', 1)).toContain(`fill-opacity="${SQUARE_FILL_DEFAULT}"`)
    expect(squareInner('#e8392b', 1, undefined, undefined, 0.4)).toContain('fill-opacity="0.4"')
    // ∅ — outline only
    expect(squareInner('#e8392b', 1, undefined, undefined, 0)).toContain('fill-opacity="0"')
  })

  it('hatches with a real pattern, so the print draws the same Schraffur', () => {
    const svg = squareInner('#e8392b', 1, undefined, undefined, 0.18, true)
    expect(svg).toContain('<pattern')
    expect(svg).toMatch(/fill="url\(#sqh-[^)]+\)"/)
    expect(svg).not.toContain('fill-opacity')
    // …in the shape's own colour, like the Fläche's
    expect(svg).toContain('stroke="#e8392b"')
  })

  it('keeps the hatch period constant on screen however big the box is', () => {
    const period = (boxPx: number) => {
      const m = /<pattern[^>]*width="([\d.]+)"/.exec(squareInner('#e8392b', 1, undefined, boxPx, 0.18, true))!
      return Number(m[1]) * boxPx / 100 // units → px
    }
    expect(period(200)).toBeCloseTo(period(900), 2) // to the rounding of the emitted units
  })
})

// A Rotation is two points. The box the renderers use is the same information written the other
// way round, so the pair has to survive a round trip exactly — that is what lets the two ends be
// a pure gesture with nothing new stored behind them.
describe('Rotation als zwei Punkte', () => {
  it('round-trips a run through the stored box', () => {
    for (const run of [40, 120, 300, 1200, 5000]) {
      const { size, aspect } = rotationBox(run, ROTATION_W_M)
      expect(rotationRun(size, aspect)).toBeCloseTo(run, 6)
    }
  })

  it('keeps the loop a racetrack: the width follows the run, but only between its bounds', () => {
    // short run — the floor stops it becoming a hairline
    expect(rotationWidth(20, ROTATION_W_M)).toBe(ROTATION_W_M.min)
    // in the band — a plain share of the run
    expect(rotationWidth(200, ROTATION_W_M)).toBeCloseTo(30, 6)
    // a Wasserpendel to the Weiher: capped, so it stays lean instead of ballooning
    expect(rotationWidth(3000, ROTATION_W_M)).toBe(ROTATION_W_M.max)
  })

  it('never inverts: the box is never taller than it is long', () => {
    for (const run of [0, 1, 25, 90, 10000]) {
      const { aspect } = rotationBox(run, ROTATION_W_M)
      expect(aspect).toBeLessThanOrEqual(shapeAspectMax('rotation'))
      expect(aspect).toBeGreaterThan(0)
    }
  })

  it('reads a stored box that predates the two-point model without inventing a run', () => {
    // sizeM 300 / aspect 0.32 is what a Rotation placed on 31.08. carries
    expect(rotationRun(300, 0.32)).toBeCloseTo(204, 6)
    // …and one stored with no aspect at all falls back to the kind's default, not to 1
    expect(rotationRun(300, undefined)).toBeGreaterThan(0)
  })

  it('is the one shape laid out as two points, and has no axis grips left', () => {
    expect(SHAPE_TWO_POINT.rotation).toBe(true)
    expect(SHAPE_AXIS_GRIPS.rotation).toBe(false)
    expect(SHAPE_ORDER.filter((k) => SHAPE_TWO_POINT[k])).toEqual(['rotation'])
  })
})

// The carrier badge is a LABEL, so it is read at a size — not at a ground distance. Sized off the
// loop's height it grew with the run, and a Wasserpendel across the map printed a «TLF» the size
// of a city block (reported 01.09.).
// «Richtung umkehren»: the circulation sense turns around, the loop stays put. That is a MIRROR
// of the two direction heads (position and direction) — a rotation of the box preserves the
// sense and could never say it.
describe('Rotation Richtung umkehren', () => {
  const heads = (s: string) =>
    [...s.matchAll(/<path d="M ([\d.-]+) ([\d.-]+) L ([\d.-]+) ([\d.-]+) L ([\d.-]+) ([\d.-]+) Z" fill=/g)]
      .map((m) => m.slice(1).map(Number))
  it('mirrors both direction heads and nothing else', () => {
    const fwd = rotationInner('#1f6feb', 0.32)
    const rev = rotationInner('#1f6feb', 0.32, undefined, undefined, undefined, true)
    // the loop outline is byte-identical — only the heads move
    expect(/<rect[^>]*\/>/.exec(rev)![0]).toBe(/<rect[^>]*\/>/.exec(fwd)![0])
    const f = heads(fwd), r = heads(rev)
    expect(f).toHaveLength(2)
    expect(r).toHaveLength(2)
    // the reversed sign is the exact horizontal mirror: every head x-coordinate reflects
    // about the box centre (x → 100 − x), y stays — top leg mirrors onto itself, reversed
    const mirrored = f.map(([x1, y1, x2, y2, x3, y3]) => [100 - x1, y1, 100 - x2, y2, 100 - x3, y3])
    const key = (h: number[]) => h.map((n) => n.toFixed(2)).join(',')
    expect(new Set(r.map(key))).toEqual(new Set(mirrored.map(key)))
  })
})

describe('Rotation carrier badge', () => {
  const badgeWidth = (run: number) => {
    const { size, aspect } = rotationBox(run, ROTATION_W_M)
    const boxPx = 4 * run // whatever pixel width that run happens to be drawn at
    const svg = rotationInner('#1f6feb', shapeAspect('rotation', aspect), 'tlf', undefined, boxPx)
    const m = /<rect x="[\d.-]+" y="[\d.-]+" width="([\d.]+)"[^>]*fill="#ffffff"/.exec(svg)!
    return Number(m[1]) * boxPx / 100 // units → px
    // (`size` only decides the aspect here; the badge must not care how long the run is)
  }
  it('stays the same size on screen however far the shuttle runs', () => {
    // to the two decimals the SVG string is emitted with
    expect(badgeWidth(3000)).toBeCloseTo(badgeWidth(300), 0)
  })

  it('shrinks to fit a deliberately thin loop instead of overflowing it', () => {
    const thin = rotationInner('#1f6feb', 0.02, 'tlf', undefined, 400)
    const m = /height="([\d.]+)"[^>]*fill="#ffffff"/.exec(thin)
    // the badge's box never exceeds the loop's own height (2 · h · 0.34 of h = 100 · 0.02)
    expect(Number(m![1])).toBeLessThanOrEqual(2 * 0.02 * 100 * 0.34 + 0.01)
  })
})
