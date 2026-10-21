// The read view asks ONE question of the server's `lockedAt`: is this visit view-only now?

import { describe, expect, it } from 'vitest'
import { visitLocked } from './lock'

const now = Date.parse('2026-10-20T12:00:00Z')

describe('visitLocked', () => {
  it('locks from the moment the server named, not before', () => {
    expect(visitLocked('2026-10-20T11:59:59Z', now)).toBe(true)
    expect(visitLocked('2026-10-20T12:00:00Z', now)).toBe(true)
    expect(visitLocked('2026-10-20T12:00:01Z', now)).toBe(false)
  })

  it('never locks what the server did not lock', () => {
    // a draft, a discarded visit, a completion the server has not seen (finished offline), and
    // an older server that sends no such field at all
    expect(visitLocked(null, now)).toBe(false)
    expect(visitLocked(undefined, now)).toBe(false)
    expect(visitLocked('', now)).toBe(false)
    expect(visitLocked('irgendwann', now)).toBe(false)
  })
})
