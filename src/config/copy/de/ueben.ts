// German copy · «Üben», the topics and their steps on the private practice Einsatz (lib/ueben,
// components/ueben). One slice of the canonical `de` catalogue, assembled in ../de.ts — read the
// rules at the top of that file before adding or renaming a key here.

export const uebenCopy = {
  // Owner picks 19.11.2026 (docs/planning, gitignored): practice on an Einsatz that stays on this
  // device. A task is a concrete problem with goals that tick live; «Zeigen» shows the next
  // control, then the gesture, then «Lösung» does it.
  // 20.11.2026: a short list of TOPICS, each a chain of short steps that build on each other;
  // coverage = what an Einsatz needs, the rest is named on the topic's closing card. Every other
  // function is tried on the Übungsplatz without a task («Ausprobieren» in the Hilfe).
  ueben: {
    /** the menu row (both menus) and the sheet's title */
    menu: 'Üben',
    sheetLead: 'Auf einem Übungsplatz nur auf diesem Gerät. Nichts geht an den Einsatz.',
    next: 'Als Nächstes',
    nextGo: 'Starten',
    allDrills: 'Alle Übungen',
    // a topic's row on the sheet: how far it stands on this device
    stepCount: '{n} / {total}',
    steps: '{total} kurze Schritte',
    nextStep: 'Weiter mit «{step}»',
    doneMark: 'Geschafft',
    // the sheet's last row: the Übungsplatz without a task
    free: 'Frei üben',
    freeSub: 'Übungsplatz ohne Aufgabe – alles ausprobieren',
    /** the button in a Hilfe section: opens the Übungsplatz on that section's surface */
    tryOut: 'Auf dem Übungsplatz ausprobieren',
    // the card
    kicker: '{topic} · {i} / {n}',
    show: 'Zeigen',
    showMore: 'Mehr zeigen',
    solve: 'Lösung',
    hideHint: 'Ausblenden',
    // «Zeigen» while a sheet lies over the next control: the ring stands on that sheet's ✕
    closeFirst: 'Zuerst schliessen',
    more: 'Mehr',
    restart: 'Neu beginnen',
    leave: 'Übung verlassen',
    // the done card of a step, and the closing card of a topic
    doneSolved: 'Mit der Lösung gemacht – zum Üben einfach nochmals.',
    doneNext: 'Weiter',
    doneAgain: 'Nochmals',
    doneList: 'Alle Übungen',
    endTitle: '{topic} geschafft',
    moreTitle: 'Was es sonst noch gibt',
    // no task running: the practice Einsatz on its own
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
    // the topic's intro card's button – before the first task, on a start from the sheet
    introGo: 'Los',
    // one entry per topic of lib/ueben/catalogue · TOPICS; `steps` holds one entry per step
    topics: {
      karte: {
        title: 'Karte & Zeichnen',
        // what is practised and why (owner, round 2, 19.11.2026: an intro card first)
        intro: 'Ein Fahrzeug, seine Leitungen und ihre Verbindungen: das Zeichnen auf der Karte in sechs kurzen Schritten. Jeder Schritt baut auf dem vorherigen auf.',
        // the closing card: what the topic did not practise (owner pick, 20.11.2026: shown, not practised)
        more: [
          'Linienende: Pfeil mit Stopp (Entwicklungsgrenze) und Teilstück (die Leitung teilt sich)',
          'Linienart: gestrichelt, Haltelinie, Wasserabwurfzone – dazu Farbe, Stärke und Text',
          'An der Leitung: Person, Trupp, Geschoss und Inhalt',
          'Am Symbol: Name, Drehung, Anzahl und Geschoss',
          'Weitere Werkzeuge: Fläche, Absperrkreis, Notiz, Messen und Mehrfach-Auswahl',
          'Sperren: nichts verschiebt sich mehr aus Versehen',
        ],
        // «Zeigen»'s words every step of the topic shares
        hint: {
          karte: 'Zur Karte',
          linePhone: 'Hinzufügen › Linie',
          lineTablet: 'Linie',
          linePick: 'Linie wählen',
          lineTap: 'Leitung antippen',
        },
        steps: {
          fahrzeug: {
            title: 'Fahrzeug setzen',
            task: 'Stell ein Fahrzeug zum Hydranten H1.',
            // goals are TARGETS, not statements: a red one must not read «Fahrzeug steht beim …» over «… zu weit weg»
            goals: { fahrzeug: 'Fahrzeug beim Hydranten H1' },
            // what the done card says the step taught
            learned: 'So setzt du jedes Symbol: Symbol wählen, auf die Karte tippen. Ziehen verschiebt es.',
            far: 'Fahrzeug steht {m} m von H1 – zieh es näher zum Hydranten',
            hint: {
              addPhone: 'Hinzufügen › Fahrzeug, dann neben H1 tippen',
              addTablet: 'Symbol › Fahrzeug, dann neben H1 tippen',
              pick: 'Fahrzeug wählen',
              tapBeside: 'Neben H1 tippen',
              drag: 'Fahrzeug zu H1 ziehen',
            },
          },
          leitung: {
            title: 'Leitung mit Pfeil',
            task: 'Zieh eine Leitung vom Fahrzeug bis zum Eingang und gib ihr einen Pfeil.',
            goals: { leitung: 'Leitung mit Pfeil vom Fahrzeug zum Eingang' },
            learned: 'Der Pfeil zeigt, wohin das Wasser fliesst. «Richtung umkehren» dreht ihn, ohne neu zu zeichnen.',
            startFar: 'Leitung beginnt {m} m vom Fahrzeug',
            endFar: 'Leitung endet {m} m vor dem Eingang',
            noArrow: 'Pfeil fehlt – er zeigt, wohin das Wasser fliesst',
            arrowBack: 'Pfeil zeigt zum Fahrzeug – das Wasser fliesst zum Eingang',
            hint: {
              draw: 'Am Fahrzeug ansetzen, bis zum Eingang ziehen',
              fix: 'Neue Linie vom Fahrzeug bis zum Eingang ziehen',
              arrow: 'Linienende: Pfeil',
              reverse: 'Richtung umkehren',
            },
          },
          verbinden: {
            title: 'Verbinden',
            task: 'Zieh eine zweite Leitung vom Hydranten H1 zum Fahrzeug und halte am Fahrzeug an, bis der blaue Ring voll ist. Verschieb danach das Fahrzeug.',
            goals: { zubringer: 'Leitung hängt an H1 und am Fahrzeug', mitziehen: 'Fahrzeug verschoben – die Leitungen kommen mit' },
            learned: 'Eine verbundene Leitung wandert mit ihrem Fahrzeug mit. Auf dem Symbol ansetzen verbindet sofort, am Ende braucht es den vollen Ring.',
            looseVehicle: 'Die Leitung hängt nicht am Fahrzeug – neu ziehen und am Fahrzeug halten, bis der Ring voll ist',
            looseH1: 'Die Leitung hängt nicht am Hydranten – neu ziehen und direkt auf H1 ansetzen',
            hint: {
              draw: 'Auf H1 ansetzen, zum Fahrzeug ziehen und dort halten, bis der Ring voll ist',
              close: 'Leitung schliessen',
              move: 'Fahrzeug antippen, dann ziehen',
            },
          },
          beschriften: {
            title: 'Leitung beschriften',
            task: 'Gib der Leitung zum Eingang eine Nummer und einen Schlauch.',
            goals: { nummer: 'Leitung hat eine Nummer', schlauch: 'Schlauch gewählt' },
            learned: 'Nummer und Schlauch stehen auf der Karte am Ende der Leitung. Im selben Blatt: Person, Trupp, Geschoss und Text.',
            hint: {
              nummer: 'Leitung Nr.: +',
              schlauch: 'Schlauch wählen',
            },
          },
          punkte: {
            title: 'Punkte',
            task: 'Füg der Leitung zum Eingang einen Punkt ein. Entfern danach einen Punkt.',
            goals: { einfuegen: 'Punkt eingefügt', entfernen: 'Punkt entfernt' },
            learned: 'Mit Punkten führst du eine Leitung um ein Hindernis: «+» fügt einen ein, ziehen verschiebt ihn, gedrückt halten entfernt ihn.',
            hint: {
              plus: '+ antippen: ein neuer Punkt',
              hold: 'Punkt gedrückt halten, bis der Ring voll ist',
            },
          },
          loesen: {
            title: 'Lösen und entfernen',
            task: 'Lös eine Leitung vom Fahrzeug. Entfern sie danach und hol sie mit «Rückgängig» zurück.',
            goals: { geloest: 'Verbindung gelöst', geloescht: 'Leitung entfernt', zurueck: 'Mit «Rückgängig» zurückgeholt' },
            learned: '«Rückgängig» nimmt jeden Schritt zurück – auf der Karte, bei den Trupps und in der Anwesenheit.',
            hint: {
              detach: 'Verbindung lösen',
              remove: 'Entfernen',
              undo: 'Rückgängig',
            },
          },
        },
      },
    },
  },
} as const
