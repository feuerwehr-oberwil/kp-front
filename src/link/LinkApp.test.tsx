// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appConfig } from '../config/appConfig'
import { LINK_CLOSED_FOLLOW_MS, type LinkExchange } from '../lib/incidentLink'
import LinkApp from './LinkApp'

/* An Atemschutz-Link RELOADED while its Einsatz is closed (staging r6, F2, 26.09.2026). It used to
 * read the exchange's 404 as «the alarm has only just come in», spin, settle on «nicht abrufbar»
 * and stay there after «Wieder öffnen» until someone tapped «Erneut versuchen». Now the exchange
 * says «closed», the page shows that — with the time — and asks again once a minute on its own,
 * so the reopen brings the board back without a tap. */

const answers = vi.hoisted(() => ({ next: [] as LinkExchange[], calls: 0 }))
vi.mock('../lib/incidentLink', async () => {
  const actual = await vi.importActual<typeof import('../lib/incidentLink')>('../lib/incidentLink')
  const exchange = async (): Promise<LinkExchange> => {
    answers.calls += 1
    return answers.next.length > 1 ? answers.next.shift()! : answers.next[0]
  }
  return {
    ...actual,
    exchangeLinkToken: exchange,
    openIncidentLink: (token: string, opts: Parameters<typeof actual.openIncidentLink>[1] = {}) =>
      actual.openIncidentLink(token, { ...opts, exchange }),
  }
})
vi.mock('../App', () => ({ default: () => <div data-testid="the-board" /> }))
vi.mock('../lib/auth', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({ user: { id: 'link' }, loading: false, probeUnreachable: false }),
}))

const C = appConfig.copy.incidentLink
const closed: LinkExchange = { ok: false, reason: 'closed', closedAt: '2026-09-26T01:12:00Z' }

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  answers.next = []; answers.calls = 0
  window.history.replaceState(null, '', '/l/a-per-incident-secret')
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('a link reloaded on a closed Einsatz', () => {
  it('says «abgeschlossen» with the time, offers no retry, and opens the board by itself after the reopen', async () => {
    answers.next = [closed]
    render(<LinkApp />)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(screen.getByText(C.closedTitle)).toBeTruthy()
    expect(screen.getByText(C.closedHint)).toBeTruthy()
    expect(document.querySelector('[data-link-closed]')?.textContent).toMatch(/\d{2}:\d{2}/)
    // not the «eben erst eingetroffen» spinner, not «nicht abrufbar», and nothing to tap
    expect(screen.queryByText(C.pendingHint)).toBeNull()
    expect(screen.queryByText(C.notReadyTitle)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(answers.calls).toBe(1)

    // a minute later: still closed — same card, asked once more
    await act(async () => { await vi.advanceTimersByTimeAsync(LINK_CLOSED_FOLLOW_MS) })
    expect(answers.calls).toBe(2)
    expect(screen.getByText(C.closedTitle)).toBeTruthy()

    // «Wieder öffnen» on the Tafel — the next minute opens the board
    answers.next = [{ ok: true, incidentId: 'inc-1' }]
    await act(async () => { await vi.advanceTimersByTimeAsync(LINK_CLOSED_FOLLOW_MS) })
    expect(screen.getByTestId('the-board')).toBeTruthy()
    expect(screen.queryByText(C.closedTitle)).toBeNull()
  })

  it('a missed follow (no signal) keeps the closed card instead of an error', async () => {
    answers.next = [closed, { ok: false, reason: 'offline' }, closed]
    render(<LinkApp />)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    await act(async () => { await vi.advanceTimersByTimeAsync(LINK_CLOSED_FOLLOW_MS) })
    expect(screen.getByText(C.closedTitle)).toBeTruthy()
    expect(screen.queryByText(C.offlineTitle)).toBeNull()
  })
})
