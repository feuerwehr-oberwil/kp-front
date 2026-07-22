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
}

const base = {
  appName: 'Incident Map',
  locale: 'de-CH',
  storage: {
    key: 'incident-map-workspace-v1',
    legacyKeys: ['kp-front-poc-v5'],
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
    // each live vehicle renders a generic vehicle glyph with its name + heading
    // baked in (see lib/useVehiclePositions.ts · vehicleSymbolSvg); no per-name
    // symbol mapping needed.
    status: { online: 'Online', offline: 'Offline', unknown: 'Unbekannt' } as Record<string, string>,
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
        'VKF Rettungen': { controls: ['count', 'floor'], fields: ['Status'] },
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
        // ── Fahrzeuge / Mittel ── operator-named; directional ones rotate, no fields.
        'VKF Drehleiter': { controls: ['rotation'] },
        'VKF Hubretter': { controls: ['rotation'] },
        // generic vehicle: user-named (see lib/symbols) — title + a Fahrer picker; type lists via config
        'VKF Fahrzeug': { controls: ['rotation'], fields: ['Fahrer'] },
        'VKF Pumpe Typ2': {},
        'VKF Helilandeplatz': {},
        'VKF Luefter mobil': { controls: ['rotation', 'airflow'], fields: ['Typ'] },
        // composite vehicle-mounted Grosslüfter: body heading (rotation) + airflow (rotation2),
        // each with its own on-canvas rotor + Drehung stepper. Synthesised in lib/useSymbols.
        'Grosslüfter': { controls: ['rotation', 'rotation2'] },
        'FW Entrauchung': { controls: ['rotation'] },
        'FW Kleinloeschgeraet': { fields: ['Typ'] },
        'FW Boot': { controls: ['rotation'] },
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
    /** distinct, well-separated accent colours assigned to teams (cycled by creation
     *  order). Kept apart from the draw `colors` so adding team hues never changes the
     *  ink palette. Each is legible on white and against the others on a busy plan. */
    teamColors: ['#1f6feb', '#e8392b', '#1f9d57', '#e2920a', '#8b5cf6', '#0891b2', '#db2777', '#65a30d', '#b45309', '#475569'],
  },
  // Atemschutzüberwachung (SCBA breathing-apparatus monitoring) defaults — Swiss FKS/CSSP
  // contact-timer model. The 5-min contact interval (+1 min Nachfrist before the hard alarm)
  // was confirmed as the standard 2026-07-02; mindestBar still needs firefighter / AdF
  // sign-off before being treated as doctrine. (A `rueckzugBar` turn-back reminder was
  // removed 2026-07-03 pending that same sign-off — re-add together with its card/dialog
  // display once the value is confirmed.) Deployment-overridable numbers resolve through
  // `atemschutzDoctrine()` in lib/deploymentConfig — don't read them from here directly.
  atemschutz: {
    /** pressure stepper: ± step and ceiling (320 allows an overfull cylinder) */
    pressureStep: 10,
    pressureMax: 320,
    /** Eingangsdruck the wizard starts on (6.8 L / 300 bar cylinder in service) */
    defaultPressureBar: 300,
    /** critical minimum pressure (bar) — the card/Druck readout highlights at or below this */
    mindestBar: 60,
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
    /** Funkkanal stepper range offered in settings (FW Handfunk channels) */
    funkkanalMin: 1,
    funkkanalMax: 99,
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
    units: ['Stk', 'l', 'm', 'Sack', 'Flasche', 'kg', 'Rolle', 'Paar', 'h'] as string[],
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

