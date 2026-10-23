// @vitest-environment jsdom
// THE tick row (20.10.2026, UX sweep F7). What is pinned is what a call site relies on without
// looking: box and label are ONE checkbox that says its state, a press hands the caller the
// toggle, a disabled row does nothing, and a box alone is still named.

import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TickRow } from './TickRow'

afterEach(cleanup)

function Live({ start = false }: { start?: boolean }) {
  const [on, setOn] = useState(start)
  return <TickRow checked={on} onToggle={() => setOn((v) => !v)}>Polizei</TickRow>
}

describe('TickRow', () => {
  it('is one checkbox named by its label, ticked and unticked by a press on the label', () => {
    render(<Live />)
    const row = screen.getByRole('checkbox', { name: 'Polizei' })
    expect(row.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByText('Polizei'))
    expect(row.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(row)
    expect(row.getAttribute('aria-checked')).toBe('false')
  })

  // Space and Enter are the platform's: it is a real <button type="button">, never a div with a
  // key handler, and it carries no aria-pressed beside aria-checked
  it('is a plain button, so the keyboard toggles it like any other', () => {
    render(<Live start />)
    const row = screen.getByRole('checkbox', { name: 'Polizei' })
    expect(row.tagName).toBe('BUTTON')
    expect(row.getAttribute('type')).toBe('button')
    expect(row.hasAttribute('aria-pressed')).toBe(false)
  })

  it('draws the ✓ only while ticked', () => {
    const { container, rerender } = render(<TickRow checked={false} onToggle={() => {}}>Polizei</TickRow>)
    expect(container.querySelector('use')).toBeNull()
    rerender(<TickRow checked onToggle={() => {}}>Polizei</TickRow>)
    expect(container.querySelector('use')?.getAttribute('href')).toBe('#check')
  })

  it('does nothing while disabled', () => {
    const onToggle = vi.fn()
    render(<TickRow checked={false} onToggle={onToggle} disabled>Polizei</TickRow>)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('stands as a box alone, named by aria-label', () => {
    const onToggle = vi.fn()
    render(<TickRow checked onToggle={onToggle} aria-label="Erledigt" />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Erledigt', checked: true }))
    expect(onToggle).toHaveBeenCalledOnce()
  })
})
