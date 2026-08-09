import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import Map, { Layer, Marker, Source, type MapRef } from 'react-map-gl/maplibre'
import type { Map as MapLibreMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Icon } from '../lib/icons'
import { cx } from '../lib/cx'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { operationalExtentPoints } from '../lib/report'
import { circlePolygon } from '../lib/geo'
import { TacticalSymbol } from '../lib/symbolRender'
import { ShapeGlyph } from '../lib/shapes'
import { EndTag, TeilstueckFork, hasLineDecor } from '../lib/lineDecor'
import { truppForLine, truppTagText } from '../lib/truppLines'
import { lerpPoint } from '../lib/lineStyle'
import { fmtDistance, hoseLengthHint, pathLengthM } from '../lib/geo'
import { Segmented } from './Segmented'
import { krokiEntity, krokiSymbolMul } from '../lib/krokiPayload'
import { shapePx, symPx } from '../lib/mapView'
import type { CaptionMode, Drawing, Entity, LayerDef, LngLat, Trupp } from '../types'
import { krokiStandLabel, type KrokiView } from '../lib/report'

// WYSIWYG framing of the printed Kroki: the auto-fit (or the last chosen crop) is just the
// STARTING point — the operator pans/zooms and exactly this crop becomes the printed Kroki.
// Preview-grade rendering: real glyphs at a fixed small size + plain drawing geometry; the
// server render stays the source of truth for the final look.
//
// A PANEL on the Rapport surface, not the modal it was until 2026-08-07. As a modal it opened
// on the press of PDF / Ausdrucken, which meant the crop was chosen blind right up to the
// moment paper was made — and put a dialog over a page that had just stopped being one itself.
// On the page the crop is simply visible while the rest of the rapport is filled in, and the
// framing on screen IS what prints: there is nothing left to confirm.

const FIT_MAX_ZOOM = 20 // mirror of the server's fit_view max_z
/** Breathing room around the fitted Lage, in preview px. 48 was ~2 cm of white on every side of
 *  an A4 sheet — enough street to orient by is a good thing, that much of it is not. */
const FIT_PAD = 28
const CARTO_FALLBACK = 'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png'
// backend/app/kroki.py renders print overlays against this reference viewport. Scaling the
// complete decorated marker (not only its glyph) makes badges/spreads/shapes WYSIWYG here.
//
// ⚠️ ONE reference is not enough. report_pdf.py renders the Kroki at 1600×940 quer but 1000×1400
// hoch, and kroki.py sizes a symbol in ABSOLUTE pixels on that canvas (sym_px clamps to 28..48).
// The same 40px symbol is therefore 2.5% of a landscape sheet and 4% of a portrait one — so a
// single reference drew the hoch preview's symbols 1.6× too small, which is not what gets
// printed. The reference follows the orientation, in the same ratio as the two renders.
const PRINT_REF_WIDTH = 1050
const PRINT_REF_WIDTH_PORTRAIT = Math.round((PRINT_REF_WIDTH * 1000) / 1600)

/** Web-Mercator northing, for a screen angle without asking the map to project. */
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))

/** Screen angle (deg) of a line's last segment, so the Teilstück fork pins to the tip the way
 *  it does on the Lage map. The crop map is north-up (rotation is disabled on it), so the angle
 *  follows from the geometry alone — no map instance, and nothing to recompute on a pan. */
function forkAngle(coords: LngLat[]): number {
  const n = coords.length
  const [x1, y1] = coords[n - 2]
  const [x2, y2] = coords[n - 1]
  const dx = ((x2 - x1) * Math.PI) / 180
  const dy = mercY(y2) - mercY(y1) // grows NORTHWARD; screen y grows downward
  return (Math.atan2(-dy, dx) * 180) / Math.PI
}

export function KrokiFramingPanel({ scene, initial, atMs = null, atBusy = false, onAtChange, moments = [], startedAtMs = null, landscape = true, onLandscapeChange, trupps = [], captionMode = 'auto', onViewChange }: {
  scene: { entities: Entity[]; drawings: Drawing[]; layers: LayerDef[]; byName: Record<string, string>; center: LngLat }
  /** the crop this panel opens on — the last one chosen for this Einsatz, else auto-fit */
  initial: KrokiView | null
  /** the instant the printed Kroki shows; null = the live picture. The scene above is already
   *  the reconstructed one — this is only the control, so the choice sits on the screen that
   *  asks what the picture shows rather than behind a fold two levels away. */
  atMs?: number | null
  atBusy?: boolean
  onAtChange?: (ms: number | null) => void
  /** epoch-ms of every moment something actually happened (lib/replay · activityMoments) —
   *  drawn as hairlines on the Stand track so dragging is aimed rather than blind */
  moments?: number[]
  /** the Einsatz's start — the slider's left end; its right end is «jetzt» */
  startedAtMs?: number | null
  /** the page shape the Kroki prints on. The crop window IS the page here — WYSIWYG only holds
   *  if the preview has the sheet's proportions, so the choice lives on this screen. Owned by
   *  the surface: there is no «übernehmen» left for a local copy to be waiting for. */
  landscape?: boolean
  onLandscapeChange?: (landscape: boolean) => void
  /** monitored Trupps — the end tag names the one working a Leitung, like the print does */
  trupps?: Trupp[]
  /** the map's Beschriftungen setting, so the preview labels what the sheet will label */
  captionMode?: CaptionMode
  /** the crop as it stands, after every settled pan/zoom/resize. Reported continuously rather
   *  than on a confirm: what is on screen is what prints, so the surface must never be holding
   *  an older framing than the one the operator is looking at. */
  onViewChange?: (view: KrokiView) => void
}) {
  const P = appConfig.copy.preflight
  // read once per open: a ticking «now» would move the slider's right end under the finger
  const [nowMs] = useState(() => Date.now())
  /** where the thumb is WHILE dragging — the reconstruction waits for it to stop */
  const [dragMs, setDragMs] = useState<number | null>(null)
  const commitDrag = () => {
    if (dragMs == null) return
    // the last notch IS the live picture: no reconstruction, and the caption stays «jetzt»
    onAtChange?.(dragMs >= nowMs - 30_000 ? null : dragMs)
    setDragMs(null)
  }
  const label = krokiStandLabel(dragMs ?? atMs)
  /** Where the ticks go, as percentages, one per VISIBLE position rather than one per event.
   *  A busy Einsatz records hundreds of moments inside one hour; drawn raw they merge into a
   *  solid bar, which says «something happened all the time» — the opposite of what a mark is
   *  for — and puts hundreds of nodes under the thumb. Rounded to 0.5 % of the track (roughly
   *  a tick's own width at any usable size) and de-duplicated, so two ticks are two places. */
  const markPcts = useMemo(() => {
    const span = nowMs - startedAtMs!
    if (startedAtMs == null || span <= 0) return []
    const seen = new Set<number>()
    for (const t of moments) {
      if (t < startedAtMs || t > nowMs) continue
      seen.add(Math.round(((t - startedAtMs) / span) * 200) / 2)
    }
    return [...seen].sort((a, b) => a - b)
  }, [moments, startedAtMs, nowMs])
  const mapRef = useRef<MapRef>(null)
  /**
   * Does the crop still follow the Lage?
   *
   * ⚠️ The stored `krokiView` used to be the last word: framed once at 22:20, restored verbatim
   * at 01:30, with everything placed since it outside the picture — and nothing said so
   * (08.08. Einsatz). It follows until somebody frames by hand, and a hand-made frame then wins
   * forever, because overruling an operator's own crop is worse than any automatic fit.
   */
  const [follow, setFollow] = useState(() => !initial)
  /** the crop as it currently stands — what decides whether anything is outside it */
  const [viewBounds, setViewBounds] = useState<[number, number, number, number] | null>(null)
  const [previewZoom, setPreviewZoom] = useState(initial?.zoom ?? 16)
  const [previewWidth, setPreviewWidth] = useState(720)
  const printScale = previewWidth / (landscape ? PRINT_REF_WIDTH : PRINT_REF_WIDTH_PORTRAIT)

  // same base-layer pick as buildKrokiPayload, so the preview shows the printed basemap
  const base = scene.layers.find((l) => l.base && l.visible && l.tiles?.length) ?? scene.layers.find((l) => l.base && l.tiles?.length)
  const style = useMemo(() => ({
    version: 8 as const,
    sources: { base: { type: 'raster' as const, tiles: base?.tiles?.length ? [base.tiles[0]] : [CARTO_FALLBACK], tileSize: 256, maxzoom: base?.maxzoom } },
    layers: [{ id: 'base', type: 'raster' as const, source: 'base' }],
  }), [base])

  const layerVisible = (id: string) => scene.layers.find((l) => l.id === id)?.visible ?? true
  const drawingsVisible = layerVisible(appConfig.defaults.drawingLayerId)
  const shown = scene.entities.filter((e) => Array.isArray(e.coord) && layerVisible(e.layer))

  const bounds = useMemo(() => {
    const pts = operationalExtentPoints(scene.center, scene.entities, drawingsVisible ? scene.drawings : [], false)
    const lngs = pts.map((p) => p[0]), lats = pts.map((p) => p[1])
    return [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]] as [[number, number], [number, number]]
  }, [scene, drawingsVisible])

  const geojson = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: (drawingsVisible ? scene.drawings : []).filter((d) => Array.isArray(d.coords) && d.coords.length).map((d) => ({
      type: 'Feature' as const,
      properties: {
        color: d.color ?? appConfig.drawing.defaultColor, area: d.kind !== 'line',
        dashed: !!d.dashed, width: (d.width ?? 4) * 0.62,
      },
      geometry: d.kind === 'circle' && d.radiusM
        ? { type: 'Polygon' as const, coordinates: circlePolygon(d.coords[0], d.radiusM) }
        : d.kind === 'area'
          ? { type: 'Polygon' as const, coordinates: [[...d.coords, d.coords[0]]] }
          : { type: 'LineString' as const, coordinates: d.coords },
    })),
  }), [scene.drawings, drawingsVisible])

  /**
   * Everything the printed Kroki carries besides the bare geometry: the Teilstück fork, the end
   * tag («Leitungsnummer · Inhalt · Stockwerk · Trupp») and the distance/label chip.
   *
   * The preview drew plain lines, so the one screen whose whole job is «this is what comes out»
   * showed less than what came out — you could not see the «-E» you were framing around. Built
   * from the same fields `buildKrokiPayload` sends and rendered with the same components the
   * Lage map uses, so preview, screen and paper cannot drift into three different pictures.
   */
  const decor = useMemo(() => (drawingsVisible ? scene.drawings : [])
    .filter((d) => d.kind === 'line' && Array.isArray(d.coords) && d.coords.length >= 2)
    .map((d) => {
      const n = d.coords.length
      const end = d.coords[n - 1] as LngLat
      const tagAt = (d.endLabelAt ?? lerpPoint(d.coords[n - 2], end, 0.72)) as LngLat
      const trupp = truppForLine(d, trupps)
      const lines: string[] = []
      if (d.showDistance) {
        const m = pathLengthM(d.coords)
        lines.push(`${fmtDistance(m)} · ${hoseLengthHint(m)}`)
      }
      if (d.label) lines.push(d.label)
      return {
        d, end, tagAt, trupp, lines,
        mid: d.coords[(n - 1) >> 1] as LngLat,
        color: d.color || appConfig.drawing.defaultColor,
        width: d.width || 4,
        hasTag: hasLineDecor(d) || !!trupp,
      }
    }), [scene.drawings, drawingsVisible, trupps])

  const fit = () => mapRef.current?.getMap().fitBounds(bounds, { padding: FIT_PAD, maxZoom: FIT_MAX_ZOOM })
  /** …and go back to following, because «alles zeigen» is a request for exactly that */
  const fitAndFollow = () => { setFollow(true); fit() }

  /**
   * Re-fit while following: when the Lage grows past the frame, and when the page shape flips.
   *
   * ⚠️ Hoch/Quer used to keep centre and zoom, so turning the sheet upright lost the left and
   * right of the picture without gaining anything above or below — the choice of shape changed
   * the crop rather than the page. `boundsKey` rather than `bounds`: the array is rebuilt on
   * every render, and depending on the object would re-fit continuously.
   */
  const boundsKey = bounds.flat().join(',')
  useEffect(() => {
    if (!follow) return
    mapRef.current?.getMap().fitBounds(bounds, { padding: FIT_PAD, maxZoom: FIT_MAX_ZOOM, duration: 200 })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boundsKey IS the bounds, stably
  }, [follow, boundsKey, landscape])

  /**
   * What is placed OUTSIDE the crop, and roughly which way.
   *
   * Shown as an arrow at the edge rather than by widening the frame: something outside is
   * usually one Hydrant two streets away, and zooming out to reach it shrinks the part of the
   * picture the sheet is actually about. The arrow says «there is more, that way» and offers
   * the fit — it never takes it.
   */
  const offscreen = useMemo(() => {
    if (!viewBounds) return null
    const [w, s2, e, n] = viewBounds
    const pts = operationalExtentPoints(scene.center, scene.entities, drawingsVisible ? scene.drawings : [], false)
    const out = pts.filter(([lng, lat]) => lng < w || lng > e || lat < s2 || lat > n)
    if (!out.length || out.length === pts.length) return null // nothing out, or nothing framed at all
    const cx = (w + e) / 2, cy = (s2 + n) / 2
    const ox = out.reduce((t, p) => t + p[0], 0) / out.length
    const oy = out.reduce((t, p) => t + p[1], 0) / out.length
    // screen y grows downwards, so the vertical component is negated for the angle
    const rad = Math.atan2(-(oy - cy), (ox - cx) * Math.cos((cy * Math.PI) / 180))
    return {
      count: out.length,
      deg: (rad * 180) / Math.PI,
      // park it just inside the frame edge, in the direction the content lies
      left: 50 + 38 * Math.cos(rad),
      top: 50 - 38 * Math.sin(rad),
    }
  }, [viewBounds, scene, drawingsVisible])

  const syncView = (m: MapLibreMap) => {
    setPreviewZoom(m.getZoom())
    setPreviewWidth(m.getContainer().clientWidth)
  }
  /** Report the crop upwards. Fired when a movement SETTLES (and on load/resize, where the map
   *  moves without anybody dragging it) rather than on every frame: the surface re-renders on
   *  each of these, and a pan is a few hundred frames. */
  const reportView = (m: MapLibreMap) => {
    const c = m.getCenter()
    const b = m.getBounds()
    setViewBounds([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()])
    onViewChange?.({
      center: [c.lng, c.lat],
      zoom: m.getZoom(),
      bounds: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
    })
  }

  return (
    <div className="kf-panel">
      {/* Hoch · Quer sits ABOVE the crop, never in or under it: it changes the shape of the
          frame below it, so a control anywhere downstream would move under the finger that
          just pressed it. Seeded from the crop's own aspect — the app's guess is the default,
          and one tap overrules it. The teaching line shares the row because there is no dialog
          title left to carry it, and a chip floating on a column-width crop would cover the
          very picture it explains. */}
      <div className="kf-panel-head">
        <span className="kf-panel-hint">{P.framingHint}</span>
        <Segmented
          ariaLabel={P.krokiOrientation}
          value={landscape ? 'land' : 'port'}
          onChange={(v) => onLandscapeChange?.(v === 'land')}
          options={[
            { value: 'port', label: P.krokiPortrait },
            { value: 'land', label: P.krokiLandscape },
          ]}
        />
      </div>
      <div className={cx('kf-map', !landscape && 'portrait')}>
        {/* Something is placed outside this crop. An ARROW, not a forced zoom-out: what is
            outside is usually one Hydrant two streets away, and widening the frame to reach it
            shrinks the part of the picture the sheet is about. It offers the fit; it never
            takes it. */}
        {offscreen && !follow && (
          <button
            type="button" className="kf-off"
            style={{ left: `${offscreen.left}%`, top: `${offscreen.top}%` }}
            title={fillTemplate(P.framingOutside, { n: offscreen.count })}
            aria-label={fillTemplate(P.framingOutside, { n: offscreen.count })}
            onClick={fitAndFollow}
          >
            <span className="kf-off-arrow" style={{ transform: `rotate(${-offscreen.deg}deg)` }} aria-hidden>
              <Icon id="chevron" />
            </span>
            <span>{offscreen.count}</span>
          </button>
        )}
        <Map
          ref={mapRef}
          initialViewState={initial
            ? { longitude: initial.center[0], latitude: initial.center[1], zoom: initial.zoom }
            : { bounds, fitBoundsOptions: { padding: FIT_PAD, maxZoom: FIT_MAX_ZOOM } }}
          mapStyle={style}
          dragRotate={false}
          pitchWithRotate={false}
          touchPitch={false}
          attributionControl={false}
          onLoad={(e) => { e.target.touchZoomRotate.disableRotation(); syncView(e.target); reportView(e.target) }}
          onMove={(e) => { setPreviewZoom(e.viewState.zoom) }}
          // `originalEvent` is present only when a HAND moved the map — the programmatic
          // fitBounds below must not switch its own mode off
          onMoveEnd={(e) => { if (e.originalEvent) setFollow(false); reportView(e.target) }}
          onResize={(e) => { syncView(e.target); reportView(e.target) }}
        >
          <Source id="draws" type="geojson" data={geojson}>
            <Layer id="draw-fill" type="fill" filter={['==', ['get', 'area'], true]} paint={{ 'fill-color': ['get', 'color'], 'fill-opacity': 0.14 }} />
            {/* solid and dashed are separate layers: line-dasharray is not data-driven in
                MapLibre, and a Druckleitung drawn dashed printed solid in the preview */}
            <Layer id="draw-line" type="line" filter={['!=', ['get', 'dashed'], true]}
              paint={{ 'line-color': ['get', 'color'], 'line-width': ['get', 'width'] }} />
            <Layer id="draw-line-dash" type="line" filter={['==', ['get', 'dashed'], true]}
              paint={{ 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-dasharray': [2.2, 1.6] }} />
          </Source>
          {decor.map((ld) => (
            <Fragment key={`kd${ld.d.id}`}>
              {ld.d.teilstueck && (
                <Marker longitude={ld.end[0]} latitude={ld.end[1]} anchor="center">
                  <TeilstueckFork angleDeg={forkAngle(ld.d.coords)} color={ld.color} width={ld.width} />
                </Marker>
              )}
              {/* zIndex: above the line's own decorations — see MapView for why it has to sit on
                  the marker container, and the printed Kroki has to match the screen */}
              {ld.hasTag && (
                <Marker longitude={ld.tagAt[0]} latitude={ld.tagAt[1]} anchor="center" offset={[0, -14]} style={{ zIndex: 3 }}>
                  {/* no alarm tint here, exactly as on paper: a printed Kroki is the record of
                      an incident, not a live board (see krokiPayload · drawings) */}
                  <EndTag lineNo={ld.d.lineNo} content={ld.d.content} floorTag={ld.d.floorTag}
                    trupp={ld.trupp ? truppTagText(ld.trupp) : undefined} tone="idle" color={ld.color} />
                </Marker>
              )}
              {ld.lines.length > 0 && (
                <Marker longitude={ld.mid[0]} latitude={ld.mid[1]} anchor="center">
                  <span className="kf-plain kf-draw-label">{ld.lines.join('\n')}</span>
                </Marker>
              )}
            </Fragment>
          ))}
          {shown.map((e) => (
            <Marker key={e.id} longitude={e.coord[0]} latitude={e.coord[1]} anchor="center">
              {(() => {
                const printable = krokiEntity(e, scene.byName, captionMode)
                if (!printable) return null
                if (e.kind === 'shape') {
                  const size = shapePx(e.sizeM, e.coord[1], previewZoom)
                  return (
                    <div className="kf-print-box" style={{ width: size * printScale, height: size * printScale }}>
                      <div className="kf-print-inner kf-glyph" style={{ width: size, height: size, transform: `translate(-50%, -50%) scale(${printScale}) rotate(${e.rotation ?? 0}deg)` }}>
                        <ShapeGlyph kind={e.shape ?? 'square'} color={e.color ?? '#1f6feb'} />
                      </div>
                    </div>
                  )
                }
                if (!printable.symbolSvg && !printable.symbol) {
                  return printable.caption ? <span className={`kf-plain ${e.kind}`}>{printable.caption}</span> : null
                }
                const svg = printable.symbolSvg ?? scene.byName[printable.symbol ?? ''] ?? ''
                const size = symPx(e.kind, e.coord[1], previewZoom, krokiSymbolMul(previewZoom))
                return (
                  <div className="kf-print-box" style={{ width: size * printScale, height: size * printScale }}>
                    <div className="kf-print-inner" style={{ transform: `translate(-50%, -50%) scale(${printScale})` }}>
                      <TacticalSymbol
                        svg={svg}
                        sizePx={size}
                        rotation={printable.rotation ?? 0}
                        floor={printable.floor}
                        floorFrom={printable.floorFrom}
                        floorTo={printable.floorTo}
                        spread={printable.spread}
                        count={printable.count}
                        caption={printable.caption}
                      />
                    </div>
                  </div>
                )
              })()}
            </Marker>
          ))}
        </Map>
      </div>
      {/* The controls belong to the PANEL, not to the picture. Floating on the map they
          covered the very crop they were there to adjust — the ± column sat on the Stand
          slider's right end, and both hid whatever was underneath them. In their own bar the
          map stays entirely map, and nothing moves when the frame changes shape. */}
      <div className="kf-controls">
        {/* «Stand» — one picture is one Lage at ONE time. «Jetzt» is the normal answer; a time
            reconstructs the Lage as it stood then (the map redraws under the crop), which is
            how a rapport can still show a Rettung that has long since left. */}
        {onAtChange && startedAtMs != null && (
          <div className="kf-at">
            <span className="kf-at-label">{P.krokiAtLabel}</span>
            {/* A SLIDER over the Einsatz, not a clock to type into: nobody knows what time the
                Rettung was still standing there — but everybody can drag until the picture
                shows it. The right end IS «jetzt», so the live picture stays one drag away and
                needs no separate switch. */}
            {/* The DRAG is local; the reconstruction runs when the thumb comes to rest. Firing
                it on every notch meant a fetch per pixel — the busy line blinked, the map
                redrew mid-drag and the whole sheet flickered. */}
            {/* The reconstruction reports itself ON the slider — a bar that runs along the
                track it belongs to. The old «Lage wird rekonstruiert …» line sat beside the
                control, needed a fixed slot so its coming and going didn't resize the bar
                under the finger, and still said in eleven words what the track can say by
                moving. */}
            {/* WHEN anything happened, as hairlines under the track. Without them «drag until
                the picture shows it» is a blind search across the whole Einsatz — and the
                moments worth stopping at are exactly the ones that left a Verlauf row or a
                recorded action. Ticks only: they mark, they are not targets, and the slider
                underneath keeps every pixel of its own hit area. */}
            <span className={cx('kf-at-track', atBusy && 'busy')}>
              {markPcts.length > 0 && (
                <span className="kf-at-marks" aria-hidden="true">
                  {markPcts.map((pct) => <i key={pct} style={{ left: `${pct}%` }} />)}
                </span>
              )}
              <input
                className="kf-at-range" type="range"
                min={startedAtMs} max={nowMs} step={30_000}
                value={dragMs ?? atMs ?? nowMs}
                aria-label={P.krokiAtLabel}
                aria-valuetext={label}
                aria-busy={atBusy || undefined}
                onChange={(e) => setDragMs(Number(e.target.value))}
                onPointerUp={() => commitDrag()}
                onKeyUp={() => commitDrag()}
                onBlur={() => commitDrag()}
              />
              <span className="kf-at-prog" aria-hidden="true" />
            </span>
            <b className="kf-at-val">{label}</b>
          </div>
        )}
        {/* «Auf Einsatz zoomen» joins the ± pair: all three answer «show me more / less / all
            of it», and the old action row they were split across is gone with the confirm. */}
        {/* «Auf Einsatz zoomen» AND «folgt der Lage» are the same wish, so they are one control:
            pressing it fits now and keeps fitting, and the first hand-made pan turns it off. */}
        <button type="button" className={cx('ip-btn kf-ctl-fit', follow && 'kf-ctl-follow')}
          aria-pressed={follow} title={follow ? P.framingFollowOn : P.framingFollowOff}
          onClick={fitAndFollow}><Icon id="cross" /> {follow ? P.framingFollows : P.framingFit}</button>
        {/* ± stays: with gloves on a tablet, pinching a crop into place is the fiddliest
            gesture the app asks for, and this is the one place where the exact framing IS
            the point. Beside the picture rather than on top of it. */}
        <div className="kf-zoom">
          <button type="button" className="kf-zoom-btn" aria-label={appConfig.copy.nav.zoomIn}
            onClick={() => mapRef.current?.getMap().zoomIn({ duration: 180 })}><Icon id="plus" /></button>
          <button type="button" className="kf-zoom-btn" aria-label={appConfig.copy.nav.zoomOut}
            onClick={() => mapRef.current?.getMap().zoomOut({ duration: 180 })}><Icon id="minus" /></button>
        </div>
      </div>
    </div>
  )
}
