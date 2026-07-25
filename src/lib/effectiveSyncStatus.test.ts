import { describe, expect, it } from 'vitest'
import { effectiveSyncStatus, type SyncStatus } from './api/workspaceSync'

// The rule that decides whether a full storage bucket is shouted about or noted quietly. Getting
// it wrong in one direction hides the loss of an operator's work; in the other it cries wolf on a
// device that is syncing perfectly well, which at 3am is its own kind of harm.

describe('effectiveSyncStatus', () => {
  it('shouts when there are unsynced edits AND the cache refused them', () => {
    // this is the real jeopardy: "cached locally, will retry" is a promise we cannot keep
    expect(effectiveSyncStatus('pending', true, false)).toBe('storage')
    expect(effectiveSyncStatus('offline', true, false)).toBe('storage')
    expect(effectiveSyncStatus('error', true, false)).toBe('storage')
  })

  it('stays quiet when the server already has our latest', () => {
    // nothing is at risk right now — the device merely is not offline-READY, which the
    // Offline-Bereitschaft sheet reports instead
    expect(effectiveSyncStatus('synced', false, false)).toBe('synced')
  })

  it('passes every status through untouched while the cache is healthy', () => {
    const all: SyncStatus[] = ['synced', 'pending', 'offline', 'error']
    for (const s of all) {
      expect(effectiveSyncStatus(s, true, true)).toBe(s)
      expect(effectiveSyncStatus(s, false, true)).toBe(s)
    }
  })

  it('does not invent jeopardy from a refused cache alone', () => {
    expect(effectiveSyncStatus('pending', false, false)).toBe('pending')
  })
})
