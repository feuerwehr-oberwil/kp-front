// @vitest-environment jsdom
// The search's «Objekte» group says why it has nothing at all – a missing catalogue is a
// standing state, said in place, not a sticky toast on the map (toast diet, 17.11.2026).
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { KarteSearch } from './KarteSearch'
import { appConfig } from '../../config/appConfig'

afterEach(cleanup)
const C = appConfig.copy.karte
const search = (objectsNote: string | null, query = '') => render(
  <KarteSearch query={query} hits={[]} nearest={[]} addresses={[]} addrState="idle" objectsNote={objectsNote}
    onPickObject={() => {}} onPickAddress={() => {}} />,
)

describe('KarteSearch · no catalogue', () => {
  it('says the catalogue is missing in the objects group, instead of «kein Objekt»', () => {
    search(C.noCatalogue, 'Schloss')
    expect(screen.getByRole('status').textContent).toBe(C.noCatalogue)
    expect(screen.queryByText(C.searchNoObject)).toBeNull()
  })
  it('says nothing of the kind while the catalogue is there', () => {
    search(null, 'Schloss')
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText(C.searchNoObject)).toBeTruthy()
  })
})
