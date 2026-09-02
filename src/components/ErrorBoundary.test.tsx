// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ErrorBoundary } from './ErrorBoundary'
import { appConfig } from '../config/appConfig'
import { clearCrash, readCrash, recordCrash } from '../lib/crashLoop'

// The shell reset touches storage and reloads; both are stubbed so the test can assert WHICH keys
// go (only the two shell caches) and that nothing else does.
const idbDel = vi.fn(async (_key: string) => {})
vi.mock('../lib/idb', () => ({ idbDel: (k: string) => idbDel(k) }))

// This fallback IS the recovery surface. Before, its only action was «Neu laden» — which boot
// answers by auto-reopening the very incident that just crashed, so a data-driven throw became a
// loop with no way out (the landing list is unreachable while an incident is active, and the only
// cache-clearing UI is behind /admin). These tests pin the escalation: lossless escape always,
// destructive escape only once reopening has demonstrably failed.

const eb = appConfig.copy.errorBoundary

function Boom(): never {
  throw new Error('malformed anno')
}

// This project's jsdom env exposes no localStorage, so the crash streak needs the same minimal
// stub storageMigration.test.ts uses — without it recordCrash silently no-ops and the escalation
// assertions below would pass for the wrong reason.
function installLocalStorage() {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size },
  } as Storage
}

beforeEach(() => {
  installLocalStorage()
  clearCrash()
  // React logs caught render errors; keep the test output readable.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  clearCrash()
})

describe('ErrorBoundary — recovery affordances', () => {
  it('renders children when nothing throws', () => {
    render(<ErrorBoundary><div>live map</div></ErrorBoundary>)
    expect(screen.getByText('live map')).toBeTruthy()
  })

  it('shows only reload at the root (no incident scope to escape from)', () => {
    render(<ErrorBoundary><Boom /></ErrorBoundary>)
    expect(screen.getByText(eb.title)).toBeTruthy()
    expect(screen.getByRole('button', { name: eb.reload })).toBeTruthy()
    expect(screen.queryByRole('button', { name: eb.closeIncident })).toBeNull()
  })

  it('offers the lossless escape on a FIRST incident crash, and hides the destructive one', () => {
    const onCloseIncident = vi.fn()
    render(
      <ErrorBoundary scopeId="inc-1" onCloseIncident={onCloseIncident} onDiscardLocal={vi.fn()}>
        <Boom />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: eb.closeIncident }))
    expect(onCloseIncident).toHaveBeenCalledOnce()
    // discarding unsynced edits is far too destructive to offer before reopening was tried
    expect(screen.queryByRole('button', { name: eb.discardLocal })).toBeNull()
    expect(screen.getByText(eb.body)).toBeTruthy()
  })

  it('escalates on a REPEAT crash of the same incident: destructive escape + reworded body', () => {
    recordCrash('inc-1') // the crash before the reload the operator just did
    const onDiscardLocal = vi.fn()
    render(
      <ErrorBoundary scopeId="inc-1" onCloseIncident={vi.fn()} onDiscardLocal={onDiscardLocal}>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByText(eb.bodyRepeat)).toBeTruthy()
    expect(screen.getByText(eb.discardLocalHint)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: eb.discardLocal }))
    expect(onDiscardLocal).toHaveBeenCalledOnce()
  })

  it('does NOT escalate when the earlier crash was a different incident', () => {
    recordCrash('inc-other')
    render(
      <ErrorBoundary scopeId="inc-1" onCloseIncident={vi.fn()} onDiscardLocal={vi.fn()}>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.queryByRole('button', { name: eb.discardLocal })).toBeNull()
  })

  // The root has no incident to close, so its repeat used to say «Schliesse ihn» with no such
  // button. Now it offers the shell reset — and that reset may touch ONLY the two shell caches.
  it('offers «App zurücksetzen» on a repeat ROOT crash, clearing only the shell caches', async () => {
    recordCrash('')
    const reload = vi.fn()
    vi.stubGlobal('location', { ...location, reload })
    render(<ErrorBoundary><Boom /></ErrorBoundary>)
    expect(screen.getByText(eb.bodyRepeatRoot)).toBeTruthy()
    expect(screen.getByText(eb.resetShellHint)).toBeTruthy()
    const reset = screen.getByRole('button', { name: eb.resetShell })
    expect(reset.className).toMatch(/primary/)
    expect(screen.getByRole('button', { name: eb.reload }).className).not.toMatch(/primary/)
    fireEvent.click(reset)
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
    expect(idbDel.mock.calls.map(([k]) => k).sort()).toEqual(['kp-front-incidents', 'kp-front-user'])
    expect(readCrash()).toBeNull()
    vi.unstubAllGlobals()
  })

  it('does not offer the shell reset on a first root crash, nor inside an incident', () => {
    render(<ErrorBoundary><Boom /></ErrorBoundary>)
    expect(screen.queryByRole('button', { name: eb.resetShell })).toBeNull()
    cleanup()
    recordCrash('inc-1')
    render(<ErrorBoundary scopeId="inc-1" onCloseIncident={vi.fn()}><Boom /></ErrorBoundary>)
    expect(screen.queryByRole('button', { name: eb.resetShell })).toBeNull()
  })

  it('demotes reload from primary once it has provably failed', () => {
    recordCrash('inc-1')
    render(
      <ErrorBoundary scopeId="inc-1" onCloseIncident={vi.fn()} onDiscardLocal={vi.fn()}>
        <Boom />
      </ErrorBoundary>,
    )
    // on a repeat crash the escape becomes the primary action, not the reload that loops
    expect(screen.getByRole('button', { name: eb.reload }).className).not.toMatch(/primary/)
    expect(screen.getByRole('button', { name: eb.closeIncident }).className).toMatch(/primary/)
  })
})
