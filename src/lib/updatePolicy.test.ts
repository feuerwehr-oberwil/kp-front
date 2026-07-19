import { describe, expect, it } from 'vitest'
import { autoApplyBudgetLeft, AUTO_APPLY_WINDOW_MS, BOOT_APPLY_WINDOW_MS, MAX_AUTO_APPLY_ATTEMPTS, recordAutoApply, shouldAutoApply, type AutoApplyRecord } from './updatePolicy'

describe('shouldAutoApply', () => {
  it('applies silently right after boot, untouched, first time', () => {
    expect(shouldAutoApply({ msSinceLoad: 2000, interacted: false, alreadyAutoApplied: false })).toBe(true)
  })

  it('never once the operator has interacted (mid-work reloads are forbidden)', () => {
    expect(shouldAutoApply({ msSinceLoad: 2000, interacted: true, alreadyAutoApplied: false })).toBe(false)
  })

  it('never outside the boot window', () => {
    expect(shouldAutoApply({ msSinceLoad: BOOT_APPLY_WINDOW_MS, interacted: false, alreadyAutoApplied: false })).toBe(false)
  })

  it('at most once per tab session (a broken build must not reload-loop)', () => {
    expect(shouldAutoApply({ msSinceLoad: 2000, interacted: false, alreadyAutoApplied: true })).toBe(false)
  })
})

describe('automatic-apply budget (persistent — sessionStorage resets across iOS reloads)', () => {
  const T0 = 1_750_000_000_000

  it('a fresh device has budget; spending attempts exhausts it at the cap', () => {
    let rec: AutoApplyRecord | null = null
    for (let i = 0; i < MAX_AUTO_APPLY_ATTEMPTS; i++) {
      expect(autoApplyBudgetLeft(rec, T0)).toBe(true)
      rec = recordAutoApply(rec, T0)
    }
    // the wedged-worker case: after the cap, NO further automatic applies — the operator
    // boots into the (old) working build with the banner instead of a cover loop
    expect(autoApplyBudgetLeft(rec, T0)).toBe(false)
    expect(autoApplyBudgetLeft(rec, T0 + 60_000)).toBe(false)
  })

  it('the budget window expiring earns a fresh budget (a later deploy can auto-apply again)', () => {
    let rec: AutoApplyRecord | null = null
    for (let i = 0; i < MAX_AUTO_APPLY_ATTEMPTS; i++) rec = recordAutoApply(rec, T0)
    const later = T0 + AUTO_APPLY_WINDOW_MS + 1
    expect(autoApplyBudgetLeft(rec, later)).toBe(true)
    expect(recordAutoApply(rec, later)).toEqual({ n: 1, at: later })
  })
})
