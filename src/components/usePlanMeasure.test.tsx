// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/ui', () => ({ toast: vi.fn() }))
vi.mock('../lib/stationPlanScale', () => ({ resolvePlanScale: () => null }))
import { toast } from '../lib/ui'
import { usePlanMeasure } from './usePlanMeasure'
import type { PlanScale } from '../lib/planScale'

// C9 (rare-user round 17.11.2026): a calibration somebody got wrong makes every metre on the plan
// wrong, so «Massstab kalibriert» carries «Rückgängig», which takes the calibration's own undo step
// back (workspace/planCalibration – what it puts back is tested there).

const args = (planScale: Record<string, PlanScale>, onCalibrate = vi.fn((): (() => boolean) => () => true), log = vi.fn(), setTool = vi.fn()) => ({
  activeId: 'modul1', stack: false, aspect: 1, tileAR: 1, planScale,
  localY: (y: number) => y, floorAt: () => 0, tool: 'measure' as const, setTool,
  toNorm: () => null, log, onCalibrate, canCalibrate: true,
})

afterEach(() => vi.clearAllMocks())

describe('usePlanMeasure · commitCalibration', () => {
  it('opens the length field empty, and «Rückgängig» on the toast takes the calibration step back', () => {
    const old: PlanScale = { mPerU: 2, refM: 20, ar: 1 }
    const takeBack = vi.fn(() => true)
    const onCalibrate = vi.fn(() => takeBack)
    const { result } = renderHook(() => usePlanMeasure(args({ modul1: old }, onCalibrate)))
    expect(result.current.lastRefM).toBeNull()
    act(() => { result.current.setCalPrompt({ a: [0, 0], b: [0.5, 0], why: true }) })
    act(() => { result.current.commitCalibration(10) })
    expect(onCalibrate).toHaveBeenCalledOnce()
    expect(onCalibrate).toHaveBeenLastCalledWith('modul1', expect.objectContaining({ refM: 10 }))
    expect(result.current.savePrompt).not.toBeNull()
    const [, opts] = vi.mocked(toast).mock.calls[0]
    act(() => { opts!.action!.onClick() })
    expect(takeBack).toHaveBeenCalledOnce()
    expect(onCalibrate).toHaveBeenCalledOnce()
    expect(result.current.savePrompt).toBeNull()
  })

  // hunt 24.11.2026, frontend-state F9: the toast put the old scale back unconditionally, so a
  // newer scale another tablet had set meanwhile was deleted
  it('declines once the step is gone, and writes nothing', () => {
    const onCalibrate = vi.fn((): (() => boolean) => () => false)
    const { result } = renderHook(() => usePlanMeasure(args({}, onCalibrate)))
    act(() => { result.current.setCalPrompt({ a: [0, 0], b: [0.5, 0] }) })
    act(() => { result.current.commitCalibration(10) })
    act(() => { vi.mocked(toast).mock.calls[0][1]!.action!.onClick() })
    expect(onCalibrate).toHaveBeenCalledOnce()
    expect(vi.mocked(toast)).toHaveBeenLastCalledWith('Nicht mehr rückgängig machbar', { icon: 'warn' })
    expect(result.current.savePrompt).not.toBeNull()
  })
})

// rare-user r4 (17.11.2026): Messen on a plan without a scale starts at «Massstab», and a scale
// once set goes on to «Strecke» – the user came to measure something
describe('usePlanMeasure · Messen without a scale', () => {
  const scale: PlanScale = { mPerU: 2, refM: 20, ar: 1 }

  it('lights «Massstab» by itself where the scale can be set, and the length dialog says why', () => {
    const setTool = vi.fn()
    const { result, rerender } = renderHook(({ tool }) => usePlanMeasure({ ...args({}, vi.fn(), vi.fn(), setTool), tool }),
      { initialProps: { tool: 'measure' as 'measure' | 'scale' } })
    expect(setTool).toHaveBeenLastCalledWith('scale')
    rerender({ tool: 'scale' })
    expect(result.current.calWhyRef.current).toBe(true)
  })

  it('leaves Messen alone on a plan with a scale, and on a locked surface', () => {
    const setTool = vi.fn()
    renderHook(() => usePlanMeasure(args({ modul1: scale }, vi.fn(), vi.fn(), setTool)))
    renderHook(() => usePlanMeasure({ ...args({}, vi.fn(), vi.fn(), setTool), canCalibrate: false }))
    expect(setTool).not.toHaveBeenCalled()
  })

  it('goes on to «Strecke» after a calibration', () => {
    const setTool = vi.fn()
    const { result } = renderHook(() => usePlanMeasure({ ...args({ modul1: scale }, vi.fn(), vi.fn(), setTool), tool: 'scale' }))
    act(() => { result.current.setMeasMode('area') })
    act(() => { result.current.setCalPrompt({ a: [0, 0], b: [0.5, 0] }) })
    act(() => { result.current.commitCalibration(10) })
    expect(setTool).toHaveBeenLastCalledWith('measure')
    expect(result.current.measMode).toBe('line')
  })

  it('«Abbrechen» in the length dialog goes back to step 1, «Massstab» still lit', () => {
    const setTool = vi.fn()
    const { result } = renderHook(() => usePlanMeasure({ ...args({}, vi.fn(), vi.fn(), setTool), tool: 'scale' }))
    act(() => { result.current.setCalPrompt({ a: [0, 0], b: [0.5, 0] }) })
    act(() => { result.current.closeCalPrompt() })
    expect(result.current.calPrompt).toBeNull()
    expect(setTool).not.toHaveBeenCalled()
  })
})
