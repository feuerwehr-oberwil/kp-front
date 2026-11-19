// «Üben»: the practice site – the small invented scene every fresh practice Einsatz starts with
// (lib/practice/localServer · ensurePracticeIncident writes it as the first workspace).
//
// Placed in METRES from the station's own map centre (deploymentConfig · deploymentDefaultCenter),
// so the real terrain and streets lie under it and the Wassertransport profile is a real one. The
// names are generic on purpose – «H1», «W», «Eingang» – never a station fact: nothing here may
// read as the Wehr's own hydrant or building (owner, 19.11.2026: invented site names that looked
// like station facts confused him).
//
// The ids are FIXED, not `newId`s: they are seed data, like data/demoIncident's `hyd1`, and the
// drills find the site by them (`siteOf`). A site object the operator removed is simply missing –
// the drill says so and «Neu beginnen» brings the site back.

import { appConfig } from '../../config/appConfig'
import { formatSymbolName } from '../format'
import type { Drawing, Entity, LngLat } from '../../types'

export const SITE_IDS = { h1: 'ueben-h1', eingang: 'ueben-eingang', weiher: 'ueben-w', gebaeude: 'ueben-gebaeude' } as const

/** `[lng, lat]` `eastM` metres east and `northM` metres north of `c` (flat earth – a few hundred
 *  metres off the centre, the error is millimetres). */
export function offsetM(c: LngLat, eastM: number, northM: number): LngLat {
  const mPerLat = 110540
  const mPerLng = 111320 * Math.cos((c[1] * Math.PI) / 180)
  return [c[0] + eastM / mPerLng, c[1] + northM / mPerLat]
}

/** The scene, laid out around `c`: Hydrant H1 south-west, a small Übungsgebäude east with its
 *  Eingang on the west wall (≈ 64 m from H1), the Löschweiher W north-west. */
export function siteScene(c: LngLat): { entities: Entity[]; drawings: Drawing[] } {
  const C = appConfig.copy.ueben.site
  const ring: LngLat[] = [offsetM(c, 15, -10), offsetM(c, 45, -10), offsetM(c, 45, 20), offsetM(c, 15, 20)]
  return {
    entities: [
      {
        id: SITE_IDS.h1, kind: 'symbol', layer: appConfig.defaults.operationalLayerId, coord: offsetM(c, -45, -25),
        symbol: 'SI Ueberflurhydrant', label: C.hydrant, subtitle: formatSymbolName('SI Ueberflurhydrant'),
      },
      {
        id: SITE_IDS.weiher, kind: 'symbol', layer: appConfig.defaults.operationalLayerId, coord: offsetM(c, -60, 45),
        symbol: 'WV Loeschweier', label: C.weiher, subtitle: formatSymbolName('WV Loeschweier'),
      },
      {
        id: SITE_IDS.eingang, kind: 'note', layer: appConfig.defaults.drawingLayerId, coord: offsetM(c, 12, 5),
        label: C.eingang, subtitle: appConfig.copy.entities.noteSubtitle,
      },
    ],
    drawings: [
      { id: SITE_IDS.gebaeude, kind: 'area', coords: ring, color: '#64748b', width: 3, locked: true },
    ],
  }
}

/** The site objects as they stand in the workspace now – each `undefined` once removed. */
export function siteOf(entities: readonly Entity[]) {
  const by = (id: string) => entities.find((e) => e.id === id)
  return { h1: by(SITE_IDS.h1), eingang: by(SITE_IDS.eingang), weiher: by(SITE_IDS.weiher) }
}
export type Site = ReturnType<typeof siteOf>
