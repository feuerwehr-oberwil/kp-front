// «Karte & Objekte» — what the panel shows about the selected place (docs/karte-objekte.md ·
// «The viewer», «Die Häuser»): the building register, the tapped house's and the pin's address,
// the object's visits, and «In der Nähe» with its hydrants.

import { useEffect, useMemo, useState, type RefObject } from 'react'
import type { MapRef } from 'react-map-gl/maplibre'
import { geocodeReverse, type GeoHit } from '../../lib/incidents'
import { loadStationBuilding, type StationObject } from '../../lib/api/stationReference'
import { nearbyPlaces, objectAtAddress, pinNear, pointsFromGeoJson, splitAddress, type NamedPoint } from '../../lib/karte/places'
import type { Sel } from '../../lib/karte/selection'
import { listVisits } from '../../objectVisits/api'
import type { LayerDef, LngLat } from '../../types'
import type { HydrantCue, RegisterState, VisitsState } from './KartePanel'

/** The building register at the selected building or object (`point`), asked again by
 *  `retryRegister`. A building whose register address IS a catalogue object's opens that object
 *  instead (`setSel`) — never a house reached as one of an object's buildings (`of`: its level was
 *  chosen). */
export function useRegister(p: {
  sel: Sel | null
  selObj: StationObject | null
  point: LngLat | null
  lang: string
  objects: readonly StationObject[]
  byId: ReadonlyMap<string, StationObject>
  setSel: (fn: (cur: Sel | null) => Sel | null) => void
}) {
  const { sel, selObj, point, lang, objects, byId, setSel } = p
  const regKey = sel && sel.kind !== 'pin' && point ? `${point[0].toFixed(6)},${point[1].toFixed(6)}|${sel.kind === 'object' ? selObj?.address ?? '' : sel.address ?? ''}` : null
  const [reg, setReg] = useState<{ key: string; state: RegisterState } | null>(null)
  const [regTry, setRegTry] = useState(0)
  useEffect(() => {
    if (!regKey || !point || !sel || sel.kind === 'pin') return
    let alive = true
    const address = sel.kind === 'object' ? selObj?.address ?? null : sel.address
    void loadStationBuilding(point[1], point[0], address, lang).then((r) => {
      if (!alive) return
      setReg({ key: regKey, state: r ? { state: 'ok', info: r.value, cached: r.source !== 'network' } : { state: navigator.onLine ? 'error' : 'offline', info: null, cached: false } })
      if (r && sel.kind === 'building' && !sel.of) {
        const o = objectAtAddress(objects, r.value.address) ?? (r.value.object ? byId.get(r.value.object.id) : null)
        if (o) setSel((cur) => (cur === sel ? { kind: 'object', id: o.id } : cur))
      }
    })
    return () => { alive = false }
    // regKey is the identity of what is asked; `sel` itself is read for the switch above
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regKey, regTry, lang])
  const register: RegisterState = reg && reg.key === regKey ? reg.state : { state: 'loading', info: null, cached: false }
  return { register, retryRegister: () => setRegTry((n) => n + 1) }
}

/** The street of the house a tap hit (`at`), for the switch «Objekt | <Haus>» and the hydrant
 *  label — asked at the tapped point as a building tap asks (the same cached answer the house
 *  level then shows). Null until it answers. */
export function useHitStreet(at: LngLat | null, lang: string): string | null {
  const key = at ? `${at[0].toFixed(6)},${at[1].toFixed(6)}` : null
  const [hitAddr, setHitAddr] = useState<{ key: string; street: string | null } | null>(null)
  useEffect(() => {
    if (!key || !at) return
    let alive = true
    void loadStationBuilding(at[1], at[0], null, lang).then((r) => { if (alive) setHitAddr({ key, street: splitAddress(r?.value.address)[0] || null }) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key is the point
  }, [key, lang])
  return hitAddr && hitAddr.key === key ? hitAddr.street : null
}

/** A dropped pin's nearest address (online only): `pinHit` once the geocoder answered for this
 *  pin, `pinNearHit` its label and distance when it is near enough to name the pin (places · pinNear). */
export function usePinAddress(sel: Sel | null, online: boolean) {
  const [pinAddr, setPinAddr] = useState<{ key: string; hit: GeoHit | null; failed: boolean } | null>(null)
  const pinKey = sel?.kind === 'pin' ? `${sel.at[0].toFixed(6)},${sel.at[1].toFixed(6)}` : null
  useEffect(() => {
    if (!pinKey || sel?.kind !== 'pin' || !online) return
    let alive = true
    geocodeReverse(sel.at[1], sel.at[0]).then((hit) => { if (alive) setPinAddr({ key: pinKey, hit, failed: false }) })
      .catch(() => { if (alive) setPinAddr({ key: pinKey, hit: null, failed: true }) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pinKey is the pin
  }, [pinKey, online])
  const pinHit = pinAddr && pinAddr.key === pinKey ? pinAddr : null
  const pinNearHit = sel?.kind === 'pin' && pinHit ? pinNear(pinHit.hit, sel.at) : null
  return { pinHit, pinNearHit }
}

/** The selected object's last visits (without the discarded ones); `off` when the deployment has
 *  no Objektbesuche. */
export function useObjectVisits(objectId: string | null, enabled: boolean): VisitsState {
  const [visits, setVisits] = useState<{ id: string; state: VisitsState } | null>(null)
  const visitObjectId = enabled ? objectId : null
  useEffect(() => {
    if (!visitObjectId) return
    let alive = true
    listVisits({ object: visitObjectId, limit: 10 })
      .then((list) => { if (alive) setVisits({ id: visitObjectId, state: { state: 'ok', list: list.filter((v) => v.lifecycle !== 'discarded') } }) })
      .catch(() => { if (alive) setVisits({ id: visitObjectId, state: { state: 'error', list: [] } }) })
    return () => { alive = false }
  }, [visitObjectId])
  return !enabled ? { state: 'off', list: [] }
    : visits && visits.id === visitObjectId ? visits.state : { state: 'loading', list: [] }
}

/** The deployment's hydrant layer and its points, fetched once when first needed: for «In der
 *  Nähe» (`selected`), and for the mouse over the map's hydrants while their layer is on. */
export function useHydrants(layers: readonly LayerDef[], selected: boolean) {
  const hydrantLayer = useMemo(() => layers.find((l) => l.geojson && l.vectorKind === 'point' && /hydrant/i.test(`${l.id} ${l.label} ${l.symbol ?? ''}`)), [layers])
  const [hydrants, setHydrants] = useState<NamedPoint[]>([])
  const wantHydrants = !!hydrantLayer?.geojson && (selected || hydrantLayer.visible)
  useEffect(() => {
    if (!wantHydrants || !hydrantLayer?.geojson || hydrants.length) return
    let alive = true
    fetch(hydrantLayer.geojson, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((fc) => { if (alive) setHydrants(pointsFromGeoJson(fc, 'h')) })
      .catch(() => {})
    return () => { alive = false }
  }, [wantHydrants, hydrantLayer, hydrants.length])
  return { hydrantLayer, hydrants }
}

/** «In der Nähe»: ONE list by distance, objects and hydrants (lib/karte/places · nearbyPlaces),
 *  from `at`; a house never lists its own object (`exceptId`). */
export function useNearby(objects: readonly StationObject[], hydrants: readonly NamedPoint[], at: LngLat | null, exceptId: string | null) {
  const [px, py] = at ?? [null, null]
  return useMemo(() => (px != null && py != null ? nearbyPlaces(objects, hydrants, [px, py], { exceptId }) : []), [objects, hydrants, px, py, exceptId])
}

/** A hydrant of «In der Nähe» on the map (owner, Karte Haus round 1). The mouse over its row shows
 *  it while it stays there; a tap (touch) shows it until tapped again. Either way it belongs to
 *  the selection it was shown for — a new one clears it. A tap also switches the Hydranten Ebene
 *  on (`showLayer`), kept like a toggle in Ebenen (owner, Karte Haus round 2); the mouse passing
 *  over a row never changes the layers. */
export function useHydrantShown(sel: Sel | null, hydrants: readonly NamedPoint[], showLayer: () => void) {
  const [hydShown, setHydShown] = useState<{ sel: Sel; id: string; pinned: boolean } | null>(null)
  const shownHyd = hydShown && hydShown.sel === sel ? hydShown : null
  const onHydrant = (id: string, cue: HydrantCue) => {
    if (!sel) return
    if (cue === 'tap') {
      setHydShown(shownHyd?.id === id && shownHyd.pinned ? null : { sel, id, pinned: true })
      showLayer()
    }
    else if (cue === 'enter') { if (!shownHyd?.pinned) setHydShown({ sel, id, pinned: false }) }
    else if (shownHyd?.id === id && !shownHyd.pinned) setHydShown(null)
  }
  const hydPoint = shownHyd ? hydrants.find((h) => h.id === shownHyd.id) ?? null : null
  return { shownHyd, onHydrant, hydPoint }
}

/** The hydrant shown off-screen or under the panel: the map moves so both ends of its line (`from`,
 *  the selected place) are in view — once per hydrant shown. */
export function useFrameHydrant(mapRef: RefObject<MapRef | null>, rootRef: RefObject<HTMLDivElement | null>, p: { hydId: string | null; hydPoint: NamedPoint | null; from: LngLat | null; phone: boolean }) {
  const { hydId, hydPoint, from, phone } = p
  useEffect(() => {
    const map = mapRef.current
    const root = rootRef.current
    if (!hydId || !hydPoint || !from || !map || !root || typeof map.project !== 'function') return
    const [px, py] = from
    const box = map.getContainer().getBoundingClientRect()
    const panel = root.querySelector('[data-karte-panel]')?.getBoundingClientRect()
    // the free part of the map: under the bar, beside the tablet's panel / above the phone's sheet
    const free = { left: 0, top: 80, right: box.width - (phone ? 0 : 88), bottom: box.height }
    if (panel && phone) free.bottom = panel.top - box.top
    else if (panel) free.left = panel.right - box.left
    const q = map.project(hydPoint.coord)
    if (q.x > free.left + 24 && q.x < free.right - 24 && q.y > free.top + 24 && q.y < free.bottom - 24) return
    // both ends into the free part, zoomed out only as far as the line needs: its middle to the
    // free part's middle (an explicit zero padding, so the offset is the screen's own)
    const o = map.project([px, py])
    const fw = Math.max(40, free.right - free.left - 64), fh = Math.max(40, free.bottom - free.top - 64)
    const scale = Math.min(1, fw / Math.max(1, Math.abs(q.x - o.x)), fh / Math.max(1, Math.abs(q.y - o.y)))
    map.easeTo({
      center: [(px + hydPoint.coord[0]) / 2, (py + hydPoint.coord[1]) / 2],
      zoom: map.getZoom() + Math.log2(scale),
      padding: { top: 0, bottom: 0, left: 0, right: 0 },
      offset: [(free.left + free.right) / 2 - box.width / 2, (free.top + free.bottom) / 2 - box.height / 2],
      duration: 500,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per hydrant shown
  }, [hydId])
}
