import { useEffect, useMemo, useRef, useState } from 'react'
import Map, { Layer, Marker, NavigationControl, Source, type MapRef } from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import '../lib/maplibreWorker'
import { QuietAttributionControl } from '../components/MapAttribution'
import { ShellLoader } from '../components/ShellLoader'
import { appConfig } from '../config/appConfig'
import { ApiError, apiGet } from '../lib/api'
import { cartoRasterTiles } from '../lib/carto'
import { fillTemplate } from '../lib/format'
import { Icon } from '../lib/icons'
import { Sheet } from '../lib/overlays'
import type { ObjectWithPlans } from '../lib/incidents'
import { searchPlaces, setObjectPosition, undoObjectPosition, type OutlineMode, type PlaceHit, type SavedObject } from './stationDataApi'

// «Lage korrigieren» — the station's own word on where an Einsatzobjekt is (Karte & Objekte,
// review round 2, 17.10.2026: ARA Birsig stood 1.1 km off, in the wrong village). Lazy: MapLibre
// ships only to whoever opens it.
//
// Two ways to the place, both on one map: tap / drag the pin (an aerial by default — a pin is
// corrected against the roofs, not against a street map), or pick the address from the register
// (the region-biased search, its town said). Plus how the Karte outlines the object: automatic,
// only the building at the pin, or none. Saving marks the position station-set: no import, push
// or pull moves it again (backend api/objects · set_position), and «Rückgängig» takes it back.
// The outline itself is derived server-side by the footprint job a few minutes later; the red
// line on this map is the one the Karte shows TODAY.

const SWISSIMAGE = 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg'

const styleFor = (aerial: boolean) => ({
  version: 8 as const,
  sources: {
    base: aerial
      ? { type: 'raster' as const, tiles: [SWISSIMAGE], tileSize: 256, maxzoom: 20, attribution: '© swisstopo' }
      : { type: 'raster' as const, tiles: cartoRasterTiles('rastertiles/voyager'), tileSize: 256, attribution: '© CARTO, © OpenStreetMap-Mitwirkende' },
  },
  layers: [{ id: 'base', type: 'raster' as const, source: 'base' }],
})

const OUTLINES: OutlineMode[] = ['auto', 'building', 'none']
/** a pin farther than this from the register's address for it is worth a question */
const SUGGEST_M = 60

const streetKey = (s: string) => s.split(',')[0].normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/str\.(?=\s|\d|$)/g, 'strasse').replace(/[^a-z0-9]/g, '')
function distanceM(a: [number, number], b: [number, number]): number {
  const kx = 111_320 * Math.cos((a[1] * Math.PI) / 180)
  return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110_540)
}

export default function ObjectPositionSheet({ object, onClose, onSaved }: {
  object: ObjectWithPlans
  onClose: () => void
  /** after a save or an undo, with what the server stored */
  onSaved: (obj: SavedObject) => void
}) {
  const C = appConfig.copy.admin.objects
  const mapRef = useRef<MapRef | null>(null)
  const start = object.lat != null && object.lng != null ? ([object.lng, object.lat] as [number, number]) : null
  const [pin, setPin] = useState<[number, number] | null>(start)
  const [picked, setPicked] = useState<PlaceHit | null>(null)
  const [outline, setOutline] = useState<OutlineMode>(object.outline ?? 'auto')
  const [aerial, setAerial] = useState(true)
  const style = useMemo(() => styleFor(aerial), [aerial])
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<{ q: string; list: PlaceHit[] } | null>(null)
  const [state, setState] = useState<{ kind: 'idle' | 'busy' | 'saved' | 'undone' } | { kind: 'error'; detail: string }>({ kind: 'idle' })
  const [footprint, setFootprint] = useState<unknown>(null)
  // the register's own answer for the object's address: offered as «Dorthin» when the pin is far
  // from it (the ARA case — an address the import geocoded onto a fuzzy neighbour)
  const [suggest, setSuggest] = useState<PlaceHit | null>(null)
  useEffect(() => {
    const addr = object.address?.trim()
    if (!addr) return
    let alive = true
    searchPlaces(addr).then((list) => {
      const own = streetKey(addr)
      const hit = list.find((h) => streetKey(h.street) === own) ?? null
      if (alive && hit && (!start || distanceM(start, [hit.lng, hit.lat]) > SUGGEST_M)) setSuggest(hit)
    }).catch(() => {})
    return () => { alive = false }
    // once per object: the stored address is what is checked
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [object.id])

  // the outline the Karte shows today (the catalogue's footprint), for orientation only
  useEffect(() => {
    let alive = true
    apiGet<{ objects: { id: string; footprint: unknown }[] }>('/api/reference/objects')
      .then((r) => { if (alive) setFootprint(r.objects.find((o) => o.id === object.id)?.footprint ?? null) })
      .catch(() => {})
    return () => { alive = false }
  }, [object.id])

  useEffect(() => {
    const query = q.trim()
    if (query.length < 3) return
    let alive = true
    const t = window.setTimeout(() => {
      searchPlaces(query).then((list) => { if (alive) setHits({ q: query, list }) }).catch(() => { if (alive) setHits({ q: query, list: [] }) })
    }, 250)
    return () => { alive = false; window.clearTimeout(t) }
  }, [q])

  const move = (at: [number, number], hit: PlaceHit | null = null) => {
    setPin(at)
    setPicked(hit)
    if (state.kind !== 'busy') setState({ kind: 'idle' })
  }
  const pick = (h: PlaceHit) => {
    move([h.lng, h.lat], h)
    setQ(''); setHits(null)
    mapRef.current?.flyTo({ center: [h.lng, h.lat], zoom: Math.max(mapRef.current.getZoom(), 18), duration: 600 })
  }

  const save = async () => {
    if (!pin) return
    setState({ kind: 'busy' })
    try {
      const written = await setObjectPosition(object.id, {
        lat: Number(pin[1].toFixed(7)),
        lng: Number(pin[0].toFixed(7)),
        outline,
        ...(picked ? { address: picked.street, locality: picked.home ? null : picked.town } : {}),
      })
      onSaved(written)
      setState({ kind: 'saved' })
    } catch (e) {
      setState({ kind: 'error', detail: e instanceof ApiError ? e.detail : C.posFailed })
    }
  }
  const undo = async () => {
    setState({ kind: 'busy' })
    try {
      const written = await undoObjectPosition(object.id)
      onSaved(written)
      if (written.lat != null && written.lng != null) setPin([written.lng, written.lat])
      setOutline(written.outline ?? 'auto')
      setPicked(null)
      setState({ kind: 'undone' })
    } catch (e) {
      setState({ kind: 'error', detail: e instanceof ApiError ? e.detail : C.posFailed })
    }
  }

  const list = hits && hits.q === q.trim() ? hits.list : null
  const centre = pin ?? start ?? [7.5547, 47.5072]
  const outlineLabel: Record<OutlineMode, [string, string]> = {
    auto: [C.posOutlineAuto, C.posOutlineAutoSub],
    building: [C.posOutlineBuilding, C.posOutlineBuildingSub],
    none: [C.posOutlineNone, C.posOutlineNoneSub],
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={fillTemplate(C.posTitle, { name: object.name })}
      wide
      modal
      sheetClassName="adm-pos-sheet"
      footer={state.kind === 'saved' ? (
        <>
          <button type="button" className="ip-btn" onClick={() => void undo()}><Icon id="undo" />{C.posUndo}</button>
          <button type="button" className="ip-btn primary" onClick={onClose}>{C.posDone}</button>
        </>
      ) : (
        <>
          <button type="button" className="ip-btn" onClick={onClose}>{appConfig.copy.admin.common2.cancel}</button>
          <button type="button" className="ip-btn primary" disabled={!pin || state.kind === 'busy'} onClick={() => void save()}>
            {state.kind === 'busy' && <ShellLoader />}{state.kind === 'busy' ? C.saving : C.posSave}
          </button>
        </>
      )}
    >
      <p className="adm-hint">{C.posIntro}</p>
      {suggest && !(picked && picked.label === suggest.label) && (
        <div className="adm-pos-suggest" role="note">
          <Icon id="warn" />
          <span>{fillTemplate(C.posSuggest, { label: suggest.label, m: start ? Math.round(distanceM(start, [suggest.lng, suggest.lat])) : '—' })}</span>
          <button type="button" className="btn adm-int-btn" onClick={() => pick(suggest)}>{C.posSuggestGo}</button>
        </div>
      )}
      <div className="adm-pos-search">
        <input
          className="adm-input" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder={C.posSearch} aria-label={C.posSearch} type="search"
        />
        {q.trim().length >= 3 && list && (
          <ul className="adm-pos-hits" role="listbox" aria-label={C.posSearch}>
            {list.length === 0 && <li className="adm-hint">{C.posSearchNone}</li>}
            {list.map((h) => (
              <li key={`${h.label}|${h.lat}`}>
                <button type="button" role="option" aria-selected={false} onClick={() => pick(h)}>
                  <Icon id="pin" /><span>{h.street}<small>{h.town}{h.home ? '' : ` · ${C.posOtherTown}`}</small></span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="adm-pos-map">
        <Map
          ref={mapRef}
          initialViewState={{ longitude: centre[0], latitude: centre[1], zoom: start ? 17.5 : 13 }}
          mapStyle={style}
          style={{ width: '100%', height: '100%' }}
          attributionControl={false}
          onClick={(e) => move([e.lngLat.lng, e.lngLat.lat])}
        >
          <QuietAttributionControl />
          <NavigationControl position="top-right" showCompass={false} />
          {!!footprint && (
            <Source id="today" type="geojson" data={{ type: 'Feature', properties: {}, geometry: footprint as { type: 'MultiPolygon'; coordinates: number[][][][] } }}>
              <Layer id="today-line" type="line" paint={{ 'line-color': '#dc2626', 'line-width': 2.5, 'line-dasharray': [2, 1.5] }} />
            </Source>
          )}
          {start && pin && (start[0] !== pin[0] || start[1] !== pin[1]) && (
            <Marker longitude={start[0]} latitude={start[1]} anchor="center">
              <span className="adm-pos-was" title={C.posWas} />
            </Marker>
          )}
          {pin && (
            <Marker longitude={pin[0]} latitude={pin[1]} anchor="bottom" draggable onDragEnd={(e) => move([e.lngLat.lng, e.lngLat.lat])}>
              <span className="adm-obj-marker sel">
                <button type="button" className="adm-obj-pin" aria-label={C.posPin}><Icon id="pin" /></button>
              </span>
            </Marker>
          )}
          <button type="button" className="adm-obj-fit" onClick={() => setAerial((a) => !a)}>
            <Icon id="layers" />{aerial ? C.posMap : C.posAerial}
          </button>
        </Map>
      </div>
      <p className="adm-hint adm-pos-where">
        {picked ? fillTemplate(C.posPicked, { label: picked.label }) : pin ? fillTemplate(C.posAt, { lat: pin[1].toFixed(6), lng: pin[0].toFixed(6) }) : C.posNoPin}
        {!!footprint && <span className="adm-pos-legend"> · {C.posLegend}</span>}
      </p>
      <h3 className="adm-fieldgroup">{C.posOutline}</h3>
      <div className="adm-pos-seg" role="group" aria-label={C.posOutline}>
        {OUTLINES.map((m) => (
          <button key={m} type="button" aria-pressed={outline === m} onClick={() => { setOutline(m); if (state.kind !== 'busy') setState({ kind: 'idle' }) }}>
            <b>{outlineLabel[m][0]}</b><small>{outlineLabel[m][1]}</small>
          </button>
        ))}
      </div>
      <p role="status" className="adm-pos-status">
        {state.kind === 'saved' && <span className="adm-save-ok">{C.posSaved}</span>}
        {state.kind === 'undone' && <span className="adm-save-ok">{C.posUndone}</span>}
        {state.kind === 'error' && <span className="adm-state adm-state-err">{state.detail}</span>}
      </p>
    </Sheet>
  )
}
