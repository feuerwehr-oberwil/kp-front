// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LayerPanel } from './LayerPanel'
import type { LayerDef } from '../types'
import { appConfig } from '../config/appConfig'
import { isTwinLayerId, twinPlanImageLayerId, type TwinLayerRow } from '../lib/georefTwins'

afterEach(cleanup)

const noop = () => {}
const plan: LayerDef = { id: 'modul5', group: 'Pläne', label: 'Hydrantenplan', icon: 'layers', visible: true, opacity: 60 }
const twin: TwinLayerRow = {
  id: twinPlanImageLayerId('p1'), group: 'Pläne', label: 'Objektplan A – Blatt',
  icon: 'layers', visible: true, opacity: 55,
}

// The Deckkraft control is the app's own slider (components/Slider), not a native
// <input type="range"> — and the rows it serves are of two kinds that persist in different
// places: a real `LayerDef` in the workspace, and a Georeferenz twin in the device preferences
// (georefTwins · isTwinLayerId → twinLayerOpacity). One control, one `onOpacity(id, …)`, so the
// twin ids have to survive the row unchanged.
describe('LayerPanel · Deckkraft', () => {
  const sliders = () => screen.getAllByRole('slider')

  it('is the app\'s own control, and states the value it carries', () => {
    render(<LayerPanel layers={[plan]} onToggle={noop} onOpacity={noop} />)
    expect(document.querySelector('input[type="range"]')).toBeNull()
    const s = sliders()[0]
    expect(s.getAttribute('aria-valuenow')).toBe('60')
    expect(s.getAttribute('aria-valuetext')).toBe('60 %')
    // …and it says WHICH layer, so «Deckkraft» alone is never the whole announcement
    expect(s.getAttribute('aria-label')).toBe(`${plan.label} – ${appConfig.copy.layerPanel.opacity}`)
  })

  it('reports the twin row under its OWN id, not a LayerDef one', () => {
    const onOpacity = vi.fn()
    render(<LayerPanel layers={[plan]} twins={[twin]} onToggle={noop} onOpacity={onOpacity} />)
    const [planSlider, twinSlider] = sliders()
    fireEvent.keyDown(planSlider, { key: 'ArrowRight' })
    expect(onOpacity).toHaveBeenLastCalledWith(plan.id, 61)
    fireEvent.keyDown(twinSlider, { key: 'ArrowLeft' })
    const [id, v] = onOpacity.mock.calls[1]
    expect(isTwinLayerId(id)).toBe(true)
    expect([id, v]).toEqual([twin.id, 54])
  })

  // …and the read-out beside it is NOT a bare <span>. `.opacity span` matched every span inside
  // the slider too — and beat `.uslider-thumb` on specificity, so its 34px width painted the
  // 18px round thumb as an ellipse. The class is what keeps the row's styling off the control.
  it('names its read-out, so the row cannot style the slider', () => {
    const { container } = render(<LayerPanel layers={[plan]} onToggle={noop} onOpacity={noop} />)
    const row = container.querySelector('.opacity')!
    expect(row.querySelector('.opacity-v')?.textContent).toBe('60%')
    expect(Array.from(row.children).filter((c) => c.tagName === 'SPAN' && !c.className)).toHaveLength(0)
  })

  it('has no row where there is nothing to make transparent', () => {
    // a mirrored SYMBOL layer is shown or it is not — it carries no `opacity` (georefTwins)
    render(<LayerPanel layers={[{ ...plan, opacity: undefined }]} twins={[{ ...twin, opacity: undefined }]} onToggle={noop} onOpacity={noop} />)
    expect(screen.queryAllByRole('slider')).toHaveLength(0)
  })

  it('hides it again with the layer — a transparency you cannot see is not a question', () => {
    render(<LayerPanel layers={[{ ...plan, visible: false }]} onToggle={noop} onOpacity={noop} />)
    expect(screen.queryAllByRole('slider')).toHaveLength(0)
  })
})

// The quick-taps (field ask 07.09.): one gesture over the whole panel. All three or none —
// the Plan-surface panel passes none, so its lent-twin rows keep their own drawer.
describe('LayerPanel · quick-taps', () => {
  it('renders the three actions when wired, and fires each', () => {
    const onShowAll = vi.fn(); const onHideAll = vi.fn(); const onReset = vi.fn()
    render(<LayerPanel layers={[plan]} onToggle={noop} onOpacity={noop}
      onShowAll={onShowAll} onHideAll={onHideAll} onReset={onReset} />)
    const C = appConfig.copy.layerPanel
    fireEvent.click(screen.getByText(C.showAll))
    fireEvent.click(screen.getByText(C.hideAll))
    fireEvent.click(screen.getByText(C.reset))
    expect(onShowAll).toHaveBeenCalledTimes(1)
    expect(onHideAll).toHaveBeenCalledTimes(1)
    expect(onReset).toHaveBeenCalledTimes(1)
  })

  // 05.10.2026 (owner): «ebenen should have an indication when using standard or all on / off»
  it.each([['standard', 'reset'], ['all', 'showAll'], ['none', 'hideAll']] as const)('draws «%s» as the selected quick-tap', (preset, key) => {
    render(<LayerPanel layers={[plan]} onToggle={noop} onOpacity={noop}
      onShowAll={noop} onHideAll={noop} onReset={noop} preset={preset} />)
    const C = appConfig.copy.layerPanel
    for (const k of ['showAll', 'hideAll', 'reset'] as const) {
      expect(screen.getByText(C[k]).getAttribute('aria-pressed')).toBe(String(k === key))
    }
  })

  it('selects none of them for a hand-switched set', () => {
    const { container } = render(<LayerPanel layers={[plan]} onToggle={noop} onOpacity={noop}
      onShowAll={noop} onHideAll={noop} onReset={noop} preset="custom" />)
    expect(container.querySelectorAll('.lc-quick [aria-pressed="true"]')).toHaveLength(0)
  })

  it('renders no quick row when the surface offers none (the Plan panel)', () => {
    const { container } = render(<LayerPanel layers={[plan]} onToggle={noop} onOpacity={noop} />)
    expect(container.querySelector('.lc-quick')).toBeNull()
  })
})

// On a phone the map's own ⓘ is hidden (15-mobile.css · .app .maplibregl-ctrl-attrib), so the
// panel's foot is the one place the tile providers are credited – for what is actually ON the
// map, each provider once.
describe('LayerPanel · Kartenquellen', () => {
  const carto: LayerDef = { id: 'base-carto', group: 'Basis', label: 'Carto', icon: 'map', base: true, visible: true, opacity: 100, attribution: '© CARTO, © OpenStreetMap-Mitwirkende' }
  const osm: LayerDef = { id: 'base-osm', group: 'Basis', label: 'OpenStreetMap', icon: 'map', base: true, visible: false, opacity: 100, attribution: '© OpenStreetMap-Mitwirkende' }
  const topo: LayerDef = { id: 'hydr', group: 'Wasser', label: 'Hydranten', icon: 'layers', visible: true, attribution: '© OpenStreetMap-Mitwirkende, © swisstopo' }
  const credits = () => document.querySelector('.lc-credits')?.textContent

  it('names every visible layer\'s provider once', () => {
    render(<LayerPanel layers={[carto, osm, topo]} onToggle={noop} onOpacity={noop} />)
    // the © is glued to its name with a no-break space, so a line never ends on a bare «©»
    expect(credits()).toBe('©\u00a0CARTO, ©\u00a0OpenStreetMap-Mitwirkende, ©\u00a0swisstopo')
  })

  it('leaves out what is hidden, and the line itself when nothing is credited', () => {
    render(<LayerPanel layers={[{ ...carto, visible: false }, plan]} onToggle={noop} onOpacity={noop} />)
    expect(document.querySelector('.lc-credits')).toBeNull()
  })
})

// On a phone Ebenen is a slide-up bottom sheet (29.09.2026, owner: «ebenen, search, etc. should be
// a slide-up rather than a modal»): the grab bar, and a push down on its head closes it — the same
// measured gesture every phone sheet has (lib/overlays · swipeDismiss), so it never exists where
// the card is not on the bottom edge (the tablet's side card).
describe('LayerPanel · phone sheet', () => {
  const VH = window.visualViewport?.height ?? window.innerHeight
  const place = (el: HTMLElement, bottom: number) => {
    el.getBoundingClientRect = () => ({ top: 300, bottom, left: 0, right: 390, width: 390, height: bottom - 300, x: 0, y: 300, toJSON: () => ({}) }) as DOMRect
  }
  // jsdom has no PointerEvent: build the touch by hand (as swipeDismiss.test does)
  const touch = (el: Element, type: string, clientY: number) => {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 100, clientY })
    Object.defineProperty(ev, 'pointerType', { value: 'touch' })
    Object.defineProperty(ev, 'pointerId', { value: 1 })
    fireEvent(el, ev)
  }
  const pull = (from: Element) => { touch(from, 'pointerdown', 400); touch(from, 'pointermove', 540); touch(from, 'pointerup', 540) }

  it('wears the grab bar and a head without the glyph — the title alone', () => {
    render(<LayerPanel layers={[plan]} onToggle={noop} onOpacity={noop} onClose={noop} />)
    expect(document.querySelector('.layers-card > .ui-sheet-grab')).toBeTruthy()
    const head = document.querySelector('.lc-title') as HTMLElement
    expect(head.querySelector('.i:not(.ip-x .i)')).toBeNull()
    expect(head.textContent).toBe(appConfig.copy.panels.layers)
  })

  it('closes on a push down its head while it stands on the bottom edge', () => {
    const onClose = vi.fn()
    render(<LayerPanel layers={[plan]} onToggle={noop} onOpacity={noop} onClose={onClose} />)
    place(document.querySelector('.layers-card') as HTMLElement, VH)
    pull(document.querySelector('.lc-title') as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('…and not as the tablet\'s side card, off the bottom edge', () => {
    const onClose = vi.fn()
    render(<LayerPanel layers={[plan]} onToggle={noop} onOpacity={noop} onClose={onClose} />)
    place(document.querySelector('.layers-card') as HTMLElement, VH - 200)
    pull(document.querySelector('.lc-title') as HTMLElement)
    expect(onClose).not.toHaveBeenCalled()
  })
})
