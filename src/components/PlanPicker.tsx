import { useEffect, useMemo, useRef, useState } from 'react'
import Map, { Marker, type MapRef } from 'react-map-gl/maplibre'
import { QuietAttributionControl } from './MapAttribution'
import 'maplibre-gl/dist/maplibre-gl.css'
import '../lib/maplibreWorker'
import { useGeoPosition } from '../lib/useGeoPosition'
import { useIsPhone } from '../lib/useIsPhone'
import { Icon } from '../lib/icons'
import { Button } from './Button'
import { SearchField } from './SearchField'
import { LoadingStatus } from './ShellLoader'
import { matchesAnyQuery, searchQuery } from '../lib/search'
import { appConfig } from '../config/appConfig'
import { confirmDialog } from '../lib/ui'
import { fillTemplate } from '../lib/format'
import { fmtDistance } from '../lib/geo'
import { listObjects, type ObjectWithPlans } from '../lib/incidents'
import { Overlay } from '../lib/overlays'
import type { LngLat } from '../types'
import { cartoRasterTiles, withCartoLabelsBaked } from '../lib/carto'
import { defaultLayers } from '../lib/workspace'
import { useNightTheme } from '../lib/useNightTheme'
import { useGlRecovery } from '../lib/useGlRecovery'
import { useDragClosesKeyboard } from '../lib/iosKeyboard'

/** the one raster source in the mini-map's style — named, because the tile events below
 *  have to tell OUR base map apart from anything else MapLibre reports on */
const BASE_SOURCE = 'base'

/**
 * The mini-map's style: the SAME base layer the Lagekarte draws, at the screen's tile
 * resolution and with the deployment's CARTO key already on it (workspace · defaultLayers →
 * lib/carto), and its purpose-built dark raster in night mode.
 *
 * It used to hard-code `rastertiles/voyager` on subdomains a+b. That made the preview the one
 * map in the app on its own tile addresses: a day basemap inside a night dialog, outside what
 * the offline prefetch cached (`useOfflinePrefetch` warms the base layer's templates), and
 * dependent on a CARTO key the rest of the surface may not even be using. Owner, round 7
 * point 17: «When opening Andres Objekt the map stayed empty and looks rather sad» — with the
 * flags drawn over it, which is what a style whose tiles never arrive looks like.
 */
const baseStyle = (night: boolean) => {
  const bases = defaultLayers().filter((l) => l.base)
  const base = bases.find((l) => l.visible) ?? bases[0]
  // a plain raster style, no vector names on top: the labelled twin of the base (lib/carto)
  const tiles = (night && base?.nightTiles?.length ? base.nightTiles : base?.tiles)?.map(withCartoLabelsBaked) ?? cartoRasterTiles('rastertiles/voyager', ['a', 'b'])
  return {
    version: 8 as const,
    sources: {
      [BASE_SOURCE]: {
        type: 'raster' as const,
        tiles,
        tileSize: 256,
        maxzoom: base?.maxzoom,
        attribution: base?.attribution ?? '© CARTO, © OpenStreetMap-Mitwirkende',
      },
    },
    layers: [{ id: BASE_SOURCE, type: 'raster' as const, source: BASE_SOURCE }],
  }
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
 *
 * ⚠️ On a phone the LIST gets the room once it is being used (sweep 28.10.2026 #20, owner: «in
 * the modal Anderes Objekt, we can't scroll through the different plans»). Under a 300px map the
 * list was ~200px — two and a half rows — so the first scroll or the first letter typed shrinks
 * the map to a strip (`pp-listfirst`, 15-mobile.css; it stays pannable and its pins tappable), and
 * stays that way while the sheet is open. And a drag on the list with the keyboard up closes the
 * keyboard first (lib/iosKeyboard · useDragClosesKeyboard, the Karte search's answer, review
 * round 11): iOS pans the visual viewport under such a drag and the list never gets it.
 */
export function PlanPicker({ center, activeObjectId, onSelect, onReset, onClose }: Props) {
  const phone = useIsPhone()
  const userPos = useGeoPosition(phone)
  const pp = appConfig.copy.planPicker
  const night = useNightTheme()
  const style = useMemo(() => baseStyle(night), [night])
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
  // the list has been scrolled or searched: on a phone the map steps back to a strip (⚠️ above)
  const [listFirst, setListFirst] = useState(false)
  // the document, not the popup: Base UI mounts the portalled popup after this component's
  // first effects, and the list's selector is unique to this sheet
  const page = useRef<HTMLElement>(document.body)
  useDragClosesKeyboard(page, '.pp-sheet .pp-list')

  // An empty preview must SAY what it is rather than look broken (owner, round 7 point 17). The
  // pins are DOM markers, so they keep drawing over a base map that never arrived — which is
  // exactly the «sad», half-drawn pane he screenshotted, and it reads as a crash rather than as
  // «no tiles here». Two causes, one appearance: tiles that fail (offline in a stairwell, a
  // withheld CARTO key, a blocked host) and a WebGL context the browser took back. Both are
  // answered here, because from the operator's side they are the same moment.
  const [mapReady, setMapReady] = useState(false)
  const [baseFailed, setBaseFailed] = useState(false)
  /** a tile of the base source actually painted — the only proof the pane is showing a map */
  const basePainted = useRef(false)
  const gl = useGlRecovery(() => mapRef.current?.getMap(), mapReady, () => {
    basePainted.current = false
    setMapReady(false)
    setBaseFailed(false)
  })

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
    // the same tolerance as the roster pickers (lib/search): «Schlossgasse» still finds
    // Schlossgasse with a letter out of place, and umlauts match either spelling
    const needle = searchQuery(q)
    if (!needle) return objects
    return objects.filter((o) => matchesAnyQuery(needle, o.name, o.address))
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
    <Overlay open onClose={onClose} className={`ip-sheet ip-wide pp-sheet ui-dialog ${mapOpen ? '' : 'pp-nomap'} ${listFirst ? 'pp-listfirst' : ''}`} ariaLabel={appConfig.copy.whiteboard.otherObject} initialFocus={searchRef} grab>
        <div className="ip-head">
          <h2>{appConfig.copy.whiteboard.otherObject}</h2>
          <button className="ip-x" onClick={onClose} aria-label={appConfig.copy.closeDialog}><Icon id="close" /></button>
        </div>

        <SearchField ref={searchRef} className="pp-search" value={q} onChange={(v) => { setQ(v); if (v) setListFirst(true) }}
          placeholder={pp.searchPlaceholder} aria-label={pp.searchPlaceholder} />

        <div className="pp-body">
          {/* primary, reliable path: the searchable list */}
          <div className="pp-list" role="listbox" onScroll={(e) => { if (e.currentTarget.scrollTop > 0 && !listFirst) setListFirst(true) }}>
            {/* revert to the auto-surfaced object — only when an object was manually picked */}
            {onReset && activeObjectId && (
              <button className="pp-row pp-row-reset" onClick={() => { onReset(); onClose() }}>
                <span className="pp-row-main"><b>{appConfig.copy.whiteboard.objectReset}</b><span className="pp-row-addr">{pp.autoNextObject}</span></span>
                <span className="pp-row-meta"><Icon id="undo" /></span>
              </button>
            )}
            {loading && <div className="pp-empty"><LoadingStatus size="surface">{pp.loading}</LoadingStatus></div>}
            {!loading && error && <div className="pp-empty">{pp.loadFailed}</div>}
            {!loading && !error && filtered.length === 0 && <div className="pp-empty">{pp.noObject}</div>}
            {!loading && !error && filtered.map((o) => {
              const n = pdfCount(o)
              return (
                <button
                  key={o.id}
                  className={`pp-row ${o.id === activeObjectId ? 'on' : ''} ${o.id === hoverId ? 'hover' : ''}`}
                  aria-current={o.id === activeObjectId || undefined}
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
                // a fresh instance (new canvas, new GL resources) is the only way back from a
                // lost context — the same remount MapView uses (lib/useGlRecovery)
                key={gl.generation}
                ref={mapRef}
                initialViewState={{ longitude: center[0], latitude: center[1], zoom: 16 }}
                mapStyle={style}
                attributionControl={false}
                dragRotate={false}
                onLoad={() => setMapReady(true)}
                onSourceData={(e) => {
                  if (e.sourceId !== BASE_SOURCE || !e.isSourceLoaded) return
                  basePainted.current = true
                  setBaseFailed(false)
                }}
                // MapLibre reports every failed tile here. Only a failure BEFORE the first tile
                // painted means an empty pane — once the map is drawn, a single dropped tile at
                // the edge is not worth a banner over it.
                onError={() => { if (!basePainted.current) setBaseFailed(true) }}
              >
                <QuietAttributionControl />
                {phone && userPos && <Marker longitude={userPos[0]} latitude={userPos[1]} anchor="center">
                  <div className="map-here map-me" title={appConfig.copy.map.youHere} />
                </Marker>}
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
              {/* …and when there is no map under the pins, the pane says so instead of looking
                  broken. `gl.lost` is the repeated-context-loss case useGlRecovery stops healing:
                  the operator gets the same words, because the list is the reliable path either
                  way and there is nothing else to do here. */}
              {(baseFailed || gl.lost) && <div className="pp-map-blank" role="status"><span>{pp.mapUnavailable}</span></div>}
              <div className="pp-map-note">{pp.mapNote}</div>
            </div>
          )}
        </div>

        {/* phone-friendly: let the map collapse so the list owns the narrow screen */}
        <Button className="pp-maptoggle" icon={<Icon id="map" />} aria-expanded={mapOpen} onClick={() => setMapOpen((v) => !v)}>
          {mapOpen ? pp.hideMap : pp.showMap}
        </Button>
    </Overlay>
  )
}
