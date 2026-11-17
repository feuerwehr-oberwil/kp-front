// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/ui', () => ({ toast: vi.fn() }))
vi.mock('../lib/stationPlanScale', () => ({ resolvePlanScale: () => null }))
import { toast } from '../lib/ui'
import { usePlanMeasure } from './usePlanMeasure'
import type { PlanScale } from '../lib/planScale'

// C9 (rare-user round 17.11.2026): a calibration somebody got wrong makes every metre on the plan
// wrong, so «Massstab kalibriert» carries «Rückgängig», which puts back what the plan had.

const args = (planScale: Record<string, PlanScale>, onCalibrate = vi.fn(), log = vi.fn()) => ({
  activeId: 'modul1', stack: false, aspect: 1, tileAR: 1, planScale,
  localY: (y: number) => y, floorAt: () => 0, tool: 'measure' as const, setTool: vi.fn(),
  toNorm: () => null, log, onCalibrate,
})

afterEach(() => vi.clearAllMocks())

describe('usePlanMeasure · commitCalibration', () => {
  it('opens the length field empty, and «Rückgängig» on the toast restores the previous scale', () => {
    const old: PlanScale = { mPerU: 2, refM: 20, ar: 1 }
    const onCalibrate = vi.fn(), log = vi.fn()
    const { result } = renderHook(() => usePlanMeasure(args({ modul1: old }, onCalibrate, log)))
    expect(result.current.lastRefM).toBeNull()
    act(() => { result.current.setCalPrompt({ a: [0, 0], b: [0.5, 0], why: true }) })
    act(() => { result.current.commitCalibration(10) })
    expect(onCalibrate).toHaveBeenLastCalledWith('modul1', expect.objectContaining({ refM: 10 }))
    const [, opts] = vi.mocked(toast).mock.calls[0]
    act(() => { opts!.action!.onClick() })
    expect(onCalibrate).toHaveBeenLastCalledWith('modul1', old)
    expect(result.current.savePrompt).toBeNull()
    expect(log).toHaveBeenLastCalledWith('measure', 'Massstab zurückgenommen')
  })

  it('takes a first calibration back to none', () => {
    const onCalibrate = vi.fn()
    const { result } = renderHook(() => usePlanMeasure(args({}, onCalibrate)))
    act(() => { result.current.setCalPrompt({ a: [0, 0], b: [0.5, 0] }) })
    act(() => { result.current.commitCalibration(10) })
    act(() => { vi.mocked(toast).mock.calls[0][1]!.action!.onClick() })
    expect(onCalibrate).toHaveBeenLastCalledWith('modul1', null)
  })
})
