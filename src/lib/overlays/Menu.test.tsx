// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { Menu } from './Menu'

afterEach(cleanup)

describe('Menu', () => {
  it('opens on trigger click and renders its items', () => {
    render(<Menu trigger={<button>Aktionen</button>} items={[{ label: 'Umbenennen', onClick: vi.fn() }, { label: 'Löschen', onClick: vi.fn(), danger: true }]} />)
    expect(screen.queryByText('Umbenennen')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Aktionen' }))
    expect(screen.getByRole('menuitem', { name: 'Umbenennen' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Löschen' })).toBeTruthy()
  })

  it('runs the item onClick and closes on select', () => {
    const onClick = vi.fn()
    render(<Menu trigger={<button>Aktionen</button>} items={[{ label: 'Umbenennen', onClick }]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Aktionen' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Umbenennen' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menuitem', { name: 'Umbenennen' })).toBeNull()
  })

  it('does not fire onClick for a disabled item', () => {
    const onClick = vi.fn()
    render(<Menu trigger={<button>Aktionen</button>} items={[{ label: 'Gesperrt', onClick, disabled: true }]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Aktionen' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Gesperrt' }))
    expect(onClick).not.toHaveBeenCalled()
  })
})
