// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'

const dismiss = vi.fn()
vi.mock('../lib/installPrompt', () => ({
  shouldShowBanner: () => true,
  onInstallStateChange: () => () => {},
  dismissInstallBanner: () => dismiss(),
}))

import { InstallBanner } from './InstallBanner'
import { Meldeleiste } from './Meldeleiste'
import { appConfig } from '../config/appConfig'

afterEach(cleanup)

// S10 (20.10.2026): the row had two ways to wave it away — a «Später» button that hid it for
// good, and nothing else — while every other row dismisses with its ✕. One dismiss, one word.
describe('InstallBanner', () => {
  it('dismisses with the strip’s ✕, not with a second button', () => {
    render(<><InstallBanner onOpenGuide={() => {}} /><Meldeleiste /></>)
    const row = document.querySelector('.ml .ml-row')!
    expect(row.querySelectorAll('.ml-act button')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.install.dismiss }))
    expect(dismiss).toHaveBeenCalledOnce()
    expect(row.querySelector('.ml-x')?.getAttribute('aria-label')).toBe('Ausblenden')
  })
})
