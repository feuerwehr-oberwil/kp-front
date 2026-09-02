// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { OfflineReadinessSheet } from './OfflineReadinessSheet'
import { appConfig } from '../../config/appConfig'

// The one thing pinned here: a running download has a way out. «Abbrechen» stands beside the
// percentage while the bar is up, calls the caller's abort, and is gone with the bar.

// installed-app view, so the readiness list (and the bar) renders instead of the browser card
vi.mock('../../lib/installPrompt', () => ({ isStandalone: () => true, getInstallPlatform: () => 'ios' }))
vi.mock('../../lib/storageBudget', () => ({ estimateStorage: async () => null, fmtBytes: (n: number) => `${n}` }))

const base = {
  onClose: () => {},
  probeUrls: { tiles: [], plan: null, references: [] },
  symbolsReady: true, planCount: 0, objectLabel: null,
  weatherOk: false, weatherError: false, personnelCount: 0,
  syncStatus: 'synced' as const, lastSyncedAt: null,
  onSyncNow: () => {}, onLoadAll: () => {}, onCancel: () => {},
}

afterEach(cleanup)

describe('OfflineReadinessSheet · Abbrechen', () => {
  it('offers «Abbrechen» beside the percentage while loading, and it aborts', () => {
    const onCancel = vi.fn()
    render(<OfflineReadinessSheet {...base} onCancel={onCancel} loading progress={{ done: 38, total: 100 }} />)
    expect(screen.getByText('38 %')).toBeTruthy()
    const cancel = screen.getByRole('button', { name: appConfig.copy.offline.cancel })
    expect(cancel.className).toMatch(/ghost/)
    fireEvent.click(cancel)
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('has no «Abbrechen» once nothing is loading — the button to start is back', () => {
    render(<OfflineReadinessSheet {...base} loading={false} progress={null} />)
    expect(screen.queryByRole('button', { name: appConfig.copy.offline.cancel })).toBeNull()
    expect(screen.getByRole('button', { name: new RegExp(appConfig.copy.offline.loadAll) })).toBeTruthy()
  })
})
