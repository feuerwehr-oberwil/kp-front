import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useMap } from 'react-map-gl/maplibre'
import { appConfig } from '../config/appConfig'
import { ensureHatchImage, ensureHatchImages, hatchImageColor } from '../lib/draw'
import { ARROW_IDS, ensureArrowImages, pointIconRegistry, pointIconVariants, type MapImageHost } from '../lib/mapImages'
import type { LayerDef } from '../types'

/**
 * Registers every image the Karte's layers draw — arrowheads, Schraffur tiles, Leitungskataster
 * point symbols — on the map it is mounted in. Rendered as the FIRST child of `<Map>`: children
 * mount as soon as the map instance exists, which is before the first tile asks for an icon and
 * well before `onLoad`, where the old registration effects waited (lib/mapImages says why that
 * logged three «could not be loaded» warnings on every open). Renders nothing.
 */
export function MapImages({ layers, byName }: { layers: readonly LayerDef[]; byName: Readonly<Record<string, string>> }) {
  const { current } = useMap()
  const map = current?.getMap()
  const variants = useMemo(() => pointIconVariants(layers, byName), [layers, byName])
  const registry = useRef<ReturnType<typeof pointIconRegistry> | null>(null)

  // ⚠️ A LAYOUT effect: it runs synchronously in the commit that mounts the <Layer> siblings,
  // before any macrotask — so before the worker's first image request can arrive and find no
  // resolver. A passive effect runs after paint, from a scheduler task that could lose that race
  // (CodeRabbit on #232). The listener then stays installed across style reloads.
  useLayoutEffect(() => {
    if (!map) return
    const host = map as unknown as MapImageHost
    const icons = pointIconRegistry(host)
    registry.current = icons
    // A style reload drops every registered image, so all three families are re-checked on each
    // `styledata` (a cheap hasImage walk when nothing is missing) — the point icons as their
    // decoded pictures, which the registry keeps.
    const ensure = () => {
      const a = ensureArrowImages(host)
      ensureHatchImages(map, appConfig.drawing.colors)
      icons.restore()
      if (a) map.triggerRepaint()
    }
    // ⚠️ A resolver (`setMissingStyleImageResolver`), not a `styleimagemissing` listener: since
    // MapLibre 6 that event is notify-only and fires after the tile's request was answered without
    // the image, so what it added came too late for the layout that asked (lib/draw ·
    // ensureHatchImages). The resolver is awaited first; everything below adds synchronously.
    const resolveMissing = (id: string) => {
      if ((ARROW_IDS as readonly string[]).includes(id)) { if (ensureArrowImages(host)) map.triggerRepaint(); return }
      if (icons.answerMissing(id)) return
      // a colour outside the palette (a legacy drawing, a station that re-cut `drawing.colors`)
      // asks for a Schraffur tile nobody registered — a missing `fill-pattern` paints NOTHING,
      // so that Fläche would simply be gone from the Karte. Mint it the moment it is asked for.
      const c = hatchImageColor(id)
      if (c) { ensureHatchImage(map, id, c); map.triggerRepaint() }
    }
    map.setMissingStyleImageResolver(resolveMissing)
    map.on('styledata', ensure)
    try { ensure() } catch { /* style not ready yet — `styledata` brings it */ }
    return () => {
      map.setMissingStyleImageResolver(null)
      map.off('styledata', ensure)
      icons.dispose()
      if (registry.current === icons) registry.current = null
    }
  }, [map])

  // the layer list and the symbol pack arrive and change independently of the map
  useEffect(() => { registry.current?.sync(variants) }, [map, variants])

  return null
}
