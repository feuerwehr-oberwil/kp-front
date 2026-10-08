// What the Gebäude card (components/BuildingCard) draws, decided here so it can be pinned without
// mounting anything: the chips in order, which of them are hazards, the one line of sources, and
// whether there is anything to show at all.
//
// The rules (KP Front card F5, 3am tenet):
//   · hazards first, and a hazard is a GLYPH + a WORD — never colour only (gas, oil, PV);
//   · nothing that nags: a source that failed, a building without a register entry, an object
//     without notes simply draws nothing, and a card with nothing in it is not drawn;
//   · every fact says where it came from and when (the sources line), and the card as a whole
//     says «Register-Hinweis», because the register can be years behind the building.
import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import type { BuildingInfo } from './api/building'

export interface BuildingChip {
  key: string
  text: string
  /** a hazard: drawn with the warn glyph and the amber tag */
  hazard: boolean
  title?: string
}

/** Energy keys that put fuel on site — the gas main valve, the oil tank. */
export const HAZARD_ENERGY = new Set(['gas', 'oil'])

/** «2026-10-07» or a full ISO timestamp → «07.10.2026»; '' when it does not parse. */
export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (m) return `${m[3]}.${m[2]}.${m[1]}`
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`
}

function energyWord(key: string): string | null {
  if (key === 'unknown') return null
  const words = appConfig.copy.building.energy as Record<string, string>
  return words[key] ?? words.other
}

function fmtKw(kw: number): string {
  const n = kw >= 100 ? Math.round(kw) : Math.round(kw * 10) / 10
  return fillTemplate(appConfig.copy.building.kw, { n: String(n) })
}

export function buildingChips(b: BuildingInfo | null): BuildingChip[] {
  if (!b) return []
  const C = appConfig.copy.building
  const hazards: BuildingChip[] = []
  const facts: BuildingChip[] = []
  const g = b.gwr_status === 'ok' ? b.gwr : null
  if (g) {
    for (const e of g.heating) {
      const w = energyWord(e)
      if (!w) continue
      ;(HAZARD_ENERGY.has(e) ? hazards : facts).push({ key: `heat-${e}`, text: fillTemplate(C.heating, { e: w }), hazard: HAZARD_ENERGY.has(e) })
    }
    // hot water only when it adds a FUEL the heating did not already name — a gas boiler for the
    // tap behind a heat pump is exactly the valve nobody would look for
    for (const e of g.hot_water) {
      if (!HAZARD_ENERGY.has(e) || g.heating.includes(e)) continue
      const w = energyWord(e)
      if (w) hazards.push({ key: `water-${e}`, text: fillTemplate(C.hotWater, { e: w }), hazard: true })
    }
  }
  if (b.pv_status === 'ok') {
    for (const [i, p] of b.plants.entries()) {
      if (p.kind === 'pv') {
        const since = p.since ? fillTemplate(C.pvSince, { d: fmtDay(p.since) }) : ''
        hazards.push({
          key: `pv-${i}`,
          text: p.power_kw != null ? fillTemplate(C.pv, { kw: fmtKw(p.power_kw) }) : C.pvBare,
          hazard: true,
          title: fillTemplate(C.pvTitle, { since }),
        })
      } else if (p.label) {
        facts.push({ key: `plant-${i}`, text: p.power_kw != null ? `${p.label} ${fmtKw(p.power_kw)}` : p.label, hazard: false })
      }
    }
  }
  if (g) {
    const lead: BuildingChip[] = []
    if (g.status) {
      const word = (C.status as Record<string, string>)[g.status]
      if (word) lead.push({ key: 'status', text: word, hazard: false })
    }
    if (g.floors != null) lead.push({ key: 'floors', text: g.floors === 1 ? C.floorsOne : fillTemplate(C.floors, { n: g.floors }), hazard: false })
    if (g.flats != null) lead.push({ key: 'flats', text: g.flats === 1 ? C.flatsOne : fillTemplate(C.flats, { n: g.flats }), hazard: false })
    if (g.year != null) lead.push({ key: 'year', text: fillTemplate(C.year, { y: g.year }), hazard: false })
    else if (g.period) lead.push({ key: 'year', text: fillTemplate(C.period, { p: g.period }), hazard: false })
    if (g.shelter) lead.push({ key: 'shelter', text: C.shelter, hazard: false })
    facts.unshift(...lead)
  }
  return [...hazards, ...facts]
}

/** «GWR Hauptstrasse 10 · Stand 07.10.2026 · Heizung erfasst 29.06.2022 · BFE abgefragt 09.10.2026» */
export function buildingSources(b: BuildingInfo | null): string {
  if (!b) return ''
  const C = appConfig.copy.building
  const parts: string[] = []
  if (b.gwr_status === 'ok' && b.gwr) {
    const street = (b.address ?? '').split(',')[0].trim()
    const d = fmtDay(b.gwr.stand)
    if (d) parts.push(street ? fillTemplate(C.srcGwr, { a: street, d }) : fillTemplate(C.srcGwrNoAddr, { d }))
    if (b.gwr.heating.length && b.gwr.heating_date) parts.push(fillTemplate(C.srcHeating, { d: fmtDay(b.gwr.heating_date) }))
  }
  if (b.pv_status === 'ok' && b.plants.length) {
    parts.push(fillTemplate(C.srcPv, { d: fmtDay(b.pv_kept_from ?? b.registers_fetched_at) }))
  } else if (b.gwr_kept_from) {
    parts.push(fillTemplate(C.srcCached, { d: fmtDay(b.gwr_kept_from) }))
  }
  return parts.join(' · ')
}

/** Stored text → its lines (one measure per line), blank ones dropped. */
export function noteLines(text: string | null | undefined): string[] {
  return (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
}

/** Who the Modul-1 notes belong to: «Schloss Musterdorf · Modul 1», or «… · in der Nähe (120 m)»
 *  when the object was surfaced by proximity alone — a neighbour's gas valve reads exactly like ours. */
export function objectCaption(b: BuildingInfo | null): string {
  const o = b?.object
  if (!o) return ''
  const C = appConfig.copy.building
  if (!o.address_match) {
    return o.distance_m != null
      ? fillTemplate(C.objectNear, { name: o.name, m: Math.round(o.distance_m) })
      : fillTemplate(C.objectNearNoDist, { name: o.name })
  }
  return o.measures_source ? fillTemplate(C.objectSource, { name: o.name, src: o.measures_source }) : o.name
}

export function visitLine(b: BuildingInfo | null): string {
  const v = b?.visit
  if (!v || !v.visited_at) return ''
  const C = appConfig.copy.building
  const d = fmtDay(v.visited_at)
  if (!v.findings) return fillTemplate(C.visit, { d })
  return v.findings === 1 ? fillTemplate(C.visitFindingsOne, { d }) : fillTemplate(C.visitFindings, { d, n: v.findings })
}

/** Anything to draw? A card with nothing in it is not drawn — no empty state that nags. */
export function hasBuildingContent(b: BuildingInfo | null): boolean {
  if (!b) return false
  return buildingChips(b).length > 0
    || noteLines(b.object?.measures).length > 0
    || noteLines(b.object?.remarks).length > 0
    || visitLine(b) !== ''
}
