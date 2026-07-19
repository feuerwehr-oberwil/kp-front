import { describe, expect, it } from 'vitest'
import { nextPollDelay } from './pollBackoff'

const base = { baseMs: 2000, maxMs: 15000 }

describe('nextPollDelay', () => {
  it('polls at the base cadence right after a change (quietRounds 0)', () => {
    expect(nextPollDelay({ ...base, quietRounds: 0, hidden: false })).toBe(2000)
  })

  it('eases off exponentially while the incident stays quiet', () => {
    expect(nextPollDelay({ ...base, quietRounds: 1, hidden: false })).toBe(4000)
    expect(nextPollDelay({ ...base, quietRounds: 2, hidden: false })).toBe(8000)
    expect(nextPollDelay({ ...base, quietRounds: 3, hidden: false })).toBe(15000) // 16000 clamped to max
    expect(nextPollDelay({ ...base, quietRounds: 4, hidden: false })).toBe(15000)
  })

  it('never exceeds maxMs, even for a very long quiet spell (no overflow)', () => {
    expect(nextPollDelay({ ...base, quietRounds: 1000, hidden: false })).toBe(15000)
    expect(Number.isFinite(nextPollDelay({ ...base, quietRounds: 1000, hidden: false }))).toBe(true)
  })

  it('polls rarely while hidden, regardless of quietRounds', () => {
    expect(nextPollDelay({ ...base, quietRounds: 0, hidden: true })).toBe(60000)
    expect(nextPollDelay({ ...base, quietRounds: 9, hidden: true })).toBe(60000)
    expect(nextPollDelay({ ...base, quietRounds: 0, hidden: true, hiddenMs: 30000 })).toBe(30000)
  })
})
