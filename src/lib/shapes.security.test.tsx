// @vitest-environment jsdom
import { render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it } from 'vitest'
import { ShapeGlyph, isSafeColor, rotationInner, shapeAspect, squareInner } from './shapes'
import { sanitizeWorkspace } from './workspace'

type ShapeProps = ComponentProps<typeof ShapeGlyph>

// SEC-01 · An editor can write any string into a drawing's `color`, and that string used to be
// interpolated straight into an SVG attribute that reached the DOM through
// `dangerouslySetInnerHTML`. A colour carrying an attribute delimiter therefore closed the
// attribute and opened a new one — an event handler running in the next operator's origin.
const HOSTILE = 'red" onmouseover="window.__pwned=1'
// …and the same trick through the closing bracket, which would open a whole element
const HOSTILE_TAG = '#fff"/><script>window.__pwned=1</script><rect fill="#fff'

const attrNames = (root: ParentNode) =>
  [...root.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.name))

describe('SEC-01 · a colour can never introduce markup', () => {
  it('keeps the Rechteck string free of any attribute the caller wrote', () => {
    for (const bad of [HOSTILE, HOSTILE_TAG]) {
      const svg = squareInner(bad, 1)
      expect(svg).not.toContain('onmouseover')
      expect(svg).not.toContain('<script')
      // …hatched too — the Schraffur paints the same colour into a pattern
      expect(squareInner(bad, 1, undefined, 300, 0.18, true)).not.toContain('onmouseover')
    }
  })

  it('keeps the Rotation string — loop, direction heads and carrier badge — free of it', () => {
    for (const bad of [HOSTILE, HOSTILE_TAG]) {
      expect(rotationInner(bad, 0.32)).not.toContain('onmouseover')
      expect(rotationInner(bad, 0.32, 'tlf')).not.toContain('onmouseover')
      expect(rotationInner(bad, 0.32, 'heli')).not.toContain('<script')
    }
  })

  it('renders no injected attribute and no injected element into the DOM', () => {
    for (const kind of ['square', 'rotation'] as const) {
      for (const bad of [HOSTILE, HOSTILE_TAG]) {
        const { container, unmount } = render(
          <ShapeGlyph kind={kind} color={bad} aspect={0.32} boxPx={300} hatch={kind === 'square'} carrier="tlf" />,
        )
        expect(attrNames(container)).not.toContain('onmouseover')
        expect(container.querySelector('script')).toBeNull()
        unmount()
      }
    }
  })
})

describe('SEC-01 · a rejected colour costs the colour, never the shape', () => {
  it('draws in the default ink and keeps the whole artwork', () => {
    const svg = squareInner(HOSTILE, 1)
    expect(svg).toContain('stroke="#1f6feb"') // lineStyle · DEFAULT_INK
    expect(svg).toMatch(/^<rect[^>]*\/>$/)
    // …and the hatch keeps a usable pattern id, which is derived from the colour
    expect(squareInner(HOSTILE, 1, undefined, 300, 0.18, true)).toMatch(/id="sqh-[a-z0-9]+-\d+"/)
  })
})

// The screen and the paper are one drawing: the live glyph builds React elements, the print path
// serialises the same description for resvg (lib/krokiPayload · shapeSvgString). They may never
// disagree — that is the whole reason a shape's artwork has ONE definition.
describe('SEC-01 · the screen still draws exactly what the print path prints', () => {
  const fromString = (svg: string) =>
    [...new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${svg}</svg>`, 'image/svg+xml')
      .documentElement.querySelectorAll('*')]
  const shape = (el: Element) =>
    `${el.tagName}{${[...el.attributes].map((a) => `${a.name}=${a.value}`).sort().join(',')}}${el.children.length ? '' : el.textContent}`

  // the print path's own call (lib/krokiPayload · shapeSvgString), so the two sides of the
  // comparison are built the way the app builds them
  const printed = (p: ShapeProps) => p.kind === 'square'
    ? squareInner(p.color, shapeAspect('square', p.aspect), p.strokeW, p.boxPx, p.fillOpacity, p.hatch, p.sharpCorners)
    : rotationInner(p.color, shapeAspect('rotation', p.aspect), p.carrier, p.strokeW, p.boxPx, p.reverse)

  it.each([
    ['Rechteck', { kind: 'square', color: '#e8392b', aspect: 0.4, strokeW: 8, boxPx: 300, fillOpacity: 0.4 }],
    ['Rechteck schraffiert', { kind: 'square', color: '#1f9d57', aspect: 1, strokeW: 3, boxPx: 220, hatch: true }],
    ['Rechteck eckig, ohne Füllung', { kind: 'square', color: '#1f6feb', aspect: 2, fillOpacity: 0, sharpCorners: true }],
    ['Rotation', { kind: 'rotation', color: '#1f6feb', aspect: 0.32, strokeW: 5, boxPx: 900 }],
    ['Rotation TLF, umgekehrt', { kind: 'rotation', color: '#e2920a', aspect: 0.2, carrier: 'tlf', strokeW: 8, boxPx: 400, reverse: true }],
    ['Rotation Helikopter', { kind: 'rotation', color: '#6b7280', aspect: 0.5 }],
  ] satisfies [string, ShapeProps][])('%s', (_name, props) => {
    const drawn = [...render(<ShapeGlyph {...props} />).container.querySelectorAll('svg > g *')]
    expect(drawn.length).toBeGreaterThan(0)
    expect(drawn.map(shape)).toEqual(fromString(printed(props)).map(shape))
  })
})

describe('SEC-01 · the load gate neutralises a hostile colour in cached or synced data', () => {
  it('drops the colour and keeps the object', () => {
    const g = sanitizeWorkspace({
      entities: [{ id: 'e1', kind: 'shape', coord: [7.5, 47.5], shape: 'square', color: HOSTILE }],
      drawings: [{ id: 'd1', kind: 'line', coords: [[7.5, 47.5], [7.6, 47.6]], color: HOSTILE }],
      board: { p1: [{ id: 'b1', kind: 'shape', x: 0.5, y: 0.5, shape: 'square', color: HOSTILE }] },
    })
    expect(g.ws!.entities).toHaveLength(1)
    expect(g.ws!.entities[0].color).toBeUndefined()
    expect(g.ws!.drawings[0].color).toBeUndefined()
    expect(g.ws!.board!.p1[0].color).toBeUndefined()
    expect(g.dropped).toBe(3)
  })

  it('drops an artwork number the app could not have written, and keeps the real ones', () => {
    const g = sanitizeWorkspace({
      entities: [{
        id: 'e1', kind: 'shape', coord: [7.5, 47.5], shape: 'square',
        aspect: '0.3" onload="1', strokeW: Number.NaN, fillOpacity: 0, sizeM: 45, rotation: 0,
      }],
    })
    expect(g.ws!.entities[0]).toEqual({ id: 'e1', kind: 'shape', coord: [7.5, 47.5], shape: 'square', fillOpacity: 0, sizeM: 45, rotation: 0 })
    expect(g.dropped).toBe(2)
  })

  it('leaves every colour the app actually writes alone', () => {
    const g = sanitizeWorkspace({
      entities: [
        { id: 'e1', kind: 'shape', coord: [7.5, 47.5], color: '#e8392b' },
        { id: 'e2', kind: 'symbol', coord: [7.5, 47.5], color: '#fff' },
        { id: 'e3', kind: 'team', coord: [7.5, 47.5], color: 'rgba(31, 111, 235, 0.5)' },
      ],
      drawings: [{ id: 'd1', kind: 'area', coords: [[7.5, 47.5], [7.6, 47.6], [7.7, 47.4]], color: '#1f6feb' }],
    })
    expect(g.ws!.entities.map((e) => e.color)).toEqual(['#e8392b', '#fff', 'rgba(31, 111, 235, 0.5)'])
    expect(g.ws!.drawings[0].color).toBe('#1f6feb')
    expect(g.dropped).toBe(0)
  })

  // ⚠️ The Python twin (_COLOR_RE) needed `$`→`\Z` because Python `$` also matches before a
  // trailing newline; JS `$` without the `m` flag does not, so isSafeColor already rejects a
  // value with any newline. Pinned so the two gates cannot silently drift apart.
  it('rejects a colour carrying a newline (the anchor cannot be slipped)', () => {
    expect(isSafeColor('red\n<script>')).toBe(false)
    expect(isSafeColor('#fff\n')).toBe(false)
    expect(isSafeColor('red')).toBe(true)
    expect(isSafeColor('#fff')).toBe(true)
  })
})

// SEC-01 (round 2) · `Entity.symbolSvg` is a free-form glyph string that also reaches the DOM
// through `dangerouslySetInnerHTML` (lib/symbolRender). The render sink sanitises it, but the load
// gate must clean a POISONED STORED value so a device with a stale cache — and every reader that is
// not TacticalSymbol (the ContextPanel's own sink) — sees safe markup.
describe('SEC-01 · the load gate neutralises a hostile symbolSvg in cached or synced data', () => {
  const HOSTILE_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><image href="x" onerror="window.__pwned=1"/></svg>'

  it('strips the injection from a stored glyph and keeps the entity, and drops an unparseable one', () => {
    const g = sanitizeWorkspace({
      entities: [
        { id: 'e1', kind: 'vehicle', coord: [7.5, 47.5], symbolSvg: HOSTILE_SVG },
        { id: 'e2', kind: 'vehicle', coord: [7.5, 47.5], symbolSvg: 'not svg at all' },
      ],
      board: { p1: [{ id: 'b1', kind: 'symbol', x: 0.5, y: 0.5, symbolSvg: HOSTILE_SVG }] },
    })
    expect(g.ws!.entities).toHaveLength(2)
    expect(g.ws!.entities[0].symbolSvg).not.toContain('onerror')
    expect(g.ws!.entities[0].symbolSvg).toContain('<svg') // the glyph itself is preserved
    expect(g.ws!.entities[1].symbolSvg).toBeUndefined()    // garbage → dropped
    // a plan twin carries symbolSvg at runtime (twinGlyph · glyphFor reads it) though it is not a
    // declared BoardAnno field — the gate cleans it there too
    expect((g.ws!.board!.p1[0] as unknown as Record<string, unknown>).symbolSvg).not.toContain('onerror')
    expect(g.dropped).toBe(3)
  })

  it('leaves a legitimate glyph byte-for-byte untouched and uncounted', () => {
    const glyph = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40" fill="#00a0ff"/></svg>'
    const g = sanitizeWorkspace({
      entities: [{ id: 'e1', kind: 'vehicle', coord: [7.5, 47.5], symbolSvg: glyph }],
    })
    expect(g.ws!.entities[0].symbolSvg).toBe(glyph)
    expect(g.dropped).toBe(0)
  })
})
