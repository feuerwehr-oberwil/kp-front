import { describe, expect, it } from 'vitest'
import { AUTO_HEAL_WINDOW_MS, shouldAutoHeal } from './useGlRecovery'

// A lost WebGL context leaves the Lage map a blank rectangle inside fully-working chrome — it
// doesn't read as a crash, and before this the only cure was killing the app. Recovery rebuilds
// the map instance. The policy has to thread a needle: heal silently for the ordinary case (the
// iPad reclaimed the GPU while asleep, nobody was looking), but never remount in a loop when the
// GPU keeps dropping us — that would replace a blank map with a flickering one.

const T0 = 1_700_000_000_000

describe('shouldAutoHeal', () => {
  it('heals the first loss silently (no prior heal recorded)', () => {
    expect(shouldAutoHeal(null, T0)).toBe(true)
  })

  it('refuses a second silent heal inside the window — hand the operator the action instead', () => {
    expect(shouldAutoHeal(T0, T0 + 1_000)).toBe(false)
    expect(shouldAutoHeal(T0, T0 + AUTO_HEAL_WINDOW_MS)).toBe(false)
  })

  it('heals again once the window has passed (unrelated later loss)', () => {
    expect(shouldAutoHeal(T0, T0 + AUTO_HEAL_WINDOW_MS + 1)).toBe(true)
  })

  it('never loops: repeated immediate losses all resolve to manual', () => {
    let last: number | null = null
    const decisions: boolean[] = []
    for (let i = 0; i < 5; i++) {
      const now = T0 + i * 500
      const auto = shouldAutoHeal(last, now)
      decisions.push(auto)
      if (auto) last = now
    }
    // exactly one silent remount, then manual for the rest of the burst
    expect(decisions.filter(Boolean)).toHaveLength(1)
    expect(decisions[0]).toBe(true)
  })
})
