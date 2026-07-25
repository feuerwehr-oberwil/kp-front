// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { FeedbackPrompt } from './FeedbackPrompt'
import { FeedbackSheet } from './FeedbackSheet'
import { appConfig } from '../../config/appConfig'
import { readTrouble, type TroubleEvent } from '../../lib/trouble'

// The two guarantees worth pinning, because breaking either turns a helpful prompt into the
// thing the 3am tenet forbids:
//   1. Dismissing starts the cooldown — so this can never become a nag.
//   2. Nothing is sent. The operator sees the whole payload and decides.

const cp = appConfig.copy.feedback
const trouble: TroubleEvent = { kind: 'crashLoop', at: 1_800_000_000_000 }

// This project's jsdom env exposes no localStorage (see ErrorBoundary.test.tsx).
function installLocalStorage() {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage
}

beforeEach(installLocalStorage)
afterEach(cleanup)

describe('FeedbackPrompt', () => {
  it('asks about the specific thing that happened, not a generic "any feedback?"', () => {
    render(<FeedbackPrompt trouble={trouble} onOpen={() => {}} onDismiss={() => {}} />)
    expect(screen.getByText(cp.promptFor.crashLoop)).toBeTruthy()
  })

  it('starts the cooldown when dismissed, so the same crash cannot come back next week', () => {
    const onDismiss = vi.fn()
    render(<FeedbackPrompt trouble={trouble} onOpen={() => {}} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByText(cp.promptDismiss))
    expect(onDismiss).toHaveBeenCalled()
    expect(readTrouble().askedAt).toBeTypeOf('number')
  })
})

describe('FeedbackSheet', () => {
  it('shows the operator exactly what would be sent', () => {
    render(<FeedbackSheet trouble={trouble} onClose={() => {}} />)
    // the technical block is on screen, verbatim — the privacy promise is only credible if
    // it can be read
    const block = document.querySelector('.fb-tech-block')?.textContent ?? ''
    expect(block).toContain(appConfig.copy.feedback.tech.version)
    expect(block).toContain(appConfig.copy.feedback.tech.device)
    expect(screen.getByText(cp.techNote)).toBeTruthy()
  })

  it('carries the trouble question through from the prompt', () => {
    render(<FeedbackSheet trouble={trouble} onClose={() => {}} />)
    expect(screen.getByText(cp.promptFor.crashLoop)).toBeTruthy()
  })

  it('has no send button — nothing leaves the device on its own', () => {
    render(<FeedbackSheet onClose={() => {}} />)
    // only copy / mail / close: every one of them requires a deliberate tap, and `mail` hands
    // off to the operator's own client rather than posting anywhere.
    const labels = [...document.querySelectorAll('.fb-actions button')].map((b) => b.textContent?.trim())
    expect(labels).toHaveLength(3)
    expect(labels.join(' ')).toContain(cp.copy)
    expect(labels.join(' ')).toContain(cp.mail)
  })

  it('starts the cooldown when closed without sending', () => {
    const onClose = vi.fn()
    render(<FeedbackSheet trouble={trouble} onClose={onClose} />)
    fireEvent.click(screen.getByText(cp.close))
    expect(onClose).toHaveBeenCalled()
    expect(readTrouble().askedAt).toBeTypeOf('number')
  })

  it('drops the trouble question when opened from Einstellungen', () => {
    render(<FeedbackSheet onClose={() => {}} />)
    expect(screen.queryByText(cp.promptFor.crashLoop)).toBeNull()
    expect(screen.getByText(cp.intro)).toBeTruthy()
  })
})
