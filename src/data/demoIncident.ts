import type { Incident, LayerDef, LngLat, PlanDocument } from '../types'

// ---------------------------------------------------------------------------
// The built-in fallbacks: an empty incident, the base layers and the plan catalogue.
// ---------------------------------------------------------------------------
// Neutral fallback only: the geographic centre of Switzerland. The real centre comes
// from the incident's own coordinate or the deployment config (map.defaultView); this
// value is only used as a last resort by a config-less/public build.
const CENTER: LngLat = [8.2275, 46.8182] // Schweiz (Landeszentrum)

const wmts = (l: string) => `https://wmts.geo.admin.ch/1.0.0/${l}/default/current/3857/{z}/{x}/{y}.jpeg`
// Carto raster basemaps (a–d subdomains). Dark Matter is the night theme; it also serves as the
// `nightTiles` swap for the light street bases so night mode shows a real dark map, not a dimmed one.
// Written at 1× here; a retina screen gets CARTO's `@2x` tiles where the layers are derived
// (lib/carto · withCartoRetina, via workspace · builtinAndConfigLayers). The `_nolabels` styles:
// the names are vector text on top (`labels`, lib/basemapLabels); print and the plain raster
// pickers ask for the labelled twin (lib/carto · withCartoLabelsBaked).
const carto = (style: string) => ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}.png`)
const CARTO_DARK = carto('dark_nolabels')

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
  { id: 'base-carto', group: 'Basis', label: 'Carto', icon: 'map', base: true, visible: true, opacity: 100, tiles: carto('rastertiles/voyager_nolabels'), nightTiles: CARTO_DARK, labels: true, maxzoom: 20, attribution: '© CARTO, © OpenStreetMap-Mitwirkende' },
  { id: 'base-osm', group: 'Basis', label: 'OpenStreetMap', shortLabel: 'OSM', icon: 'map', base: true, visible: false, opacity: 100, tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], maxzoom: 19, attribution: '© OpenStreetMap-Mitwirkende' },
  // swissimage has real z20 tiles (10 cm imagery; checked 17.10.2026, z21 answers 400): at 19
  // the closest zoom stretched z19 four times over and the satellite was the blurriest base
  { id: 'base-air', group: 'Basis', label: 'Satellit', icon: 'sat', base: true, visible: false, opacity: 100, tiles: [wmts('ch.swisstopo.swissimage')], maxzoom: 20, attribution: '© swisstopo' },

  // Operational layers: symbols → taktisch, vehicles → fahrzeuge, drawings/notes → markup.
  // Wind/Wetter is always shown via the TopBar's WeatherBadge (no toggle).
  { id: 'taktisch', group: 'Inhalte', label: 'Taktische Zeichen', icon: 'hex', visible: true },
  { id: 'fahrzeuge', group: 'Inhalte', label: 'Fahrzeuge', icon: 'truck', visible: true },
  // Off by default on purpose: the tracks answer "where did it come from?", which is an
  // occasional question, and drawn permanently they compete with the tactical symbols.
  { id: 'fahrzeugspuren', group: 'Inhalte', label: 'Fahrzeugspuren', icon: 'truck', visible: false },
  // Crew members who are sharing their own position (Standort teilen). Visible by default —
  // it stays empty until somebody actually opts in on their phone, and the whole point is to
  // notice the Wassertransport without going looking for a layer toggle first.
  { id: 'personen', group: 'Inhalte', label: 'Personen (live)', icon: 'people', visible: true },
  { id: 'markup', group: 'Inhalte', label: 'Skizzen & Notizen', icon: 'area', visible: true },

  // Per-station REFERENCE layers (hydrants, Leitungskataster, canton WMS, …) are NOT bundled
  // here — they're station data that lives in the config/reference store, loaded with the
  // `admin_geodata` CLI (or added via the Datenquellen panel) and merged in at runtime by
  // `referenceLayersFromConfig` (see src/lib/deploymentConfig.ts → src/lib/workspace.ts).
]

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
  { id: 'modul6', code: 'Modul 6', title: 'Gebäudepläne', subtitle: 'Geschosspläne (alle Geschosse)', imageUrl: '', orientation: 'portrait' },
  { id: 'osm', code: 'Umrisse', title: 'Gebäudeumrisse', subtitle: 'OSM-Gebäude (live) – Gebäude antippen', imageUrl: '', orientation: 'landscape', icon: 'footprint', osm: { center: CENTER, radiusM: 250 } },
  { id: 'tafel', code: 'Tafel', title: 'Leeres Blatt', subtitle: 'Freie Notiz- / Skizzenfläche', imageUrl: '', orientation: 'landscape', icon: 'easel' },
]

// The generated floor-stack document. Only shown once a building is picked on
// the Umgebung sheet; its annotations live in board['gebaeude'] (floor-tagged).
export const gebaeudeDoc: PlanDocument = {
  // title = the printed page label (reportPdfDirect · floorStackPages) — the same word the
  // rail tile wears, so the paper and the screen name the surface identically
  id: 'gebaeude', code: 'Gebäude', title: 'Gebäude',
  subtitle: 'Aus Gebäudeumriss – ohne Pläne', imageUrl: '', orientation: 'portrait', icon: 'floors', floorStack: true,
}
