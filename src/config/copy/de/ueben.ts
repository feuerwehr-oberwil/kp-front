// German copy · «Üben», the drills on the private practice Einsatz (lib/ueben, components/ueben).
// One slice of the canonical `de` catalogue, assembled in ../de.ts — read the rules at the
// top of that file before adding or renaming a key here.

export const uebenCopy = {
  // Owner picks 19.11.2026 (docs/planning, gitignored): one drill per function, on a practice
  // Einsatz that stays on this device. A drill is a concrete problem with goals that tick live;
  // «Zeigen» shows the next control, then the gesture, then «Lösung» does it.
  // 20.11.2026: a few core drills in ONE list (no modules), lenient checks, and every other
  // function is tried on the Übungsplatz without a drill («Ausprobieren» in the Hilfe).
  ueben: {
    /** the menu row (both menus) and the sheet's title */
    menu: 'Üben',
    sheetLead: 'Auf einem Übungsplatz nur auf diesem Gerät. Nichts geht an den Einsatz.',
    next: 'Als Nächstes',
    nextGo: 'Starten',
    allDrills: 'Alle Übungen',
    doneCount: '{n} von {total} geschafft',
    doneMark: 'Geschafft',
    // the sheet's last row: the Übungsplatz without a drill
    free: 'Frei üben',
    freeSub: 'Übungsplatz ohne Aufgabe – alles ausprobieren',
    /** the button in a Hilfe section: opens the Übungsplatz on that section's surface */
    tryOut: 'Auf dem Übungsplatz ausprobieren',
    // the card
    kicker: 'Üben · {i} / {n}',
    show: 'Zeigen',
    showMore: 'Mehr zeigen',
    solve: 'Lösung',
    hideHint: 'Ausblenden',
    // «Zeigen» while a sheet lies over the next control: the ring stands on that sheet's ✕
    closeFirst: 'Zuerst schliessen',
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
    // the intro card's button – before the task, once per start from the sheet
    introGo: 'Los',
    // one entry per drill of lib/ueben/catalogue · DRILLS
    drills: {
      fahrzeugLeitung: {
        title: 'Fahrzeug mit Leitung',
        // what is practised and why (owner, round 2, 19.11.2026: an intro card first)
        intro: 'Eine Leitung mit Pfeil zeigt auf der Karte, woher das Wasser kommt und wohin es fliesst. Du stellst ein Fahrzeug zu einem Hydranten und legst die Leitung vom Fahrzeug bis zum Eingang.',
        task: 'Stell ein Fahrzeug zum Hydranten H1 und zieh eine Leitung mit Pfeil vom Fahrzeug bis zum Eingang.',
        // goals are TARGETS, not statements: a red one must not read «Fahrzeug steht beim …» over «… zu weit weg»
        goals: { fahrzeug: 'Fahrzeug beim Hydranten H1', leitung: 'Leitung mit Pfeil vom Fahrzeug zum Eingang' },
        far: 'Fahrzeug steht {m} m von H1 – zieh es näher zum Hydranten',
        startFar: 'Leitung beginnt {m} m vom Fahrzeug',
        endFar: 'Leitung endet {m} m vor dem Eingang',
        noArrow: 'Pfeil fehlt – er zeigt, wohin das Wasser fliesst',
        arrowBack: 'Pfeil zeigt zum Fahrzeug – das Wasser fliesst zum Eingang',
        hint: {
          karte: 'Zur Karte',
          addPhone: 'Hinzufügen › Fahrzeug, dann neben H1 tippen',
          addTablet: 'Symbol › Fahrzeug, dann neben H1 tippen',
          pick: 'Fahrzeug wählen',
          tapBeside: 'Neben H1 tippen',
          drag: 'Fahrzeug zu H1 ziehen',
          linePhone: 'Hinzufügen › Linie, dann vom Fahrzeug zum Eingang ziehen',
          lineTablet: 'Linie, dann vom Fahrzeug zum Eingang ziehen',
          linePick: 'Linie wählen',
          lineDraw: 'Am Fahrzeug ansetzen, bis zum Eingang ziehen',
          lineFix: 'Neue Linie vom Fahrzeug bis zum Eingang ziehen',
          lineTap: 'Leitung antippen',
          arrow: 'Linienende: Pfeil',
          reverse: 'Richtung umkehren',
        },
      },
    },
  },
} as const
