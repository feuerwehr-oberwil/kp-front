// «Karte & Objekte» — the Ebenen quick-taps «Alle ein» / «Alle aus» / «Standard» (review round 2,
// 17.10.2026, owner: «ebenen should also have the "alle" / "keine" / "standard" setup»). Same
// three chips and the same meaning as in an Einsatz (IncidentWorkspace · setAllLayers /
// resetLayers, lib/layerPreset), over the viewer's OWN layers (lib/karte/session):
//
//   · «Standard» = the deployment's default set as the viewer opens it with no device choice
//     (`viewerLayers(defaultLayers(), undefined)`), the Basiskarte included;
//   · «Alle ein» / «Alle aus» = every overlay on / off, the Basiskarte untouched.
//
// The viewer's own rows outside `layers` count as layers too — «Stationsobjekte» and whatever
// else the panel lists for the station (category rows): on in «Standard», switched by «Alle» and
// «Keine» like any overlay. They are passed in as rows, never as a list kept here, so a row the
// panel gains is covered without touching this file. Deliberately NOT a row here: the aligned
// plan on the map («Objektplan auf der Karte») — a plan backdrop is something switched on on
// purpose for one object, and the Einsatz's quick-taps leave plan rasters alone too. The radar
// follows the Einsatz's rule (workspace/useKarteWeather): «Standard» and «Alle aus» switch it
// off, «Alle ein» leaves it, and while it is on no chip is lit.

import type { LayerDef } from '../../types'
import { layerPreset, type LayerPreset } from '../layerPreset'

export type QuickTap = 'all' | 'none' | 'standard'

/** A viewer row outside `layers` that the quick-taps reach. `standard`: its state in «Standard»
 *  (on unless said otherwise — a station row exists to be seen). */
export interface PresetRow { id: string; visible: boolean; standard?: boolean }

const asLayer = (id: string, visible: boolean) => ({ id, visible, base: false }) as unknown as LayerDef

/** Which chip the Ebenen on screen match: `layers` + the rows against the defaults + the rows'
 *  standard states (lib/layerPreset · layerPreset, which ignores ids missing on either side). */
export function karteLayerPreset(layers: readonly LayerDef[], defaults: readonly LayerDef[], rows: readonly PresetRow[], radarOn = false): LayerPreset {
  return layerPreset(
    [...layers, ...rows.map((r) => asLayer(r.id, r.visible))],
    [...defaults, ...rows.map((r) => asLayer(r.id, r.standard ?? true))],
    radarOn,
  )
}

/** The viewer's `layers` after a chip: visibility only — a transparency set by hand stays. */
export function applyLayerPreset(layers: readonly LayerDef[], defaults: readonly LayerDef[], tap: QuickTap): LayerDef[] {
  if (tap === 'standard') {
    const want = new Map(defaults.map((l) => [l.id, l.visible]))
    const next = layers.map((l) => (want.has(l.id) && want.get(l.id) !== l.visible ? { ...l, visible: want.get(l.id)! } : l))
    // exactly one Basiskarte, whatever the defaults name (a base the deployment dropped keeps the one on)
    return next.some((l) => l.base && l.visible) ? next : [...layers]
  }
  const on = tap === 'all'
  return layers.map((l) => (l.base || l.visible === on ? l : { ...l, visible: on }))
}

/** The rows a chip has to flip (they are toggled through the panel's own `onToggle`). */
export function presetFlips(rows: readonly PresetRow[], tap: QuickTap): string[] {
  return rows.filter((r) => r.visible !== (tap === 'standard' ? r.standard ?? true : tap === 'all')).map((r) => r.id)
}
