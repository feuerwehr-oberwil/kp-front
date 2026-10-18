// «Karte & Objekte» — what the viewer remembers, and what it never does (docs/karte-objekte.md).
//
// ⚠️ The viewer is READ-ONLY for every operational record. It has its OWN map state and never
// touches an Einsatz: no workspace, no saved drawings, no plan bindings, no journal. What it keeps
// is device view state, in two small places:
//
//   · its Ebenen, as a device preference under its own key (lib/layerPrefs · `kp.layers.karte`),
//     so switching a layer off here changes no Einsatz and an Einsatz changes nothing here;
//   · where it was looking (`KarteView`: the map's frame, the selected object, the open plan, the
//     open tool — never its content), in sessionStorage, so coming back from an Objektbesuch or
//     from an Einsatz lands on the same object, the same plan and the same frame. Its `label`
//     («Schloss Musterdorf · Modul 2/3») is what the Einsatz menu's «Karte & Objekte» row says
//     it returns to, read without loading the catalogue (panels/IncidentSwitcher).
//
// Measurements, the Gefahrgut rings and a dropped pin are TEMPORARY: they live in component state
// and die with it. `karteViewSnapshot` is the one door into storage and takes only the view
// fields, so nothing temporary can ride along by accident (lib/karte/session.test.ts pins that).

import type { LayerDef, LngLat } from '../../types'
import { appConfig } from '../../config/appConfig'
import { loadLayerPrefs, saveLayerPrefs, type StoredLayerState } from '../layerPrefs'
import { UNDERGROUND_LAYER_ID } from '../underground'

/** The `incidentId` slot the viewer's Ebenen live under in lib/layerPrefs — not an Einsatz. */
export const KARTE_LAYER_PREFS_ID = 'karte'
const VIEW_KEY = 'kp.karte.view'

export interface KarteView {
  center: LngLat
  zoom: number
  bearing: number
  /** the selected catalogue object, if any */
  objectId: string | null
  /** what was open: the map, one plan (its dataset id) or the Gebäude stack */
  surface: 'karte' | 'gebaeude' | { plan: string }
  /** the open tool — only WHICH one: a measurement, a UN number or a pin never ride along */
  tool?: KarteTool | null
  /** «<Objekt> · <Plan>» for «Zurück zu …», null with nothing selected */
  label?: string | null
}

/** The tools whose being open is worth restoring (the pin tool is a one-tap mode, not a place). */
export type KarteTool = 'measure' | 'erg' | 'layers'
const TOOLS: readonly string[] = ['measure', 'erg', 'layers']

/** Only the view: whatever else the caller hands in (measure points, rings, a pin) is dropped. */
export function karteViewSnapshot(s: KarteView & Record<string, unknown>): KarteView {
  const surface = s.surface === 'gebaeude' ? 'gebaeude' as const
    : typeof s.surface === 'object' && s.surface && typeof (s.surface as { plan?: unknown }).plan === 'string'
      ? { plan: (s.surface as { plan: string }).plan }
      : 'karte' as const
  return {
    center: [Number(s.center[0]), Number(s.center[1])],
    zoom: Number(s.zoom),
    bearing: Number(s.bearing) || 0,
    objectId: typeof s.objectId === 'string' ? s.objectId : null,
    surface,
    tool: typeof s.tool === 'string' && TOOLS.includes(s.tool) ? s.tool as KarteTool : null,
    label: typeof s.label === 'string' && s.label.trim() ? s.label.trim().slice(0, 120) : null,
  }
}

export function saveKarteView(v: KarteView & Record<string, unknown>): void {
  try { sessionStorage.setItem(VIEW_KEY, JSON.stringify(karteViewSnapshot(v))) } catch { /* view state only */ }
}

export function loadKarteView(): KarteView | null {
  try {
    const raw = sessionStorage.getItem(VIEW_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as KarteView
    if (!Array.isArray(v?.center) || !Number.isFinite(v.center[0]) || !Number.isFinite(v.center[1]) || !Number.isFinite(v.zoom)) return null
    return karteViewSnapshot(v as KarteView & Record<string, unknown>)
  } catch { return null }
}

/** Layers that belong to an Einsatz and mean nothing here: the tactical picture, the sketches and
 *  the crew's live positions (which are an Einsatz's, and refused without one). */
const EINSATZ_ONLY: readonly string[] = [
  appConfig.defaults.operationalLayerId,
  appConfig.defaults.drawingLayerId,
  appConfig.personGps.layerId,
  // not Einsatz-only, but the viewer has its own row for it under «Station» (KarteApp ·
  // UNDERGROUND_ROW, with the count and the loading state) — the catalogue's would be a twin
  UNDERGROUND_LAYER_ID,
]

/** The viewer's layer list: the deployment's layers without the Einsatz-only ones, with this
 *  device's own Karte & Objekte choices applied over the defaults. */
export function viewerLayers(all: readonly LayerDef[], stored: readonly StoredLayerState[] | undefined): LayerDef[] {
  const base = all.filter((l) => !EINSATZ_ONLY.includes(l.id))
  if (!stored?.length) return base
  const by = new Map(stored.map((s) => [s.id, s]))
  const out = base.map((l) => {
    const s = by.get(l.id)
    return s ? { ...l, visible: s.visible, ...(s.opacity != null ? { opacity: s.opacity } : {}) } : l
  })
  // exactly one base: a stored set that names none (or a base the deployment dropped) keeps the default
  if (!out.some((l) => l.base && l.visible)) return base
  return out
}

export const loadViewerLayerPrefs = () => loadLayerPrefs(KARTE_LAYER_PREFS_ID)
export const saveViewerLayerPrefs = (layers: readonly LayerDef[]) =>
  saveLayerPrefs(KARTE_LAYER_PREFS_ID, layers.map((l) => ({ id: l.id, visible: l.visible, ...(l.opacity != null ? { opacity: l.opacity } : {}) })))

/** The «Niederschlag (Radar)» row's own device store (workspace/useKarteWeather · RadarPrefStore):
 *  the Einsatz keeps its choice in the device prefs, the viewer here. */
const RADAR_KEY = 'kp.karte.radar'
export const karteRadarStore = {
  load: (): { on: boolean; opacity: number | undefined } => {
    try {
      const v = JSON.parse(localStorage.getItem(RADAR_KEY) ?? '{}') as { on?: unknown; opacity?: unknown }
      return { on: v.on === true, opacity: typeof v.opacity === 'number' ? v.opacity : undefined }
    } catch { return { on: false, opacity: undefined } }
  },
  save: (patch: { on?: boolean; opacity?: number }): void => {
    try { localStorage.setItem(RADAR_KEY, JSON.stringify({ ...karteRadarStore.load(), ...patch })) } catch { /* preference only */ }
  },
}
