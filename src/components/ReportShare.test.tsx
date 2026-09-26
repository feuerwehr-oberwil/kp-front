// @vitest-environment jsdom
import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { appConfig } from '../config/appConfig'

// The «Weitergeben» section is the Einsatz's share sheet inline, and that sheet asks the server
// for both links on mount. Stubbed so the test can count those questions.
const fetchShareLink = vi.fn(async () => ({ enabled: false, token: null }))
vi.mock('../lib/viewLink', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/viewLink')>()),
  fetchShareLink: (...a: unknown[]) => fetchShareLink(...(a as [])),
}))
// ReportPreflight imports KrokiFramingPanel statically, which pulls maplibre-gl in; jsdom cannot
// load it (see ReportLinks.test.tsx)
vi.mock('./KrokiFramingPanel', () => ({ KrokiFramingPanel: () => null }))

import { ReportPreflight } from './ReportPreflight'

beforeAll(() => {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})
afterEach(() => { cleanup(); fetchShareLink.mockClear() })

const INCIDENT = {
  id: 'i1', title: 'Brand Gebäude', address: 'Musterstrasse 3',
  started_at: '2026-08-14T19:42:00Z', closed_at: null, is_archived: false,
} as unknown as React.ComponentProps<typeof ReportPreflight>['incident']

const setup = (over: Partial<React.ComponentProps<typeof ReportPreflight>> = {}) => render(
  <ReportPreflight
    incident={INCIDENT} reportMeta={{}} events={[]} annotatedPlanCount={0} truppCount={0}
    attendanceCount={0} mittelCount={0} mapContentCount={0} onSaveMeta={() => {}}
    {...over}
  />,
)

describe('Rapport · «Weitergeben» belongs to whoever may hand a link out', () => {
  it('an editor sees it, and the sheet asks for its links', () => {
    setup({ canEdit: true, canShare: true })
    expect(screen.getByText(appConfig.copy.preflight.shareHead)).toBeTruthy()
    expect(fetchShareLink).toHaveBeenCalled()
  })

  it('⚠️ the el role keeps the record (canEdit) but gets no section — and asks the server nothing', () => {
    // 3am test, 25.09.2026: the section mounted for `canEdit` and fired GET view-link and GET
    // atemschutz-link, two 403s on every open of the el's Einsatz tab
    setup({ canEdit: true, canShare: false })
    expect(screen.queryByText(appConfig.copy.preflight.shareHead)).toBeNull()
    expect(fetchShareLink).not.toHaveBeenCalled()
  })
})
