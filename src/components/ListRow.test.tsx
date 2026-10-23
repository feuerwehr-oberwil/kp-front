// @vitest-environment jsdom
// THE list row and THE back row (20.10.2026). What is pinned is what a call site relies on without
// looking: a row that opens something is a button with the ›, a fact row is static without one,
// «where you are» is announced, and the back row names where it goes.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackRow, ListGroup, ListRow } from './ListRow'

afterEach(cleanup)

describe('ListRow', () => {
  it('opens on a press and carries the chevron when it has onClick', () => {
    const onClick = vi.fn()
    render(<ListRow title="Aufgaben FU" sub="3 Phasen" onClick={onClick} />)
    const row = screen.getByRole('button', { name: /Aufgaben FU/ })
    expect(row.getAttribute('type')).toBe('button')
    expect(row.querySelector('.list-row-chev')).not.toBeNull()
    fireEvent.click(row)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('is a static row without a chevron when it opens nothing', () => {
    const { container } = render(<ListRow title="Speicher" end="12 MB" />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.querySelector('.list-row-chev')).toBeNull()
    expect(container.querySelector('.list-row-end')?.textContent).toBe('12 MB')
  })

  it('says «where you are» with aria-current', () => {
    render(<ListRow title="TLF" on onClick={() => {}} />)
    const row = screen.getByRole('button', { name: /TLF/ })
    expect(row.getAttribute('aria-current')).toBe('true')
    expect(row.classList.contains('on')).toBe(true)
  })
})

describe('ListGroup', () => {
  it('is a labelled section with its rows on a card', () => {
    render(<ListGroup label="Checklisten" end="zum Lesen"><ListRow title="A" onClick={() => {}} /></ListGroup>)
    const group = screen.getByRole('region', { name: 'Checklisten' })
    expect(group.querySelector('.list-card .list-row')).not.toBeNull()
  })
})

describe('BackRow', () => {
  it('names the level it goes back to', () => {
    const onClick = vi.fn()
    render(<BackRow label="TLF" onClick={onClick} />)
    fireEvent.click(screen.getByRole('button', { name: 'TLF' }))
    expect(onClick).toHaveBeenCalledOnce()
  })
})
