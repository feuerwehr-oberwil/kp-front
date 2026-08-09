import type { LayerId, SymbolControl } from '../types'
import { getCopy, type Copy } from './copy'

/** One symbol's curated defaults: which built-in steppers make sense for it
 *  (`controls`) and the empty detail rows it drops in with (`fields`). Omitted
 *  `controls` = none; omitted `fields` = no detail rows. See lib/symbols. */
interface SymbolPreset {
  controls?: SymbolControl[]
  fields?: string[]
  /** which detail field is the symbol's identity at a glance — printed under the glyph in
   *  the 'auto' caption mode (lib/symbols · symbolCaptionText). Defaults to the first `fields`
   *  entry when omitted; set it where the first field isn't the readable one (e.g. a
   *  Gefahrentafel leads with 'UN-Nr' but 'Stoff' is what a passing operator wants to read). */
  caption?: string
  /** shipped suggestion lists for detail fields, keyed by field name. A hint, never a cage:
   *  the field stays free text, and a deployment's own `fleet.attributeLists` entry for the
   *  same symbol+field wins over anything here (lib/symbols · symbolFieldOptions). */
  fieldOptions?: Record<string, string[]>
}

const base = {
  appName: 'Incident Map',
  locale: 'de-CH',
  storage: {
    key: 'incident-map-workspace-v1',
    legacyKeys: ['kp-front-poc-v5'],
  },
  // Rückmeldung (see lib/feedbackReport). Nothing is ever sent automatically — this is only the
  // address the «E-Mail schreiben» button pre-addresses, and the operator sees the whole text
  // first. Upstream by default so a fresh self-hosted station's feedback reaches the people who
  // can act on it; a deployment that would rather triage internally overrides `mailto` with its
  // own address and upstream never hears from it, which is the correct default for a project
  // whose promise is that the station owns its data.
  feedback: {
    mailto: 'bastian@eichenbergers.ch',
  },
  defaults: {
    operationalLayerId: 'taktisch' as LayerId,   // placed symbols
    drawingLayerId: 'markup' as LayerId,          // freehand/area drawings, notes, photos
    snapshotFilePrefix: 'incident-map-snapshot',
    /** undo-history depth, shared by the Lage map doc and the Plan board (one cap
     *  instead of the map's old 60 vs the plan's old 80) */
    historyCap: 80,
  },
  // Journal composer: national default Textbausteine (quick phrases) — fuzzy-completed while
  // typing (src/lib/quickPhrases.ts), so the list can be generous: only the 3 best matches
  // surface. Keep entries short Meldung style with distinct first words (fast prefix hits) and
  // generic national wording — brigade-specific partners belong in the station override
  // (deployment config journal.quickPhrases); content stays German domain language.
  journal: {
    quickPhrases: [
      // Führung / Ablauf
      'Rekognoszierung läuft',
      'Erkundung abgeschlossen',
      'Einsatzleitung übernommen',
      'Lagemeldung an Einsatzzentrale',
      'Verstärkung angefordert',
      'Retablierung läuft',
      'Rückbau eingeleitet',
      'Einsatzbereitschaft wiederhergestellt',
      'Übergabe an Eigentümer',
      // Brand
      'Brand unter Kontrolle',
      'Feuer aus',
      'Nachlöscharbeiten laufen',
      'Brandwache gestellt',
      'Entrauchung eingeleitet',
      'Atemschutz eingesetzt',
      'Wasserversorgung erstellt',
      // BMA
      'Fehlalarm BMA',
      'Nichts festgestellt',
      'BMA zurückgestellt',
      // Personen
      'Gebäude geräumt',
      'Keine Personen im Gebäude',
      'Person gerettet',
      'Patient an Sanität übergeben',
      // Partner
      'Sanität aufgeboten',
      'Sanität vor Ort',
      'Polizei aufgeboten',
      'Polizei vor Ort',
      'Nachbarfeuerwehr aufgeboten',
      // Elementar / Technik
      'Strom abgeschaltet',
      'Gas abgestellt',
      'Strasse gesperrt',
      'Verkehrsdienst eingerichtet',
      'Pumpen eingesetzt',
      'Ölspur gebunden',
    ],
  },
  // Live vehicle GPS, pulled from our own backend's Traccar integration. With
  // baseUrl empty (the default) the path is same-origin — served by the backend
  // in production and by the Vite proxy in dev. If the deployment has no Traccar
  // configured, the backend answers 503 and polling stops (layer stays empty).
  // VITE_KP_RUECK_URL only overrides the origin for a split-origin setup.
  gps: {
    baseUrl: (import.meta.env.VITE_KP_RUECK_URL ?? '').replace(/\/$/, ''),
    positionsPath: '/api/traccar/positions',
    layerId: 'fahrzeuge' as LayerId,
    pollMs: 15_000,
    // Breadcrumbs behind each vehicle. Own layer and OFF by default: on a busy Lage the tracks
    // compete with the tactical symbols, and the question they answer ("where did it come
    // from?") is one you ask occasionally, not continuously. Polled only while the layer is
    // actually visible — an unopened layer costs nothing.
    trailsPath: '/api/traccar/trails',
    trailsLayerId: 'fahrzeugspuren' as LayerId,
    trailMinutes: 30,
    trailsPollMs: 30_000,
    // each live vehicle renders a generic vehicle glyph with its name + heading
    // baked in (see lib/useVehiclePositions.ts · vehicleSymbolSvg); no per-name
    // symbol mapping needed.
    status: { online: 'Online', offline: 'Offline', unknown: 'Unbekannt' } as Record<string, string>,
  },
  // Standort teilen — crew members reporting their own position from their own phones, so the
  // command post can see where people are working (the Wassertransport several kilometres out
  // is the case this exists for). Own-backend, same-origin, one row per person, gone when the
  // Einsatz closes. Nothing here alerts on distance: being far away is normal and useful.
  personGps: {
    layerId: 'personen' as LayerId,
    /** how often the command post asks for the picture */
    pollMs: 15_000,
    /** how often a sharing phone reports, at most (a fix that hasn't moved still refreshes
     *  the age, which is what tells the FU the picture is current) */
    sendMs: 20_000,
    /** report immediately when the phone has moved at least this far since the last send —
     *  someone driving to the Weiher shouldn't crawl across the map in 20 s steps */
    minMoveM: 25,
    /** GPS fixes worse than this are dropped rather than drawn: a 2 km circle rendered as a
     *  dot is a lie, and indoors/underground that is exactly what a phone reports */
    maxAccuracyM: 500,
    selfReported: 'Selbstauskunft',
    copyFields: { lastFix: 'Letzte Position', accuracy: 'Genauigkeit' },
  },
  // Multi-device live sync (HTTP, no WebSocket — the backend is last-write-wins on the
  // full workspace blob, polled with a `since`-rev conditional GET that 304s when nothing
  // changed). Two knobs set how fast an edit on one device appears on another:
  //   saveDebounceMs — how long after the LAST edit the drawing device pushes to the server.
  //                    The debounce re-arms on every edit, so a continuous gesture (a freehand
  //                    stroke, a drag) flushes once, ~this long after it ends — not per point.
  //   livePollMs     — how often the other devices poll for a newer revision.
  // Worst-case cross-device latency ≈ saveDebounceMs + livePollMs + one round-trip.
  sync: {
    saveDebounceMs: 600,
    livePollMs: 2000,
    // Battery: the 2 s live-poll is the fast cadence used while the incident is active. When
    // polls keep returning nothing new, the loop eases off (doubling) toward livePollMaxMs so a
    // quiet incident stops pinning the cellular radio awake; any change snaps it back to
    // livePollMs. A backgrounded tab polls at hiddenPollMs (nothing on screen to keep fresh) and
    // catches up immediately on the visibility-return. See lib/pollBackoff.
    livePollMaxMs: 15000,
    hiddenPollMs: 60000,
  },
  // The weather badge's detail target (MeteoSwiss radar) is locale-dependent and lives in
  // the copy catalogues: appConfig.copy.weather.detailsUrl.
  symbols: {
    namePrefixes: ['VKF', 'FW', 'FWD', 'FKS', 'WV', 'Abw', 'Rettung', 'GVB', 'SI', 'GB', 'fw'],
    // the generic vehicle glyph — placed copies render their (typed) name baked in,
    // exactly like the live GPS vehicles (see lib/useVehiclePositions · vehicleSymbolSvg)
    vehicleName: 'VKF Fahrzeug',
    // detail fields that offer the Mannschaft roster as a combobox (person pickers)
    rosterFields: ['Name', 'Fahrer', 'Stv.'],
    // symbols whose roster picker offers a "nur Offiziere" filter + officer-first order
    // (leadership glyphs where you pick the FU/EL/officer by name) — same toggle as the
    // Einsatzleiter picker in the Rapport preflight.
    officerRosterSymbols: ['FW Offizier', 'VKF Einsatzleiter'],
    // the orange ADR Warntafel symbol — when it carries a UN-Nr field, the icon renders
    // as a real plate with the Gefahrnummer (Kemler) over the UN number baked in (see
    // lib/placard · placardSvgForSymbol), the same way the vehicle bakes its name.
    placardName: 'FW Gefahr Tafel',
    // the Einsatzleiter glyph. Its 'Name' field is the person in charge, so a Kroki that carries
    // one pre-fills the Rapport's Einsatzleiter (lib/report · einsatzleiterFromScene).
    einsatzleiterName: 'VKF Einsatzleiter',
    // NOTE: the old `rotatable` list is gone — a symbol is rotatable iff its preset
    // (below) lists 'rotation' in `controls`, so the drag-to-rotate handle and the
    // editor's Drehung stepper stay in sync from one source (see lib/symbols ·
    // ROTATABLE / symbolControls).
    // short, clear display labels (raw library name → label). Anything not listed
    // falls back to the prefix-stripped + umlaut-restored name.
    displayNames: {
      'VKF Feuer': 'Feuer',
      'VKF Rettungen': 'Rettung',
      'VKF Unfall': 'Unfall',
      'VKF Gefaehrliche Stoffe': 'Gefahrstoffe',
      'VKF Wasser': 'Wasser',
      // damage/Naturereignis signatures (Faltkarte 11/2022, added 2026-07-02)
      'FW Beschaedigung': 'Beschädigung',
      'FW Teilzerstoerung': 'Teilzerstörung',
      'FW Totalzerstoerung': 'Totalzerstörung',
      'FW Ueberschwemmung': 'Überschwemmung',
      'FW Gefahr allgemein': 'Gefahr',
      'FW Gefahr Tafel': 'Gefahrentafel',
      'FW Gefahr Radioaktiv': 'Radioaktiv',
      'FW Gefahr Ex': 'Explosion',
      'FW Gefahr G': 'Gas',
      'FW Gefahr C': 'Chemie',
      'FW Gefahr W': 'Wasser',
      'FW Elektroanlage': 'Elektroanlage',
      'VKF Patientensammelstelle': 'Patientensammelstelle',
      'VKF Sanitaetshilfsstelle': 'Sanitätshilfsstelle',
      'VKF Totensammelstelle': 'Totensammelstelle',
      // FKS audit: this glyph (rectangle + two horizontal lines) is the FKS sign for Unverletzte,
      // not a generic Sammelstelle — the assembly point is the separate FW Sammelplatz (□ + S).
      'VKF Sammelstelle': 'Unverletzte',
      'FW Sammelplatz': 'Sammelplatz',
      'FW Warteraum': 'Warteraum',
      'FW Verwundetennest': 'Verwundetennest',
      'VKF Bereich Sanitaet': 'Sanität',
      'VKF KP Front': 'KP Front',
      'VKF Einsatzleiter': 'Einsatzleiter',
      'FW Offizier': 'Offizier',
      'VKF Kontrollposten': 'Kontrollposten',
      'VKF Informationszentrum': 'Informationszentrum',
      'VKF Bereich Materialdepot': 'Materialdepot',
      'VKF Verkehrssperre ueberwacht': 'Verkehrssperre',
      'VKF Drehleiter': 'Drehleiter',
      'VKF Hubretter': 'Hubretter',
      'VKF Fahrzeug': 'Fahrzeug',
      'VKF Pumpe Typ2': 'Pumpe',
      'VKF Helilandeplatz': 'Helilandeplatz',
      'VKF Drohne': 'Drohne',
      'VKF Luefter mobil': 'Lüfter',
      'FW Entrauchung': 'Entrauchung',
      'FW Kleinloeschgeraet': 'Kleinlöschgerät',
      'FW Sprungretter': 'Sprungretter',
      'FW Leiter': 'Leiter',
      'SI Ueberflurhydrant': 'Überflurhydrant',
      'SI Unterflurhydrant': 'Unterflurhydrant',
      'VKF Innenhydrant': 'Innenhydrant',
      'SI Wasserloeschposten': 'Wasserlöschposten',
      'WV Loeschweier': 'Löschweiher',
      'SI Wasserbezugsort': 'Wasserbezugsort',
      'SI Wasserdruckversorgung': 'Wasserdruckversorgung',
      'GB Lift': 'Lift',
      'GB Kamin': 'Kamin',
      'GB Abzug': 'Abzug',
      'SI Schieber': 'Schieber',
      'GB Elektrotableau': 'Elektrotableau',
      'GB Sprinklerzentrale': 'Sprinklerzentrale',
      'GB Brandmeldezentrale': 'Brandmeldezentrale',
      'GB BMA Melder': 'BMA Melder',
      'GB Fernsignaltableau': 'Fernsignaltableau',
      'GB Schluesseldepot': 'Schlüsseldepot',
      'GB BA Wand F30': 'Wand F30',
      'GB BA Wand F60': 'Wand F60',
      'GB BA Wand F180': 'Wand F180',
      'GB Ture BS R30': 'Türe R30',
      'GB Ture Durchgang': 'Durchgang',
      'GB Treppe 8': 'Treppe',
      'SI Nordpfeil': 'Nordpfeil',
      'SI Windrichtung': 'Windrichtung',
      'VKF Bereich Polizei': 'Polizei',
      'VKF Bereich Chemiewehr': 'Chemiewehr',
      'VKF Bereich Zivilschutz': 'Zivilschutz',
      'VKF Bereich Feuerwehr': 'Feuerwehr',
    } as Record<string, string>,
    // Per-symbol presets. On placement a symbol drops in with its empty `fields`
    // rows (operator just fills the blanks) and the editor shows only the `controls`
    // steppers that carry meaning for it: 'rotation' for directional glyphs (arrows,
    // ladders, walls), 'count' where several can stack on one marker, 'floor' (map
    // only) for things tied to a storey. Looked up by exact name first, then the
    // category fallback, else: no controls, no fields. One curated list for all 65
    // library symbols — keep it the single source for both fields and gating.
    presets: {
      byName: {
        // ── Schadenlage ── on a storey (floor badge); the label carries the rest.
        'VKF Feuer': { controls: ['floor', 'spread'] },
        'VKF Rauch': { controls: ['floor', 'spread'] },
        // ⚠️ «Vermisst» and «eingesperrt» are STATES of a Rettung, not symbols of their own.
        // The count and the storey were already here; what the map could not say was whether
        // those three on the 2nd floor are still unaccounted for or known and trapped, which
        // is the difference between a search and a rescue. Free text stays possible — the list
        // is the fast path, not a cage (a station overrides it via fleet.attributeLists).
        'VKF Rettungen': {
          controls: ['count', 'floor'],
          fields: ['Status'],
          fieldOptions: { Status: ['vermisst', 'eingesperrt', 'gerettet'] },
        },
        'VKF Unfall': { controls: ['floor'] },
        'VKF Gefaehrliche Stoffe': { controls: ['floor', 'spread'], fields: ['Stoff'] },
        'VKF Wasser': { controls: ['floor', 'spread'] },
        'FW Gefahr Ex': { controls: ['floor'] },
        // ── Gefahren ── floor badge; hazmat seeds just the substance.
        'FW Gefahr allgemein': { controls: ['floor'] },
        'FW Gefahr G': { controls: ['floor'], fields: ['Stoff'] },
        'FW Gefahr C': { controls: ['floor'], fields: ['Stoff'] },
        // Gefahrentafel = orange UN placard; UN-Nr first (future lookup UN→Stoff fills the rest),
        // but the substance is what an operator reads off the map → caption on 'Stoff'.
        'FW Gefahr Tafel': { controls: ['floor'], fields: ['UN-Nr', 'Stoff'], caption: 'Stoff' },
        'FW Gefahr Radioaktiv': { controls: ['floor'] },
        'FW Elektroanlage': { controls: ['floor'] },
        'FW Gefahr W': { controls: ['floor'] },
        // ── Personen / Sanität ── the label/name says it; no fields, no count.
        'VKF Patientensammelstelle': {},
        'VKF Sanitaetshilfsstelle': {},
        'VKF Totensammelstelle': {},
        'VKF Sammelstelle': {},   // FKS: Unverletzte (see displayNames)
        'FW Sammelplatz': {},
        'FW Warteraum': {},
        'FW Verwundetennest': {},
        'VKF Bereich Sanitaet': { fields: ['Einheit'] },
        // ── Führung ── name is the info; only the two person symbols seed 'Name'.
        'VKF KP Front': {},
        // Name = the Einsatzleiter (caption source, fields[0]); Stv. = deputy — both roster pickers
        // (officer-first, since VKF Einsatzleiter is in officerRosterSymbols).
        'VKF Einsatzleiter': { fields: ['Name', 'Stv.'] },
        // 'Funktion' = separate Führungsaufgabe picker (Front/SiBe/…); 'Name' stays the person
        // (roster-fed). Suggestion lists for 'Funktion' come from the deployment config, not code.
        'FW Offizier': { fields: ['Funktion', 'Name'] },
        'VKF Kontrollposten': {},
        'VKF Informationszentrum': {},
        'VKF Bereich Materialdepot': {},
        'FW Absperrung': { controls: ['rotation'] },
        'VKF Verkehrssperre ueberwacht': { controls: ['rotation'] },
        // ── Fahrzeuge / Mittel ── operator-named; directional ones rotate. The driven vehicles
        // (generic Fahrzeug, Drehleiter, Hubretter, Grosslüfter, Boot) also carry a Fahrer roster picker.
        // Drehleiter: composite body + independently-slewing ladder — `rotation` aims the truck,
        // `rotation2` aims the ladder (own rotor + Drehung stepper). Synthesised like the Grosslüfter
        // (see lib/symbolRender COMPOSITES).
        'VKF Drehleiter': { controls: ['rotation', 'rotation2'], fields: ['Fahrer'] },
        // Hubretter: the truck body rotates on its own (`rotation` — normal rotor + Drehung stepper),
        // INDEPENDENT of the articulated boom, which is shaped by dragging the cage tip (a separate
        // on-canvas handle sets the boom bearing `rotation2` + reach `reachM`/`reachN`). Rotating the
        // truck doesn't move the boom and vice-versa. See MapMarkers / Whiteboard cage handle +
        // lib/symbolRender HubretterBoom.
        'VKF Hubretter': { controls: ['rotation'], fields: ['Fahrer'] },
        // Drohne: a hovering-asset marker — stays upright (no rotation), no fields.
        'VKF Drohne': {},
        // generic vehicle: user-named (see lib/symbols) — title + a Fahrer picker; type lists via config
        'VKF Fahrzeug': { controls: ['rotation'], fields: ['Fahrer'] },
        'VKF Pumpe Typ2': {},
        'VKF Helilandeplatz': {},
        'VKF Luefter mobil': { controls: ['rotation', 'airflow'], fields: ['Typ'] },
        // composite vehicle-mounted Grosslüfter: body heading (rotation) + fan aim (rotation2),
        // each with its own on-canvas rotor + Drehung stepper, PLUS the Lüfter airflow direction
        // (Einblasen / Absaugen — reverses the fan glyph, same as the mobile Lüfter). Synthesised
        // in lib/useSymbols.
        'Grosslüfter': { controls: ['rotation', 'rotation2', 'airflow'], fields: ['Fahrer'] },
        'FW Entrauchung': { controls: ['rotation'] },
        'FW Kleinloeschgeraet': { fields: ['Typ'] },
        'FW Boot': { controls: ['rotation'], fields: ['Fahrer'] },
        'FW Sprungretter': {},
        'FW Leiter': { controls: ['rotation'] },
        // ── Wasser ── fixed supply points; the symbol is the info.
        'SI Ueberflurhydrant': {},
        'SI Unterflurhydrant': {},
        'VKF Innenhydrant': {},
        'SI Wasserloeschposten': {},
        'WV Loeschweier': {},
        'SI Wasserbezugsort': {},
        'SI Wasserdruckversorgung': {},
        // ── Gebäude ── interior elements: floor badge; walls/doors/stairs also orient.
        'GB BA Wand F30': { controls: ['rotation', 'floor'] },
        'GB BA Wand F60': { controls: ['rotation', 'floor'] },
        'GB BA Wand F180': { controls: ['rotation', 'floor'] },
        'GB Ture BS R30': { controls: ['rotation', 'floor'] },
        'GB Ture Durchgang': { controls: ['rotation', 'floor'] },
        // stairs & lift span storeys → a von/bis range badge (e.g. -1/+3) instead of a single floor badge
        'GB Treppe 8': { controls: ['rotation', 'floorRange'] },
        'GB Lift': { controls: ['floorRange'] },
        'GB Kamin': { controls: ['floor'] },
        'GB Abzug': { controls: ['rotation', 'floor'] },
        'SI Schieber': { controls: ['floor'], fields: ['Status'] },   // auf/zu
        'GB Elektrotableau': { controls: ['floor'] },
        'GB Sprinklerzentrale': { controls: ['floor'] },
        // BMA: the tripped Meldergruppe/Melder read off the BMZ display — one free row
        // (e.g. «12/3»), captioned under the glyph so the whole KP sees which one went off
        'GB Brandmeldezentrale': { controls: ['floor'], fields: ['Melder-Nr.'] },
        'GB BMA Melder': { controls: ['floor'], fields: ['Melder-Nr.'] },
        'GB Fernsignaltableau': { controls: ['floor'] },
        'GB Schluesseldepot': { controls: ['floor'] },
        // ── Karte ── pure orientation glyphs.
        'SI Nordpfeil': { controls: ['rotation'] },
        'SI Windrichtung': { controls: ['rotation'] },
        // ── Partner ── labelled zones, each with a fixed Einheit dropdown (tune the lists above).
        'VKF Bereich Polizei': { fields: ['Einheit'] },
        'VKF Bereich Chemiewehr': {},
        'VKF Bereich Zivilschutz': {},
        'VKF Bereich Feuerwehr': { fields: ['Einheit'] },
      } as Record<string, SymbolPreset>,
      // category fallback for any future symbol not listed above — keep it lean
      byCat: {
        'Schadenlage': { controls: ['floor'] },
        'Gefahren': { controls: ['floor'] },
        'Gebäude': { controls: ['floor'] },
        'Wasser': {},
        'Führung': {},
        'Personen / Sanität': {},
        'Partner': {},
      } as Record<string, SymbolPreset>,
    },
    /** Global default for on-canvas symbol captions (device pref `prefs.symbolCaptions`
     *  overrides per device; a single symbol's `caption` overrides per object). 'auto'
     *  shows each symbol's one discriminating value so an operator reads it without opening
     *  the dashboard — the 3am "recognition over recall" rule. */
    captionDefault: 'auto',
    /** below this map zoom, captions are hidden so a wide view doesn't turn to soup (the
     *  glyphs are tiny there anyway). The Plan has no zoom, so it always shows them. */
    captionMinZoom: 16,
  },
  drawing: {
    colors: ['#1f6feb', '#e8392b', '#1f9d57', '#e2920a', '#1b2330', '#ffffff'],
    widths: [3, 5, 8],
    defaultColor: '#1f6feb',
    /** Gefahrenradius / Absperrkreis defaults — red hazard ring, dashed, with a sensible
     *  starting radius and ± step (metres). Min radius guards against a stray tap. */
    circleColor: '#e8392b',
    /** stroke width of the cordon ring — slim, matching the live drag preview, so the
     *  committed circle isn't a heavy 4px band (the shared draw default). */
    circleLineWidth: 2,
    circleMinRadiusM: 5,
    circleRadiusStepM: 1,
    /** radius a freshly-placed Absperrkreis starts at — a visible default so a tap (no
     *  drag) still drops a real circle the user can then resize, rather than nothing. */
    circleInitialRadiusM: 25,
    /** default fill transparency of a new circle, and the presets offered in the editor. */
    circleFillOpacity: 0.12,
    fillOpacities: [0, 0.12, 0.25, 0.4],
    /** nominal hose length (m) for the Messpfeil distance helper "~N Schläuche" */
    hoseLengthM: 20,
    /** reserve margin added to a measured run before dividing into hose lengths (10 %) */
    hoseReservePct: 0.1,
    /** Plan-Maßstab calibration: the reference length (m) the −/+ stepper pre-fills. Most plans
     *  carry similar scale bars, so the LAST-used length is remembered and pre-filled from here. */
    planScaleDefaultM: 10,
    /** quick-pick reference lengths offered next to the stepper (the common scale-bar values) */
    planScaleDefaultsM: [50, 100],
    /** ± step (m) of the Massstab-festlegen stepper */
    planScaleStepM: 1,
    /** Line-tool presets: the single "Linie" tool draws a line; its style is then set
     *  (post-pick) via these presets in the DrawEditor. A preset is a bundle of `Drawing`
     *  defaults applied to the line; 'freihand' is the neutral line (clears arrow/marker/
     *  distance, keeps the freehand colour/width/dash). Each preset sets EVERY field it owns
     *  so switching back to Freihand cleanly removes the extras. The last-used preset is
     *  remembered, so a new line inherits it. */
    linePresets: [
      { id: 'freihand', label: 'Freihand', defaults: { arrow: false, marker: '', showDistance: false } },
      { id: 'pfeil', label: 'Pfeil', defaults: { arrow: true, marker: '', showDistance: false, dashed: false } },
      { id: 'rettungsachse', label: 'Rettungsachse', defaults: { arrow: true, marker: 'R', showDistance: false, dashed: true } },
    ] as { id: string; label: string; defaults: { arrow?: boolean; marker?: string; showDistance?: boolean; dashed?: boolean; color?: string } }[],
    /** subtle ink casing under a selected drawing — markers/symbols instead pop on select */
    selectColor: '#1b2330',
    /** how long a «zeigen» outline stays on the drawing it points at (ms). Long enough to find
     *  after the camera settles, short enough that it can't be mistaken for a selection. */
    flashMs: 2600,
    /** Halo colours for a hose line whose Atemschutz-Trupp is due / überfällig. MapLibre paint
     *  can't read CSS custom properties, so these mirror the --amber / --red tokens as literals
     *  (same values app.css defines); the DOM-side tag uses the tokens themselves. */
    atemschutzTone: { warn: '#e2920a', crit: '#e8392b' },
    /** distinct, well-separated accent colours assigned to teams (cycled by creation
     *  order). Kept apart from the draw `colors` so adding team hues never changes the
     *  ink palette. Each is legible on white and against the others on a busy plan. */
    teamColors: ['#1f6feb', '#e8392b', '#1f9d57', '#e2920a', '#8b5cf6', '#0891b2', '#db2777', '#65a30d', '#b45309', '#475569'],
  },
  // Atemschutzüberwachung (SCBA breathing-apparatus monitoring) defaults — Swiss FKS/CSSP
  // contact-timer model. The 5-min contact interval (+1 min Nachfrist before the hard alarm)
  // was confirmed as the standard 2026-07-02; `alarmBar` (100) was confirmed 2026-07-27 by the
  // Atemschutz-Verantwortlicher, together with the decision that ONE pressure threshold is
  // enough – the older second «Mindestdruck» tier (60) was dropped in the same pass.
  // Deployment-overridable numbers resolve through `atemschutzDoctrine()` in
  // lib/deploymentConfig – don't read them from here directly.
  atemschutz: {
    /** pressure stepper: ± step and ceiling (320 allows an overfull cylinder) */
    pressureStep: 10,
    pressureMax: 320,
    /** Eingangsdruck the wizard starts on (6.8 L / 300 bar cylinder in service) */
    defaultPressureBar: 300,
    /** Alarmdruck (bar) – at or below it the Trupp turns back, and the card says so on the
     *  logged Druck AND on the expected-pressure Schätzung. The single pressure threshold there
     *  is; 0 switches it off. Visual only: it never touches the contact-clock alarm, which
     *  stays the one audible signal. */
    alarmBar: 100,
    /** contact interval (min): amber "Kontakt fällig" from this mark (FKS-Standard: 5) */
    contactIntervalMin: 5,
    /** Nachfrist (sec) on top of the interval before the hard überfällig alarm fires */
    contactGraceSec: 60,
    /** opt-in soft pip when a Trupp crosses into the amber «Kontakt fällig» lead (default OFF —
     *  the überfällig alarm stays the only mandatory tone; stations that want an early audible
     *  nudge set this true). Muted/demo suppress it like the main alarm. */
    contactDueChime: false,
    /** default Funkkanal a new Trupp is seeded with (FKS-Standard: 11) */
    defaultFunkkanal: 11,
    /** Funkkanal stepper range offered in settings. Handfunk is 1–99, but digital/relay
     *  schemes number channels far higher, so the ceiling is generous — the field is really a
     *  free channel number, not a fixed FKS 1–99 dial. */
    funkkanalMin: 1,
    funkkanalMax: 9999,
    /** SCBA cylinder volume (L) and assumed air consumption (L/min) used only as the initial
     *  expected-pressure fallback until confirmed pressure history provides a measured rate.
     *  A Schätzung only — kept out of alarm math; it never replaces a real reading. */
    cylinderLiters: 7,
    estConsumptionLPerMin: 50,
    /** Auftrag types offered in the wizard (FKS); the actual order + location go in `ziel` */
    auftrag: [
      { id: 'retten', label: 'Retten' },
      { id: 'loeschen', label: 'Löschen' },
      { id: 'absuchen', label: 'Absuchen' },
      { id: 'sichern', label: 'Sichern' },
      { id: 'erkunden', label: 'Erkunden' },
      { id: 'anderes', label: 'Anderes' },
    ] as { id: 'retten' | 'loeschen' | 'absuchen' | 'sichern' | 'erkunden' | 'anderes'; label: string }[],
  },
  // Mittel (material-use) catalogue defaults. A deployment overrides `catalogue`/`sources` via
  // its station config (DeploymentMittel); these national defaults give a usable picker out of
  // the box — empty catalogue (place-don't-configure: everything can be typed as «Anderes
  // Mittel»), plus the common Swiss FW units offered for custom entries.
  mittel: {
    catalogue: [] as { id: string; label: string; unit?: string; category?: string; stock?: { source: string; qty: number }[]; symbol?: string; verbrauchbar?: boolean }[],
    sources: [] as { id: string; label: string }[],
    units: ['Stk.', 'l', 'm', 'Sack', 'Flasche', 'kg', 'Rolle', 'Paar', 'h'] as string[],
    /** What a catalogue entry that names no unit is counted in. ⚠️ It is «Stk.» WITH the dot —
     *  it is an abbreviation of «Stück», and the same sheet printing «2 Stk.» on one line and
     *  «1 Stk» on the next reads as two different units. Five call sites each carried their own
     *  `|| 'Stk'` literal and all five had lost the dot; this is the one they read now. */
    defaultUnit: 'Stk.',
  },
  /** Schichtenplanung (the Zeitplan surface) */
  shifts: {
    /** length a freshly added availability block opens on — one watch, correctable in two taps */
    defaultHours: 8,
    /** How far AHEAD the planning surfaces let you reach (Schicht anlegen, a person's
     *  Verfügbarkeit, a Schichten column). Planning is about time that has not happened yet —
     *  the day wheel used to stop at «now», or at whatever was already planned, so somebody
     *  who is free the day after tomorrow simply could not be entered. Matches the Zeitplan's
     *  longest Zeitraum (168 h), so what can be planned is what can be looked at.
     *  Anwesenheit is deliberately NOT included: you cannot have arrived in the future. */
    planAheadHours: 168,
  },
} as const

// `copy` is sourced from the active locale (see ./copy): `appConfig.copy.*` resolves
// the user's language at read time via the getter below. The rest of `appConfig` is the
// static, language-independent config (`base`, frozen `as const`). Locale is resolved at
// boot (device pref → deployment config → de-CH) by copy/applyLocale() in main.tsx; the
// getter then returns the resolved catalogue, so every `appConfig.copy.x` site is localized.
export const appConfig = {
  ...base,
  get copy(): Copy { return getCopy() },
} as typeof base & { readonly copy: Copy }
