import { describe, it, expect } from 'vitest'
import { resolvePlanScale, saveStationPlanScales } from './stationPlanScale'
import type { PlanScale } from './planScale'

// resolvePlanScale reads the module singleton; saveStationPlanScales updates it in place (the
// PUT is fire-and-forget over apiPut, which throws offline but the singleton is set first — we
// don't await it here). Each test seeds the singleton then resolves.
const AR = 1.414
const scale = (mPerU: number, ar = AR): PlanScale => ({ mPerU, refM: 20, ar })

async function seed(doc: { default: PlanScale | null; byPlan: Record<string, PlanScale> }) {
  try { await saveStationPlanScales(doc) } catch { /* offline PUT rejects; singleton is set */ }
}

describe('resolvePlanScale priority', () => {
  it('prefers the per-incident workspace scale over station layers', async () => {
    await seed({ default: scale(100), byPlan: { p1: scale(50) } })
    expect(resolvePlanScale('p1', scale(7), AR)?.mPerU).toBe(7)
  })

  it('falls back to the station per-plan override when no workspace scale', async () => {
    await seed({ default: scale(100), byPlan: { p1: scale(50) } })
    expect(resolvePlanScale('p1', undefined, AR)?.mPerU).toBe(50)
  })

  it('falls back to the station default when neither workspace nor per-plan exists', async () => {
    await seed({ default: scale(100), byPlan: {} })
    expect(resolvePlanScale('pX', undefined, AR)?.mPerU).toBe(100)
  })

  it('returns undefined when nothing is calibrated', async () => {
    await seed({ default: null, byPlan: {} })
    expect(resolvePlanScale('pX', undefined, AR)).toBeUndefined()
  })

  it('skips a stale candidate (aspect drift) and falls through to the next layer', async () => {
    // per-plan override derived at a very different aspect → stale for the current AR → skipped;
    // the default (matching AR) is used instead.
    await seed({ default: scale(100), byPlan: { p1: scale(50, 3.0) } })
    expect(resolvePlanScale('p1', undefined, AR)?.mPerU).toBe(100)
  })
})
