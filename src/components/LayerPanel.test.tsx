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
