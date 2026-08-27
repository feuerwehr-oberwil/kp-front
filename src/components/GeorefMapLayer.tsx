/** The MAP half of «Karte verknüpfen»: the numbered reference crosses on the map, and the
 *  magnifier that makes it possible to hit a house corner with a thumb on top of it.
 *
 *  Lives inside MapView because it needs the one live map — its layers, its view, its tiles.
 *  The plan half is GeorefMode.tsx; the shared state is lib/georefMode.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Layer, Marker, Source } from 'react-map-gl/maplibre'
import type { Map as MlMap } from 'maplibre-gl'
import type { LayerDef, LayerId } from '../types'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { georefDispatch, georefMapQueueNo, georefMatching, GEOREF_TAP_SLOP_PX, useGeorefMode, type GeorefModeState } from '../lib/georefMode'
import { fitSimilarity } from '../lib/georef'
import s from './GeorefMode.module.css'

/** Zoom levels above the live map the loupe shows. Two levels ≈ 4×, matching the plan loupe. */
const LOUPE_ZOOM_UP = 2
const TILE = 256

const crossSvg = (
  <svg viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden>
    <circle cx="13" cy="13" r="7.5" />
    <path d="M13 0v6M13 20v6M0 13h6M20 13h6" />
    <circle cx="13" cy="13" r="1.7" fill="currentColor" stroke="none" />
  </svg>
)

/**
 * The reference crosses on the map, numbered to match the plan.
 *
 * A drag fine-tunes with a live refit; a tap picks that half up to re-place it (replace, never
 * append — see georef · replacePair). Both go through the same threshold as the plan side, so
 * the two surfaces feel like one gesture rather than two.
 */
export function GeorefMapMarks({ mode, map }: { mode: GeorefModeState; map: MlMap | null }) {
  // ⚠️ The threshold is measured in SCREEN px via `map.project`, not in degrees: react-map-gl's
  // marker drag event carries no original pointer event, and a fixed lng/lat threshold would be
  // a different distance at every zoom — forgiving when zoomed out, unusable when zoomed in.
  const drag = useRef<{ start: { lng: number; lat: number }; moved: boolean } | null>(null)
  // MapLibre suppresses a native click after most drags, but not uniformly across mouse/touch
  // engines. Remember a real drag briefly so its trailing click cannot turn into “pick up”.
  const draggedAt = useRef(0)
  // Paired crosses remain draggable while unmatched points wait: an intentional press on an
  // existing landmark is a correction. Only a picked-up half makes them inert while it lands.
  const placing = georefMatching(mode)
  const C = appConfig.copy.whiteboard.georef
  if (!mode.planId) return null
  const movedFar = (from: { lng: number; lat: number }, to: { lng: number; lat: number }) => {
    if (!map) return true
    const a = map.project([from.lng, from.lat]), b = map.project([to.lng, to.lat])
    return Math.hypot(a.x - b.x, a.y - b.y) > GEOREF_TAP_SLOP_PX
  }
  return (
    <>
      {mode.pairs.map((p, i) => (
        <Marker
          key={i}
          longitude={p.lngLat.lng}
          latitude={p.lngLat.lat}
          anchor="center"
          // crosses go inert while a placement is mid-pair: the tap belongs to the map, not to
          // whatever cross happens to sit under it
          draggable={!placing}
          onDragStart={(e) => { drag.current = { start: { lng: e.lngLat.lng, lat: e.lngLat.lat }, moved: false } }}
          onDrag={(e) => {
            const d = drag.current; if (!d) return
            const to = { lng: e.lngLat.lng, lat: e.lngLat.lat }
            if (!d.moved && !movedFar(d.start, to)) return
            d.moved = true
            georefDispatch({ type: 'dragMap', idx: i, lngLat: to })
          }}
          onDragEnd={(e) => {
            const d = drag.current; drag.current = null
            if (!d) return
            // never left the tap radius ⇒ that was a tap: hand this half back to be re-placed
            // instead of nudging it by a pixel
            if (!d.moved) { georefDispatch({ type: 'pick', idx: i, side: 'map' }); return }
            draggedAt.current = Date.now()
            georefDispatch({ type: 'dragMap', idx: i, lngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat } })
          }}
        >
          {placing ? (
            <span className={`${s.cross} ${s.inert} ${mode.edit?.idx === i && mode.edit.side === 'map' ? s.picked : ''}`}
              style={{ position: 'relative', margin: 0, display: 'block' }} aria-hidden>
              {crossSvg}<span className={s.badge}>{i + 1}</span>
            </span>
          ) : (
            <button type="button" className={s.cross}
              style={{ position: 'relative', margin: 0, display: 'block' }}
              title={fillTemplate(C.crossTitle, { n: String(i + 1) })}
              aria-label={fillTemplate(C.crossTitle, { n: String(i + 1) })}
              onClick={(e) => {
                e.stopPropagation()
                if (Date.now() - draggedAt.current < 250) return
                georefDispatch({ type: 'pick', idx: i, side: 'map' })
              }}>
              {crossSvg}<span className={s.badge}>{i + 1}</span>
            </button>
          )}
        </Marker>
      ))}
      {mode.mapQueue.map((p, i) => {
        const number = georefMapQueueNo(mode, i)
        const cls = `${s.cross} ${s.pending} ${mode.edit?.pending && mode.edit.side === 'map' && mode.edit.idx === i ? s.picked : ''}`
        const style = { position: 'relative' as const, margin: 0, display: 'block' }
        return (
          <Marker key={`open-map-${i}`} longitude={p.lng} latitude={p.lat} anchor="center">
            {mode.edit ? (
              <span className={`${cls} ${s.inert}`} style={style} aria-hidden>
                {crossSvg}<span className={s.badge}>{number}</span>
              </span>
            ) : (
              <button type="button" className={cls} style={style}
                title={fillTemplate(C.pendingCrossTitle, { n: String(number) })}
                aria-label={fillTemplate(C.pendingCrossTitle, { n: String(number) })}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); georefDispatch({ type: 'pickPending', idx: i, side: 'map' }) }}>
                {crossSvg}<span className={s.badge}>{number}</span>
              </button>
            )}
          </Marker>
        )
      })}
    </>
  )
}

// --- «Deckung prüfen» -------------------------------------------------------------------------

/** The link tone, read off the live theme — a GL paint property cannot take a CSS variable, and
 *  a frozen hex would be the one blue in the app that does not follow day/night. */
function blueTone(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--blue').trim()
  return v || '#1f6feb'
}

/**
 * The sheet's own outline, laid on the map — the check no residual can perform.
 *
 * ⚠️ Four corners, not the bitmap. Painting the plan itself over the map means a second raster
 * source, a rotated image layer and a decode of a PDF page the map surface has never loaded —
 * for a look that lasts five seconds. The rectangle answers the actual question («does the
 * building sit where the sheet says it does?») because the sheet's frame IS the building's
 * frame on a Modul plan, and it costs one GeoJSON feature.
 *
 * It is deliberately not a layer anybody can leave on: `check` clears itself the moment
 * something is placed or corrected (lib/georefMode · georefReduce).
 */
export function GeorefCheckOutline({ mode, map }: { mode: GeorefModeState; map: MlMap | null }) {
  const fit = mode.planId && mode.check ? fitSimilarity(mode.pairs, mode.aspect) : null
  const corners = fit ? ([[0, 0], [1, 0], [1, 1], [0, 1]] as const).map(([x, y]) => {
    const c = fit.toMap({ x, y })
    return [c.lng, c.lat] as [number, number]
  }) : []
  const valid = corners.length === 4 && corners.every(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat))
  // A check whose sheet is outside the current camera looks exactly like a broken button. Bring
  // the complete overlay into the borrowed map pane when the check opens; the ordinary view is
  // otherwise left untouched, and subsequent pan/zoom remains fully manual. Wait until the CSS
  // has expanded the former split pane to the full viewport before fitting: fitting against its
  // old half-width is what left the plan centred in the right half of the finished layout.
  useEffect(() => {
    if (!map || !mode.check || !valid) return
    const lngs = corners.map((c) => c[0]), lats = corners.map((c) => c[1])
    const bounds: [[number, number], [number, number]] = [
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)],
    ]
    let fitFrame = 0
    const resizeFrame = requestAnimationFrame(() => {
      try { map.resize() } catch { return }
      fitFrame = requestAnimationFrame(() => {
        try { map.fitBounds(bounds, { padding: 56, duration: 280 }) } catch {
          /* map is being torn down — the outline still renders on the next open */
        }
      })
    })
    return () => {
      cancelAnimationFrame(resizeFrame)
      if (fitFrame) cancelAnimationFrame(fitFrame)
    }
    // corners are derived from these scalar inputs; listing the arrays themselves would refit on
    // every render because fitSimilarity creates fresh functions and points.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, mode.check, mode.planId, mode.pairs, mode.aspect, valid])
  if (!fit || !valid) return null
  const ring = [...corners, corners[0]]
  const tone = blueTone()
  const data = {
    type: 'Feature' as const,
    properties: {},
    geometry: { type: 'Polygon' as const, coordinates: [ring] },
  }
  return (
    <>
      {/* This is the CHECK: the actual Modul sheet, not only its rectangle. At 58 % opacity the
          plan's walls and the base map's roofs are both visible, so a displacement reads as a
          doubled edge immediately. If a browser could not snapshot the PDF, the outline below
          remains an honest (if weaker) fallback. */}
      {mode.previewUrl && (
        <Source id="s-georef-check-image" type="image" url={mode.previewUrl}
          coordinates={corners as [[number, number], [number, number], [number, number], [number, number]]}>
          <Layer id="l-georef-check-image" type="raster" paint={{ 'raster-opacity': mode.checkOpacity, 'raster-fade-duration': 0 }} />
        </Source>
      )}
      <Source id="s-georef-check" type="geojson" data={data}>
        <Layer id="l-georef-check-fill" type="fill" paint={{ 'fill-color': tone, 'fill-opacity': mode.previewUrl ? 0.02 : 0.1 }} />
        {/* a white halo under the line, like every other thin line this map draws over aerials */}
        <Layer id="l-georef-check-halo" type="line" layout={{ 'line-join': 'round' }} paint={{ 'line-color': '#fff', 'line-width': 5, 'line-opacity': 0.75 }} />
        <Layer id="l-georef-check-line" type="line" layout={{ 'line-join': 'round' }} paint={{ 'line-color': tone, 'line-width': 2.4, 'line-dasharray': [2, 1.6] }} />
      </Source>
    </>
  )
}

// --- the loupe ------------------------------------------------------------------------------

/** Web-Mercator world position, in tile units, at a given zoom. */
function tilePoint(lng: number, lat: number, z: number) {
  const n = 2 ** z
  const rad = (lat * Math.PI) / 180
  return {
    x: ((lng + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
  }
}

/** Fill a raster template's `{z}/{x}/{y}` (and the `{s}` subdomain some templates carry). */
function tileUrl(tpl: string, z: number, x: number, y: number): string {
  return tpl
    .replace('{s}', 'a')
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y))
    .replace('{r}', '')
}

/** One `<img>` of the magnified crop, positioned relative to the crop's own top-left tile. */
interface LoupeTile { key: string; url: string; left: number; top: number }

/**
 * The tile crop behind the magnifier: which tiles to fetch, and how far the plane carrying them
 * has to slide so the aimed point lands in the middle.
 *
 * ⚠️ TILE-RELATIVE, never world-absolute — `dx`/`dy` and every `left`/`top` are measured from
 * the crop's first tile. At z 20 a world pixel coordinate is ~1.4e8, and a browser CLAMPS a CSS
 * transform's translation at ±2²⁵ px (33'554'432): the plane was asked to move −139'856'000px,
 * moved −33'554'432px instead, and every tile ended up a hundred million pixels off to the
 * right. The circle was empty even though all four tiles had loaded — the whole of «the map loupe
 * never appears». Anchoring on the first tile keeps every number a few hundred px at most, well
 * inside both the clamp and float precision. Pure, so the test can pin exactly that.
 */
export function loupeCrop(tpl: string, lng: number, lat: number, z: number, k: number, size: number): { tiles: LoupeTile[]; dx: number; dy: number } {
  const c = tilePoint(lng, lat, z)
  const px = c.x * TILE, py = c.y * TILE
  // radius to cover, in tile px — the diagonal, since the plane is rotated with the map
  const r = (size * 0.75) / k
  const x0 = Math.floor((px - r) / TILE), x1 = Math.floor((px + r) / TILE)
  const y0 = Math.floor((py - r) / TILE), y1 = Math.floor((py + r) / TILE)
  const n = 2 ** z
  const ox = x0 * TILE, oy = y0 * TILE
  const tiles: LoupeTile[] = []
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      if (ty < 0 || ty >= n) continue
      const wx = ((tx % n) + n) % n // wrap at the antimeridian
      tiles.push({ key: `${tx}/${ty}`, url: tileUrl(tpl, z, wx, ty), left: tx * TILE - ox, top: ty * TILE - oy })
    }
  }
  return { tiles, dx: ox - px, dy: oy - py }
}

/** A raster source the loupe can magnify: one `{z}/{x}/{y}` template and how deep it goes. */
interface LoupeSource { tpl: string; maxzoom: number }

/**
 * The tile source the RUNNING MAP is actually painting, read off the live style.
 *
 * ⚠️ Read from the map, not from the `layers` config, and in that order. The config says which
 * base is *configured*; the style says which one is *drawn* — after the operator's own pick, the
 * night swap (`s-<id>-night` is a different source with a different template) and any layer the
 * deployment added. A loupe fed from the config can therefore magnify a different map than the
 * one under the finger, which is the one thing a magnifier must never do.
 *
 * The BOTTOM-most visible raster is the base: MapView pins it below the drawings
 * (`keepBaseBelowDrawings`) and the canton WMS overlays sit above it. Taking the topmost would
 * hand the loupe a mostly-transparent overlay and it would show almost nothing.
 */
function liveBaseSource(map: MlMap | null): LoupeSource | null {
  if (!map) return null
  try {
    const style = map.getStyle()
    for (const l of style?.layers ?? []) {
      if (l.type !== 'raster') continue
      if (map.getLayoutProperty(l.id, 'visibility') === 'none') continue
      const src = style.sources?.[l.source as string]
      if (!src || src.type !== 'raster' || !src.tiles?.length) continue
      return { tpl: src.tiles[0], maxzoom: src.maxzoom ?? 19 }
    }
  } catch { /* style not built yet, or the map is being torn down — the config below covers it */ }
  return null
}

/**
 * The map-side magnifier.
 *
 * ⚠️ NOT a second MapLibre instance. This app's map is assembled from React `<Source>/`<Layer>`
 * children over an EMPTY style, so a second instance would have to rebuild the whole stack —
 * a second WebGL context, a second set of tile requests, and a second copy of every overlay,
 * for a 148px circle. Instead the loupe re-uses the visible BASE raster's own tile template:
 * the tiles are already in the browser (and in the service worker's offline cache), so the
 * magnifier costs a handful of `<img>` elements and no GL at all.
 *
 * The trade is deliberate and worth naming: the loupe shows the base map only — no symbols, no
 * hose lines, no canton overlay. That is exactly right for what it is for. A landmark is a
 * house corner or a path junction, and the operator is aiming at the MAP, not at the Lage drawn
 * on top of it.
 *
 * Three rules keep it honest, in order: magnify the source the map is REALLY drawing
 * (`liveBaseSource`), fall back to the configured base while the style is still being built, and
 * if the tiles will not load at all, render nothing. There is no fourth state — an empty circle
 * says «no house corner here», which is a lie the operator would act on.
 */
export function GeorefMapLoupe({ map, layers, isVisible, night, atRef }: {
  map: MlMap | null
  layers: LayerDef[]
  isVisible: (id: LayerId) => boolean
  night: boolean
  /**
   * The position under the pointer, as a REF the caller writes on every pointer sample — null
   * until the map has been aimed at, which on a touch screen is «not yet»: the loupe then opens
   * on the map's own centre (see `aim` below).
   *
   * ⚠️ A ref and not a prop, because this used to be `useState` in MapView. Every pointer sample
   * of the georef turn therefore re-rendered the whole map tree — and `labelDecisions()` runs
   * unconditionally in that render, projecting every entity through `map.project` and running the
   * full AABB pass. MapView's own comment on `onView` already forbids exactly this ("that
   * re-renders all of IncidentWorkspace every frame"); the loupe was doing the local equivalent
   * while a finger was aiming, on the one device this mode exists for. Now the samples cost a
   * ref write, and only this 168px circle repaints — once per animation frame, not once per
   * sample.
   */
  atRef: { current: { lng: number; lat: number } | null }
}) {
  const mode = useGeorefMode()
  // one rAF tick while the loupe is up: it is the aim's own clock, and it stops with the loupe
  const [, tick] = useState(0)
  useEffect(() => {
    let raf = 0
    const loop = () => { tick((n) => n + 1); raf = requestAnimationFrame(loop) }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  const at = atRef.current
  // Tiles that answered with an error (a 403 from a keyed source, an offline miss). Keyed by URL,
  // so a template that is simply unreachable disqualifies itself after its first tile — see the
  // `alive` check below, which hides the loupe rather than leaving an empty circle on screen.
  const [dead, setDead] = useState<Record<string, true>>({})
  const base = useMemo(() => {
    // what the map is really drawing, first…
    const live = liveBaseSource(map)
    if (live) return live
    // …and the configured base only as a fallback, for the moment before the style exists
    const b = layers.find((l) => l.base && isVisible(l.id) && (l.tiles?.length || l.nightTiles?.length))
    if (!b) return null
    const tiles = (night && b.nightTiles?.length ? b.nightTiles : b.tiles) ?? []
    return tiles.length ? { tpl: tiles[0], maxzoom: b.maxzoom ?? 19 } : null
  }, [map, layers, isVisible, night])

  if (mode.check || !map || !base) return null
  // ⚠️ The magnifier is up for the WHOLE of the map's turn, and it opens by itself on the map's
  // centre. Waiting for a pointer position meant waiting for a hover — which a touch screen never
  // sends, so on the one device this mode is built for the map loupe simply never appeared: you
  // placed the point and only afterwards saw what you had hit. Same rule as the plan half, which
  // opens on the middle of the sheet (GeorefMode · centreAim).
  const aim = at ?? map.getCenter()
  const size = window.innerWidth <= 600 ? 168 : 196

  const live = map.getZoom()
  const z = Math.max(0, Math.min(base.maxzoom, Math.round(live) + LOUPE_ZOOM_UP))
  // scale the integer-zoom tiles back onto the exact magnification we promised, so the loupe is
  // always LOUPE_ZOOM_UP levels over the live map however fractional that map's zoom is
  const k = 2 ** (live + LOUPE_ZOOM_UP - z)
  const crop = loupeCrop(base.tpl, aim.lng, aim.lat, z, k, size)
  // Every tile of this crop answered with an error ⇒ the template is not usable here (a keyed
  // source without its key, an offline gap). Show NOTHING rather than a fine-looking empty
  // circle: a magnifier that reports «nothing is there» about a house corner that is there is
  // worse than no magnifier, and the map underneath stays perfectly aimable without it.
  const alive = crop.tiles.filter((t) => !dead[t.url])
  if (!alive.length) return null

  return (
    <div className={s.loupe} aria-hidden>
      <div
        className={s.plane}
        style={{ transform: `translate(${size / 2}px, ${size / 2}px) rotate(${-map.getBearing()}deg) scale(${k}) translate(${crop.dx}px, ${crop.dy}px)` }}
      >
        {alive.map((t) => (
          <img key={t.key} src={t.url} alt="" style={{ left: t.left, top: t.top }} draggable={false}
            onError={() => setDead((d) => (d[t.url] ? d : { ...d, [t.url]: true }))} />
        ))}
      </div>
      <span className={s.xh} />
      <span className={s.ring} />
    </div>
  )
}
