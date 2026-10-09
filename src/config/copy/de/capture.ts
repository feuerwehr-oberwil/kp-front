// German copy · the capture (QR) app.
// One slice of the canonical `de` catalogue, assembled in ../de.ts — read the rules at the
// top of that file before adding or renaming a key here.

export const captureCopy = {
  // Erfassung view (/e/<token>) — what the poster in the Magazin opens. No login, no map;
  // deliberately NOT the crew's training surface.
  capture: {
    // Verlauf rows for whatever gets captured via the poster. «(QR)» is on them because a row
    // with no author in the legal record doesn't say who wrote it — on the tablet that is the
    // signed-in person, on the poster nobody.
    logAttendancePresent: '{name} anwesend (QR)',
    logAttendanceLeft: '{name} gegangen (QR)',
    logAttendanceCleared: '{name} aus der Anwesenheit entfernt (QR)',
    logAttendanceRestored: '{name} wiederhergestellt (QR)',
    logTimes: 'Zeiten von {name} korrigiert (QR)',
    // ⚠️ kein «von wem»: der Poster fragt seit 15.08. nicht mehr, wer erfasst – «(QR)» ist die
    // ganze Wahrheit über die Herkunft dieser Zeile.
    logMittel: '{label}: {menge} {unit} (QR)',
    logAttachmentAdd: 'Rapport-Foto hinzugefügt (QR)',
    logAttachmentRemove: 'Rapport-Foto entfernt (QR)',
    logMeta: 'Rapportangaben geändert (QR): {fields}',
    title: 'Einsatz erfassen',
    invalid: 'Link ungültig oder Erfassung deaktiviert.',
    noIncidents: 'Zurzeit kein erfassbarer Einsatz.',
    noIncidentsHint: 'Hier erscheinen laufende und noch nicht rapportierte Einsätze. Fehlt euer Einsatz? Auf dem Papier-Erfassungsblatt notieren oder der Einsatzleitung melden – sie kann ihn später nachtragen.',
    searchName: 'Name suchen …',
    // Schnellfilter neben der Suche: alle, die schon abgehakt sind – gekommen wie gegangen
    filterRecorded: 'Erfasste {n}',
    back: 'Zurück',
    alarmedAt: 'Alarm {t}',
    saveFailed: 'Speichern fehlgeschlagen',
    saveFailedOffline: 'Kein Empfang – die letzte Änderung wurde nicht gespeichert.',
    retry: 'Erneut versuchen',
    savedOk: 'Gespeichert',
    undo: 'Rückgängig',
    mittelSet: '{label}: neu {n} {unit}',
    mittelRemoved: '{label} entfernt',
    mittelExtra: 'Weitere erfasste Positionen',
    gerettete: 'Gerettete',
    gerettetePersonen: 'Personen',
    geretteteTiere: 'Tiere',
    rueckmeldung: 'Rückmeldung ELZ',
    rueckName: 'Name wählen …',
    rueckZeit: 'Zeit',
    jetzt: 'Jetzt',
    kurzberichtHead: 'Kurzbericht',
    // Rapport photos on the Erfassung poster: pictures belonging to the Rapport (ID, damage)
    partnersHead: 'Partnerorganisationen',
    partnerOrg: 'Organisation',
    partnerNote: 'Bemerkung',
    partnerAdd: 'Organisation hinzufügen',
    // the field's placeholder — the verb is the «+» beside it (27.09.2026, slim sweep · mockup 5:
    // «hinzufügen» rows lose the word; partnerAdd stays the name of the button and the field)
    partnerPlaceholder: 'Organisation …',
    partnerRemove: 'Organisation entfernen',
    // header of the collapsible sections — says while collapsed whether anything is in there yet
    partnerCount: '{n} erfasst',
    partnerNone: 'keine',
    beilagenHead: 'Fotos',
    beilagenAdd: 'Foto hinzufügen',
    beilagenBusy: 'Wird hochgeladen …',
    beilagenCaption: 'Bildlegende',
    beilagenRemove: 'Foto löschen',
    beilagenFailed: 'Foto konnte nicht hochgeladen werden.',
    beilagenCount: '{n} Foto(s)',
    beilagenNone: 'keine',
    kurzberichtPlaceholder: 'Was ist passiert, was wurde gemacht?',
    gruppenHead: 'Alarmierung Gruppen',
    fahrzeugeHead: 'Ausrückzeiten der Fahrzeuge',
    einsatzleiter: 'Einsatzleiter',
    rapportPdf: 'Rapport-PDF',
    pdfFailed: 'PDF fehlgeschlagen – nochmals versuchen',
    sectionZeiten: 'Zeiten',
    sectionAngaben: 'Angaben',
    zeitenFilled: '{n} Zeiten erfasst',
    abschlussHead: 'Abschluss',
    // Was vor dem Ausdrucken noch fehlt – dieselben Mindestangaben wie auf dem KP-Tablet
    // (lib/abschluss). Jeder Punkt ist ein Chip, der seinen Abschnitt öffnet und das Feld zeigt.
    missingHead: 'Noch offen:',
    missingGo: '{step} öffnen',
    missingNote: 'Wird als Leerfeld gedruckt.',
    ausgerueckt: 'Ausgerückt',
    kontaktperson: 'Kontaktperson',
    kontaktpersonPlaceholder: 'Eigentümer / Melder',
    kontaktpersonTelefon: 'Telefon Kontaktperson',
    kontaktpersonTelefonPlaceholder: 'Telefonnummer',
    kontaktpersonCall: 'Kontaktperson anrufen',
    von: 'von',
    bis: 'bis',
    ende: 'Einsatzende',
    sectionPersonen: 'Anwesenheit',
    presentCount: '{n} anwesend',
    tapHint: 'Antippen: nicht anwesend → Magazin → Vor Ort → gegangen. Zeit daneben: von = Ankunft, nach Weggang bis = Weggang.',
    tapHelp: 'Hilfe zur Bedienung',
    stateLeft: 'gegangen',
    sectionMaterial: 'Material',
    cancel: 'Abbrechen',
    mittelCount: '{n} Positionen',
    pickMaterial: 'Material wählen …',
    add: 'Hinzufügen',
    notePlaceholder: 'Notiz für den Verlauf …',
    footNote: 'Alles wird laufend gespeichert.',
    loadFailedOffline: 'Kein Empfang',
    clockSkew: 'Die Uhr dieses Geräts weicht um {n} Minuten ab – erfasste Zeiten prüfen.',
    searchMaterial: 'Material suchen …',
    // Cross-visibility QR ↔ KP: the live-dot line in the capture header once the KP tablet
    // has the incident (editor_opened_at latch), and the quiet hint that de-emphasizes the
    // print buttons — the full rapport (incl. Kroki) will come from the KP.
    kpActive: 'KP-Tablet aktiv',
    kpActiveHint: 'Das KP-Tablet ist im Einsatz – der vollständige Rapport (mit Kroki) kommt von dort.',
    // dasselbe, aber ohne laufendes KP-Tablet: der Normalfall, nicht eine Meldung über jetzt
    kpNormallyHint: 'Der vollständige Rapport (mit Kroki) kommt normalerweise vom KP-Tablet.',
    // tablet-side mirror: chip on the QR-writable surfaces (Anwesenheit, Mittel, Rapport)
    usageChip: 'QR: {n} Einträge · zuletzt {t}',
    usageChipOne: 'QR: 1 Eintrag · zuletzt {t}',
    // Übung: the poster reaches Übungen just like real Einsätze — whoever captures has to tell
    // the two apart at a glance (list, header, and before every print).
    exerciseHint: 'Übung – zählt nicht für die Einsatzstatistik.',
    // The list mixes the fresh Einsatz with the backlog that hasn't been reported yet; without a
    // split, a three-week-old Einsatz sits directly below tonight's.
    groupCurrent: 'Aktuell',
    groupBacklog: 'Noch offen',
  },
} as const
