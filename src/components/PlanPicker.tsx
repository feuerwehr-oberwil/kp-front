import { useEffect, useMemo, useRef, useState } from 'react'
import Map, { Marker, type MapRef } from 'react-map-gl/maplibre'
import { QuietAttributionControl } from './MapAttribution'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { confirmDialog } from '../lib/ui'
import { fillTemplate } from '../lib/format'
import { fmtDistance } from '../lib/geo'
import { listObjects, type ObjectWithPlans } from '../lib/incidents'
import { Overlay } from '../lib/overlays'
import type { LngLat } from '../types'

// Carto Voyager — the app's default basemap (see demoIncident base-carto), so the
// mini-map matches the Lagekarte look.
const BASE_STYLE = {
  version: 8 as const,
  sources: {
    carto: {
      type: 'raster' as const,
      tiles: ['https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', 'https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© CARTO, © OpenStreetMap-Mitwirkende',
    },
  },
  layers: [{ id: 'carto', type: 'raster' as const, source: 'carto' }],
}

const pdfCount = (o: ObjectWithPlans) => o.plans.filter((p) => p.kind === 'pdf' && p.module).length

interface Props {
  /** the incident location — centres the mini-map */
  center: LngLat
  /** id of the currently active object (auto-surfaced or manually picked), to mark it */
  activeObjectId?: string | null
  onSelect: (obj: ObjectWithPlans) => void
  /** revert to the auto-surfaced nearest object — shown only when an object is manually picked */
  onReset?: () => void
  onClose: () => void
}

/**
 * Manually pick ANY Einsatzobjekt to surface its module plans, overriding the
 * auto-surfaced nearest object. The searchable list is the primary, reliable path
 * (some object coords are imprecise); the mini-map is a supporting aid. On a phone
 * the map collapses to keep the list usable at narrow widths.
 */
export function PlanPicker({ center, activeObjectId, onSelect, onReset, onClose }: Props) {
  const pp = appConfig.copy.planPicker
  const [q, setQ] = useState('')
  const [objects, setObjects] = useState<ObjectWithPlans[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [hoverId, setHoverId] = useState<string | null>(null)
  // the mini-map is shown by default (helps disambiguate objects by location); it can be
  // collapsed via the toggle below to give the list the full width on a narrow screen.
  const [mapOpen, setMapOpen] = useState(true)
  const mapRef = useRef<MapRef>(null)
  const searchRef = useRef<HTMLInputElement>(null) // Base UI initial focus → the search box (not the close button)

  // load near the incident so distance_m comes back ranked; the text filter is applied
  // client-side so typing is instant (the 155-object list is small).
  useEffect(() => {
    let alive = true
    setLoading(true)
    listObjects(undefined, `${center[0]},${center[1]}`)
      .then((objs) => { if (alive) { setObjects(objs); setError(false) } })
      .catch(() => { if (alive) setError(true) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [center])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return objects
    return objects.filter((o) =>
      o.name.toLowerCase().includes(needle) || (o.address ?? '').toLowerCase().includes(needle))
  }, [objects, q])

  const withCoords = useMemo(() => filtered.filter((o) => o.lat != null && o.lng != null), [filtered])

  // Selecting an object swaps the plans of EVERY module at once. A stray tap (easy on a
  // crowded list or a map pin) would silently replace the active object's plans, so the
  // switch is confirmed first. Re-picking the already-active object is a no-op → no prompt.
  const choose = async (o: ObjectWithPlans) => {
    if (o.id !== activeObjectId) {
      const ok = await confirmDialog({
        title: appConfig.copy.whiteboard.objectSwitchConfirmTitle,
        message: fillTemplate(appConfig.copy.whiteboard.objectSwitchConfirm, { name: o.name }),
        confirmLabel: appConfig.copy.whiteboard.objectSwitchConfirmCta,
        cancelLabel: appConfig.copy.cancel,
      })
      if (!ok) return
    }
    onSelect(o)
    onClose()
  }

  return (
    <Overlay open onClose={onClose} className={`ip-sheet pp-sheet ui-dialog ${mapOpen ? '' : 'pp-nomap'}`} ariaLabel={appConfig.copy.whiteboard.otherObject} initialFocus={searchRef}>
        <div className="ip-head">
          <h2>{appConfig.copy.whiteboard.otherObject}</h2>
          <button className="ip-x" onClick={onClose} aria-label={appConfig.copy.closeDialog}><Icon id="close" /></button>
        </div>

        <div className="pp-search">
          <Icon id="search" />
          <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder={pp.searchPlaceholder} />
          {q && <button className="pp-clear" onClick={() => setQ('')} aria-label={appConfig.copy.clear}><Icon id="close" /></button>}
        </div>

        <div className="pp-body">
          {/* primary, reliable path: the searchable list */}
          <div className="pp-list" role="listbox">
            {/* revert to the auto-surfaced object — only when an object was manually picked */}
            {onReset && activeObjectId && (
              <button className="pp-row pp-row-reset" onClick={() => { onReset(); onClose() }}>
                <span className="pp-row-main"><b>{appConfig.copy.whiteboard.objectReset}</b><span className="pp-row-addr">{pp.autoNextObject}</span></span>
                <span className="pp-row-meta"><Icon id="undo" /></span>
              </button>
            )}
            {loading && <div className="pp-empty">{pp.loading}</div>}
            {!loading && error && <div className="pp-empty">{pp.loadFailed}</div>}
            {!loading && !error && filtered.length === 0 && <div className="pp-empty">{pp.noObject}</div>}
            {!loading && !error && filtered.map((o) => {
              const n = pdfCount(o)
              return (
                <button
                  key={o.id}
                  className={`pp-row ${o.id === activeObjectId ? 'on' : ''} ${o.id === hoverId ? 'hover' : ''}`}
                  onClick={() => void choose(o)}
                  onMouseEnter={() => setHoverId(o.id)}
                  onMouseLeave={() => setHoverId((h) => (h === o.id ? null : h))}
                >
                  <span className="pp-row-main">
                    <b>{o.name}</b>
                    {o.address && <span className="pp-row-addr">{o.address}</span>}
                  </span>
                  <span className="pp-row-meta">
                    {o.distance_m != null && <span className="pp-dist">{fmtDistance(o.distance_m)}</span>}
                    <span className={`pp-mods ${n ? '' : 'pp-mods-none'}`}>{n} {n === 1 ? pp.planOne : pp.planMany}</span>
                  </span>
                </button>
              )
            })}
          </div>

          {/* supporting aid: a mini-map with a pin per object that has coords */}
          {mapOpen && (
            <div className="pp-map">
              <Map
                ref={mapRef}
                initialViewState={{ longitude: center[0], latitude: center[1], zoom: 16 }}
                mapStyle={BASE_STYLE}
                attributionControl={false}
                dragRotate={false}
              >
                <QuietAttributionControl />
                {/* incident location */}
                <Marker longitude={center[0]} latitude={center[1]} anchor="center">
                  <span className="pp-pin-inc" />
                </Marker>
                {withCoords.map((o) => (
                  <Marker key={o.id} longitude={o.lng!} latitude={o.lat!} anchor="bottom">
                    <button
                      className={`pp-pin ${o.id === activeObjectId ? 'on' : ''} ${o.id === hoverId ? 'hover' : ''}`}
                      title={o.name}
                      onClick={() => void choose(o)}
                      onMouseEnter={() => setHoverId(o.id)}
                      onMouseLeave={() => setHoverId((h) => (h === o.id ? null : h))}
                    >
                      <Icon id="flag" />
                    </button>
                  </Marker>
                ))}
              </Map>
              <div className="pp-map-note">{pp.mapNote}</div>
            </div>
          )}
        </div>

        {/* phone-friendly: let the map collapse so the list owns the narrow screen */}
        <button className="pp-maptoggle" onClick={() => setMapOpen((v) => !v)}>
          <Icon id="map" /> {mapOpen ? pp.hideMap : pp.showMap}
        </button>
    </Overlay>
  )
}
