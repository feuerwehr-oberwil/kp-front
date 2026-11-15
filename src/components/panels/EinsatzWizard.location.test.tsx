// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { appConfig } from '../../config/appConfig'
import type { IncidentMeta, ObjectWithPlans } from '../../lib/incidents'

// The location on the Einsatz form (owner pick 1A, 15.11.2026): every method rides the address
// field, and the coordinate itself is no longer shown – only its ABSENCE is, as one warning line
// under the field. These pin that line and the «Aus Plänen» fold.

const OBJ = { id: 'o1', name: 'Tramdepot', address: 'Grenzweg 1, 9999 Musterdorf', lng: 7.56, lat: 47.49, plans: [] } as unknown as ObjectWithPlans

// the network and the map are not what is being tested
vi.mock('../../lib/incidents', () => ({
  createIncident: vi.fn(), patchIncident: vi.fn(),
  getIncident: vi.fn(() => Promise.resolve({ text: '' })),
  listObjects: vi.fn(() => Promise.resolve([OBJ])),
  geocodeSearch: vi.fn(() => Promise.resolve([])),
  geocodeReverse: vi.fn(() => Promise.resolve(null)),
}))
vi.mock('../MapPicker', () => ({ MapPicker: () => null }))
// the Sheet portals and traps focus; the field is plain markup inside it
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
const warning = () => screen.queryByText(ix.coordMissing)

describe('«Noch kein Standort»', () => {
  it('says nothing when the Einsatz has a coordinate', () => {
    render(<EinsatzWizard edit={meta({})} onClose={() => {}} onCreated={() => {}} />)
    expect(warning()).toBeNull()
  })

  // an address typed by hand is not a location: the warning follows the COORDINATE
  it('shows on an Einsatz with an address but no coordinate', () => {
    render(<EinsatzWizard edit={meta({ lng: null, lat: null })} onClose={() => {}} onCreated={() => {}} />)
    expect(warning()).toBeTruthy()
  })

  it('shows on a blank create, and goes once an object gives the form a coordinate', async () => {
    render(<EinsatzWizard onClose={() => {}} onCreated={() => {}} />)
    expect(warning()).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: ix.objectButton }))
    fireEvent.click(await screen.findByRole('button', { name: /Tramdepot/ }))
    expect(warning()).toBeNull()
  })
})

describe('«Aus Plänen» on the address field', () => {
  it('folds the object list open under the field and shut again', () => {
    render(<EinsatzWizard edit={meta({})} onClose={() => {}} onCreated={() => {}} />)
    const doc = screen.getByRole('button', { name: ix.objectButton })
    const search = () => screen.queryByLabelText(ix.objectSearchPlaceholder)
    expect(doc.getAttribute('aria-expanded')).toBe('false')
    expect(search()).toBeNull()
    fireEvent.click(doc)
    expect(doc.getAttribute('aria-expanded')).toBe('true')
    expect(doc.classList.contains('on')).toBe(true)
    expect(search()).toBeTruthy()
    fireEvent.click(doc)
    expect(doc.getAttribute('aria-expanded')).toBe('false')
    expect(search()).toBeNull()
  })
})
