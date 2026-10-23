// @vitest-environment jsdom
// The Rapport for a session that cannot edit it (viewer, view link, a closed Einsatz it may not
// correct): read-outs, never a disabled form (RBAC audit 22.10.2026, §3 «Rapport for viewer»).
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { appConfig } from '../config/appConfig'
import type { ReportMeta } from '../lib/workspace'

// jsdom cannot load maplibre-gl, which KrokiFramingPanel pulls in (see ReportLinks.test)
vi.mock('./KrokiFramingPanel', () => ({ KrokiFramingPanel: () => null }))

import { ReportPreflight } from './ReportPreflight'

beforeAll(() => {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})
afterEach(cleanup)

const INCIDENT = {
  id: 'i1', title: 'Brand Gebäude', address: 'Musterstrasse 3',
  started_at: '2026-08-14T19:42:00Z', closed_at: null,
} as unknown as React.ComponentProps<typeof ReportPreflight>['incident']

function setup(over: Partial<React.ComponentProps<typeof ReportPreflight>> = {}, reportMeta: ReportMeta = {}) {
  const onSaveMeta = vi.fn()
  render(
    <ReportPreflight incident={INCIDENT} events={[]} annotatedPlanCount={0} truppCount={0} attendanceCount={0}
      mittelCount={0} mapContentCount={0} onSaveMeta={onSaveMeta} onSign={() => {}} reportMeta={reportMeta} {...over} />,
  )
  return { onSaveMeta }
}

const P = appConfig.copy.preflight

describe('Rapport · a viewer reads values, it meets no doors', () => {
  it('draws no control the session cannot use – no field, «Jetzt», «Entfällt», ✕ or to-do chip', () => {
    setup({ canEdit: false })
    expect(screen.queryByPlaceholderText(P.summaryPlaceholder)).toBeNull()
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: P.now })).toBeNull()
    expect(screen.queryByRole('button', { name: P.entfaellt })).toBeNull()
    expect(screen.queryByText(/noch offen/)).toBeNull()
    // empty answers read «Nicht erfasst», like the dispatch block
    expect(screen.getAllByText(P.notRecorded).length).toBeGreaterThan(1)
  })

  it('shows what was recorded as words, and keeps the Kontaktperson’s call', () => {
    setup({ canEdit: false }, {
      summary: 'Zimmerbrand im 2. OG', einsatzleiter: 'Widmer Céline',
      kontaktperson: 'Frau Huber', kontaktpersonTelefon: '079 123 45 67',
    })
    expect(screen.getByText('Zimmerbrand im 2. OG')).toBeTruthy()
    expect(screen.getByText('Widmer Céline')).toBeTruthy()
    expect(screen.getByText('Frau Huber · 079 123 45 67')).toBeTruthy()
    expect(screen.getByRole('link', { name: P.kontaktpersonCall })).toBeTruthy()
  })

  it('an answered «Entfällt» stays, its undo does not', () => {
    setup({ canEdit: false }, { kontaktpersonNone: true })
    expect(screen.getByText(P.entfaellt)).toBeTruthy()
    expect(screen.queryByRole('button', { name: P.entfaelltUndo })).toBeNull()
  })

  it('asks a session that never signs for no signature', () => {
    setup({ canEdit: false })
    expect(screen.queryByText(appConfig.copy.signature.cardTitle)).toBeNull()
    expect(screen.queryByText(appConfig.copy.signature.runningHint)).toBeNull()
  })
})

describe('Rapport · «Nichts verwendet» is the el’s answer too', () => {
  it('is offered to a session that edits the Rapport without the Abschluss (no onComplete)', () => {
    const { onSaveMeta } = setup({ canEdit: true })
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.abschluss.mittelNone }))
    expect((onSaveMeta.mock.lastCall?.[0] as ReportMeta).mittelConfirmedNone).toBe(true)
  })

  it('reads as the answer, not a button, where the Rapport cannot be edited', () => {
    setup({ canEdit: false }, { mittelConfirmedNone: true })
    expect(screen.queryByRole('button', { name: appConfig.copy.abschluss.mittelNone })).toBeNull()
    expect(screen.getByText(appConfig.copy.abschluss.mittelNone)).toBeTruthy()
  })
})
