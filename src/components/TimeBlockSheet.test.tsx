// @vitest-environment jsdom
//
// The block's delete is the bin, never a ✕ (UX sweep F1, 20.10.2026): the sheet's close ✕ sits
// two rows above it, and a look-alike that erases somebody's attendance is one tired tap away
// from the one that only closes.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TimeBlockSheet } from './TimeBlockSheet'
import { appConfig } from '../config/appConfig'

afterEach(cleanup)

function renderSheet(onRemove: () => void, onClose: () => void) {
  render(
    <TimeBlockSheet
      title="Zeiten" subject="Müller Hans" sectionTitle="Zeiten" emptyLabel="keine" onClose={onClose}
      labels={{ from: 'von', to: 'bis', remove: 'Zeit löschen', fromStart: 'ab Beginn', reopen: 'noch da', flip: 'umschalten' }}
      blocks={[{ key: 'a', from: '19:12', to: '21:40', head: { label: 'beendet', tone: 'done' as const }, onRemove }]}
    />,
  )
}

describe('TimeBlockSheet · deleting a block', () => {
  it('is the bin, and a different control from the close ✕', () => {
    const onRemove = vi.fn()
    const onClose = vi.fn()
    renderSheet(onRemove, onClose)
    const bin = screen.getByRole('button', { name: 'Zeit löschen – Müller Hans' })
    expect(bin.querySelector('use')?.getAttribute('href')).toBe('#trash')
    const close = screen.getByRole('button', { name: appConfig.copy.closeDialog })
    expect(close).not.toBe(bin)

    fireEvent.click(close)
    expect(onRemove).not.toHaveBeenCalled()
    fireEvent.click(bin)
    expect(onRemove).toHaveBeenCalledTimes(1)
  })
})
