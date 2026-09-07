// ERG Schutzabstand rings — the placard's isolation/protective distances drawn on the Karte
// (Feldtest Manuel, 07.09.: «kannst ja gleich einen Radius zeichnen, automatisch. Mit Warnung»).
//
// Derived, never stored: the rings are computed from the placard entity's UN number on every
// render, so they follow the marker, vanish with it, and can never drift out of sync the way a
// hand-drawn Absperrkreis does. They ride the placard's own layer, so hiding «taktisch» hides
// them too. ⚠️ Like the panel's ERG block they are a Planungshilfe (AGENTS.md 3am rule): the
// assumptions — first TIH row, day window, circles where the ERG means downwind corridors —
// are named here and surfaced next to the control in the ContextPanel, not hidden.

import type { Entity, PreparedMapOverlay } from '../types'
import { appConfig } from '../config/appConfig'
import { lookupErg, type ErgTihRow } from './erg'
import { UN_CAPABLE } from './symbols'

/** The per-placard mode (SymbolProps.ergRings). Absent = 'small': the whole point is that the
 *  rings appear WITHOUT anybody drawing them, and the small-spill pair is the conservative
 *  first answer the ERG itself opens with. 'large' switches to the large-spill column;
 *  'off' silences a placard whose rings are in the way. */
export type ErgRingMode = 'off' | 'small' | 'large'

export const DEFAULT_ERG_RING_MODE: ErgRingMode = 'small'

/** "30 m" / "0.2 km" / "11.0+ km (7.0+ mi)" → metres. The ERG tables carry nothing but these
 *  shapes; anything else (the 'T3' sentinel, a missing cell) is honestly not a distance. */
export function parseErgDistance(value: string | undefined): number | null {
  if (!value) return null
  const m = /^(\d+(?:\.\d+)?)\+?\s?(m|km)\b/.exec(value.trim())
  if (!m) return null
  const n = Number(m[1])
  return m[2] === 'km' ? Math.round(n * 1000) : Math.round(n)
}

/** ERG protective distances split at sunrise/sunset; without an ephemeris the day window is the
 *  07–19 h approximation. The panel shows both values regardless, so the assumption costs a
 *  reader nothing but a glance. */
export function isErgDay(now: Date): boolean {
  const h = now.getHours()
  return h >= 7 && h < 19
}

export interface ErgRing {
  kind: 'isolation' | 'protect'
  radiusM: number
}

/** The rings one placard earns: the initial-isolation circle plus the protective distance for
 *  the current day/night — from the FIRST TIH row (the general scenario; a substance with a
 *  «when spilled in water» split keeps its first answer, the panel lists every row). 'large'
 *  reads the large-spill column and yields nothing on the 'T3' sentinel (see ERG Table 3 —
 *  container and wind decide, which no circle can claim to know). */
export function ergRingsFor(row: ErgTihRow | undefined, mode: ErgRingMode, now: Date): ErgRing[] {
  if (!row || mode === 'off') return []
  const day = isErgDay(now)
  let isolation: number | null
  let protect: number | null
  if (mode === 'large') {
    if (!row.l || row.l === 'T3') return []
    isolation = parseErgDistance(row.l.li)
    protect = parseErgDistance(day ? row.l.ld : row.l.ln)
  } else {
    isolation = parseErgDistance(row.si)
    protect = parseErgDistance(day ? row.pd : row.pn)
  }
  const rings: ErgRing[] = []
  if (isolation) rings.push({ kind: 'isolation', radiusM: isolation })
  // the protective ring only outside the isolation one — a smaller/equal circle underneath
  // would just double the line
  if (protect && (!isolation || protect > isolation)) rings.push({ kind: 'protect', radiusM: protect })
  return rings
}

/** Every ring the current entity set earns, as ready-made map overlays. Pure and cheap: one
 *  Map lookup per placard, so the workspace can recompute it per render. */
export function ergRingOverlays(entities: readonly Entity[], now: Date): PreparedMapOverlay[] {
  const cfg = appConfig.ergRings
  const overlays: PreparedMapOverlay[] = []
  for (const e of entities) {
    // every UN-speaking symbol earns rings — the Tafel, and since 07.09. the Gas/Chemie
    // hazard symbols too (lib/symbols · UN_CAPABLE, derived from the presets)
    if (e.kind !== 'symbol' || !e.symbol || !UN_CAPABLE.has(e.symbol) || !e.coord) continue
    const un = Object.entries(e.fields ?? {}).find(([k]) => k.replace(/\.$/, '') === 'UN-Nr')?.[1]
    if (!un?.trim()) continue
    const row = lookupErg(un)?.tih?.[0]
    for (const ring of ergRingsFor(row, e.ergRings ?? DEFAULT_ERG_RING_MODE, now)) {
      const isolation = ring.kind === 'isolation'
      overlays.push({
        id: `erg-${e.id}-${ring.kind}`,
        kind: 'circle',
        layer: e.layer,
        center: e.coord,
        radiusM: ring.radiusM,
        color: isolation ? cfg.isolationColor : cfg.protectColor,
        // isolation is the «get everyone out» circle and gets the visible wash; the protective
        // ring is planning distance — dashed line, no fill, so it never reads as a cordon.
        fillOpacity: isolation ? cfg.isolationFillOpacity : 0,
        lineWidth: appConfig.drawing.circleLineWidth,
        lineDasharray: isolation ? undefined : [2, 2],
      })
    }
  }
  return overlays
}
