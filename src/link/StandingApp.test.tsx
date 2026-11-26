// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appConfig } from '../config/appConfig'
import StandingApp from './StandingApp'
import { exchangeTerminalSession } from '../lib/standingLink'

/* The two standing surfaces share one state machine but NOT one waiting screen (Entwurf B,
 * 09.09.): the depot terminal is the Stationsuhr while it waits, the laminated Atemschutz card
 * breathes. Both are read from across a room by somebody who did not open them — so which of
 * the two a page shows is a property of the credential, never of anything the holder does, and
 * that is exactly what this pins. */

vi.mock('../lib/standingLink', async () => {
  const actual = await vi.importActual<typeof import('../lib/standingLink')>('../lib/standingLink')
  return {
    ...actual,
    exchangeStandingToken: vi.fn(async () => ({ ok: true, resolution: { status: 'idle' } })),
    exchangeTerminalSession: vi.fn(async () => ({ ok: true, resolution: { status: 'idle' } })),
  }
})
// the app behind an «ok» answer is never reached here, but it is imported — keep it cheap
vi.mock('../App', () => ({ default: () => <div /> }))
// the session behind an «ok» answer: what its probe ended with is this file's to say
const auth = vi.hoisted(() => ({ state: { user: null as null | { id: string }, loading: false, probeUnreachable: false }, mounts: 0 }))
vi.mock('../lib/auth', async () => {
  const { useEffect } = await vi.importActual<typeof import('react')>('react')
  return {
    AuthProvider: ({ children }: { children: React.ReactNode }) => { useEffect(() => { auth.mounts++ }, []); return <>{children}</> },
    useAuth: () => auth.state,
  }
})

afterEach(cleanup)

const C = appConfig.copy.standingLink

describe('the standing waiting screen', () => {
  it('gives the enrolled terminal the Stationsuhr and its own sentence', async () => {
    render(<StandingApp token={null} />)
    await waitFor(() => { expect(screen.getByText(C.idleTitle)).toBeTruthy() })
    // a clock, not a ring — HH:MM off the device
    expect(document.querySelector('.sl-clock')?.textContent).toMatch(/^\d{2}:\d{2}$/)
    expect(document.querySelector('.sl-ring')).toBeNull()
    expect(screen.getByText(C.idleHintTerminal)).toBeTruthy()
    // …and the proof that the screen is not frozen: the timestamp of the poll that just answered
    expect(document.querySelector('.sl-checked')?.textContent).toContain(C.checkedLabel)
  })

  it('gives the laminated Atemschutz code the breathing ring and its own sentence', async () => {
    render(<StandingApp token="s-secret" />)
    await waitFor(() => { expect(screen.getByText(C.idleTitle)).toBeTruthy() })
    expect(document.querySelector('.sl-ring')).toBeTruthy()
    expect(document.querySelector('.sl-clock')).toBeNull()
    // «Sobald ein Einsatz ODER EINE ÜBUNG läuft» — the QR is what gets drilled, and the
    // terminal's «geht ein Alarm ein» would be the wrong answer on the Überwachungstafel
    expect(screen.getByText(C.idleHintAs)).toBeTruthy()
  })
})

describe('a session whose probe ended without a user', () => {
  it('offers the retry and starts the exchange again — the provider probes once per mount', async () => {
    vi.mocked(exchangeTerminalSession).mockResolvedValue({ ok: true, resolution: { status: 'ok', incidentId: 'inc-1' } })
    auth.state = { user: null, loading: false, probeUnreachable: true } // /me or the config read failed
    auth.mounts = 0
    render(<StandingApp token={null} />)
    const retry = await screen.findByRole('button', { name: appConfig.copy.incidentLink.retry })
    // the count is the provider's effect, which React runs after the commit that showed the
    // button – findByRole can answer between the two
    await waitFor(() => { expect(auth.mounts).toBe(1) })
    fireEvent.click(retry)
    await waitFor(() => { expect(auth.mounts).toBe(2) }) // a new mount is a new probe
  })
})
