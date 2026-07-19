import { Fragment } from 'react'
import { Source, Layer } from 'react-map-gl/maplibre'
import type { LayerDef, LayerId, PreparedMapOverlay } from '../types'
import { circlePolygon } from '../lib/geo'
import { vis, lineFeat } from '../lib/mapView'
import { useNightTheme } from '../lib/useNightTheme'

// Night mode dims the basemap so it's mostly dark without losing detail (buildings/roads stay
// visible) — a gentle dim, NOT a full dark/black swap. Applied to the BASE raster only, so the
// tactical overlays/symbols keep their real colours. Each basemap stays itself (no swap), just
// darker; satellite imagery is left untouched.
const NIGHT_BASE_PAINT = { 'raster-brightness-max': 0.6, 'raster-saturation': -0.1, 'raster-contrast': 0.1 } as const
// A true-dark raster (Carto Dark Matter, or the night swap) renders buildings near-black on black,
// so almost everything is invisible. `raster-brightness-min` is the lever: it lifts the BLACK floor
// so the dark structure rises into a legible charcoal range. (Positive `raster-contrast` would do
// the opposite here — it pushes the dark mid-tones back toward black — so we keep it flat/slightly
// negative.) Raise brightness-min toward ~0.4 for lighter, lower toward ~0.2 for darker.
const DARK_BASE_PAINT = { 'raster-brightness-min': 0.34, 'raster-contrast': -0.05 } as const

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
          </Fragment>
        )
      })}

      {/* overlay raster layers (e.g. canton WMS) — above base, below zones/markers */}
      {layers.filter((l) => !l.base && l.tiles).map((o) => (
        <Source key={o.id} id={`s-${o.id}`} type="raster" tiles={o.tiles} tileSize={256} maxzoom={o.maxzoom} attribution={o.attribution}>
          <Layer id={`l-${o.id}`} type="raster" layout={vis(isVisible(o.id))} paint={{ 'raster-opacity': (o.opacity ?? 100) / 100 }} />
        </Source>
      ))}

      {/* vector overlays from local GeoJSON (Leitungskataster). Mount only when visible
          so the file is fetched lazily on toggle, not upfront. */}
      {layers.filter((l) => !l.base && l.geojson && isVisible(l.id)).map((o) => (
        <Source key={o.id} id={`s-${o.id}`} type="geojson" data={o.geojson!} attribution={o.attribution}>
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
          data={
            overlay.kind === 'circle'
              ? { type: 'Feature' as const, geometry: { type: 'Polygon' as const, coordinates: circlePolygon(overlay.center, overlay.radiusM) }, properties: {} }
              : lineFeat(overlay.coords)
          }
        >
          {overlay.kind === 'circle' ? (
            <>
              <Layer
                id={`l-${overlay.id}-fill`}
                source={`s-${overlay.id}`}
                type="fill"
                layout={vis(isVisible(overlay.layer))}
                paint={{ 'fill-color': overlay.color, 'fill-opacity': overlay.fillOpacity ?? 0.08 }}
              />
              <Layer
                id={`l-${overlay.id}-line`}
                source={`s-${overlay.id}`}
                type="line"
                layout={vis(isVisible(overlay.layer))}
                paint={{
                  'line-color': overlay.color,
                  'line-opacity': overlay.lineOpacity ?? 0.5,
                  'line-width': overlay.lineWidth ?? 2,
                  'line-dasharray': overlay.lineDasharray ?? [2, 2.5],
                }}
              />
            </>
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
