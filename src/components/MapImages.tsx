import { useEffect, useMemo, useRef } from 'react'
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

  useEffect(() => {
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
    const onMissing = (e: { id: string }) => {
      if ((ARROW_IDS as readonly string[]).includes(e.id)) { if (ensureArrowImages(host)) map.triggerRepaint(); return }
      if (icons.answerMissing(e.id)) return
      // a colour outside the palette (a legacy drawing, a station that re-cut `drawing.colors`)
      // asks for a Schraffur tile nobody registered — a missing `fill-pattern` paints NOTHING,
      // so that Fläche would simply be gone from the Karte. Mint it the moment it is asked for.
      const c = hatchImageColor(e.id)
      if (c) { ensureHatchImage(map, e.id, c); map.triggerRepaint() }
    }
    map.on('styleimagemissing', onMissing)
    map.on('styledata', ensure)
    try { ensure() } catch { /* style not ready yet — `styledata` brings it */ }
    return () => {
      map.off('styleimagemissing', onMissing)
      map.off('styledata', ensure)
      icons.dispose()
      if (registry.current === icons) registry.current = null
    }
  }, [map])

  // the layer list and the symbol pack arrive and change independently of the map
  useEffect(() => { registry.current?.sync(variants) }, [map, variants])

  return null
}
