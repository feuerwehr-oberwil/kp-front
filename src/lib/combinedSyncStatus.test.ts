import { describe, expect, it } from 'vitest'
import { combinedSyncStatus } from './combinedSyncStatus'

describe('combined operational save status', () => {
  it('does not let an acknowledged workspace hide rejected or undurable journal/audit data', () => {
    expect(combinedSyncStatus('synced', 'error', 'pending')).toBe('error')
    expect(combinedSyncStatus('offline', 'storage', 'error')).toBe('storage')
    expect(combinedSyncStatus('synced', 'synced', 'pending')).toBe('pending')
    expect(combinedSyncStatus('synced', 'synced', 'synced')).toBe('synced')
  })
})
