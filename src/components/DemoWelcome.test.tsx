// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { applyLocale } from '../config/copy'
import { DemoWelcome } from './DemoWelcome'

afterEach(() => {
  cleanup()
  applyLocale('de-CH')
})

describe('DemoWelcome', () => {
  it('keeps the first visit to one compact set of essential facts', () => {
    applyLocale('de-CH')
    render(<DemoWelcome onClose={vi.fn()} />)

    expect(screen.getByRole('dialog', { name: 'Willkommen bei KP Front' })).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getByText(/Alle Besucher arbeiten gemeinsam/)).toBeTruthy()
    expect(screen.getByText(/Neue Einsätze sind gesperrt/)).toBeTruthy()
    expect(screen.queryByText('Gut zu wissen')).toBeNull()
  })

  it('enters the demo through the one primary action', () => {
    const onClose = vi.fn()
    render(<DemoWelcome onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Los geht’s' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
