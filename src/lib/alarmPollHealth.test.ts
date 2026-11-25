import { describe, expect, it } from 'vitest'
import { pollReadiness, READY_MAX_AGE_MS } from './alarmPollHealth'

describe('pollReadiness', () => {
  it('says nothing before any round has answered', () => {
    expect(pollReadiness({ okAt: null, failAt: null }, 1_000)).toBeNull()
  })

  it('is ready while the last good answer is younger than 60 s', () => {
    expect(pollReadiness({ okAt: 1_000, failAt: null }, 1_000 + READY_MAX_AGE_MS - 1)).toBe('ready')
    expect(pollReadiness({ okAt: 1_000, failAt: null }, 1_000 + READY_MAX_AGE_MS)).toBe('down')
  })

  it('a failed round after the good one is down at once; a good one after it is ready again', () => {
    expect(pollReadiness({ okAt: null, failAt: 500 }, 600)).toBe('down')
    expect(pollReadiness({ okAt: 1_000, failAt: 2_000 }, 2_100)).toBe('down')
    expect(pollReadiness({ okAt: 3_000, failAt: 2_000 }, 3_100)).toBe('ready')
  })
})
