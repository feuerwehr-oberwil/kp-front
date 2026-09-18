// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { appConfig } from '../../config/appConfig'
import type { IncidentMeta } from '../../lib/incidents'

// ⚠️ The decision this file pins (owner, 18.09.2026): people enter an ADDRESS. The literal
// coordinate is what the address RESOLVED to, and it used to sit open on every intake and every
// correction — five decimal places nobody reads, with a ✕ beside them that silently clears the
// Einsatzort. It is behind a «Koordinaten» fold now, and the fold's default is the whole point:
// closed while the address answers «where», open whenever the coordinate is the only answer there
// is. A warning behind a fold is not a warning.

// the network and the map are not what is being tested
vi.mock('../../lib/incidents', () => ({
  createIncident: vi.fn(), patchIncident: vi.fn(),
  getIncident: vi.fn(() => Promise.resolve({ text: '' })),
  listObjects: vi.fn(() => Promise.resolve([])),
  geocodeSearch: vi.fn(() => Promise.resolve([])),
  geocodeReverse: vi.fn(() => Promise.resolve(null)),
}))
vi.mock('../MapPicker', () => ({ MapPicker: () => null }))
// Sheet portals and traps focus; the fold is a plain row inside it
vi.mock('./_shared', async (orig) => ({
  ...(await orig<typeof import('./_shared')>()),
  Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const { EinsatzWizard } = await import('./EinsatzWizard')

const ix = appConfig.copy.intake
afterEach(cleanup)

const BASE = {
  id: 'i1', title: 'Gebäudebrand Schulhaus', address: 'Schulstrasse 4' as string | null,
  started_at: '2026-09-18T03:14:00.000Z', lng: 7.55 as number | null, lat: 47.48 as number | null,
}
const meta = (over: Partial<typeof BASE>): IncidentMeta => ({ ...BASE, ...over }) as unknown as IncidentMeta

const open = () => screen.getByRole('button', { name: new RegExp(ix.coordFold) })

describe('the «Koordinaten» fold', () => {
  it('is closed on an Einsatz whose address already answers «where»', () => {
    render(<EinsatzWizard edit={meta({})} onClose={() => {}} onCreated={() => {}} />)
    expect(open().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(new RegExp(ix.coordSet))).toBeNull()
  })

  it('opens on the row and shows the same read-out, unchanged', () => {
    render(<EinsatzWizard edit={meta({})} onClose={() => {}} onCreated={() => {}} />)
    fireEvent.click(open())
    expect(open().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/47\.48000, 7\.55000/)).toBeTruthy()
    expect(screen.getByRole('button', { name: ix.coordClear })).toBeTruthy()
  })

  // no address ⇒ the coordinate IS the location, so it is not hidden behind anything
  it('stands open when there is no address', () => {
    render(<EinsatzWizard edit={meta({ address: null })} onClose={() => {}} onCreated={() => {}} />)
    expect(open().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/47\.48000, 7\.55000/)).toBeTruthy()
  })

  // ⚠️ …and an address that never resolved is the dangerous case: the Einsatz would open with no
  // coordinate at all, and «Kein Standort» is exactly the sentence that must not be folded away.
  it('stands open when the address resolved to no coordinate', () => {
    render(<EinsatzWizard edit={meta({ lng: null, lat: null })} onClose={() => {}} onCreated={() => {}} />)
    expect(open().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(ix.coordNone)).toBeTruthy()
  })

  // a blank create has neither yet — it opens, and closes itself once an address+coordinate stand
  it('starts open on a blank create', () => {
    render(<EinsatzWizard onClose={() => {}} onCreated={() => {}} />)
    expect(open().getAttribute('aria-expanded')).toBe('true')
  })

  // the derivation is a DEFAULT, not a rule: once the operator has worked the head it stays put
  it('keeps the operator\'s own choice over the derivation', () => {
    render(<EinsatzWizard edit={meta({})} onClose={() => {}} onCreated={() => {}} />)
    fireEvent.click(open())
    fireEvent.click(screen.getByRole('button', { name: ix.coordClear }))
    // the coordinate is gone, but the fold the operator opened has not slammed shut on them
    expect(open().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(ix.coordNone)).toBeTruthy()
  })
})
