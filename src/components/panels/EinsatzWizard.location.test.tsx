// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { appConfig } from '../../config/appConfig'
import { clearAllDrafts } from '../../lib/draftKeep'
import { fillTemplate } from '../../lib/format'
import type { GeoHit, IncidentMeta, ObjectWithPlans } from '../../lib/incidents'

// The location on the Einsatz form (owner picks 1A + round 2, 15.11.2026): every method rides the
// address field, ONE list under it holds the typed objects and addresses, and the coordinate itself
// is no longer shown – only its ABSENCE is, as one warning line under the field.

const obj = (id: string, name: string, address: string, distance_m: number) =>
  ({ id, name, address, distance_m, lng: 7.56, lat: 47.49, plans: [] }) as unknown as ObjectWithPlans
const DEPOT = obj('o1', 'Tramdepot', 'Grenzweg 1, 9999 Musterdorf', 120)
const SCHOOL = obj('o2', 'Schulhaus Mitte', 'Schulstrasse 4, 9999 Musterdorf', 2400)
const HIT: GeoHit = { label: 'Grenzweg 3, 9999 Musterdorf', lng: 7.561, lat: 47.491 } as GeoHit

// the network and the map are not what is being tested
vi.mock('../../lib/incidents', () => ({
  createIncident: vi.fn(), patchIncident: vi.fn(),
  getIncident: vi.fn(() => Promise.resolve({ text: '' })),
  listObjects: vi.fn(() => Promise.resolve([DEPOT, SCHOOL])),
  geocodeSearch: vi.fn(() => Promise.resolve([HIT])),
  geocodeReverse: vi.fn(() => Promise.resolve(null)),
}))
vi.mock('../MapPicker', () => ({ MapPicker: () => null }))
// the Sheet portals and traps focus; the field is plain markup inside it
vi.mock('./_shared', async (orig) => ({
  ...(await orig<typeof import('./_shared')>()),
  Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const { EinsatzWizard } = await import('./EinsatzWizard')
const { geocodeSearch } = await import('../../lib/incidents')

const ix = appConfig.copy.intake
// a typed address is kept as a draft (lib/draftKeep) – it must not open the next test's form
afterEach(() => { cleanup(); clearAllDrafts() })

const BASE = {
  id: 'i1', title: 'Gebäudebrand Schulhaus', address: 'Schulstrasse 4' as string | null,
  started_at: '2026-09-18T03:14:00.000Z', lng: 7.55 as number | null, lat: 47.48 as number | null,
}
const meta = (over: Partial<typeof BASE>): IncidentMeta => ({ ...BASE, ...over }) as unknown as IncidentMeta
const warning = () => screen.queryByText(ix.coordMissing)
const field = () => screen.getByPlaceholderText(ix.addressPlaceholder)
const group = (label: string) => screen.findByRole('region', { name: label })

describe('the one list under the address field', () => {
  it('shows the matching objects and the addresses for one query, objects first', async () => {
    render(<EinsatzWizard onClose={() => {}} onCreated={() => {}} />)
    fireEvent.change(field(), { target: { value: 'Grenzweg' } })
    const objects = await group(ix.objectsGroup)
    const addresses = await group(ix.addressGroup)
    expect(within(objects).getByRole('button', { name: /Tramdepot/ })).toBeTruthy()
    expect(within(objects).queryByRole('button', { name: /Schulhaus/ })).toBeNull()
    expect(addresses.contains(await screen.findByRole('button', { name: /Grenzweg 3/ }))).toBe(true)
    expect(objects.compareDocumentPosition(addresses) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // no second search field anywhere – the object picker's own went (round 2)
    expect(document.querySelector('.ui-search')).toBeNull()
  })

  // «Aus Plänen» went (owner, 15.11.2026: «the map and current location are enough») – an
  // object is found by typing, and a tap into the empty field drops no list over the form
  it('has no «Aus Plänen» button, and a tap into the empty field opens nothing', async () => {
    render(<EinsatzWizard onClose={() => {}} onCreated={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Aus Plänen' })).toBeNull()
    fireEvent.focus(field())
    await Promise.resolve()
    expect(screen.queryByRole('button', { name: /Tramdepot/ })).toBeNull()
  })
})

// Duck sweep LISTS.1, 17.11.2026: a failed lookup said «Keine Adresse gefunden»
describe('the address search tells «failed» from «nothing found»', () => {
  it('a failed lookup says so, and is not a no-hit line', async () => {
    vi.mocked(geocodeSearch).mockRejectedValueOnce(new Error('502'))
    render(<EinsatzWizard onClose={() => {}} onCreated={() => {}} />)
    fireEvent.change(field(), { target: { value: 'Hauptstrasse' } })
    expect(await screen.findByText(ix.addressFailed)).toBeTruthy()
    expect(screen.queryByText(/Keine Treffer/)).toBeNull()
  })
  it('an answer with nothing in it is the shared no-hit line', async () => {
    vi.mocked(geocodeSearch).mockResolvedValueOnce([])
    render(<EinsatzWizard onClose={() => {}} onCreated={() => {}} />)
    fireEvent.change(field(), { target: { value: 'Hauptstrasse' } })
    expect(await screen.findByText(fillTemplate(appConfig.copy.noHits, { q: 'Hauptstrasse' }))).toBeTruthy()
  })
})

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
    fireEvent.change(field(), { target: { value: 'Tramdepot' } })
    fireEvent.click(await screen.findByRole('button', { name: /Tramdepot/ }))
    expect(warning()).toBeNull()
    expect((field() as HTMLInputElement).value).toBe(DEPOT.address)
  })
})
