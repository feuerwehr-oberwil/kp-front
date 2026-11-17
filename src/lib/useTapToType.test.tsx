// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useTapToType } from './useTapToType'

afterEach(cleanup)

function Probe({ onCommit }: { onCommit: (v: number) => void }) {
  const edit = useTapToType({ min: 0, max: 320, onCommit })
  return edit.editing
    ? <input aria-label="wert" {...edit.inputProps} />
    : <button onClick={() => edit.start(300)}>300</button>
}

describe('tap-to-type numeric entry', () => {
  it('arrives with the seeded value SELECTED, so typing replaces it', () => {
    render(<Probe onCommit={() => {}} />)
    fireEvent.click(screen.getByRole('button'))
    const input = screen.getByLabelText('wert') as HTMLInputElement
    fireEvent.focus(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe('300'.length)
  })

  it('keeps the previous value when the field is left empty', () => {
    const onCommit = vi.fn()
    render(<Probe onCommit={onCommit} />)
    fireEvent.click(screen.getByRole('button'))
    const input = screen.getByLabelText('wert') as HTMLInputElement
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(onCommit).not.toHaveBeenCalled() // empty commits nothing — 300 stands
  })

  // Esc keeps what was typed and leaves the field, like tapping away (owner, 17.11.2026)
  it('commits what was typed on Escape and leaves the field', () => {
    const onCommit = vi.fn()
    render(<Probe onCommit={onCommit} />)
    fireEvent.click(screen.getByRole('button'))
    const input = screen.getByLabelText('wert') as HTMLInputElement
    input.focus()
    fireEvent.change(input, { target: { value: '180' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onCommit).toHaveBeenCalledWith(180)
    expect(screen.getByRole('button')).toBeTruthy()
  })

  it('commits a typed replacement, clamped', () => {
    const onCommit = vi.fn()
    render(<Probe onCommit={onCommit} />)
    fireEvent.click(screen.getByRole('button'))
    const input = screen.getByLabelText('wert') as HTMLInputElement
    fireEvent.change(input, { target: { value: '9999' } })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledWith(320)
  })
})
