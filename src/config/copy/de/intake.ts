// German copy · the Einsatz wizard (intake).
// One slice of the canonical `de` catalogue, assembled in ../de.ts — read the rules at the
// top of that file before adding or renaming a key here.

export const intakeCopy = {
  // "Einsatz eröffnen" / "Einsatzdaten bearbeiten". An alarm opens its Einsatz by itself,
  // so this panel is for the two remaining jobs: a manual create (fully analog Einsatz,
  // three location methods — Objekt · Adresse · Karte) and correcting what the dispatch
  // got wrong on an incident that is already running.
  intake: {
    titleNew: 'Einsatz eröffnen',
    // …and with «Übung: Ja» the form says what it is about to open (sweep F.8)
    titleNewExercise: 'Übung eröffnen',
    // --- Standort section ---
    addressLabel: 'Adresse',
    addressPlaceholder: 'Strasse oder Objekt',
    addressSearching: 'Wird gesucht …',
    // «Auf Karte» · «Hier» – icon buttons on the address field (owner pick 1A, 15.11.2026), the
    // words are their aria-label and title. «Aus Plänen» went (15.11.): typing finds the station's
    // objects in the field's one list, so the placeholder names both.
    objectPlans: (n: number) => (n === 1 ? '1 Plan' : `${n} Pläne`),
    objectNoPlans: 'keine Pläne',
    mapPickButton: 'Auf Karte',
    hereButton: 'Hier',
    hereFailed: 'Standort nicht verfügbar',
    // --- Stichwort section ---
    titleLabel: 'Stichwort / Titel',
    titlePlaceholder: 'z. B. Gebäudebrand Schulhaus',
    categoryLabel: 'Kategorie',
    // Übungen stay fully operable, but do not feed the statistics and are the only ones
    // that can be deleted (Alle Einsätze)
    // the right half of the form's first control since 17.11.2026, the consequence under it
    exerciseLabel: 'Übung',
    // «Hier» moves the Einsatzort to the device's location. On a running Einsatz it always asks
    // first – the form is usually opened in the Magazin to correct an address, and a mis-tap
    // takes the map, the Kroki, the tile stock and the Objektpläne along with it.
    moveConfirmTitle: 'Einsatzort verschieben?',
    moveConfirmMsg: 'Der Einsatzort wird auf deinen jetzigen Standort gesetzt – {d} vom bisherigen entfernt. Karte, Kroki-Ausschnitt und die Objektpläne in der Nähe richten sich danach.',
    moveConfirmBtn: 'Verschieben',
    alarmTextUnavailable: 'Alarmmeldung konnte nicht geladen werden – bleibt unverändert',
    detailsPlaceholder: 'Zusätzliche Angaben zur Meldung',
    // --- Actions ---
    open: 'Einsatz eröffnen',
    openExercise: 'Übung eröffnen',
    opening: 'Wird eröffnet …',
    demoBlocked: 'In der Demo deaktiviert – hier lässt sich kein neuer Einsatz eröffnen.',
    cancel: 'Abbrechen',
    errorCreate: 'Einsatz nicht eröffnet – erneut versuchen',
    errorTake: 'Alarm nicht übernommen – erneut «Öffnen», es entsteht kein zweiter Einsatz',
    errorUpdate: 'Einsatzdaten nicht geändert – erneut versuchen',
    // --- edit mode + result toasts ---
    editTitle: 'Einsatzdaten bearbeiten',
    save: 'Speichern',
    saving: 'Speichert …',
    taken: 'Alarm übernommen',
    alarmTime: 'Zeit Alarmierung',
    alarmMessage: 'Alarmmeldung',
    // --- Divera pool + incoming banner + in-map review ---
    addressUnknown: 'Adresse unbekannt',
    alarmOpen: 'Öffnen',
    alarmOpening: 'Öffne …',
    manualIncident: 'Manueller Einsatz',
    // --- attach: split/Nachalarm dispatch joins an existing incident instead of a duplicate ---
    attach: 'Zu bestehendem Einsatz hinzufügen',
    attachShort: 'Zu Einsatz',
    attachConfirmTitle: '«{alarm}» zu diesem Einsatz hinzufügen?',
    attachHint: 'Die Meldung landet im Verlauf, GPS-Zeiten folgen automatisch. Stichwort und Standort des Einsatzes bleiben unverändert.',
    attachConfirm: 'Hinzufügen',
    attachError: 'Alarm nicht angehängt – er bleibt in der Liste, erneut «Zu Einsatz»',
    newDiveraAlarm: 'Neuer Alarm',
    hide: 'Ausblenden',
    fromDivera: 'Aus der Alarmquelle übernommen',
    // Zeilentitel in der Meldeleiste; fromDivera darunter ist der Untertitel. Die Zeile
    // ERSETZT die 700px-Karte mit Meldung und Kategorie-Combo — geprüft wird beim
    // Bearbeiten, bestätigt wird mit «Passt».
    reviewTitle: 'Einsatzdaten prüfen',
    noLocationOnMap: 'Kein Standort – auf Karte setzen',
    ok: 'Passt',
    // «Alarm aktualisiert» (15.11.2026, Mock Variante A): die Leitstelle meldet für ein offenes
    // Einsatz nach. Nichts wird automatisch überschrieben – die Zeile zeigt alt → neu, die Mannschaft
    // übernimmt, bearbeitet oder blendet aus (für alle Geräte). Banners · AlarmUpdateBanner.
    alarmUpdate: {
      title: 'Alarm aktualisiert',
      take: 'Übernehmen',
      // wenn ein Feld von Hand geändert wurde: der Knopf nennt, was er nimmt («Meldung übernehmen»)
      takeSome: '{fields} übernehmen',
      fields: { address: 'Adresse', title: 'Stichwort', text: 'Meldung' } as Record<string, string>,
      // «Adresse bleibt Musterweg 14 (von euch) · Alarm neu: Musterweg 21»
      keeps: '{field} bleibt',
      byHand: '(von euch)',
      alarmNew: 'Alarm neu:',
      taken: 'Einsatz aktualisiert',
      failed: 'Nicht gespeichert – braucht Verbindung, erneut versuchen',
    },
    // The VKF Schadenkategorien are the SERVER's (`categoryLabels` on GET /api/config, from
    // backend app/divera.py CATEGORY_LABELS) – read through `incidentCategories()`.
    // DISPLAY labels for the category picker, keyed by the German category VALUE (the server's
    // `categoryLabels` values). de = identity (German→German); en/fr/it translate. The stored/
    // submitted value stays the German label — only the option TEXT localizes; the picker
    // falls back to the German label when a translation is missing.
    kategorienLabels: {
      'Brandbekämpfung': 'Brandbekämpfung',
      'Strassenrettung': 'Strassenrettung',
      'Technische Hilfeleistung': 'Technische Hilfeleistung',
      'Elementarereignis': 'Elementarereignis',
      'Ölwehr': 'Ölwehr',
      'Chemiewehr': 'Chemiewehr',
      'Strahlenwehr': 'Strahlenwehr',
      'Einsatz Bahnanlagen': 'Einsatz Bahnanlagen',
      'BMA / unechte Alarme': 'BMA / unechte Alarme',
      'Gerettete Tiere': 'Gerettete Tiere',
      'Dienstleistungen': 'Dienstleistungen',
      'Diverse Einsätze': 'Diverse Einsätze',
    } as Record<string, string>,
    // The one line under the address field when the form has no coordinate yet (owner pick
    // 1A, 15.11.2026) – on create and edit alike; set, the form says nothing about it.
    coordMissing: 'Noch kein Standort',
    // The two group heads of the one list under the address field (round 2, 15.11.2026):
    // the objects first, then the geocoder's addresses; «Weitere» = the rest A–Z under «In der Nähe».
    objectsGroup: 'Objekte',
    addressGroup: 'Adressen',
    // the address search's own states (LISTS.1) – the Karte search's words
    addressOffline: 'Adresssuche braucht Netz. Objekte werden trotzdem gefunden.',
    addressFailed: 'Adresssuche gerade nicht erreichbar.',
    undoTakeFailed: 'Alarm nicht zurückgenommen – der Einsatz bleibt offen',
    // «Ernstfall | Übung» – the form's FIRST question (owner pick C7, 17.11.2026); «Übung» is
    // `exerciseLabel`. The list filter's words.
    kindLabel: 'Ernstfall / Übung',
    kindReal: 'Ernstfall',
    // «Zeigen» on a hidden alarm's (or «Alarm aktualisiert»'s) row in the «Einsätze» lists – the way
    // back after ✕ (rare-user round M3 / F7, 17.11.2026; panels/AppMenuRows · FoldedRow)
    showAlarm: 'Zeigen',
    // the review row's sub-line while it shows the Alarmmeldung (Banners · ReviewBanner, owner pick B3·4, 25.11.2026)
    fromDiveraRead: 'Aus der Alarmquelle übernommen – nur zum Lesen',
  },
} as const
