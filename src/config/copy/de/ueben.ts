// German copy · «Üben», the drills on the private practice Einsatz (lib/ueben, components/ueben).
// One slice of the canonical `de` catalogue, assembled in ../de.ts — read the rules at the
// top of that file before adding or renaming a key here.

export const uebenCopy = {
  // Owner picks 19.11.2026 (docs/planning, gitignored): one drill per function, on a practice
  // Einsatz that stays on this device. A drill is a concrete problem with goals that tick live;
  // «Zeigen» shows the next control, then the gesture, then «Lösung» does it.
  ueben: {
    /** the menu row (both menus) and the sheet's title */
    menu: 'Üben',
    sheetLead: 'Auf einem Übungsplatz nur auf diesem Gerät. Nichts geht an den Einsatz.',
    next: 'Als Nächstes',
    nextGo: 'Starten',
    allDrills: 'Alle Übungen',
    doneCount: '{n} von {total} geschafft',
    soon: 'bald',
    doneMark: 'Geschafft',
    // the card
    kicker: '{module} · {i} / {n}',
    show: 'Zeigen',
    showMore: 'Mehr zeigen',
    solve: 'Lösung',
    hideHint: 'Ausblenden',
    more: 'Mehr',
    restart: 'Neu beginnen',
    leave: 'Übung verlassen',
    // the done card
    doneTitle: 'Geschafft',
    doneSolved: 'Mit der Lösung gemacht – zum Üben einfach nochmals.',
    doneNext: 'Nächste Übung',
    doneAgain: 'Nochmals',
    doneList: 'Alle Übungen',
    // no drill running: the practice Einsatz on its own
    idleTitle: 'Übungsplatz',
    idleText: 'Nur auf diesem Gerät – kein anderes Gerät und keine Einsatzliste sieht ihn.',
    idlePick: 'Übung wählen',
    // «Neu beginnen» asks first
    restartTitle: 'Übungsplatz neu beginnen?',
    restartMessage: 'Karte, Verlauf, Trupps und Rapport des Übungsplatzes werden gelöscht. Echte Einsätze sind nicht betroffen.',
    restartConfirm: 'Neu beginnen',
    // the head pill's sync word on the practice Einsatz: nothing is synchronised, by design
    localOnly: 'Nur auf diesem Gerät',
    siteMissing: '{name} fehlt auf der Karte – «Neu beginnen» stellt den Übungsplatz wieder her',
    site: { hydrant: 'H1', eingang: 'Eingang' },
    modules: {
      karteWasser: 'Karte & Wasser',
      atemschutzGebaeude: 'Atemschutz & Gebäude',
      protokollAbschluss: 'Protokoll & Abschluss',
    },
    // the intro card's button – before the task, once per start from the sheet
    introGo: 'Los',
    // every drill's title; `intro`, `task` and `goals` only where the drill can be run already
    drills: {
      fahrzeugLeitung: {
        title: 'Fahrzeug mit Leitung',
        // what is practised and why (owner, round 2, 19.11.2026: an intro card first)
        intro: 'Eine Leitung mit Pfeil zeigt auf der Karte, woher das Wasser kommt und wohin es fliesst. Du stellst ein TLF neben einen Hydranten und legst die Leitung vom TLF bis zum Eingang.',
        task: 'Stell das TLF neben den Hydranten H1 und zieh eine Leitung mit Pfeil vom TLF bis zum Eingang.',
        // goals are TARGETS, not statements: a red one must not read «TLF steht neben …» over «… auf dem Hydranten»
        goals: { tlf: 'TLF neben dem Hydranten H1', leitung: 'Leitung mit Pfeil vom TLF zum Eingang' },
        tlfFar: 'TLF steht {m} m von H1 – zu weit für den Schlauch zum Hydranten',
        tlfOnTop: 'TLF steht auf dem Hydranten – stell es daneben',
        vehicleFar: 'Fahrzeug steht {m} m von H1 – und heisst noch nicht «TLF»',
        startFar: 'Leitung beginnt {m} m vom TLF',
        endFar: 'Leitung endet {m} m vor dem Eingang',
        noArrow: 'Pfeil fehlt – er zeigt, wohin das Wasser fliesst',
        arrowBack: 'Pfeil zeigt zum TLF – das Wasser fliesst zum Eingang',
        hint: {
          karte: 'Zur Karte',
          addPhone: 'Hinzufügen › Fahrzeug, dann neben H1 tippen',
          addTablet: 'Symbol › Fahrzeug, dann neben H1 tippen',
          pick: 'Fahrzeug wählen',
          tapBeside: 'Neben H1 tippen',
          tapVehicle: 'Fahrzeug antippen',
          name: 'Bezeichnung: TLF',
          drag: 'TLF neben H1 ziehen',
          linePhone: 'Hinzufügen › Linie, dann vom TLF zum Eingang ziehen',
          lineTablet: 'Linie, dann vom TLF zum Eingang ziehen',
          linePick: 'Linie wählen',
          lineDraw: 'Am TLF ansetzen, bis zum Eingang ziehen',
          lineFix: 'Neue Linie vom TLF bis zum Eingang ziehen',
          lineTap: 'Leitung antippen',
          arrow: 'Linienende: Pfeil',
          reverse: 'Richtung umkehren',
        },
      },
      absperrkreis: { title: 'Absperrkreis' },
      messen: { title: 'Messen' },
      leitungRechnen: { title: 'Leitung rechnen' },
      pumpenVerschieben: { title: 'Pumpen verschieben' },
      truppAnmelden: { title: 'Trupp anmelden' },
      funkkontakt: { title: 'Funkkontakt & Druck' },
      rueckzug: { title: 'Rückzug' },
      notfall: { title: 'Atemschutznotfall' },
      truppGeschoss: { title: 'Trupp im Geschoss' },
      gefahrUg: { title: 'Gefahr im UG' },
      eintrag: { title: 'Eintrag' },
      pendenz: { title: 'Pendenz' },
      checkliste: { title: 'Checkliste' },
      anwesenheit: { title: 'Anwesenheit' },
      material: { title: 'Material' },
      fehlalarm: { title: 'Fehlalarm abschliessen' },
    },
  },
} as const
