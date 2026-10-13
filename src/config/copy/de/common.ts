// German copy · shared words: dialogs, delete/remove, undo/redo, search.
// One slice of the canonical `de` catalogue, assembled in ../de.ts — read the rules at the
// top of that file before adding or renaming a key here.

export const commonCopy = {
  baseMap: 'Grundkarte',
  // floor (Geschoss) short labels — shared by the Plan floor-stack and the report plan labels.
  // ground floor is a literal; upper/basement carry the number via {n}.
  floor: { eg: 'EG', og: '{n}. OG', ug: '{n}. UG' },
  // hose-count hint for the Messpfeil label (lib/geo · hoseLengthHint), e.g. "~5 Schläuche"
  hoseHint: '~{n} Schläuche',
  noHistoryRows: 'Noch keine Ereignisse erfasst.',
  symbolSearchPlaceholder: 'Suchen …',
  closeDialog: 'Schliessen',
  sheetGrip: 'Detailhöhe anpassen',
  edit: 'Bearbeiten',
  primarySymbol: { id: 'symbol', icon: 'plus-bold', label: 'Symbol' },
  done: 'Fertig',
  cancel: 'Abbrechen',
  // shared «Übung» marker — switcher, dropdown rows, Alle Einsätze (is_exercise incidents)
  exerciseBadge: 'Übung',
  /** …its one-letter form for the phone's Einsatz pill, where the street needs the width (the
   *  full word stays the badge's title and part of the pill's accessible name) */
  exerciseInitial: 'Ü',
  keepPlacing: 'Mehrere platzieren',
  delete: 'Löschen',
  /** ⚠️ The ONE word for taking a tactical object (Symbol, Notiz, Form, Linie, Fläche,
   *  Absperrkreis, Truppmarker) off the picture — its panel's button, its confirm and its Verlauf
   *  row («… entfernt»), since 25.09.2026. «gelöscht» now means only an extinguished Feuer
   *  (objectDone); «Löschen» stays for records that are not on the picture (views, checklists). */
  remove: 'Entfernen',
  undo: 'Rückgängig',
  // ⚠️ «Wiederherstellen», nicht «Wiederholen» (11.09.): «wiederholen» heisst, die Aktion NOCH
  // EINMAL auszuführen – im Verlauf stand hintereinander «Druck 280 bar rückgängig gemacht» und
  // «Druck 280 bar wiederholt», was wie zwei Meldungen desselben Trupps aussieht statt wie eine
  // zurückgenommene und wieder hergestellte. Redo stellt den Stand von vorher wieder her.
  redo: 'Wiederherstellen',
  // ⚠️ Das ↶ im Kopf greift seit 08.09.2026 über ALLE Flächen (lib/undoTimeline), also muss es
  // sagen, was es zurücknimmt – sonst nimmt es auf der Karte etwas zurück, das zwei Tipps vorher
  // auf der Atemschutz-Tafel passiert ist, und niemand sieht es. Der Text steht in der
  // Halte-Blase (Versprechen) und blitzt beim Tippen an derselben Stelle auf (Bestätigung).
  undoNamed: 'Rückgängig: {action}',
  redoNamed: 'Wiederherstellen: {action}',
  // Der Schritt zeigte auf etwas, das es nicht mehr gibt (Fremdgerät hat es gelöscht, Merge hat
  // die Fläche ersetzt). Kein Fehler des Bedieners – darum ohne Knopf und ohne «fehlgeschlagen».
  undoLost: 'Nicht mehr rückgängig machbar',
  /** Womit «Rückgängig: …» weitergeht, wenn die Fläche selbst die Aktion nicht benennt. Die
   *  Atemschutz-Tafel, Mittel und die Checklisten benennen sie (dieselbe Zeile, die der Verlauf
   *  bekommen hat); Karte und Plan führen ein Dokument, das viele kleine Schritte kennt. */
  undoDomains: {
    /** Die Passung eines Plans wurde korrigiert — ein Schritt für alle neu verorteten Objekte. */
    reference: 'Referenz angepasst',
    /** ⚠️ Dieselbe Rückverortung, aber NIEMAND hat die Referenz angefasst: die App hat das
     *  Blatt vermessen und dieselben Passpunkte in der richtigen Form neu gelöst. Der Verlauf
     *  behauptet keine Handlung, die niemand ausgeführt hat — und ein ↶ hat zu benennen, was
     *  es zurücknimmt. */
    blattform: 'Blattform gemessen',
    karte: 'Änderung auf der Karte',
    plan: 'Änderung auf «{plan}»',
    anwesenheit: 'Anwesenheit',
    mittel: 'Material',
    checkliste: 'Checkliste',
    gebaeude: 'Gebäude',
    /** Der Einsatzrapport – eine getippte Angabe, eine Rettung, eine Partnerorganisation. */
    rapport: 'Rapport',
    zeitplan: 'Zeitplan',
    ansicht: 'Ansicht',
  },
  /** ⚠️ Die FLÄCHE, auf der ein Schritt passiert ist — steht vor der Aktion in «Rückgängig: …»,
   *  wo die Aktion sie nicht schon selbst nennt (lib/undoTimeline · undoCaption). Seit ein Merge
   *  nur noch einzelne Schritte fallen lässt (25.09.2026), kann das ↶ nach einem fremden Speichern
   *  auf eine ältere Aktion einer ANDEREN Fläche zeigen; ohne Fläche nimmt der zweite Tipp, der
   *  der Karte galt, eine Trupp-Änderung zurück. */
  undoSurfaces: {
    karte: 'Karte',
    plan: 'Plan',
    trupps: 'Trupps',
    anwesenheit: 'Anwesenheit',
    mittel: 'Material',
    checkliste: 'Checklisten',
    gebaeude: 'Gebäude',
    rapport: 'Rapport',
    zeitplan: 'Zeitplan',
    ansicht: 'Karte',
    pendenz: 'Verlauf',
  },
  /** Ein anderes Gerät hat geändert, was der OBERSTE Schritt zurückgenommen hätte: der Schritt
   *  fällt weg, und das ↶ zeigt jetzt auf etwas Älteres. Einmal sagen, statt still umzubenennen.
   *  `{what}` aus `undoDroppedWhat`. */
  undoTopDropped: 'Letzter Schritt nicht mehr rückgängig machbar – ein anderes Gerät hat {what} geändert',
  undoDroppedWhat: {
    karte: 'die Karte',
    plan: 'den Plan',
    trupps: 'den Trupp',
    anwesenheit: 'die Anwesenheit',
    mittel: 'das Material',
    checkliste: 'die Checkliste',
    gebaeude: 'das Gebäude',
    rapport: 'den Rapport',
    zeitplan: 'den Zeitplan',
    ansicht: 'die Ansichten',
    pendenz: 'die Pendenz',
  },
  play: 'Abspielen',
  // The ✕ that EMPTIES a field (29.09.2026): «leeren», never «löschen» — «löschen» is the delete
  // verb (records are «gelöscht», removalWords.test), and this ✕ deletes nothing. ONE key for the
  // bare word, one for the search, one template for a named field («Bemerkung leeren»); the
  // four «Suche löschen» copies (help/anwesenheit/mittel/top) are gone.
  clear: 'Leeren',
  clearSearch: 'Suche leeren',
  clearField: '{field} leeren',
  // THE «no hits» line (29.09.2026) — says what was searched; a list keeps a noun of its own only
  // where the noun helps («Kein Trupp gefunden»). Drawn as `.no-hits` (13-incident.css).
  noHits: 'Keine Treffer für «{q}».',
  savedLive: 'Alles wird laufend gespeichert.',
} as const
