// «Karte & Objekte» — the search (docs/karte-objekte.md · «The viewer»): the station's objects
// by name, alias and address (lib/karte/search), and addresses from the geocoder.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { focusWithoutPan } from '../../lib/iosKeyboard'
import { geocodeSearch, type GeoHit } from '../../lib/incidents'
import type { StationObject } from '../../lib/api/stationReference'
import { nearestObjects, searchObjects } from '../../lib/karte/search'
import type { LngLat } from '../../types'
import type { AddrState } from './KarteSearch'

/** The map's query and whether its list is open, and the Checkliste's own query (the same field
 *  in the bar, its own words — the map's stay for the way back). On a phone the field lives in a
 *  slide-up (review round 3, owner: «Einsätze ▾ + a search button», the sheet «like Ebenen», the
 *  keyboard right away): `sheetFieldRef` is its field, focused the moment the sheet opens.
 *  Addresses are asked from three letters, a beat after the typing stops, and only online. */
export function useKarteSearch(objects: readonly StationObject[], center: LngLat, online: boolean, phone: boolean) {
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [libQuery, setLibQuery] = useState('')
  const sheetFieldRef = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    if (phone && searchOpen) focusWithoutPan(sheetFieldRef.current)
  }, [phone, searchOpen])
  const [addr, setAddr] = useState<{ q: string; state: 'ok' | 'error'; list: GeoHit[] }>({ q: '', state: 'ok', list: [] })
  const q = query.trim()
  useEffect(() => {
    if (!online || q.length < 3) return
    let alive = true
    const t = setTimeout(() => {
      geocodeSearch(q, 6).then((list) => { if (alive) setAddr({ q, state: 'ok', list }) })
        .catch(() => { if (alive) setAddr({ q, state: 'error', list: [] }) })
    }, 250)
    return () => { alive = false; clearTimeout(t) }
  }, [q, online])
  const addrState: AddrState = !q ? 'idle' : !online ? 'offline' : q.length < 3 ? 'short' : addr.q !== q ? 'loading' : addr.state
  const hits = useMemo(() => searchObjects(objects, query, center), [objects, query, center])
  const nearest = useMemo(() => nearestObjects(objects, center), [objects, center])
  return {
    query, setQuery, searchOpen, setSearchOpen, libQuery, setLibQuery, sheetFieldRef,
    addrState, addresses: addrState === 'ok' ? addr.list : [], hits, nearest,
  }
}
