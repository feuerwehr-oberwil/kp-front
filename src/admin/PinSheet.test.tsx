// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The two refusals the operator must meet in German, before anything reaches the server:
//  • the two entries disagree — a typo here locks somebody out of a fireground tablet;
//  • the PIN is one of the well-known weak ones. The SERVER refuses those too now
//    (auth/router._hash_pin_or_400 · security.TRIVIAL_PINS), so this one is a hint that saves a
//    round trip, not the guard — and the server's own German refusal is shown as it arrives.

const { apiPost, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    status: number
    detail: string
    constructor(status: number, detail: string) { super(detail); this.status = status; this.detail = detail }
  }
  return { apiPost: vi.fn(), ApiError }
})
vi.mock('../lib/api', () => ({ apiPost, ApiError }))

import { PinSheet } from './PinSheet'
import { appConfig } from '../config/appConfig'

const C = appConfig.copy.admin.members
const USER = { id: 'u1', display_name: 'Kunz Bea', color: null }

const type = (pin: string) => {
  for (const d of pin) fireEvent.click(screen.getByRole('button', { name: d }))
}
const nextBtn = () => screen.getByRole('button', { name: C.pinNext }) as HTMLButtonElement
const saveBtn = () => screen.getByRole('button', { name: C.pinSave }) as HTMLButtonElement

beforeEach(() => { vi.clearAllMocks(); apiPost.mockResolvedValue({}) })
afterEach(cleanup)

describe('PIN-Sheet', () => {
  it('refuses a trivial PIN in German instead of letting it through to the server', () => {
    render(<PinSheet user={USER} onClose={vi.fn()} onSaved={vi.fn()} />)
    type('123456')

    expect(screen.getByText(C.pinTrivial)).toBeTruthy()
    expect(nextBtn().disabled).toBe(true)

    // one backspace + a different last digit and the refusal is gone
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.login.clearDigit }))
    type('7')
    expect(screen.queryByText(C.pinTrivial)).toBeNull()
    expect(nextBtn().disabled).toBe(false)
  })

  it('refuses a mismatch, says so in German, and never posts', () => {
    render(<PinSheet user={USER} onClose={vi.fn()} onSaved={vi.fn()} />)
    type('481592')
    fireEvent.click(nextBtn())

    type('481593')
    expect(screen.getByText(C.pinMismatch)).toBeTruthy()
    expect(saveBtn().disabled).toBe(true)
    expect(apiPost).not.toHaveBeenCalled()
  })

  it('saves once both entries match', async () => {
    const onSaved = vi.fn()
    render(<PinSheet user={USER} onClose={vi.fn()} onSaved={onSaved} />)
    type('481592')
    fireEvent.click(nextBtn())
    type('481592')

    expect(screen.getByText(C.pinMatch)).toBeTruthy()
    fireEvent.click(saveBtn())

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(apiPost).toHaveBeenCalledWith('/api/auth/users/u1/pin', { pin: '481592' })
  })

  it('shows the server\'s refusal verbatim — it is already German', async () => {
    const detail = 'Diese PIN ist zu einfach – bitte eine andere wählen.'
    apiPost.mockRejectedValue(new ApiError(400, detail))
    render(<PinSheet user={USER} onClose={vi.fn()} onSaved={vi.fn()} />)
    type('481592')
    fireEvent.click(nextBtn())
    type('481592')
    fireEvent.click(saveBtn())

    await waitFor(() => expect(screen.getByText(detail)).toBeTruthy())
  })
})
