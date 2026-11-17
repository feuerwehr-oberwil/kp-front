// @vitest-environment jsdom
// A correction in the player is never thrown away by a way out (owner, 17.11.2026 – duck sweep
// FEEDBACK.8): its ✕ and Esc save the words, as ✓ does.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AudioPlayerSheet } from './AudioPlayerSheet'
import type { TimelineEvent } from '../types'

afterEach(cleanup)
beforeAll(() => {
  // no media in jsdom: an inert element is all the sheet needs to render its rows
  vi.stubGlobal('Audio', class { preload = ''; addEventListener() {} removeEventListener() {} pause() {} play() { return Promise.resolve() } })
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext']
})

const memo = {
  id: 'r1', at: '2026-11-17T01:00:00.000Z', text: 'Sprachnotiz', audioUrl: 'blob:x',
  audioMeta: { source: 'recorded', startedAt: '2026-11-17T01:00:00.000Z', durationSec: 8 },
  transcriptSections: [{ id: 's1', at: 2, text: 'Trupp 1 rein' }],
} as unknown as TimelineEvent

const open = () => {
  const onEditSection = vi.fn()
  render(<AudioPlayerSheet row={memo} events={[memo]} readOnly={false} serverPeaks={false} canTranscribe={false}
    onAddSection={vi.fn()} onEditSection={onEditSection} onClose={vi.fn()} />)
  fireEvent.click(screen.getByText('Trupp 1 rein'))
  const field = document.querySelector<HTMLInputElement>('.ap-row-input')!
  fireEvent.change(field, { target: { value: 'Trupp 2 rein' } })
  return { onEditSection, field }
}

describe('AudioPlayerSheet · a correction', () => {
  it('its ✕ saves the typed words', () => {
    const { onEditSection } = open()
    fireEvent.click(document.querySelector('.ap-row-editing .ip-x')!)
    expect(onEditSection).toHaveBeenCalledWith('s1', 'Trupp 2 rein')
  })

  it('Esc in it keeps the words and leaves the row', () => {
    const { onEditSection, field } = open()
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(onEditSection).toHaveBeenCalledWith('s1', 'Trupp 2 rein')
    expect(document.querySelector('.ap-row-editing')).toBeNull()
  })
})
