import type { Entity, Incident, LayerDef, LngLat, PlanDocument, PreparedMapOverlay, TimelineEvent } from '../types'

// ---------------------------------------------------------------------------
// Demo incident data. All map objects are defined as meter offsets from CENTER,
// so replacing the example location starts with one coordinate change.
// ---------------------------------------------------------------------------
// Neutral fallback only: the geographic centre of Switzerland. The real centre comes
// from the incident's own coordinate or the deployment config (map.defaultView); this
// value is only used as a last resort by a config-less/public build.
const CENTER: LngLat = [8.2275, 46.8182] // Schweiz (Landeszentrum)
const M_PER_LAT = 110540
const M_PER_LON = 111320 * Math.cos((CENTER[1] * Math.PI) / 180)
const at = (eastM: number, northM: number): LngLat => [
  CENTER[0] + eastM / M_PER_LON,
  CENTER[1] + northM / M_PER_LAT,
]

const wmts = (l: string) => `https://wmts.geo.admin.ch/1.0.0/${l}/default/current/3857/{z}/{x}/{y}.jpeg`
// Carto raster basemaps (a–d subdomains). Dark Matter is the night theme; it also serves as the
// `nightTiles` swap for the light street bases so night mode shows a real dark map, not a dimmed one.
const carto = (style: string) => ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}.png`)
const CARTO_DARK = carto('dark_all')

export const incident: Incident = {
  type: '',
  title: '',
  address: '',
  center: CENTER,
  startedAt: '14:23',
  durationSec: 47 * 60 + 12,
  offline: true,
  cachedTiles: 312,
  recording: true,
  recDurationSec: 2 * 60 + 14,
}

export const layers: LayerDef[] = [
  // ONE base per type (testing feedback 2026-07-14): Carto (default), OSM, one satellite.
  // The swisstopo farbig/grau, Esri-satellite, and OpenTopoMap variants were dropped — the
  // long radio list made the Ebenen panel unnavigable. A workspace that had a removed base
  // selected falls back to Carto in deriveInitial (workspace.ts).
  { id: 'base-carto', group: 'Basis', label: 'Carto', icon: 'map', base: true, visible: true, opacity: 100, tiles: carto('rastertiles/voyager'), nightTiles: CARTO_DARK, maxzoom: 20, attribution: '© CARTO, © OpenStreetMap-Mitwirkende' },
  { id: 'base-osm', group: 'Basis', label: 'OpenStreetMap', icon: 'map', base: true, visible: false, opacity: 100, tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], maxzoom: 19, attribution: '© OpenStreetMap-Mitwirkende' },
  { id: 'base-air', group: 'Basis', label: 'Satellit', icon: 'sat', base: true, visible: false, opacity: 100, tiles: [wmts('ch.swisstopo.swissimage')], maxzoom: 19, attribution: '© swisstopo' },

  // Operational layers: symbols → taktisch, vehicles → fahrzeuge, drawings/notes → markup.
  // Wind/Wetter is always shown via the corner WindBadge (no toggle).
  { id: 'taktisch', group: 'Lage', label: 'Taktische Zeichen', icon: 'hex', visible: true },
  { id: 'fahrzeuge', group: 'Lage', label: 'Fahrzeuge', icon: 'truck', visible: true },
  { id: 'markup', group: 'Lage', label: 'Skizzen & Notizen', icon: 'area', visible: true },

  // Per-station REFERENCE layers (hydrants, Leitungskataster, canton WMS, …) are NOT bundled
  // here — they're station data that lives in the config/reference store, loaded with the
  // `admin_geodata` CLI (or added via the Datenquellen panel) and merged in at runtime by
  // `referenceLayersFromConfig` (see src/lib/deploymentConfig.ts → src/lib/workspace.ts).
]

export const entities: Entity[] = [
  // --- Lage / taktische Zeichen (um das Schulgebäude herum) ---
  { id: 'brand', kind: 'symbol', layer: 'taktisch', coord: at(4, 6), symbol: 'VKF Feuer', label: 'Vollbrand Schulhaus Trakt B' },
  {
    id: 'person', kind: 'symbol', layer: 'taktisch', coord: at(26, 2), symbol: 'VKF Rettungen', label: '2 Personen vermisst',
    subtitle: 'Menschenrettung', fields: { 'Anzahl': '2', 'Bereich': 'OG 1, Westseite', 'Status': 'in Rettung' },
  },
  {
    id: 'pv', kind: 'symbol', layer: 'taktisch', coord: at(-6, 16), symbol: 'FW Elektroanlage', label: 'PV-Anlage Dach',
    subtitle: 'Gefahr Elektrizität', fields: { 'Quelle': 'SchlüeHü Objekt 4471', 'DC-Trennung': 'nicht bestätigt' },
  },
  {
    id: 'gefahrgut', kind: 'symbol', layer: 'taktisch', coord: at(-30, 4), symbol: 'VKF Gefaehrliche Stoffe', label: 'Chemie- / Werkraum',
    subtitle: 'Gefährliche Stoffe', fields: { 'Hinweis': 'Werkstoffe / Chemikalien', 'Quelle': 'Objektplan' },
  },

  // --- Führung ---
  {
    id: 'kp-front', kind: 'symbol', layer: 'taktisch', coord: at(-58, -34), symbol: 'VKF KP Front', label: 'KP Front',
    subtitle: 'Kommandoposten Front', badge: 'KP', fields: { 'Einsatzleiter': 'Hptm Meier', 'Funkkanal': 'Kdo BL', 'Errichtet': '14:31' },
  },
  {
    id: 'bereitstellung', kind: 'symbol', layer: 'taktisch', coord: at(-95, -58), symbol: 'VKF Sammelstelle', label: 'Bereitstellungsraum',
    subtitle: 'Sammelstelle', fields: { 'Lage': 'Schulstrasse / Parkplatz', 'Zufahrt': 'ab Schulstrasse' },
  },

  // --- Fahrzeuge / Mittel ---
  // No static vehicles here: the Fahrzeuge / Mittel layer ('fahrzeuge') is fed
  // live from kp-rueck's Traccar GPS feed (see lib/useVehiclePositions.ts).

  // --- Hydranten ---
  { id: 'hyd1', kind: 'symbol', layer: 'taktisch', coord: at(-30, -18), symbol: 'SI Unterflurhydrant', label: 'UH 220', subtitle: 'Unterflurhydrant', fields: { 'Leistung': '1200 l/min', 'Nennweite': 'DN 150' } },
  { id: 'hyd2', kind: 'symbol', layer: 'taktisch', coord: at(52, -22), symbol: 'SI Unterflurhydrant', label: 'UH 221', subtitle: 'Unterflurhydrant', fields: { 'Leistung': '900 l/min', 'Nennweite': 'DN 125' } },
  { id: 'hyd3', kind: 'symbol', layer: 'taktisch', coord: at(20, 26), symbol: 'SI Ueberflurhydrant', label: 'OH 045', subtitle: 'Oberflurhydrant', fields: { 'Leistung': '1600 l/min', 'Nennweite': 'DN 150' } },
]

export const timeline: TimelineEvent[] = [
  { id: 't8', t: '14:26', icon: 'mic', text: 'Audionotiz · Lagemeldung EL', kind: 'audio' },
  { id: 't7', t: '14:25', icon: 'truck', text: 'ADL Reinach eingetroffen', kind: 'vehicle' },
  { id: 't6', t: '14:24', icon: 'hex', text: 'Menschenrettung-Symbol gesetzt', kind: 'symbol' },
  { id: 't5', t: '14:22', icon: 'area', text: 'Gefahrenzone 135 m erstellt', kind: 'symbol' },
  { id: 't4', t: '14:21', icon: 'truck', text: 'TLF 1 platziert', kind: 'vehicle' },
  { id: 't3', t: '14:20', icon: 'doc', text: 'Feuerwehrplan 4471 geöffnet', kind: 'layer' },
  { id: 't2', t: '14:19', icon: 'flag', text: 'KP Front errichtet', kind: 'symbol' },
  { id: 't1', t: '14:18', icon: 'photo', text: 'Foto Westfassade angehängt', kind: 'photo' },
]

// No pre-baked map overlays — incidents start clean (the red demo "Gefahrenzone" circle
// was removed). Kept as an (empty) export so MapView's prop wiring is unchanged.
export const preparedOverlays: PreparedMapOverlay[] = []

// Module tiles carry NO bundled PDFs: a module only appears when the deployment's nearest/
// picked Einsatzobjekt actually provides that plan (useObjectPlans fills imageUrl from the
// backend). Without an object the plan rail is just Umrisse + Tafel — station plans are
// deployment data, never shipped in the repo.
export const planDocuments: PlanDocument[] = [
  { id: 'modul1', code: 'Modul 1', title: 'Übersicht', subtitle: 'Situations- / Übersichtsplan mit Zufahrt', imageUrl: '', orientation: 'portrait' },
  { id: 'modul2', code: 'Modul 2', title: 'Wie komme ich herein', subtitle: 'Umgebungsplan mit Zugängen', imageUrl: '', orientation: 'landscape' },
  { id: 'modul3', code: 'Modul 3', title: 'Was finde ich drinnen', subtitle: 'Objektplan: Haupthahn, BMA-BD, RWA', imageUrl: '', orientation: 'landscape' },
  // combined sheet: some objects ship Modul 2 + 3 on one PDF ("Modul 2-3.pdf"); the backend
  // serves it under the id "modul2-3" and useObjectPlans then hides the separate 2 + 3 tiles.
  { id: 'modul2-3', code: 'Modul 2/3', title: 'Zugang & Objekt', subtitle: 'Umgebungs- + Objektplan (kombiniert)', imageUrl: '', orientation: 'landscape' },
  { id: 'modul6', code: 'Modul 6', title: 'Gebäudepläne', subtitle: 'Geschosspläne (alle Stockwerke)', imageUrl: '', orientation: 'portrait' },
  { id: 'osm', code: 'Umrisse', title: 'Gebäudeumrisse', subtitle: 'OSM-Gebäude (live) – Gebäude antippen', imageUrl: '', orientation: 'landscape', icon: 'footprint', osm: { center: CENTER, radiusM: 250 } },
  { id: 'tafel', code: 'Tafel', title: 'Leeres Blatt', subtitle: 'Freie Notiz- / Skizzenfläche', imageUrl: '', orientation: 'landscape', icon: 'pen' },
]

// The generated floor-stack document. Only shown once a building is picked on
// the Umgebung sheet; its annotations live in board['gebaeude'] (floor-tagged).
export const gebaeudeDoc: PlanDocument = {
  id: 'gebaeude', code: 'Gebäude', title: 'Geschosse (Skizze)',
  subtitle: 'Aus Gebäudeumriss – ohne Pläne', imageUrl: '', orientation: 'portrait', icon: 'layers', floorStack: true,
}
