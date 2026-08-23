import { describe, expect, it } from 'vitest'
import { fanOffsets, LABEL_RANK, labelSize, MARKER_Z, markerZ, pileAt, placeLabels, wrapLine, type LabelBox, type LabelCandidate } from './labelPass'

/** A candidate at (x, y), 40×14 unless told otherwise — the size of a short caption. */
const at = (key: string, rank: LabelCandidate['rank'], x: number, y: number, extra: Partial<LabelCandidate> = {}): LabelCandidate =>
  ({ key, rank, dist: Math.hypot(x, y), box: { x, y, w: 40, h: 14 }, ...extra })

describe('placeLabels — rank decides, never placement order', () => {
  it('keeps the higher-ranked label and suppresses the one that collides with it', () => {
    const tag = at('tag:1', LABEL_RANK.criticalTag, 100, 100)
    const caption = at('cap:1', LABEL_RANK.caption, 110, 104)
    expect(placeLabels([tag, caption], [])).toEqual(new Set(['cap:1']))
    // the same pair fed in the other order must decide the same way — that is the whole point
    expect(placeLabels([caption, tag], [])).toEqual(new Set(['cap:1']))
  })

  it('breaks a tie inside one rank by distance to the incident, not by input order', () => {
    const near: LabelCandidate = { key: 'cap:near', rank: LABEL_RANK.caption, dist: 10, box: { x: 100, y: 100, w: 40, h: 14 } }
    const far: LabelCandidate = { key: 'cap:far', rank: LABEL_RANK.caption, dist: 900, box: { x: 108, y: 100, w: 40, h: 14 } }
    expect(placeLabels([far, near], [])).toEqual(new Set(['cap:far']))
  })

  it('draws everything that does not touch anything', () => {
    const spread = [at('a', LABEL_RANK.caption, 0, 0), at('b', LABEL_RANK.caption, 200, 0), at('c', LABEL_RANK.caption, 0, 200)]
    expect(placeLabels(spread, []).size).toBe(0)
  })

  it('never lets a label cover a glyph', () => {
    const glyph: LabelBox = { x: 100, y: 100, w: 32, h: 32 }
    expect(placeLabels([at('cap:1', LABEL_RANK.caption, 110, 110)], [glyph])).toEqual(new Set(['cap:1']))
  })
})

describe('placeLabels — the exemptions that make suppression safe', () => {
  it('never suppresses the selection, and pushes the rest out of its way', () => {
    // the caption outranks nothing here: it is the SELECTED object, so it wins against a
    // critical tag it overlaps — every hidden name stays one tap from readable
    const selected = at('cap:sel', LABEL_RANK.selected, 100, 100)
    const tag = at('tag:1', LABEL_RANK.criticalTag, 104, 102)
    expect(placeLabels([tag, selected], [])).toEqual(new Set(['tag:1']))
  })

  it('never suppresses a hand-placed label, whatever its rank', () => {
    // d.labelAt / d.endLabelAt: the operator already dragged this one out of the way by hand
    const pinned = at('dl:1', LABEL_RANK.readout, 100, 100, { pinned: true })
    const team = at('team:1', LABEL_RANK.team, 104, 102)
    expect(placeLabels([team, pinned], [])).toEqual(new Set(['team:1']))
  })

  it('places a selected label even when it sits on a glyph', () => {
    const glyph: LabelBox = { x: 100, y: 100, w: 32, h: 32 }
    expect(placeLabels([at('cap:sel', LABEL_RANK.selected, 105, 105)], [glyph]).size).toBe(0)
  })
})

describe('wrapLine — German breaks at compound seams, never by syllable', () => {
  // 10px per character: «Wasserbezugsort» is 150, its first component «Wasser-» is 70
  const measure = (s: string) => s.length * 10
  const SOFT = '­'

  it('breaks at a soft hyphen and renders the hyphen it costs', () => {
    expect(wrapLine(`Wasser${SOFT}bezugs${SOFT}ort`, 80, measure)).toEqual(['Wasser-', 'bezugs-', 'ort'])
  })

  it('fills each line before breaking, so a seam that fits is not used', () => {
    expect(wrapLine(`Wasser${SOFT}bezugs${SOFT}ort`, 90, measure)).toEqual(['Wasser-', 'bezugsort'])
  })

  it('breaks a field value at its seam, then at its spaces', () => {
    expect(wrapLine(`Salpeter${SOFT}säure, rauchend`, 100, measure)).toEqual(['Salpeter-', 'säure,', 'rauchend'])
  })

  it('wraps a seamless value at its spaces and drops the trailing space', () => {
    expect(wrapLine('1200 l/min ab Weiher', 100, measure)).toEqual(['1200 l/min', 'ab Weiher'])
  })

  it('leaves a word with no seam whole rather than breaking inside it', () => {
    expect(wrapLine('Kontrollposten', 60, measure)).toEqual(['Kontrollposten'])
  })

  it('keeps a short label on one line', () => {
    expect(wrapLine('CO₂', 120, measure)).toEqual(['CO₂'])
  })
})

describe('labelSize', () => {
  const style = { font: '700 11.5px x', maxTextW: 90, chromeW: 12, chromeH: 2, lineH: 14 }
  const measure = (s: string) => s.length * 10

  it('adds the CSS chrome to the widest line and stacks the rows', () => {
    // 'ab' → 20px wide, one row
    expect(labelSize('ab', style, measure)).toEqual({ w: 32, h: 16 })
  })

  it('counts a wrapped caption as two rows and clamps its width to the wrapped text', () => {
    const { w, h } = labelSize(`Wasser­bezugs­ort`, style, measure)
    expect(h).toBe(2 * 14 + 2)
    expect(w).toBeLessThanOrEqual(style.maxTextW + style.chromeW)
  })

  it('gives a multi-value caption a row per value', () => {
    expect(labelSize('ab\ncd\nef', style, measure).h).toBe(3 * 14 + 2)
  })
})

describe('pileAt — nearest centre replaces "later drawn wins"', () => {
  // the Wasserbezugsort was placed first, the Kleinlöscher last; DOM order used to hand every
  // tap between them to the Kleinlöscher
  const wbo = { id: 'wbo', x: 100, y: 100, pad: 48 }
  const klg = { id: 'klg', x: 120, y: 108, pad: 48 }

  it('returns the nearest centre first, whatever the input order', () => {
    expect(pileAt({ x: 103, y: 101 }, [wbo, klg])[0].id).toBe('wbo')
    expect(pileAt({ x: 103, y: 101 }, [klg, wbo])[0].id).toBe('wbo')
  })

  it('reports every candidate the finger actually covers', () => {
    expect(pileAt({ x: 110, y: 104 }, [wbo, klg]).map((p) => p.id)).toEqual(['wbo', 'klg'])
  })

  it('is empty beside the pile, and single inside one pad alone', () => {
    expect(pileAt({ x: 400, y: 400 }, [wbo, klg])).toEqual([])
    expect(pileAt({ x: 138, y: 112 }, [wbo, klg]).map((p) => p.id)).toEqual(['klg'])
  })
})

describe('fanOffsets', () => {
  const pile = [
    { id: 'a', x: 100, y: 100, pad: 48 },
    { id: 'b', x: 110, y: 100, pad: 48 },
    { id: 'c', x: 105, y: 112, pad: 48 },
  ]

  it('moves nothing when there is nothing to disambiguate', () => {
    expect(fanOffsets(pile.slice(0, 1))).toEqual({})
  })

  it('spreads every member onto the same ring around the pile centre', () => {
    const out = fanOffsets(pile)
    expect(Object.keys(out).sort()).toEqual(['a', 'b', 'c'])
    const cx = 105, cy = 104
    for (const p of pile) {
      const r = Math.hypot(p.x + out[p.id].dx - cx, p.y + out[p.id].dy - cy)
      expect(r).toBeCloseTo(34, 0) // max(34, n × 11)
    }
  })
})

describe('markerZ — the tapped marker comes forward', () => {
  const resting = ['note', 'photo', 'shape', 'symbol', 'vehicle', 'hydrant', 'team']

  it('lifts the selected marker above every resting neighbour', () => {
    // the reported defect: a symbol under a Trupp (the highest resting level) stayed under it
    // when tapped, so the panel opened for something the operator could not see
    for (const kind of resting) expect(markerZ('symbol', { selected: true })).toBeGreaterThan(markerZ(kind))
  })

  it('clears the end tag of a selected Leitung too — only one thing is ever the selection', () => {
    expect(markerZ('symbol', { selected: true })).toBeGreaterThan(MARKER_Z.tagSelected)
  })

  it('drops straight back when the selection ends', () => {
    expect(markerZ('symbol')).toBe(MARKER_Z.symbol)
    expect(markerZ('team')).toBe(MARKER_Z.team)
  })

  it('never fights the fan: a fanned glyph outranks the selection', () => {
    // its spokes stand off the true position — one hidden behind a neighbour is worse than none
    expect(markerZ('team', { selected: true, fanned: true })).toBe(MARKER_Z.fanned)
    expect(MARKER_Z.fanned).toBeGreaterThan(MARKER_Z.selected)
  })
})
