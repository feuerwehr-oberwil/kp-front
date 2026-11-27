// German copy · the Karte: tools, nav, views, hints.
// One slice of the canonical `de` catalogue, assembled in ../de.ts — read the rules at the
// top of that file before adding or renaming a key here.

export const mapCopy = {
  // kind drives how the tool-rail button reads & behaves:
  //   'tool'   — modal, sticky (flat, lights up while active)
  //   'action' — one-shot, fires & gives toast feedback (push-button look)
  //   'mode'   — switches the whole surface (push-button look)
  mapTools: [
    // ONE list, no dividers (22.09.2026): the rail used to draw a hairline before the create
    // group, and it read as noise beside the one seam that matters — the footer's generic
    // controls, which the rail separates itself. Symbol leads the create tools as a plain tool.
    // Auswahl carries Mehrfach as its SECOND state (05.09.) instead of a rail slot of its own:
    // tapping the already-armed Auswahl swaps glyph AND word to Mehrfach, tapping again swaps
    // back. Both keys keep working ([[V]] / [[W]]) — this is chrome, not a new tool.
    { id: 'select', icon: 'select', label: 'Auswahl', kind: 'tool', alt: { id: 'lasso', icon: 'marquee', label: 'Mehrfach' } },
    { id: 'symbol-slot', slot: true, icon: '', label: '' },
    { id: 'line', icon: 'pen', label: 'Linie', kind: 'tool' },
    { id: 'area', icon: 'area', label: 'Fläche', kind: 'tool' },
    { id: 'circle', icon: 'circle', label: 'Absperrkreis', kind: 'tool', short: 'Sperrkreis' },
    // (no divider between Absperrkreis and Notiz — it cost a rail row to separate two groups
    // that are both «etwas auf die Karte setzen»; the one before Symbol followed it on 22.09.)
    { id: 'note', icon: 'type', label: 'Notiz', kind: 'tool' },
    { id: 'team', icon: 'flag', label: 'Trupp', kind: 'tool' },
    { id: 'measure', icon: 'measure', label: 'Messen', kind: 'tool' },
  ],
  // Plan/whiteboard tool list — mirrors mapTools' ordering (Auswahl · Symbol · then the create
  // tools) so the two shared tool rails read the same. Symbol leads the create group as a plain
  // tool, one undivided list — the same as mapTools.
  planTools: [
    // …and the same two-state Auswahl the Karte has: 'pan' IS the plan's Auswahl, Mehrfach is
    // the second tap on it. Lage ↔ Plan parity — one interaction, both surfaces.
    { id: 'pan', icon: 'select', label: 'Auswahl', alt: { id: 'lasso', icon: 'marquee', label: 'Mehrfach' } },
    { id: 'symbol-slot', slot: true, icon: '', label: '' },
    // single Linie tool (Freihand-drag ↔ Punkte toggle lives in its dock), mirroring the Karte map
    { id: 'line', icon: 'pen', label: 'Linie' },
    { id: 'area', icon: 'area', label: 'Fläche' },
    { id: 'circle', icon: 'circle', label: 'Absperrkreis', short: 'Sperrkreis' },
    { id: 'text', icon: 'type', label: 'Notiz' },
    { id: 'resource', icon: 'flag', label: 'Trupp' },
    // Messen: node-based distance/area on the plan (uses the calibrated scale). Calibration
    // itself is reached via the always-visible Massstab trust chip, not a separate rail button.
    { id: 'measure', icon: 'measure', label: 'Messen' },
  ],
  nav: {
    zoomIn: 'Vergrössern',
    zoomOut: 'Verkleinern',
    fit: 'Einpassen',
    resetNorth: 'Nach Norden ausrichten',
    centerIncident: 'Auf Einsatz zentrieren',
    coords: 'Koordinaten abgreifen',
    coordsHint: 'Auf Karte klicken zum Festhalten',
    // the readout's ✕ (and Esc, and the toolbar button) all END the mode — a locked point is
    // never cycled back into aiming, which is what used to swallow the next map tap (02.09.)
    coordsLocked: 'Festgehalten – ✕ zum Beenden',
    coordsExit: 'Koordinaten beenden',
    autoMode: 'Automatisch',
    // 'device' follows the OS light/dark setting (prefers-color-scheme), 'auto' the daylight
    deviceMode: 'Gerät',
    dayMode: 'Tag',
    nightMode: 'Nacht',
  },
  // saved map views (camera bookmarks) — opened from the multi-purpose compass
  mapViews: {
    title: 'Ansichten',
    north: 'Nach Norden',
    fit: 'Einpassen',
    locate: 'Mein Standort',
    save: 'Ansicht speichern',
    hint: 'Eine Ansicht merkt sich Ausschnitt, Zoom und Drehung – antippen springt dorthin.',
    rename: 'Umbenennen',
    delete: 'Löschen',
    deleted: 'Ansicht «{name}» gelöscht',
  },
  toast: {
    micDenied: 'Kein Mikrofonzugriff – als Platzhalter vermerkt',
    // the mic WAS granted; the recorder itself would not start (unsupported format/hardware)
    micFailed: 'Aufnahme nicht gestartet – erneut versuchen',
    // a permission denied long ago (rare-user round F9, 17.11.2026; lib/permissionPath): what is
    // blocked, then where its switch is on THIS platform – «Mein Standort» never does nothing
    micBlocked: 'Mikrofon gesperrt – erlauben unter {path}',
    locateBlocked: 'Standort gesperrt – erlauben unter {path}',
    locateNone: 'Kein Standort gefunden – erneut versuchen',
    permissionPath: {
      location: {
        iosApp: 'iPhone-Einstellungen › Datenschutz & Sicherheit › Ortungsdienste › Safari-Websites',
        iosSafari: 'iPhone-Einstellungen › Apps › Safari › Standort',
        android: 'Chrome ⋮ › Einstellungen › Website-Einstellungen › Standort',
        desktop: 'dem Symbol links der Adresse › Standort',
      },
      microphone: {
        iosApp: 'iPhone-Einstellungen › Apps › Safari › Mikrofon',
        iosSafari: 'iPhone-Einstellungen › Apps › Safari › Mikrofon',
        android: 'Chrome ⋮ › Einstellungen › Website-Einstellungen › Mikrofon',
        desktop: 'dem Symbol links der Adresse › Mikrofon',
      },
      notifications: {
        iosApp: 'iPhone-Einstellungen › Mitteilungen › {app}',
        iosSafari: 'iPhone-Einstellungen › Mitteilungen › {app}',
        android: 'Android-Einstellungen › Apps › {app} › Benachrichtigungen',
        desktop: 'dem Symbol links der Adresse › Benachrichtigungen',
      },
    },
  },
  // help shown by the info (ℹ) button on each tool dock — the instructions
  // that used to sit in the bottom hint bar
  dockHints: {
    lasso: 'Rahmen um mehrere Objekte ziehen – dann gemeinsam verschieben oder entfernen.',
    /** …per input mode, because the two take different gestures: «Freihand» draws only with a
     *  drag (a tap does nothing), «Punkte» only with taps and ✓ – the Fläche's too (`areaFreehand`
     *  / `areaNodes`, button sweep audit B4, 17.11.2026: ONE text said «Eckpunkte tippen» in
     *  Freihand). They are the Karte's AND the Plan's (WbControls), so they name no surface (UX
     *  sweep M4, 20.10.2026): a node draft finishes on ✓ on both, never on a double tap — that
     *  zooms, as everywhere. The Trupp's `team` is both surfaces' too (audit B8). */
    lineFreehand: 'Mit dem Finger ziehen – die Linie folgt. Gerade Stücke: «Punkte».',
    lineNodes: 'Punkt für Punkt tippen, dann ✓ Fertig.',
    circle: 'Von der Mitte zum Rand ziehen.',
    note: 'Tippen, wo die Notiz hin soll – dann schreiben.',
    team: 'Tippen, dann den Trupp wählen – einen gesetzten Trupp ziehen, um ihn zu verschieben.',
    shape: 'Tippen setzt die Form. Für mehrere: «Mehrere platzieren».',
    // Eine Rotation ist eine Strecke zwischen zwei Orten, also wird sie auch so gelegt:
    // erst der Wasserbezug, dann die Brandstelle. Auf einem Symbol halten, bis der Ring
    // zu ist, setzt den Punkt genau darauf.
    rotationStart: 'Ersten Punkt tippen – wo das Wasser bezogen wird. Auf einem Symbol halten setzt ihn genau darauf.',
    rotationEnd: 'Zweiten Punkt tippen – die Brandstelle. Nochmals auf den ersten Punkt: übliche Länge.',
    measure: 'Punkte tippen. Punkt halten entfernt ihn.',
    areaFreehand: 'Rundum ziehen – die Fläche schliesst sich beim Loslassen.',
    areaNodes: 'Ecke für Ecke tippen, dann ✓ Fertig.',
  },
  map: {
    incidentHere: 'Einsatzort',
    youHere: 'Mein Standort',
    // the 6px ink dot on a glyph whose name did not fit: it says a name EXISTS here, and
    // selecting the symbol always brings it back (the selection is exempt from suppression)
    // WebGL context loss (iPad reclaims the GPU in the background) — the map goes blank while
    // everything around it still works, so it needs naming and a way out.
    glLost: 'Kartenansicht unterbrochen',
    glLostHint: 'Das Gerät hat die Grafikanzeige der Karte freigegeben. Deine Einträge sind gespeichert.',
    glLostAction: 'Karte neu aufbauen',
    // offline with no cached basemap for this view: the map is a flat colour with symbols on it,
    // and nothing said why. One Meldeleiste row per Einsatz, gone the moment the link is back.
    noTilesTitle: 'Keine Basiskarte für diesen Ausschnitt gespeichert',
    noTilesSub: 'Offline – Objekte und Linien werden ohne Karte gezeigt',
    noTilesAction: 'Was offline da ist',
    noTilesDismiss: 'Ausblenden',
    // Live positions on the Karte: a Traccar vehicle's status word, keyed by Traccar's own status
    // value (unknown values show raw), and a crew phone's self-reported position («Standort
    // teilen»). `lastFix` / `accuracy` are the detail-row labels of that position.
    live: {
      vehicleStatus: { online: 'Online', offline: 'Offline', unknown: 'Unbekannt' } as Record<string, string>,
      selfReported: 'Selbstauskunft',
      selfReportedAge: 'Selbstauskunft · vor {n} min',
      lastFix: 'Letzte Position',
      accuracy: 'Genauigkeit',
      // the Traccar vehicle's detail rows (`useVehiclePositions` · toEntity) and its subtitle; with
      // the feed silent past GPS_STALE_AFTER_MS the subtitle and one more row say since when
      fieldStatus: 'Status',
      fieldSpeed: 'Geschwindigkeit',
      fieldCourse: 'Kurs',
      fieldPlace: 'Standort',
      fieldLastGps: 'Letzte GPS-Pos.',
      vehicleSubtitle: 'GPS · {status}',
      vehicleSubtitleStale: 'GPS · veraltet ({n} min)',
      fieldFeed: 'GPS-Feed',
      feedSilent: 'seit {n} min keine Daten',
      feedUnreachable: 'GPS nicht erreichbar',
    },
  },
} as const
