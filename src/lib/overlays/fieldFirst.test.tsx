// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { Sheet } from './Sheet'
import { Overlay } from './Overlay'
import { isTextField } from './fieldFirst'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

// appConfig.copy.closeDialog === 'Schliessen' (de base catalogue)
const CLOSE = 'Schliessen'

/** One tap: the press, then its click — what a finger on the ✕ / the backdrop sends. */
function tap(el: Element, pointerType = 'touch') {
  fireEvent.pointerDown(el, { pointerType })
  fireEvent.mouseDown(el)
  fireEvent.click(el)
}

describe('the keyboard goes first (fieldFirst)', () => {
  it('a first ✕ with a field focused only blurs it; the second closes', () => {
    const onClose = vi.fn()
    render(<Sheet open onClose={onClose} title="Trupp anmelden"><input aria-label="Suche" /></Sheet>)
    const input = screen.getByRole('textbox', { name: 'Suche' })
    input.focus()
    tap(screen.getByRole('button', { name: CLOSE }))
    expect(onClose).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(input)
    tap(screen.getByRole('button', { name: CLOSE }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a first tap outside with a field focused only blurs it; the second closes', () => {
    const onClose = vi.fn()
    render(<Sheet open onClose={onClose} title="T"><textarea aria-label="Notiz" /></Sheet>)
    const field = screen.getByRole('textbox', { name: 'Notiz' })
    // past the opening echo's grace window (dismissGrace), or the first outside press is vetoed there
    const later = Date.now() + 1000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    field.focus()
    tap(document.body)
    expect(onClose).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(field)
    tap(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes at once with no field focused, and on a mouse (no on-screen keyboard)', () => {
    const onClose = vi.fn()
    render(<Sheet open onClose={onClose} title="T"><input aria-label="Suche" /></Sheet>)
    tap(screen.getByRole('button', { name: CLOSE }))
    expect(onClose).toHaveBeenCalledTimes(1)
    screen.getByRole('textbox', { name: 'Suche' }).focus()
    tap(screen.getByRole('button', { name: CLOSE }), 'mouse')
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  // the Trupp form's case: a bespoke frame whose head ✕ calls onClose itself
  it('catches a bespoke frame’s own head ✕, and leaves its other ✕ buttons alone', () => {
    const onClose = vi.fn()
    const onRowCancel = vi.fn()
    render(
      <Overlay open onClose={onClose} className="ip-sheet ui-dialog" ariaLabel="Trupp anmelden">
        <div className="ip-head"><button className="ip-x" aria-label="Abbrechen" onClick={onClose}>✕</button></div>
        <input aria-label="Person" />
        <button className="ip-x" aria-label="Zeile verwerfen" onClick={onRowCancel}>✕</button>
      </Overlay>,
    )
    const input = screen.getByRole('textbox', { name: 'Person' })
    input.focus()
    tap(screen.getByRole('button', { name: 'Zeile verwerfen' }))
    expect(onRowCancel).toHaveBeenCalledTimes(1)
    input.focus()
    tap(screen.getByRole('button', { name: 'Abbrechen' }))
    expect(onClose).not.toHaveBeenCalled()
    tap(screen.getByRole('button', { name: 'Abbrechen' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('counts only fields that raise a keyboard', () => {
    const el = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild }
    expect(isTextField(el('<input type="search">'))).toBe(true)
    expect(isTextField(el('<input>'))).toBe(true)
    expect(isTextField(el('<textarea></textarea>'))).toBe(true)
    expect(isTextField(el('<input type="checkbox">'))).toBe(false)
    expect(isTextField(el('<input readonly>'))).toBe(false)
    expect(isTextField(el('<button></button>'))).toBe(false)
  })
})
