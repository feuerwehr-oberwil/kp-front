import type { LayerDef } from '../types'
import { appConfig } from '../config/appConfig'

/** Which of the Ebenen panel's three quick-taps the layer set on screen matches (05.10.2026,
 *  owner: «ebenen should have an indication when using standard or all on / off»).
 *
 *  - `standard` — exactly what «Standard» sets: every layer, the Basiskarte included, as the
 *    Einsatz category opens with (IncidentWorkspace · resetLayers). Checked FIRST, so a category
 *    whose default happens to be «everything on» still reads as its default.
 *  - `all` / `none` — every overlay on / off, as «Alle ein» / «Alle aus» leave it; the Basiskarte
 *    is not part of those taps, so it is not part of the answer either.
 *  - `custom` — anything else: a row was switched by hand.
 *
 *  Visibility only: a transparency slider moved is still the same set of layers. Layers missing
 *  from either side are ignored rather than counted, so a deployment's config layer that came or
 *  went does not flip the answer.
 *
 *  `radarOn` – the «Niederschlag (Radar)» row (workspace/useKarteWeather), a device pref outside
 *  `layers`: «Standard» and «Alle aus» switch it off, so while it is on the set is neither of them,
 *  and «Alle ein» leaves it alone, so it is not that either – «Eigene Auswahl» (10.10.2026, owner:
 *  «Standard» lit with the radar on the map). */
export type LayerPreset = 'standard' | 'all' | 'none' | 'custom'

export function layerPreset(layers: LayerDef[], defaults: LayerDef[], radarOn = false): LayerPreset {
  if (radarOn) return 'custom'
  const byId = new Map(defaults.map((l) => [l.id, l.visible]))
  const matchesDefault = layers.every((l) => !byId.has(l.id) || byId.get(l.id) === l.visible)
  if (matchesDefault) return 'standard'
  const overlays = layers.filter((l) => !l.base)
  if (overlays.length && overlays.every((l) => l.visible)) return 'all'
  if (overlays.length && overlays.every((l) => !l.visible)) return 'none'
  return 'custom'
}

/** the preset's name as the panel's quick-taps say it — «Standard», «Alle ein», «Alle aus» — or
 *  «Eigene Auswahl»: the Ebenen button's tooltip and screen-reader state */
export function layerPresetLabel(p: LayerPreset): string {
  const c = appConfig.copy.layerPanel
  return p === 'standard' ? c.reset : p === 'all' ? c.showAll : p === 'none' ? c.hideAll : c.custom
}
