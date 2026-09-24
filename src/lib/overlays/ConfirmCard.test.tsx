// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { ConfirmCard } from './ConfirmCard'

afterEach(cleanup)

const ask = { title: 'Abmelden?', message: 'Danach …', confirmLabel: 'Abmelden', cancelLabel: 'Abbrechen' }

describe('ConfirmCard · initial focus', () => {
  // a keyboard cover's Enter pressed «to get the dialog away» must not confirm a destructive ask
  it('focuses «Abbrechen» first on a danger ask', async () => {
    render(<ConfirmCard open {...ask} danger onResolve={vi.fn()} />)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Abbrechen' })))
  })

  it('focuses the confirm on an ordinary ask — the operator came here to do it', async () => {
    render(<ConfirmCard open {...ask} onResolve={vi.fn()} />)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Abmelden' })))
  })
})
