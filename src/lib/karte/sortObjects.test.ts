import { describe, expect, it } from 'vitest'
import { sortObjects } from './places'
import { searchQuery } from '../search'

// THE order of an Objekt pick list (duck sweep LISTS.7, 17.11.2026): the Einsatz form put
// everything past one kilometre A–Z, «Anderes Objekt» kept the server's order
const o = (name: string, distance_m: number | null, address = '') => ({ name, distance_m, address })

describe('sortObjects', () => {
  it('nearest first all the way down, A–Z only between equals, no distance last', () => {
    const list = [o('Altersheim', 3000), o('Werkhof', null), o('Schulhaus', 2400), o('Tramdepot', 120)]
    expect(sortObjects(list, null).map((x) => x.name)).toEqual(['Tramdepot', 'Schulhaus', 'Altersheim', 'Werkhof'])
  })
  it('a name hit before an address-only hit while a query narrows', () => {
    const list = [o('Tramdepot', 50, 'Schulstrasse 1'), o('Schulhaus', 900, 'Hauptstrasse 4')]
    expect(sortObjects(list, searchQuery('schul')).map((x) => x.name)).toEqual(['Schulhaus', 'Tramdepot'])
  })
})
