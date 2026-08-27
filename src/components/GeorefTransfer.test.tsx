// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PlanDocument } from '../types'
import { GeorefTransfer } from './GeorefTransfer'

afterEach(cleanup)

const plan = (id: string, code: string): PlanDocument => ({
  id,
  code,
  title: `${code} Übersicht`,
  subtitle: '',
  imageUrl: `${id}.pdf`,
  orientation: 'landscape',
})

describe('Passung auf mehrere Module übertragen', () => {
  it('keeps the picker open, marks completed targets, and closes only through Fertig', async () => {
    const source = plan('m1', 'Modul 1')
    const target2 = { plan: plan('m2', 'Modul 2'), linked: false }
    const target3 = { plan: plan('m3', 'Modul 3'), linked: true }
    const onTransfer = vi.fn(async () => true)
    const onClose = vi.fn()
    const onDone = vi.fn()

    render(<GeorefTransfer source={source} targets={[target2, target3]}
      onTransfer={onTransfer} onClose={onClose} onDone={onDone} />)

    fireEvent.click(screen.getByRole('button', { name: /Modul 2/ }))
    await waitFor(() => expect(screen.getByText('übertragen')).toBeTruthy())

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect((screen.getByRole('button', { name: /Modul 2/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /Modul 3/ }) as HTMLButtonElement).disabled).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Fertig' }))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('returns to Passung when cancelled before a transfer', () => {
    const onClose = vi.fn()
    render(<GeorefTransfer source={plan('m1', 'Modul 1')}
      targets={[{ plan: plan('m2', 'Modul 2'), linked: false }]}
      onTransfer={async () => true} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
