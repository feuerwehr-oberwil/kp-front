import { Fragment, useEffect, useState } from 'react'
import { Source, Layer } from 'react-map-gl/maplibre'
import type { LayerDef, LayerId, PreparedMapOverlay } from '../types'
import type { LayerData } from '../lib/layerData'
import { circlePolygon } from '../lib/geo'
import { vis, lineFeat } from '../lib/mapView'
import { useNightTheme } from '../lib/useNightTheme'
import { hatchImageId } from '../lib/draw'
import { prefersReducedMotion } from '../lib/reducedMotion'
import { loadLayerData, useLayerData } from '../lib/layerData'
import { LABEL_ATTRIBUTION, LABEL_MAXZOOM, LABEL_TILES, labelLayers } from '../lib/basemapLabels'

// Night mode dims the basemap so it's mostly dark without losing detail (buildings/roads stay
// visible) — a gentle dim, NOT a full dark/black swap. Applied to the BASE raster only, so the
// tactical overlays/symbols keep their real colours. Each basemap stays itself (no swap), just
// darker; satellite imagery is left untouched.
const NIGHT_BASE_PAINT = { 'raster-brightness-max': 0.6, 'raster-saturation': -0.1, 'raster-contrast': 0.1 } as const
// A true-dark raster (Carto Dark Matter, or the night swap) renders buildings near-black on black:
// measured off a z17 tile (20.09.2026) the whole picture lives in 0–33 of 255 – buildings 0,
// ground 8, roads 25. MapLibre's shader is `mix(min, max, (v − .5) · f + .5)` with
// f = 1 / (1 − contrast), so the separation between two dark tones is scaled by f · (max − min).
// `raster-brightness-min` ALONE lifts the floor but squeezes that span (0.34 → ×0.63: everything
// landed in 91–112, one flat grey). The pair does both: a high min sets the floor, a high
// positive contrast stretches the dark end back out underneath it (×1.47 here: 36–84, the floor
// DARKER than before and the roads further from it). Floor = .5 + .5·min − .5·f·(1 − min); keep
// it near 0.14 when retuning, and the labels (≥ ~0.55 in the source) clip to white.
const DARK_BASE_PAINT = { 'raster-brightness-min': 0.75, 'raster-contrast': 0.83 } as const

/** One prepared overlay as GeoJSON — the same object for the same overlay, so a re-render hands
 *  react-map-gl the data it already has and MapLibre is not made to re-tile it. That matters for
 *  the big ones: the region's ~15 000 underground buildings («Karte & Objekte», one overlay kept
 *  by identity in karte/useKarteOverlays) were re-sent to the worker on every pan's render without it. */
const overlayDataCache = new WeakMap<PreparedMapOverlay, ReturnType<typeof buildOverlayData>>()
function overlayData(overlay: PreparedMapOverlay) {
  let data = overlayDataCache.get(overlay)
  if (!data) { data = buildOverlayData(overlay); overlayDataCache.set(overlay, data) }
  return data
}

/** A circle's polygon, a line, or a set of outlines (each ring its own polygon, so one source
 *  carries every station object of «Karte & Objekte»). */
function buildOverlayData(overlay: PreparedMapOverlay) {
  if (overlay.kind === 'circle') {
    return { type: 'Feature' as const, geometry: { type: 'Polygon' as const, coordinates: circlePolygon(overlay.center, overlay.radiusM) }, properties: {} }
  }
  if (overlay.kind === 'polygons') {
    return {
      type: 'FeatureCollection' as const,
      features: overlay.rings.filter((r) => r.length >= 3).map((r) => ({
        type: 'Feature' as const,
        geometry: { type: 'Polygon' as const, coordinates: [[...r, r[0]]] },
        properties: {},
      })),
    }
  }
  return lineFeat(overlay.coords)
}

/** how long a `fadeIn` overlay takes to reach its opacity — the Karte's markers arrive at the
 *  same pace (lib/karte/arrival) */
const FADE_IN_MS = 280

/** The fill + line pair of a circle / polygons overlay. A polygons overlay with `fadeIn` mounts
 *  transparent and reaches its opacity over FADE_IN_MS on the next frame, carried by MapLibre's
 *  paint transition — «Karte & Objekte»'s outlines, which answer a viewport fetch well after the
 *  map stands (owner, 20.10.2026: «subtle motion for what arrives»). Rings added later (a pan's
 *  new area) change the SOURCE, not the layer, so they never fade; a layer toggled off and on in
 *  Ebenen fades again, which is the same arrival. Reduced motion: MapLibre has no media query, so
 *  the pair asks (lib/reducedMotion) and mounts opaque. */
function FilledOverlay({ overlay, visible }: { overlay: Extract<PreparedMapOverlay, { kind: 'circle' | 'polygons' }>; visible: boolean }) {
  const fade = overlay.kind === 'polygons' && !!overlay.fadeIn && !prefersReducedMotion()
  const [shown, setShown] = useState(!fade)
  useEffect(() => {
    if (shown) return
    const f = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(f)
  }, [shown])
  const k = shown ? 1 : 0
  const transition = fade ? { duration: FADE_IN_MS } : undefined
  const minzoom = overlay.kind === 'polygons' && overlay.minzoom != null ? { minzoom: overlay.minzoom } : {}
  return (
    <>
      <Layer
        id={`l-${overlay.id}-fill`}
        source={`s-${overlay.id}`}
        type="fill"
        {...minzoom}
        layout={vis(visible)}
        // a hatched overlay paints the Schraffur tile of its colour (registered on demand by
        // MapImages' missing-image resolver, like a hatched Fläche). No antialiasing: the
        // rings are adjacent tiles, and antialiased edges drew a seam along every one.
        paint={{
          ...(overlay.kind === 'polygons' && overlay.hatch
            ? { 'fill-pattern': hatchImageId(overlay.color), 'fill-opacity': (overlay.fillOpacity ?? 1) * k, 'fill-antialias': false }
            : { 'fill-color': overlay.color, 'fill-opacity': (overlay.fillOpacity ?? 0.08) * k }),
          ...(transition ? { 'fill-opacity-transition': transition } : {}),
        }}
      />
      <Layer
        id={`l-${overlay.id}-line`}
        source={`s-${overlay.id}`}
        type="line"
        {...minzoom}
        layout={vis(visible)}
        paint={{
          'line-color': overlay.color,
          'line-opacity': (overlay.lineOpacity ?? 0.5) * k,
          'line-width': overlay.lineWidth ?? 2,
          // an outline is solid unless it asks otherwise; a circle keeps its dashes
          ...(overlay.kind === 'circle' || overlay.lineDasharray
            ? { 'line-dasharray': overlay.lineDasharray ?? [2, 2.5] }
            : {}),
          ...(transition ? { 'line-opacity-transition': transition } : {}),
        }}
      />
    </>
  )
}

interface Props {
  layers: LayerDef[]
  preparedOverlays: PreparedMapOverlay[]
  isVisible: (id: LayerId) => boolean
  mapReady: boolean
}

/**
 * The raster/vector basemap + overlay layer stack: radio base rasters, canton WMS
 * overlays, local Leitungskataster GeoJSON (point/line), and the prepared incident
 * overlays (zones / circles). Pure MapLibre source/layer config driven by `layers`.
 */
export function MapLayers({ layers, preparedOverlays, isVisible, mapReady }: Props) {
  const baseLayers = layers.filter((l) => l.base)
  const night = useNightTheme()
  /* The GeoJSON overlays (Leitungskataster) are fetched by the app, not by MapLibre: the Ebenen
     row has to be able to say how far a multi-megabyte Leitungen file has got (lib/layerData),
     and a source pointed at the URL would download it a second time inside the worker. Started
     from an effect while the layer is on, so a layer nobody switched on is never fetched. */
  const vectorLayers = layers.filter((l) => !l.base && l.geojson && isVisible(l.id))
  const loads = useLayerData()
  const vectorKeys = vectorLayers.map((l) => `${l.id}|${l.geojson}`).join(',')
  useEffect(() => {
    for (const key of vectorKeys ? vectorKeys.split(',') : []) {
      const at = key.indexOf('|')
      loadLayerData(key.slice(0, at), key.slice(at + 1))
    }
  }, [vectorKeys])
  return (
    <>
      {/* base layers (radio). In night mode a light street base swaps to its dark variant
          (Carto Dark Matter) for a real dark map; bases without a dark variant get a gentle dim
          instead (satellite + already-dark bases are left untouched). */}
      {baseLayers.map((b) => {
        const hasNight = !!b.nightTiles // a purpose-built dark raster beats dimming
        const visible = isVisible(b.id)
        // a base WITH a dark variant renders BOTH rasters as STABLE sources and just toggles
        // their visibility on theme change — NEVER remounting the base source. Re-keying it
        // (the old approach) made react-map-gl re-add the base layer ON TOP of the drawings,
        // burying them until a refresh. react-map-gl appends every layer without a beforeId and
        // re-adds late-loading sources on each `styledata`, so a raster that loads after the
        // (synchronous) draw layers lands ON TOP and paints over them. MapView keeps the base
        // pinned below the drawings via a styledata re-order (keepBaseBelowDrawings).
        const dim = night && !b.dark && !hasNight && b.icon !== 'sat' // dim only when there's no dark swap
        return (
          <Fragment key={b.id}>
            <Source id={`s-${b.id}`} type="raster" tiles={b.tiles} tileSize={256} maxzoom={b.maxzoom} attribution={b.attribution}>
              <Layer id={`l-${b.id}`} type="raster" layout={vis(visible && !(night && hasNight))} paint={{ 'raster-opacity': (b.opacity ?? 100) / 100, ...(dim ? NIGHT_BASE_PAINT : {}), ...(b.dark ? DARK_BASE_PAINT : {}) }} />
            </Source>
            {hasNight && (
              <Source id={`s-${b.id}-night`} type="raster" tiles={b.nightTiles} tileSize={256} maxzoom={b.maxzoom} attribution={b.attribution}>
                <Layer id={`l-${b.id}-night`} type="raster" layout={vis(visible && night)} paint={{ 'raster-opacity': (b.opacity ?? 100) / 100, ...DARK_BASE_PAINT }} />
              </Source>
            )}
            {/* the names over an unlabelled raster, day and night alike (lib/basemapLabels). Same
                stable-source rule as above; the `l-base…` ids keep them in keepBaseBelowDrawings. */}
            {b.labels && (
              <Source id={`s-${b.id}-labels`} type="vector" tiles={LABEL_TILES} maxzoom={LABEL_MAXZOOM} attribution={LABEL_ATTRIBUTION}>
                {labelLayers(`s-${b.id}-labels`, `l-${b.id}-labels`, night).map((l) => (
                  <Layer key={l.id} {...l} layout={{ ...l.layout, ...vis(visible) }}
                    paint={{ ...l.paint, 'text-opacity': (b.opacity ?? 100) / 100 }} />
                ))}
              </Source>
            )}
          </Fragment>
        )
      })}

      {/* overlay raster layers (e.g. canton WMS) — above base, below zones/markers */}
      {layers.filter((l) => !l.base && l.tiles).map((o) => (
        <Source key={o.id} id={`s-${o.id}`} type="raster" tiles={o.tiles} tileSize={256} maxzoom={o.maxzoom} attribution={o.attribution}>
          <Layer id={`l-${o.id}`} type="raster" layout={vis(isVisible(o.id))} paint={{ 'raster-opacity': (o.opacity ?? 100) / 100 }} />
        </Source>
      ))}

      {/* vector overlays from local GeoJSON (Leitungskataster). Mounted only once the app has
          the collection in hand (lib/layerData), which is also when the Ebenen row stops
          reporting progress — an empty or failed file draws nothing and says so in its row. */}
      {vectorLayers.map((o) => [o, loads.get(o.id)] as const)
        .filter((pair): pair is [LayerDef, Extract<LayerData, { state: 'ready' }>] => pair[1]?.state === 'ready')
        .map(([o, load]) => (
        <Source key={o.id} id={`s-${o.id}`} type="geojson" data={load.data} attribution={o.attribution}>
          {o.vectorKind === 'point' && o.symbol ? (
            <Layer
              id={`l-${o.id}`}
              type="symbol"
              layout={{
                'icon-image': night && o.nightColor ? `icon-${o.id}-night` : `icon-${o.id}`,
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
                'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.22, 17, 0.42, 20, 0.8],
              }}
              paint={{ 'icon-opacity': (o.opacity ?? 100) / 100 }}
            />
          ) : o.vectorKind === 'point' ? (
            <Layer
              id={`l-${o.id}`}
              type="circle"
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 2, 17, 4, 20, 7],
                'circle-color': (night && o.nightColor) || o.color || '#e23',
                'circle-opacity': (o.opacity ?? 100) / 100,
                'circle-stroke-color': '#fff',
                'circle-stroke-width': 1.2,
              }}
            />
          ) : (
            <Layer
              id={`l-${o.id}`}
              type="line"
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{
                'line-color': (night && o.nightColor) || o.color || '#39f',
                'line-opacity': (o.opacity ?? 100) / 100,
                'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.6, 17, 1.6, 20, 4],
              }}
            />
          )}
        </Source>
      ))}

      {/* hold overlay sources/layers until the style is loaded, else MapLibre logs
          "missing required property source" when a Layer mounts before its Source */}
      {mapReady && preparedOverlays.map((overlay) => (
        <Source
          key={overlay.id}
          id={`s-${overlay.id}`}
          type="geojson"
          data={overlayData(overlay)}
        >
          {overlay.kind === 'circle' || overlay.kind === 'polygons' ? (
            <FilledOverlay overlay={overlay} visible={isVisible(overlay.layer)} />
          ) : (
            <Layer
              id={`l-${overlay.id}`}
              source={`s-${overlay.id}`}
              type="line"
              layout={vis(isVisible(overlay.layer))}
              paint={{
                'line-color': overlay.color,
                'line-width': overlay.width ?? 3,
                'line-dasharray': overlay.dasharray ?? [1.5, 1.2],
              }}
            />
          )}
        </Source>
      ))}
    </>
  )
}
