import { afterEach, describe, expect, it, vi } from 'vitest'
import { newId } from './ids'

afterEach(() => { vi.useRealTimers() })

describe('newId', () => {
  // The whole reason this exists: `d${Date.now()}` gave two drawings finished inside one
  // millisecond the SAME id, and the workspace merge then treated them as one record.
  it('mints distinct ids within one millisecond', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-02T10:00:00Z'))
    const ids = Array.from({ length: 500 }, () => newId('d'))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps the prefix, the timestamp and a URL/storage-safe charset', () => {
    vi.useFakeTimers()
    const at = new Date('2026-09-02T10:00:00Z')
    vi.setSystemTime(at)
    const id = newId('sh')
    expect(id.startsWith(`sh${at.getTime()}`)).toBe(true)
    expect(id).toMatch(/^[a-z0-9-]+$/)
  })
})
