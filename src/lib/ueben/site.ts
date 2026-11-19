// «Üben»: the practice site – the small invented scene every fresh practice Einsatz starts with
// (lib/practice/localServer · ensurePracticeIncident writes it as the first workspace).
//
// Placed in METRES from the station's own map centre (deploymentConfig · deploymentDefaultCenter),
// so the real terrain and streets lie under it and the Wassertransport profile is a real one. The
// names are generic on purpose – «H1», «Eingang» – never a station fact: nothing here may
// read as the Wehr's own hydrant or building (owner, 19.11.2026: invented site names that looked
// like station facts confused him).
//
// The ids are FIXED, not `newId`s: they are seed data, like data/demoIncident's `hyd1`, and the
// drills find the site by them (`siteOf`). A site object the operator removed is simply missing –
// the drill says so and «Neu beginnen» brings the site back.

import { appConfig } from '../../config/appConfig'
import { formatSymbolName } from '../format'
import type { Drawing, Entity, LngLat } from '../../types'

export const SITE_IDS = { h1: 'ueben-h1', eingang: 'ueben-eingang', gebaeude: 'ueben-gebaeude' } as const

/** the practice building's own colour: the drills' violet (01-tokens · --ueben), as a wash – a
 *  real building on the base map is grey, so the practice one cannot be taken for it */
const GEBAEUDE_COLOUR = '#7c3aed'

/** `[lng, lat]` `eastM` metres east and `northM` metres north of `c` (flat earth – a few hundred
 *  metres off the centre, the error is millimetres). */
export function offsetM(c: LngLat, eastM: number, northM: number): LngLat {
  const mPerLat = 110540
  const mPerLng = 111320 * Math.cos((c[1] * Math.PI) / 180)
  return [c[0] + eastM / mPerLng, c[1] + northM / mPerLat]
}

/** The scene, laid out around `c` – the practice Einsatz's own position, so the Einsatzort pin
 *  stands IN the Übungsgebäude (30 × 30 m, violet wash), not beside a label: the Eingang on its
 *  south wall, Hydrant H1 some 50 m south-west of it. */
export function siteScene(c: LngLat): { entities: Entity[]; drawings: Drawing[] } {
  const C = appConfig.copy.ueben.site
  const ring: LngLat[] = [offsetM(c, -15, -15), offsetM(c, 15, -15), offsetM(c, 15, 15), offsetM(c, -15, 15)]
  return {
    entities: [
      {
        id: SITE_IDS.h1, kind: 'symbol', layer: appConfig.defaults.operationalLayerId, coord: offsetM(c, -45, -40),
        symbol: 'SI Ueberflurhydrant', label: C.hydrant, subtitle: formatSymbolName('SI Ueberflurhydrant'),
      },
      {
        id: SITE_IDS.eingang, kind: 'note', layer: appConfig.defaults.drawingLayerId, coord: offsetM(c, 0, -15),
        label: C.eingang, subtitle: appConfig.copy.entities.noteSubtitle,
      },
    ],
    drawings: [
      { id: SITE_IDS.gebaeude, kind: 'area', coords: ring, color: GEBAEUDE_COLOUR, width: 3, fillOpacity: 0.22, locked: true },
    ],
  }
}

/** The site objects as they stand in the workspace now – each `undefined` once removed. */
export function siteOf(entities: readonly Entity[]) {
  const by = (id: string) => entities.find((e) => e.id === id)
  return { h1: by(SITE_IDS.h1), eingang: by(SITE_IDS.eingang) }
}
export type Site = ReturnType<typeof siteOf>
