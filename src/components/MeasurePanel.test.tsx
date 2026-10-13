// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MeasurePanel } from './MeasurePanel'
import { appConfig } from '../config/appConfig'
import type { LngLat } from '../types'

afterEach(cleanup)

const C = appConfig.copy.measure
// two points ~1 km apart in Oberwil — enough for the Strecke readout
const strecke: LngLat[] = [[7.55, 47.5], [7.56, 47.5]]
// three corners — the minimum a Fläche readout (and its adopt action) needs
const flaeche: LngLat[] = [...strecke, [7.56, 47.51]]

// «Als Linie übernehmen» — the measured path becomes a drawn line. Before it, the only way to KEEP
// a Strecke was to draw it a second time by hand, on top of the one just measured. The panel is
// shared by both surfaces (Lage map + Plan), so the action arrives on both at once.
describe('MeasurePanel · Als Linie übernehmen', () => {
  const base = { coords: strecke, profile: null, profileLoading: false, showProfile: false } as const

  it('hands the measured path over on tap', () => {
    const onAdopt = vi.fn()
    render(<MeasurePanel {...base} mode="line" onAdopt={onAdopt} />)
    fireEvent.click(screen.getByRole('button', { name: C.adoptLine }))
    expect(onAdopt).toHaveBeenCalledTimes(1)
  })

  it('is absent without the callback — a locked surface measures but never draws', () => {
    render(<MeasurePanel {...base} mode="line" />)
    expect(screen.queryByRole('button', { name: C.adoptLine })).toBeNull()
  })

  it('is absent while the measurement is only a hint (too few points / uncalibrated plan)', () => {
    const onAdopt = vi.fn()
    const { rerender } = render(<MeasurePanel {...base} coords={[strecke[0]]} mode="line" onAdopt={onAdopt} />)
    expect(screen.queryByRole('button', { name: C.adoptLine })).toBeNull()
    rerender(<MeasurePanel {...base} mode="line" blocked hint="Zuerst kalibrieren" onAdopt={onAdopt} />)
    expect(screen.queryByRole('button', { name: C.adoptLine })).toBeNull()
  })

  it('is line-only — a measured Fläche offers its own action instead', () => {
    render(<MeasurePanel {...base} coords={flaeche} mode="area" onAdopt={vi.fn()} />)
    expect(screen.queryByRole('button', { name: C.adoptLine })).toBeNull()
  })
})

describe('MeasurePanel · automatic Kartenverknüpfung', () => {
  const base = { profile: null, profileLoading: false, showProfile: false } as const

  it('opens an empty linked Plan with only the automatic reference source', () => {
    const note = appConfig.copy.whiteboard.scale.chipAutoHint
    render(<MeasurePanel {...base} mode="line" coords={[]} scaleNote={note} />)
    expect(screen.getByRole('status').textContent).toBe(note)
    expect(screen.queryByText(C.hintLine)).toBeNull()
  })

  it('restores the point instruction once the first point has been placed', () => {
    const note = appConfig.copy.whiteboard.scale.chipAutoHint
    render(<MeasurePanel {...base} mode="line" coords={[strecke[0]]} scaleNote={note} />)
    expect(screen.getByText(C.hintLine)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe(note)
  })
})

// «Als Fläche übernehmen» — the twin of the line adopt, on the measure tool's area mode: the
// measured ring becomes a drawn Fläche. Same panel, so again both surfaces at once.
describe('MeasurePanel · Als Fläche übernehmen', () => {
  const base = { coords: flaeche, profile: null, profileLoading: false, showProfile: false } as const

  it('hands the measured ring over on tap', () => {
    const onAdopt = vi.fn()
    render(<MeasurePanel {...base} mode="area" onAdopt={onAdopt} />)
    fireEvent.click(screen.getByRole('button', { name: C.adoptArea }))
    expect(onAdopt).toHaveBeenCalledTimes(1)
  })

  it('is absent without the callback — a locked surface measures but never draws', () => {
    render(<MeasurePanel {...base} mode="area" />)
    expect(screen.queryByRole('button', { name: C.adoptArea })).toBeNull()
  })

  it('is absent while the measurement is only a hint (under 3 points / uncalibrated plan)', () => {
    const onAdopt = vi.fn()
    const { rerender } = render(<MeasurePanel {...base} coords={strecke} mode="area" onAdopt={onAdopt} />)
    expect(screen.queryByRole('button', { name: C.adoptArea })).toBeNull()
    rerender(<MeasurePanel {...base} mode="area" blocked hint="Zuerst kalibrieren" onAdopt={onAdopt} />)
    expect(screen.queryByRole('button', { name: C.adoptArea })).toBeNull()
  })

  it('is area-only — a measured Strecke offers the line action instead', () => {
    render(<MeasurePanel {...base} coords={strecke} mode="line" onAdopt={vi.fn()} />)
    expect(screen.queryByRole('button', { name: C.adoptArea })).toBeNull()
    expect(screen.getByRole('button', { name: C.adoptLine })).toBeTruthy()
  })
})

// ONE ROW (10.10.2026, owner's iPhone): the readout, the adopt action and the ▾ share a line, and
// what else the panel carries — the Höhenprofil, «Neu kalibrieren», the scale's source — folds
// behind that ▾. Before there is a measurement nothing folds: the calibration IS the next step.
describe('MeasurePanel · one row, the rest folded', () => {
  const base = { coords: strecke, profile: null, profileLoading: false, showProfile: false } as const
  const note = appConfig.copy.whiteboard.scale.chipAutoHint

  it('folds the scale note and the recalibration behind the row, and opens them on tap', () => {
    const onCalibrate = vi.fn()
    const { rerender } = render(<MeasurePanel {...base} mode="line" scaleNote={note} onAdopt={vi.fn()} />)
    const toggle = screen.getByRole('button', { expanded: false })
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByRole('status').textContent).toBe(note)
    // the adopt action is its own control on the row, not part of the toggle
    expect(toggle.contains(screen.getByRole('button', { name: C.adoptLine }))).toBe(false)
    rerender(<MeasurePanel {...base} mode="line" onCalibrate={onCalibrate} recalibrateLabel="Neu kalibrieren" />)
    fireEvent.click(screen.getByRole('button', { name: 'Neu kalibrieren' }))
    expect(onCalibrate).toHaveBeenCalledTimes(1)
  })

  it('folds the Höhenprofil the same way', () => {
    render(<MeasurePanel {...base} mode="line" showProfile profileLoading />)
    expect(screen.queryByText(C.profileLoading)).toBeNull()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText(C.profileLoading)).toBeTruthy()
  })

  it('is a plain readout with nothing to fold, and on a measured Fläche too', () => {
    const { rerender } = render(<MeasurePanel {...base} mode="line" onAdopt={vi.fn()} />)
    expect(screen.queryByRole('button', { expanded: false })).toBeNull()
    rerender(<MeasurePanel {...base} coords={flaeche} mode="area" scaleNote={note} onAdopt={vi.fn()} />)
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByRole('status').textContent).toBe(note)
  })

  it('keeps an uncalibrated Plan\'s «Kalibrieren» in view — nothing is measured yet', () => {
    render(<MeasurePanel {...base} mode="line" blocked hint="Zuerst kalibrieren" onCalibrate={vi.fn()} calibrateLabel="Kalibrieren" />)
    expect(screen.getByRole('button', { name: 'Kalibrieren' })).toBeTruthy()
    expect(screen.queryByRole('button', { expanded: false })).toBeNull()
  })
})
