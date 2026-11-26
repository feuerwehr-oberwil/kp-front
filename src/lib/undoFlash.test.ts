// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearUndoCaption, createSaveWait, flashUndoCaption } from './undoFlash'

const bubble = () => document.querySelector('.hold-tip')

// owner pick UX journeys M·11 (25.11.2026): «✓ gespeichert» once the server has the step
describe('flashUndoCaption', () => {
  let anchor: HTMLButtonElement
  beforeEach(() => { vi.useFakeTimers(); anchor = document.body.appendChild(document.createElement('button')) })
  afterEach(() => { clearUndoCaption(); anchor.remove(); vi.useRealTimers() })

  it('goes after its moment when nothing was sent', () => {
    flashUndoCaption(anchor, 'Rückgängig: TLF verschoben')
    expect(bubble()?.textContent).toBe('Rückgängig: TLF verschoben')
    vi.advanceTimersByTime(1500)
    expect(bubble()).toBeNull()
  })

  it('waits for the save, then says it and goes', () => {
    const flash = flashUndoCaption(anchor, 'Rückgängig: TLF verschoben')
    flash.holdForSave()
    vi.advanceTimersByTime(3000)
    expect(bubble()?.querySelector('.hold-tip-saved')).toBeNull()
    flash.saved()
    expect(bubble()?.querySelector('.hold-tip-saved')?.textContent).toBe('gespeichert')
    vi.advanceTimersByTime(1500)
    expect(bubble()).toBeNull()
  })

  it('claims nothing when the save never comes, nor for a caption already replaced', () => {
    const first = flashUndoCaption(anchor, 'Rückgängig: TLF verschoben')
    first.holdForSave()
    flashUndoCaption(anchor, 'Rückgängig: Feuer gesetzt')
    first.saved()
    expect(document.querySelector('.hold-tip-saved')).toBeNull()
    const second = flashUndoCaption(anchor, 'Rückgängig: Feuer gesetzt')
    second.holdForSave()
    vi.advanceTimersByTime(8100)
    expect(bubble()).toBeNull()
  })
})

describe('createSaveWait', () => {
  const flash = () => ({ holdForSave: vi.fn(), saved: vi.fn() })
  it('says «gespeichert» only once the step was seen pending and then synced', () => {
    const wait = createSaveWait()
    const f = flash()
    wait.watch(f)
    wait.status('pending')
    expect(f.holdForSave).toHaveBeenCalled()
    wait.status('synced')
    expect(f.saved).toHaveBeenCalledTimes(1)
  })
  it('counts a save already under way at the press', () => {
    const wait = createSaveWait()
    wait.status('pending')
    const f = flash()
    wait.watch(f)
    expect(f.holdForSave).toHaveBeenCalled()
    wait.status('synced')
    expect(f.saved).toHaveBeenCalled()
  })
  it('claims nothing offline', () => {
    const wait = createSaveWait()
    const f = flash()
    wait.watch(f)
    wait.status('pending')
    wait.status('offline')
    wait.status('synced')
    expect(f.saved).not.toHaveBeenCalled()
  })
})
