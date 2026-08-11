// German (de-CH) — the canonical locale and the source of the `Copy` type.
//
// This is the full user-facing string catalogue (was inlined as `appConfig.copy`).
// Every other locale (see ./en, ./fr, ./it) is a DeepPartial<Copy> deep-merged over
// this one, so a missing key anywhere falls back to the German string here. When you
// add or rename a UI string, add it HERE first — it defines the shape all locales share.
//
// Read strings LATE: `appConfig.copy` is a getter that resolves the active locale, so a
// module-level capture like `const C = appConfig.copy.journal` freezes the language at
// import time. Always read `appConfig.copy.x.y` inside the component/function body.
//
// Domain language is German (Lage, Atemschutz, Trupp, …); keep these terms accurate.

// Help overlay content model (authored as data so it bundles offline, no markdown dep).
// Inline markup in `lead`/`sub`/list items: **bold** for emphasis, [[Key]] for keyboard chips.
export type HelpBlock =
  | { kind: 'intro' } // the per-station helpIntro (or introFallback)
  | { kind: 'lead'; text: string }
  | { kind: 'sub'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'list'; items: string[] }
export interface HelpSection { id: string; title: string; icon: string; blocks: HelpBlock[] }

export const de = {
  loadingSubtitle: 'Lade Karte & Symbolbibliothek ...',
  modes: { map: 'Lage', plans: 'Plan', checklists: 'Checkliste', atemschutz: 'Atemschutz', anwesenheit: 'Anwesenheit', mittel: 'Mittel', rapport: 'Rapport' },
  // the left navigation rail (Karte · Pläne group · Checkliste · Atemschutz)
  // (no «Objekt wählen» any more: the rail is pure navigation, the object sits on the
  //  plan surface – see whiteboard.objectLabel)
  navRail: { map: 'Karte', plansGroup: 'Pläne', assign: 'Plan zuweisen', expand: 'Ausklappen', collapse: 'Einklappen', resize: 'Leiste anpassen', scrollMore: 'Weitere anzeigen' },
  panels: { layers: 'Ebenen', history: 'Verlauf' },
  // LayerPanel: the toggle aria-label appends one of these state words after the layer name
  layerPanel: {
    stateVisible: 'sichtbar, ausblenden',
    stateHidden: 'ausgeblendet, einblenden',
  },
  help: {
    menu: 'Funktionen & Hilfe',
    title: 'Was kann KP Front?',
    subtitle: 'Alle Funktionen auf einen Blick – gebaut, um auch um 3 Uhr morgens ohne Übung bedienbar zu sein.',
    contents: 'Inhalt',
    close: 'Schliessen',
    // The help is long and gets opened during an Einsatz with a concrete question, not to be
    // read — the search filters the table of contents AND the sections (on a phone there is no
    // table of contents, so filtering the sections is the whole search there).
    search: 'Hilfe durchsuchen …',
    searchClear: 'Suche löschen',
    searchNone: 'Keine Treffer für «{q}».',
    searchHint: 'Anderes Stichwort versuchen – gesucht wird in Überschriften und Text.',
    // Fallback intro when the station has not configured a helpIntro of its own.
    introFallback: 'KP Front ist die digitale Lage- und Einsatzführung deiner Feuerwehr: taktische Lagekarte, Objektpläne, Atemschutzüberwachung und ein gemeinsames Verlaufsprotokoll – alles live auf mehreren Geräten gleichzeitig.',
    // Content of the help sections. Inline markup: **bold** for emphasis, [[Taste]] for
    // keyboard chips. blocks: lead/sub/list/note are rendered in HelpOverlay.
    sections: [
      {
        id: 'ueberblick', title: 'Überblick', icon: 'info',
        blocks: [
          { kind: 'intro' },
          { kind: 'sub', text: 'Die Arbeitsbereiche (linke Leiste)' },
          { kind: 'list', items: [
            '**Lage** – die taktische Karte mit Symbolen, Linien, Flächen und den Werkleitungs-Ebenen.',
            '**Plan** – die Objektpläne dieser Wehr (Module, Gebäudeumrisse) als Whiteboard, stockwerkweise.',
            '**Checkliste** – abarbeitbare Einsatz-Checklisten.',
            '**Atemschutz** – Überwachung der eingesetzten Trupps mit Zeit und Druck.',
            '**Personal** – wer im Einsatz ist, mit Zeiten und Bemerkung; auch Gäste («Weitere Person»).',
            '**Material** – was eingesetzt wurde, aus dem Katalog oder frei erfasst.',
            '**Rapport** – der Einsatzrapport: ein vorausgefülltes Formular, das über den ganzen Einsatz hinweg ergänzt und am Schluss gedruckt wird.',
          ] },
          { kind: 'note', text: 'Leitgedanke: bedienbar um 3 Uhr morgens, nach einem halben Jahr ohne Übung. Wiedererkennen statt auswendig lernen, mit Handschuhen und offline nutzbar.' },
        ],
      },
      {
        id: 'navigation', title: 'Navigation & Oberfläche', icon: 'cursor',
        blocks: [
          { kind: 'lead', text: 'Drei feste Zonen: die Bereichsleiste links, die Einsatzleiste oben, die Werkzeugleiste rechts.' },
          { kind: 'sub', text: 'Linke Leiste' },
          { kind: 'list', items: [
            'Wechselt den Arbeitsbereich: **Karte** (Lage), die **Pläne** (Module/Gebäude), **Checkliste**, **Atemschutz**, **Personal**, **Material**, **Rapport**. Auf jedem Knopf steht sein Buchstabe – der erste des deutschen Worts.',
            'Im Lage-Modus sind **Ebenen** und der **Karten**-Umschalter unten angeheftet – immer sichtbar.',
            'Am rechten Rand der Leiste ziehen klappt sie mit Beschriftungen auf bzw. wieder zu.',
          ] },
          { kind: 'sub', text: 'Obere Einsatzleiste' },
          { kind: 'list', items: [
            'Links der Einsatz-Name mit dem **Menü** (Einsatz abschliessen, Einsatz wechseln, Einstellungen, Offline-Bereitschaft, diese Hilfe …) und der **Einsatzuhr**.',
            'Rechts **Rückgängig/Wiederholen**, **Verlauf** und **+ Eintrag**.',
          ] },
          { kind: 'sub', text: 'Rechte Werkzeugleiste' },
          { kind: 'list', items: [
            'Die Zeichen- und Platzierwerkzeuge; unten angeheftet die Karten-Navigation (Zoom, Einpassen, Koordinaten).',
          ] },
        ],
      },
      {
        id: 'tastatur', title: 'Tastaturkürzel', icon: 'type',
        blocks: [
          { kind: 'lead', text: 'Wer mit Tastatur arbeitet, erreicht alles ohne Maus. Kürzel wirken nicht, während in einem Textfeld getippt wird. Wo ein Feld in der linken Leiste eine Taste hat, steht sie darauf.' },
          { kind: 'sub', text: 'Bereiche wechseln' },
          { kind: 'list', items: [
            'Zahlen öffnen das Plan-Modul mit dieser Nummer – welche es gibt, richtet sich nach den Modulen dieser Wehr: [[1]] Modul 1, [[2]] oder [[3]] das Modul «2/3», [[4]] Modul 4 …',
            '[[K]] Karte · [[C]] Checkliste · [[A]] Atemschutz · [[P]] Personal · [[M]] Material · [[R]] Rapport – jeweils der erste Buchstabe des Bereichs.',
            '[[⌘]] [[[]] / [[⌘]] []]] blättert Schritt für Schritt durch alle Bereiche (auch Umgebung und Gebäude, die keine Nummer haben).',
          ] },
          { kind: 'sub', text: 'Werkzeuge (Lage & Plan gleich)' },
          { kind: 'list', items: [
            '[[V]] Auswahl · [[W]] Mehrfach wählen · [[S]] Symbol · [[L]] Linie · [[F]] Fläche · [[U]] Umkreis · [[N]] Notiz · [[T]] Trupp · [[D]] Messen.',
          ] },
          { kind: 'sub', text: 'Bearbeiten' },
          { kind: 'list', items: [
            '[[⌘]] [[Z]] Rückgängig · [[⌘]] [[⇧]] [[Z]] Wiederholen · [[⌘]] [[D]] Duplizieren.',
            '[[Esc]] schliesst der Reihe nach: Werkzeug → offenes Panel → Auswahl. [[⌫]] löscht die Auswahl.',
          ] },
          { kind: 'sub', text: 'Ansicht & Panels' },
          { kind: 'list', items: [
            '[[+]] / [[−]] Zoom · [[0]] Einpassen · [[G]] Mein Standort · [[X]] Koordinaten-Format. «Nach Norden» hat keine Taste – dafür ist der Kompass da, der immer sichtbar ist und mitdreht.',
            '[[J]] Verlauf · [[E]] Eintrag · [[B]] Ebenen · [[O]] Objekt wählen · [[⌘]] [[,]] Einstellungen · [[?]] diese Hilfe.',
          ] },
        ],
      },
      {
        id: 'lage', title: 'Lage – Karte', icon: 'map',
        blocks: [
          { kind: 'lead', text: 'Die taktische Karte über dem realen Kartenhintergrund (Einsatzgebiet und Umgebung).' },
          { kind: 'list', items: [
            '**Basiskarte** (zuoberst im Ebenen-Panel) wechselt den Hintergrund: Carto, OpenStreetMap oder Satellit.',
            '**Vergrössern/Verkleinern**, **Einpassen** und **Koordinaten abgreifen** in der rechten Leiste unten. Beim Abgreifen auf die Karte tippen, um einen Punkt (LV95 + WGS84) festzuhalten; der Kompass richtet wieder nach Norden aus.',
            '**Wind** wird laufend angezeigt (Richtung + Temperatur), damit die Ausbreitungsrichtung sofort ersichtlich ist.',
            '**Fahrzeuge/Mittel** erscheinen live per GPS (Name + Ausrichtung), die eigene Position als ruhiger blauer Punkt.',
          ] },
        ],
      },
      {
        id: 'ebenen', title: 'Ebenen & Daten', icon: 'layers',
        blocks: [
          { kind: 'lead', text: 'Über **Ebenen** blendest du die Werkleitungs- und Gefahren-Daten ein – geordnet nach Typ.' },
          { kind: 'list', items: [
            '**Lage** – Taktische Zeichen, Fahrzeuge, Skizzen & Notizen.',
            'Welche Ebenen es gibt, hängt an den Geodaten dieser Wehr – nichts davon ist mitgeliefert. Üblich sind:',
            '**Abwasser** – Schmutz/Misch, Regen/Rein, Schächte / Gully.',
            '**Gas** – Leitungen.',
            '**Strom** – Leitungen, PV-Anlagen.',
            '**Gefahren** – Hochwasser, Überschwemmungstiefe.',
          ] },
          { kind: 'lead', text: 'Jede Ebene lässt sich ein-/ausblenden und in der Deckkraft regeln.' },
          { kind: 'list', items: [
            '**Karte offline laden** (im Ebenen-Bereich) lädt Kartenkacheln, Pläne, Symbole und Geodaten für den Einsatzort vor.',
          ] },
          { kind: 'note', text: 'Die Werkleitungsdaten decken das konfigurierte Einsatzgebiet ab und sind lokal verfügbar – sie funktionieren auch offline.' },
        ],
      },
      {
        id: 'zeichnen', title: 'Zeichnen & Symbole', icon: 'pen',
        blocks: [
          { kind: 'lead', text: 'Werkzeuge der rechten Leiste im Lage-Modus.' },
          { kind: 'list', items: [
            '**Symbol** – das taktische Zeichen (FKS/VKF). Schnellwahl der häufigsten Zeichen oder Suche in der ganzen Bibliothek. Tippen platziert; mit dem Schloss mehrere nacheinander setzen.',
            '**Auswahl** – Objekte antippen, verschieben, im Editor anpassen.',
            '**Mehrfach** – Lasso: mehrere Symbole/Zeichnungen auf einmal auswählen.',
            '**Linie** – ziehen oder Punkte tippen; der Stil wird danach im Editor gewählt: **Freihand**, **Pfeil** oder **Rettungsachse**.',
            '**Fläche** – Eckpunkte tippen (ab 3 Punkten mit Flächeninhalt); Eckpunkte ziehen/einfügen/löschen.',
            '**Absperrkreis** – von der Mitte zum Rand ziehen setzt den Radius in Metern (Füllung einstellbar).',
            '**Notiz** – freier Text direkt auf die Karte.',
            '**Messen** – Strecke (Distanz + Höhenprofil) oder Fläche (Inhalt + Umfang). Punkte ziehen verschiebt, Tippen auf die Linie setzt Zwischenpunkte, Rechtsklick entfernt einen Punkt.',
          ] },
          { kind: 'sub', text: 'Symbol-Voreinstellungen' },
          { kind: 'lead', text: 'Jedes Symbol bringt nur die sinnvollen Regler mit: **Drehung** bei gerichteten Zeichen (Pfeile, Leitern, Wände), **Anzahl** wo mehrere zählen, **Stockwerk** bzw. ein **Stockwerk-Bereich** (z. B. Treppe/Lift), **Ausbreitung** bei Schadenlagen – plus passende Eingabefelder (z. B. Name, Stoff, Status).' },
        ],
      },
      {
        id: 'plan', title: 'Plan – Module & Gebäude', icon: 'doc',
        blocks: [
          { kind: 'lead', text: 'Pro Objekt ein Whiteboard über den Modul-/Gebäudeplänen. Stockwerkweise, mit eigenen Werkzeugen.' },
          { kind: 'list', items: [
            'Unten links, neben dem Massstab, steht die **Adresse** des geladenen Objekts – antippen wählt ein anderes ([[O]]). Das Objekt bestimmt die Pläne in der linken Leiste.',
            '**Symbol**, **Auswahl**, **Zeichnen** (Farbe/Stärke/Linienart), **Notiz** (Text), **Trupp**.',
            '**Stockwerke** als Stapel: mit den **OG/UG**-Knöpfen am Plan ein Geschoss darüber/darunter hinzufügen.',
            '**Zoom/Einpassen** unten in der Werkzeugleiste, wie auf der Karte.',
            '**Trupps** als farbige Marker; **Spuren** ein-/ausblenden zeigt ihren Weg. Trupp-Chips, deren Trupp „raus" ist, werden ausgegraut/durchgestrichen.',
            '**Massstab** – die zwei Endpunkte des gedruckten Massstabsbalken antippen und die reale Länge eingeben. Danach zeigen Linien mit «Länge» und das **Messen** echte Meter.',
          ] },
          { kind: 'note', text: 'Die **Gebäudeumrisse** kommen live von OpenStreetMap. **Modul 6** (Geschosspläne) ist standardmässig ein reiner Blätter-/Zoom-Betrachter – annotiert wird auf dem Gebäude-Stockwerkstapel, nicht auf dem Modul-6-PDF. Ob ein Modul Betrachter ist, steht in der Modul-Konfiguration dieser Wehr.' },
        ],
      },
      {
        id: 'atemschutz', title: 'Atemschutzüberwachung', icon: 'gauge',
        blocks: [
          { kind: 'lead', text: 'Lückenlose Überwachung jedes Atemschutztrupps nach FKS – das Sicherheitssignal ist die **Zeit seit dem letzten Funkkontakt**, nicht eine geschätzte Restzeit.' },
          { kind: 'sub', text: 'Trupp anlegen' },
          { kind: 'list', items: [
            '**Wer geht rein**: drei Slots, der oberste ist der **GF** – die ganze Zeile antippen macht jemanden zum Gruppenführer, das **✕** entfernt ihn. Ein grösserer Trupp hängt einfach weitere Zeilen an.',
            'Über die **Personensuche** wird die ganze Mannschaft gefunden, nicht nur die Anwesenden; neben jedem Namen steht, was dagegen spricht (nicht anwesend, Magazin, schon in einem Trupp). **(+)** erfasst einen Gast (Nachbarwehr) – der landet zugleich in der Anwesenheit und gilt dort als derselbe Mensch.',
            '**Eingangsdruck** (bar) und **Funkkanal** stehen rechts daneben.',
            'Darunter der **Auftrag**: Art (Retten · Löschen · Absuchen · Sichern · Erkunden · Anderes), **Ziel / Ort** in Klartext, **Leitung Nr.** (die bereits gezeichneten Leitungen stehen als Schnellwahl daneben) und die **Farbe** auf Lage und Plan.',
            'Der Auftrag hält niemanden auf: **Trupp anmelden** geht auch ohne ihn. Die Karte trägt dann **«Auftrag offen»**, und ein Tipp darauf öffnet das Formular.',
            'Getippte Angaben bleiben erhalten, wenn das Fenster mit **✕** oder per Klick daneben geschlossen wird – nur **Abbrechen** verwirft sie.',
          ] },
          { kind: 'sub', text: 'Überwachung pro Trupp' },
          { kind: 'list', items: [
            'Gross die Uhr **Seit letztem Kontakt**: grün **Kontakt ok** → nach {contactMin} min gelb **Kontakt fällig** → nach weiteren {graceSec} s rot **Überfällig** mit Alarm. Beide Werte gelten für diese Wehr und stehen in den Einsatz-Einstellungen ([[⌘]] [[,]]).',
            '**Kontakt** (grosser Knopf) bestätigt den Funkkontakt und stellt die Uhr zurück.',
            '**Druck** direkt mit ± einstellen und mit **Bestätigen** übernehmen – das zählt als Kontakt und wird protokolliert; ein Fehlklick ohne Bestätigen ändert nichts. Niedriger Druck wird rot.',
            'Status **Angemeldet → Im Einsatz → Rückzug → Draussen**. **Rückzug** lässt sich mit **Fortsetzen** widerrufen; ein draussener Trupp geht mit **Wieder einrücken** (neue Flasche) zurück in die Überwachung.',
            '**Verlauf** je Trupp (ausklappbar) zeigt jeden Kontakt mit Uhrzeit und Druck.',
            '**Bearbeiten** (Stift) passt Auftrag, Ziel/Stockwerk oder Trupp mitten im Einsatz an.',
            'Wer unter AS ist, lässt sich in der **Anwesenheit** nicht abmelden – ein Tipp auf die Zeile springt stattdessen auf die Karte dieses Trupps und hebt sie kurz hervor.',
            'Überfällige Trupps rücken nach oben, oben erscheint ein Zähler; der **Alarmton** ist pro Gerät stummschaltbar (Glocke). Alles landet im Verlauf.',
            'Jeder Trupp lässt sich auf dem Plan platzieren (Knopf „auf Plan zeigen").',
          ] },
        ],
      },
      {
        id: 'checkliste', title: 'Checkliste', icon: 'check',
        blocks: [
          { kind: 'lead', text: 'Zwei Spalten: abarbeitbare Aufgaben und ein durchsuchbares Taktik-Nachschlagewerk.' },
          { kind: 'list', items: [
            '**Aufgaben** – Einsatz-Checklisten (z. B. FU, Lagerapport) mit Fortschrittsanzeige; Punkte abhaken, Verzweigungen folgen mehrstufigen Abläufen.',
            '**Taktik · Stichworte** – Stichwort suchen und den passenden Eintrag öffnen (mit Gefahren-Farbcode und Skizzen).',
            'Bei einem übernommenen Alarm wird automatisch ein passendes Stichwort vorgeschlagen.',
          ] },
          { kind: 'lead', text: 'Der Stand bleibt erhalten und wird auf alle Geräte synchronisiert.' },
        ],
      },
      {
        id: 'verlauf', title: 'Verlauf & Eintrag', icon: 'history',
        blocks: [
          { kind: 'lead', text: 'Ein gemeinsames, fortlaufendes Protokoll über Lage und Plan – die Einsatz-Chronik.' },
          { kind: 'list', items: [
            '**+ Eintrag** (oben rechts): kurz tippen öffnet die Texteingabe; **gedrückt halten** nimmt eine **Sprachnotiz** auf. Fotos lassen sich ebenfalls anhängen.',
            'Ab **zwei Buchstaben** werden Namen vorgeschlagen – Mannschaft, Material, Partnerorganisationen, Fahrzeuge und Alarmgruppen. Angetippt wird der ganze Name eingesetzt; im Verlauf und auf dem gedruckten Rapport ist er hervorgehoben. Ein eigenes «Von»-Feld gibt es nicht: der Satz sagt schon, wer gemeldet hat.',
            'Wesentliche Aktionen (Symbol gesetzt, Zeichnung erstellt/entfernt …) landen automatisch im Verlauf.',
            '**Rückgängig/Wiederholen** gilt für Lage und Plan.',
            'Ein Verlaufseintrag mit Ort springt beim Antippen zurück auf die Stelle in Karte oder Plan; Fotos und Sprachnotizen lassen sich direkt im Verlauf öffnen/abspielen.',
            '**Wiedergabe starten** spielt Lage und Plan zu einem früheren Zeitpunkt ab (Zeitschieber; Bearbeiten ist dabei gesperrt).',
          ] },
        ],
      },
      {
        id: 'einsatz', title: 'Einsätze verwalten', icon: 'swap',
        blocks: [
          { kind: 'lead', text: 'Alles im Einsatz-Menü (Name oben links).' },
          { kind: 'list', items: [
            '**Einsatz wechseln** zwischen den offenen Einsätzen; **Neuer Einsatz** (Ort auf der Karte wählbar).',
            '**Alarm-Pool** – eingehende Alarme übernehmen (nur wo eine Alarmquelle angebunden ist).',
            '**Einsätze** – Archiv/frühere Einsätze öffnen.',
            '**Aktuellen archivieren** schliesst den laufenden Einsatz ab.',
          ] },
        ],
      },
      {
        id: 'rapport', title: 'Rapport & Abschluss', icon: 'doc',
        blocks: [
          { kind: 'lead', text: 'Der **Einsatzrapport** ist eine eigene Fläche in der linken Leiste, unter Material ([[R]]) – ein vorausgefülltes Erfassungsblatt, kein Formular von null. Er wird über den ganzen Einsatz hinweg ergänzt, nicht erst am Schluss.' },
          { kind: 'list', items: [
            'Auf breiten Schirmen zwei Spalten: links das **Formular** zum Tippen (Alarmierung, Kurzbericht, Zeiten, Bemerkungen, Rückmeldung ELZ), rechts der **Abgleich** zum Abhaken (Anwesenheit, Material, Partnerorganisationen, Fotos).',
            'Unter dem Titel steht, was erfasst ist – und als eigene Chips, was **noch offen** ist: Zeiten, Anwesenheit, Mittel, Einsatzleiter, Kurzbericht, Rückmeldung ELZ. Nichts davon blockiert je den Druck.',
            'Der **Kroki-Ausschnitt** liegt als Feld neben dem Formular: verschieben, zoomen, **Hoch/Quer** und der **Kroki-Stand** – welchen Zeitpunkt das Bild zeigt, mit Strichen dort, wo etwas passiert ist. Gedruckt wird genau das, was auf dem Schirm steht; es gibt keinen Bestätigungsschritt.',
            '**Einsatzrapport (PDF)** erzeugt den fertigen Rapport – serverseitig gerendert, ein Knopf. Das **▾** daneben öffnet **«Abschnitte»**: was aufs Papier kommt (Kroki, Pläne, Atemschutz, Anwesenheit, Material, Verlauf, Fotos, detaillierter Prüfnachweis). Das Menü bleibt beim Anhaken offen.',
            'Wo eine Wehr einen **Stationsdrucker** betreibt: **Ausdrucken** schickt den Rapport direkt dorthin (bei Unterbruch wird gespeichert und nachgeschickt).',
            'Stimmt etwas mit dem Datensatz nicht – eine unterbrochene Prüfkette, eine Sprachnotiz ohne Transkript, ein Foto noch in der Warteschlange –, erscheint neben den Knöpfen ein **oranger Hinweis-Chip**. Er zählt die Punkte und öffnet sie; ist alles in Ordnung, erscheint er gar nicht.',
            '**Einsatz abschliessen** archiviert den Einsatz und hält das Einsatzende fest.',
          ] },
          { kind: 'note', text: 'Ein abgeschlossener Einsatz lässt sich **wieder öffnen** – spätere Ergänzungen erscheinen in Verlauf und Rapport als **Nachträge**, nichts geht verloren.' },
        ],
      },
      {
        id: 'erfassung', title: 'Erfassung per QR', icon: 'cam',
        blocks: [
          { kind: 'lead', text: 'Wo eine Wehr die Erfassung aktiviert hat (Verwaltung › Erfassung), öffnet ein **QR-Poster** im Magazin die Erfassungs-Ansicht – ohne Login, für alle ohne Tablet-Zugriff.' },
          { kind: 'list', items: [
            'Der laufende Einsatz wird gewählt; **Anwesenheit** und **Mittel** lassen sich am eigenen Handy erfassen.',
            'Ein Name wird durch Antippen weitergeschaltet: **nicht anwesend → Magazin → Vor Ort → gegangen**. Das **ⓘ** neben der Suche sagt es nochmals, samt der Bedeutung der Zeit daneben (von = Ankunft, bis = Weggang).',
            'Die Angaben fliessen in **denselben Einsatz** wie am KP-Tablet und werden zusammengeführt (bei Abweichungen mit Hinweis zum Prüfen).',
            'Als Rückfall gibt es das **leere Erfassungsblatt (PDF)** zum Ausdrucken und Nachtragen von Hand.',
          ] },
        ],
      },
      {
        id: 'sync', title: 'Mehrgeräte & Offline', icon: 'check',
        blocks: [
          { kind: 'lead', text: 'Alle Geräte sehen denselben Einsatz live.' },
          { kind: 'list', items: [
            'Änderungen werden automatisch geteilt; das Sync-Abzeichen oben zeigt den Stand (gespeichert/ausstehend).',
            'Gleichzeitige Bearbeitung wird pro Objekt zusammengeführt (jüngste Änderung gewinnt).',
            '**Nur-Lesen**: Betrachter und Telefone sehen die Lage live, ohne die taktischen Werkzeuge.',
          ] },
        ],
      },
      {
        id: 'bedienung', title: 'Bedienung & Tag/Nacht', icon: 'move',
        blocks: [
          { kind: 'sub', text: 'Tippen & Ziehen (Touch/iPad)' },
          { kind: 'list', items: [
            'Ein Finger schiebt die Karte/den Plan; zwei Finger zoomen (Pinch).',
            'Mit **Mehrfach** ein Lasso ziehen wählt mehrere Objekte; ausgewählte Objekte verschiebt man durch Ziehen.',
          ] },
          { kind: 'sub', text: 'Maus' },
          { kind: 'list', items: [
            'Scrollen zoomt; **Rechtsklick** (oder langes Tippen) auf einen Mess-/Linienpunkt entfernt ihn, Klick auf eine Linie fügt einen Zwischenpunkt ein.',
          ] },
          { kind: 'sub', text: 'Tasten' },
          { kind: 'list', items: [
            '[[Esc]] bricht das aktive Werkzeug ab bzw. hebt die Auswahl auf.',
            '[[Entf]] / [[Backspace]] löscht die Auswahl (nicht beim Tippen in ein Feld).',
          ] },
          { kind: 'sub', text: 'Tag / Nacht' },
          { kind: 'list', items: [
            'In den **Einstellungen** ([[⌘]] [[,]]) unter «Farbschema»: Automatisch (folgt dem Tageslicht), Tag oder Nacht. Der Nachtmodus dämpft Karte und Oberfläche fürs Dunkle.',
          ] },
        ],
      },
    ] as HelpSection[],
  },
  // Tactical-symbol DISPLAY labels, keyed by the RAW FireGIS name (same keys as
  // appConfig.symbols.displayNames). de = the current German short labels; en/fr/it translate
  // them. The stored/looked-up symbol identity is always the raw name — only the label localizes.
  // formatSymbolName falls back to appConfig.symbols.displayNames (per-deployment override) then
  // to the prefix-strip/umlaut-restore, so missing keys keep working.
  symbolNames: {
    'VKF Feuer': 'Feuer',
    'VKF Rettungen': 'Rettung',
    'VKF Unfall': 'Unfall',
    'VKF Gefaehrliche Stoffe': 'Gefahrstoffe',
    'VKF Wasser': 'Wasser',
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
    'FW Absperrung': 'Absperrung',
    'VKF Verkehrssperre ueberwacht': 'Verkehrssperre',
    'VKF Drehleiter': 'Drehleiter',
    'VKF Hubretter': 'Hubretter',
    'VKF Fahrzeug': 'Fahrzeug',
    'VKF Pumpe Typ2': 'Pumpe',
    // ⚠️ These two had NO entry and fell through to formatSymbolName(), which strips the
    // pack prefix — «VKF Rauch» → «Rauch» happened to be right, and would have stopped being
    // right the moment either name changed. Every other placeable symbol is named here.
    'VKF Rauch': 'Rauch',
    'FW Boot': 'Boot',
    'FW Tauchpumpe': 'Tauchpumpe',
    'FW Wassersauger': 'Wassersauger',
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
  // Palette-search synonyms, keyed by the RAW FireGIS name. Matched (substring, case/umlaut
  // tolerant) IN ADDITION to the raw key + display label + category heading — so "wasser"
  // finds the Hydranten and "UN"/"ADR" find the Gefahrentafel. Recognition over recall: the
  // operator types whatever the thing is called in their head, not our label. Locale overlays
  // may translate; missing keys fall back to these German lists.
  symbolAliases: {
    'VKF Feuer': ['Brand', 'Brandherd', 'Flammen'],
    'VKF Rettungen': ['Personenrettung', 'Menschenrettung', 'Evakuierung'],
    'VKF Unfall': ['Verkehrsunfall', 'Kollision'],
    'VKF Gefaehrliche Stoffe': ['Gefahrgut', 'ABC', 'Chemie', 'Öl', 'Oel', 'Austritt', 'Hazmat'],
    'VKF Wasser': ['Wasserschaden', 'Hochwasser', 'Leck'],
    'FW Gefahr Ex': ['Explosionsgefahr', 'Detonation'],
    'FW Beschaedigung': ['Schaden', 'beschädigt'],
    'FW Teilzerstoerung': ['Zerstörung', 'Trümmer'],
    'FW Totalzerstoerung': ['Zerstörung', 'Einsturz', 'Trümmer'],
    'FW Ueberschwemmung': ['Hochwasser', 'Flut', 'Wasserschaden'],
    'FW Gefahr Tafel': ['UN', 'UN-Nummer', 'ADR', 'Gefahrgut', 'Kemler', 'orange Tafel', 'Warntafel', 'Hazmat'],
    'FW Gefahr allgemein': ['Achtung', 'Warnung', 'Gefahrenstelle'],
    'FW Gefahr G': ['Gasleitung', 'Erdgas', 'Propan', 'Explosionsgefahr'],
    'FW Gefahr C': ['Chemikalien', 'Säure', 'Lauge', 'Gefahrstoff'],
    'FW Gefahr Radioaktiv': ['Strahlung', 'atomar', 'nuklear', 'A-Gefahr'],
    'FW Gefahr W': ['Wassergefahr', 'Gewässer', 'Gewässerschutz'],
    'FW Elektroanlage': ['Strom', 'Spannung', 'Hochspannung', 'Elektrizität'],
    'VKF KP Front': ['Kommandoposten', 'Einsatzleitung', 'Führungsstandort'],
    'VKF Einsatzleiter': ['Einsatzleitung', 'EL'],
    'FW Offizier': ['Kader', 'Führung'],
    'FW Sammelplatz': ['Treffpunkt', 'Besammlung'],
    'FW Warteraum': ['Bereitstellungsraum', 'Bereitstellung'],
    'VKF Kontrollposten': ['Checkpoint', 'Kontrolle', 'Verkehrsposten', 'Pforte'],
    'VKF Informationszentrum': ['Info', 'Medien', 'Auskunft', 'Mediensammelstelle'],
    'VKF Bereich Materialdepot': ['Material', 'Depot', 'Lager'],
    'FW Absperrung': ['Sperre', 'Barriere', 'Absperrband', 'Sperrzone'],
    'VKF Verkehrssperre ueberwacht': ['Strassensperre', 'Absperrung', 'Sperre', 'bewacht', 'Bewachung', 'Überwachung'],
    'VKF Fahrzeug': ['Auto', 'TLF', 'Tanklöschfahrzeug', 'Einsatzfahrzeug', 'Lastwagen'],
    'VKF Drehleiter': ['ADL', 'Autodrehleiter', 'Leiterfahrzeug'],
    'VKF Luefter mobil': ['Ventilator', 'Belüftung', 'Druckbelüfter'],
    'FW Kleinloeschgeraet': ['Feuerlöscher', 'Handfeuerlöscher', 'Löschdecke'],
    'VKF Hubretter': ['Hebebühne', 'Teleskopmast'],
    'VKF Pumpe Typ2': ['Motorspritze', 'Wassertransport', 'MS'],
    'FW Tauchpumpe': ['Pumpe', 'Keller', 'Wasser', 'TP', 'Lenzpumpe'],
    'FW Wassersauger': ['Sauger', 'Nasssauger', 'Wasser', 'WS'],
    'VKF Helilandeplatz': ['Helikopter', 'Heli', 'Rega', 'Landeplatz'],
    'VKF Drohne': ['Drone', 'UAV', 'Multicopter', 'Quadrocopter', 'Luftaufklärung', 'Wärmebild'],
    'FW Entrauchung': ['Rauchabzug', 'Belüftung', 'Abluft'],
    'FW Sprungretter': ['Sprungkissen', 'Sprungpolster', 'Rettungskissen'],
    'FW Leiter': ['Anstellleiter', 'Schiebleiter', 'Steckleiter'],
    'VKF Sammelstelle': ['Unverletztensammelstelle', 'Betreuung', 'Evakuierte'],
    'VKF Patientensammelstelle': ['Verletzte', 'Triage', 'Patienten'],
    'VKF Sanitaetshilfsstelle': ['Verbandplatz', 'Sanposten', 'Sanhist'],
    'VKF Totensammelstelle': ['Tote', 'Verstorbene'],
    'FW Verwundetennest': ['Verletzte', 'Verwundete'],
    'VKF Bereich Sanitaet': ['Ambulanz', 'Rettungsdienst', '144'],
    'VKF Bereich Feuerwehr': ['118'],
    'VKF Bereich Polizei': ['117', 'Kantonspolizei'],
    'VKF Bereich Chemiewehr': ['ABC-Wehr', 'Chemikalien'],
    'VKF Bereich Zivilschutz': ['ZS', 'Bevölkerungsschutz'],
    'SI Ueberflurhydrant': ['Wasserbezug'],
    'SI Unterflurhydrant': ['Wasserbezug'],
    'VKF Innenhydrant': ['Steigleitung', 'Wandhydrant'],
    'SI Wasserloeschposten': ['Innenangriff'],
    'WV Loeschweier': ['Weiher', 'Teich', 'Reservoir', 'Löschwasserreserve'],
    'SI Wasserbezugsort': ['Saugstelle', 'Fluss', 'Bach', 'See'],
    'SI Wasserdruckversorgung': ['Druckleitung', 'Reservoir'],
    'GB BA Wand F30': ['Brandabschnitt', 'Brandmauer', 'Brandschutzwand'],
    'GB BA Wand F60': ['Brandabschnitt', 'Brandmauer', 'Brandschutzwand'],
    'GB BA Wand F180': ['Brandabschnitt', 'Brandmauer', 'Brandschutzwand'],
    'GB Ture BS R30': ['Brandschutztüre', 'Brandschutztür', 'Tür'],
    'GB Ture Durchgang': ['Tür', 'Eingang', 'Zugang'],
    'GB Lift': ['Aufzug', 'Fahrstuhl', 'Warenlift'],
    'GB Kamin': ['Cheminée', 'Schornstein', 'Abgas'],
    'GB Abzug': ['Lüftung', 'Ventilation', 'Abluft'],
    'SI Schieber': ['Absperrschieber', 'Ventil', 'Gasschieber'],
    'GB Elektrotableau': ['Sicherungskasten', 'Verteiler', 'Strom', 'Hauptschalter'],
    'GB Sprinklerzentrale': ['Sprinkler', 'Löschanlage'],
    'GB Brandmeldezentrale': ['BMA', 'BMZ', 'Brandmeldeanlage', 'Alarmzentrale'],
    'GB BMA Melder': ['Melder', 'Brandmelder', 'Rauchmelder', 'Meldergruppe', 'Handfeuermelder'],
    'GB Fernsignaltableau': ['Brandmeldeanlage', 'Signaltableau'],
    'GB Schluesseldepot': ['Schlüsselrohr', 'Feuerwehrschlüsseldepot'],
    'GB Treppe 8': ['Treppenhaus', 'Stiege', 'Aufgang'],
    'SI Windrichtung': ['Wind', 'Windsack', 'Wetter'],
    'SI Nordpfeil': ['Norden', 'Kompass', 'Orientierung'],
  } as Record<string, string[]>,
  // Symbol-palette category headings, keyed by the German category (the keys of
  // appConfig.symbols.presets.byCat). de = identity; en/fr/it translate. The German key is the
  // canonical category — only the heading localizes. Palette falls back to the raw key.
  symbolCategories: {
    'Schadenlage': 'Schadenlage',
    'Gefahren': 'Gefahren',
    'Gebäude': 'Gebäude',
    'Wasser': 'Wasser',
    'Führung': 'Führung',
    'Personen / Sanität': 'Personen / Sanität',
    'Partner': 'Partner',
  } as Record<string, string>,
  baseMap: 'Karte',
  // floor (Geschoss) short labels — shared by the Plan floor-stack and the report plan labels.
  // ground floor is a literal; upper/basement carry the number via {n}.
  floor: { eg: 'EG', og: '{n}. OG', ug: '{n}. UG' },
  // hose-count hint for the Messpfeil label (lib/geo · hoseLengthHint), e.g. "~5 Schläuche"
  hoseHint: '~{n} Schläuche',
  noHistoryRows: 'Noch keine Ereignisse erfasst',
  symbolSearchPlaceholder: 'Suchen …',
  noSymbolMatches: 'Keine Treffer',
  close: 'Zu',
  closeDialog: 'Schliessen',
  sheetGrip: 'Detailhöhe anpassen',
  edit: 'Bearbeiten',
  primarySymbol: { id: 'symbol', icon: 'plus-bold', label: 'Symbol' },
  done: 'Fertig',
  cancel: 'Abbrechen',
  // shared «Übung» marker — switcher, dropdown rows, Alle Einsätze (is_exercise incidents)
  exerciseBadge: 'Übung',
  keepPlacing: 'Mehrere platzieren',
  delete: 'Entfernen',
  undo: 'Rückgängig',
  redo: 'Wiederholen',
  play: 'Abspielen',
  clear: 'Leeren',
  // kind drives how the tool-rail button reads & behaves:
  //   'tool'   — modal, sticky (flat, lights up while active)
  //   'action' — one-shot, fires & gives toast feedback (push-button look)
  //   'mode'   — switches the whole surface (push-button look)
  mapTools: [
    // grouped: selection · create (Symbol + drawing) · annotate/measure. One divider before
    // the create group; Symbol leads it as a plain tool — no divider isolating it from the
    // drawing tools and no special styling.
    { id: 'select', icon: 'select', label: 'Auswahl', kind: 'tool' },
    { id: 'lasso', icon: 'marquee', label: 'Mehrfach', kind: 'tool' },
    { id: 'sep-symbol', sep: true, icon: '', label: '' },
    { id: 'symbol-slot', slot: true, icon: '', label: '' },
    { id: 'line', icon: 'pen', label: 'Linie', kind: 'tool' },
    { id: 'area', icon: 'area', label: 'Fläche', kind: 'tool' },
    { id: 'circle', icon: 'circle', label: 'Absperrkreis', kind: 'tool' },
    { id: 'sep-anno', sep: true, icon: '', label: '' },
    { id: 'note', icon: 'type', label: 'Notiz', kind: 'tool' },
    { id: 'team', icon: 'flag', label: 'Trupp', kind: 'tool' },
    { id: 'measure', icon: 'measure', label: 'Messen', kind: 'tool' },
  ],
  // Plan/whiteboard tool list — mirrors mapTools' ordering (Auswahl · Mehrfach · Symbol ·
  // then the create tools) so the two shared tool rails read the same. Symbol leads the
  // create group as a plain tool (no divider isolating it from Zeichnen).
  planTools: [
    // grouped: selection · create — mirrors mapTools' divider rhythm
    { id: 'pan', icon: 'select', label: 'Auswahl' },
    { id: 'lasso', icon: 'marquee', label: 'Mehrfach' },
    { id: 'sep-symbol', sep: true, icon: '', label: '' },
    { id: 'symbol-slot', slot: true, icon: '', label: '' },
    // single Linie tool (Freihand-drag ↔ Punkte toggle lives in its dock), mirroring the Lage map
    { id: 'line', icon: 'pen', label: 'Linie' },
    { id: 'area', icon: 'area', label: 'Fläche' },
    { id: 'text', icon: 'type', label: 'Notiz' },
    { id: 'resource', icon: 'flag', label: 'Trupp' },
    { id: 'sep-measure', sep: true, icon: '', label: '' },
    // Messen: node-based distance/area on the plan (uses the calibrated scale). Calibration
    // itself is reached via the always-visible Maßstab trust chip, not a separate rail button.
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
    coordsLocked: 'Festgehalten – Knopf für neuen Punkt',
    // colour-scheme control (cycles in the incident menu); 'auto' tracks daylight
    themeLabel: 'Darstellung',
    autoMode: 'Automatisch',
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
    hint: 'Eine Ansicht speichert die Karte wie sie gerade ist – Position, Zoom und Drehung. Tippe eine gespeicherte Ansicht an, um dorthin zu springen (z.B. zwischen Nordübersicht und der Karte gedreht wie du stehst). Kompass lange drücken: direkt einpassen.',
    empty: 'Noch keine Ansichten. Speichere die aktuelle Karte – Position, Zoom und Drehung – um mit einem Tipp dorthin zurückzukehren.',
    rename: 'Umbenennen',
    delete: 'Löschen',
    saved: 'Ansicht gespeichert',
    deleteTitle: 'Ansicht löschen',
    deleteMsg: '«{name}» löschen?',
  },
  toast: {
    recordingStarted: 'Audioaufnahme läuft …',
    audioSaved: 'Audionotiz gespeichert ({secs}s)',
    micDenied: 'Kein Mikrofonzugriff – als Platzhalter vermerkt',
    merged: 'Änderungen zusammengeführt',
  },
  mapHints: {
    placeSymbol: 'Tippe auf die Karte, um "{name}" zu platzieren',
    areaDraft: 'Flächen-Eckpunkte auf die Karte tippen',
    placeNote: 'Tippe auf die Karte, um eine Notiz zu setzen',
    placeShape: 'Tippe auf die Karte, um {name} zu platzieren',
  },
  // help shown by the info (ℹ) button on each tool dock — the instructions
  // that used to sit in the bottom hint bar
  dockHints: {
    symbol: 'Auf die Karte tippen, um das Zeichen zu platzieren. Schloss aktivieren, um mehrere nacheinander zu setzen.',
    lasso: 'Mit einem Finger einen Rahmen um mehrere Objekte ziehen. Mit zwei Fingern verschiebt sich weiterhin die Karte.',
    line: 'Auf der Karte ziehen oder Punkte tippen, um eine Linie zu zeichnen. Stil (Freihand · Pfeil · Rettungsachse) danach im Editor wählen.',
    area: 'Mindestens drei Eckpunkte auf die Karte tippen, dann mit dem Haken abschliessen.',
    circle: 'Von der Mitte zum Rand ziehen setzt den Radius in Metern. Radius und Füllung danach im Editor anpassen.',
    note: 'Auf die Karte tippen, um eine Notiz zu setzen. «Textfeld» macht daraus einen mehrzeiligen Block, dessen Breite sich am rechten Rand ziehen lässt.',
    team: 'Auf die Karte tippen und den Trupp aus der Liste wählen. Zum Verschieben ziehen.',
    shape: 'Auf die Karte tippen, um die Form zu platzieren. Schloss aktivieren, um mehrere nacheinander zu setzen.',
    measure: 'Punkte auf die Karte tippen. Strecke zeigt Distanz und Höhenprofil, Fläche zeigt Flächeninhalt und Umfang. Punkte ziehen zum Verschieben, das + in der Mitte einer Strecke setzt einen Zwischenpunkt, Rechtsklick auf einen Punkt entfernt ihn.',
  },
  map: {
    incidentHere: 'Einsatzort',
    youHere: 'Mein Standort',
    // WebGL context loss (iPad reclaims the GPU in the background) — the map goes blank while
    // everything around it still works, so it needs naming and a way out.
    glLost: 'Kartenansicht unterbrochen',
    glLostHint: 'Das Gerät hat die Grafikanzeige der Karte freigegeben. Deine Einträge sind gespeichert.',
    glLostAction: 'Karte neu aufbauen',
  },
  // "Einsatz eröffnen" / "Einsatzdaten bearbeiten". An alarm opens its Einsatz by itself,
  // so this panel is for the two remaining jobs: a manual create (fully analog Einsatz,
  // three location methods — Objekt · Adresse · Karte) and correcting what the dispatch
  // got wrong on an incident that is already running.
  intake: {
    titleNew: 'Einsatz eröffnen',
    // --- Standort section ---
    locationHead: 'Standort',
    addressLabel: 'Adresse',
    addressPlaceholder: 'Strasse Nr, PLZ Ort',
    addressSearching: 'Suche …',
    addressNoHits: 'Keine Adresse gefunden',
    objectButton: 'Objekt aus Feuerwehrplänen',
    objectSearchPlaceholder: 'Objekt oder Adresse suchen …',
    objectNear: 'In der Nähe',
    objectNoHits: 'Keine Objekte gefunden',
    objectPlans: (n: number) => (n === 1 ? '1 Plan' : `${n} Pläne`),
    objectNoPlans: 'keine Pläne',
    mapPickButton: 'Auf Karte setzen',
    hereButton: 'Hier',
    hereFailed: 'Standort nicht verfügbar',
    coordSet: 'Koordinate gesetzt',
    coordNone: 'Kein Standort – wird ohne Koordinate eröffnet',
    coordClear: 'Standort entfernen',
    // --- Stichwort section ---
    keywordHead: 'Stichwort & Kategorie',
    titleLabel: 'Stichwort / Titel',
    titlePlaceholder: 'z. B. Gebäudebrand Schulhaus',
    categoryLabel: 'Kategorie',
    // Priorität: guessed from the alarm's Stichwörter, hence correctable here
    priorityLabel: 'Priorität',
    priorityHigh: 'Dringend',
    priorityLow: 'Normal',
    // Übungen stay fully operable, but do not feed the statistics and are the only ones
    // that can be deleted (Alle Einsätze)
    exerciseToggle: 'Übung – zählt nicht zur Einsatzstatistik',
    detailsLabel: 'Meldungstext (optional)',
    // «Hier» moves the Einsatzort to the device's location. On a running Einsatz it always asks
    // first – the form is usually opened in the Magazin to correct an address, and a mis-tap
    // takes the map, the Kroki, the tile stock and the Objektpläne along with it.
    moveConfirmTitle: 'Einsatzort verschieben?',
    moveConfirmMsg: 'Der Einsatzort wird auf deinen jetzigen Standort gesetzt – {d} vom bisherigen entfernt. Karte, Kroki-Ausschnitt und die Objektpläne in der Nähe richten sich danach.',
    moveConfirmBtn: 'Verschieben',
    alarmTextUnavailable: 'Alarmmeldung konnte nicht geladen werden – bleibt unverändert',
    detailsPlaceholder: 'Zusätzliche Angaben zur Meldung',
    // --- Actions ---
    open: 'Einsatz öffnen',
    opening: 'Wird eröffnet …',
    demoBlocked: 'In der Demo deaktiviert – hier lässt sich kein neuer Einsatz eröffnen.',
    cancel: 'Abbrechen',
    errorCreate: 'Fehler beim Erstellen',
    errorTake: 'Übernahme fehlgeschlagen',
    errorUpdate: 'Aktualisierung fehlgeschlagen',
    // --- edit mode + result toasts ---
    editTitle: 'Einsatzdaten bearbeiten',
    back: '← Zurück',
    save: 'Speichern',
    saving: 'Speichert …',
    created: 'Einsatz erstellt',
    taken: 'Alarm übernommen',
    updated: 'Einsatz aktualisiert',
    alarmierungHead: 'Alarmierung',
    alarmTime: 'Alarmzeit',
    alarmMessage: 'Alarmmeldung',
    // --- Divera pool + incoming banner + in-map review ---
    addressUnknown: 'Adresse unbekannt',
    alarmOpen: 'Öffnen',
    alarmOpening: 'Öffne …',
    dismiss: 'Verwerfen',
    manualIncident: 'Manueller Einsatz',
    // --- attach: split/Nachalarm dispatch joins an existing incident instead of a duplicate ---
    attach: 'Zu bestehendem Einsatz hinzufügen',
    attachShort: 'Zu Einsatz',
    attachConfirmTitle: '«{alarm}» zu diesem Einsatz hinzufügen?',
    attachHint: 'Die Meldung landet im Verlauf, GPS-Zeiten folgen automatisch. Stichwort und Standort des Einsatzes bleiben unverändert.',
    attachConfirm: 'Hinzufügen',
    attachDone: 'Alarm zum Einsatz hinzugefügt',
    attachError: 'Hinzufügen fehlgeschlagen',
    newDiveraAlarm: 'Neuer Alarm',
    hide: 'Ausblenden',
    fromDivera: 'Aus der Alarmquelle übernommen',
    locationSet: 'Standort gesetzt',
    noLocationOnMap: 'Kein Standort – auf Karte setzen',
    ok: 'Passt',
    // VKF Schadenkategorien — mirrors the labels the backend derives server-side (see
    // backend app/divera.py CATEGORY_LABELS). The keyword half below comes from
    // backend/app/data/alarm_keywords.json, the file kp-front and kp-rueck share;
    // copy.test.ts fails when this list and that file disagree, so "keep in sync"
    // is now checked rather than remembered. Note it mirrors the SHIPPED vocabulary:
    // a station that sets its own `alarmKeywords` changes what the server classifies,
    // not this list.
    kategorien: [
      'Brandbekämpfung',
      'Strassenrettung',
      'Technische Hilfeleistung',
      'Elementarereignis',
      'Ölwehr',
      'Chemiewehr',
      'Strahlenwehr',
      'Einsatz Bahnanlagen',
      'BMA / unechte Alarme',
      'Gerettete Tiere',
      'Dienstleistungen',
      'Diverse Einsätze',
    ] as string[],
    // Keyword (UPPERCASE substring of the Stichwort) → category, mirroring the same
    // backend map. Lets the wizard pre-select a category for a Divera alarm; first hit
    // wins. The backend still derives it authoritatively if the EL leaves it unset.
    kategorieGuess: [
      ['FEUER', 'Brandbekämpfung'],
      ['BRAND', 'Brandbekämpfung'],
      ['HOCHWASSER', 'Elementarereignis'],
      ['UNWETTER', 'Elementarereignis'],
      ['STURM', 'Elementarereignis'],
      ['VU', 'Strassenrettung'],
      ['VERKEHR', 'Strassenrettung'],
      ['UNFALL', 'Strassenrettung'],
      ['THL', 'Technische Hilfeleistung'],
      ['TECH', 'Technische Hilfeleistung'],
      ['ÖL', 'Ölwehr'],
      ['OELWEHR', 'Ölwehr'],
      ['CHEMIE', 'Chemiewehr'],
      ['STRAHLEN', 'Strahlenwehr'],
      ['BAHN', 'Einsatz Bahnanlagen'],
      ['BMA', 'BMA / unechte Alarme'],
      ['FEHLALARM', 'BMA / unechte Alarme'],
      ['DIENST', 'Dienstleistungen'],
      ['TIER', 'Gerettete Tiere'],
    ] as [string, string][],
    // DISPLAY labels for the category <select>, keyed by the German category VALUE (the entries
    // of `kategorien`). de = identity (German→German); en/fr/it translate. The stored/submitted
    // value stays the German `kategorien` entry — only the option TEXT localizes; the select
    // falls back to the raw German key when a label is missing.
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
  },
  measure: {
    modeLine: 'Strecke',
    modeArea: 'Fläche',
    clear: 'Zurücksetzen',
    // the + in the middle of every segment — the same label on Lage and Plan, because it is
    // the same gesture
    insertPoint: 'Punkt einfügen',
    deleteNode: 'Rechtsklick zum Entfernen',
    distance: 'Distanz',
    perimeter: 'Umfang',
    area: 'Fläche',
    hoses: 'Schläuche',
    profile: 'Höhenprofil',
    ascent: 'Aufstieg',
    descent: 'Abstieg',
    min: 'Tiefster',
    max: 'Höchster',
    profileLoading: 'Höhenprofil wird geladen …',
    profileNone: 'Kein Höhenprofil verfügbar',
    hintLine: 'Mind. 2 Punkte für die Distanz',
    hintArea: 'Mind. 3 Punkte für den Flächeninhalt',
  },
  shapes: {
    sectionTitle: 'Formen',
    kindLabel: 'Form',
    color: 'Farbe',
    size: 'Grösse',
    sizeSmaller: 'Kleiner',
    sizeBigger: 'Grösser',
    rotateHint: 'Griff ziehen zum Drehen',
    resizeHint: 'Ecke ziehen zum Skalieren',
    moveHint: 'Korb ziehen – Richtung und Reichweite',
    names: { arrow: 'Pfeil', cloud: 'Rauch', square: 'Rechteck' } as Record<string, string>,
  },
  log: {
    noMicrophone: 'Audionotiz (kein Mikrofonzugriff)',
    audioNote: 'Audionotiz',
    symbolPlaced: 'Symbol "{name}" gesetzt',
    shapePlaced: '{name} platziert',
    notePlaced: 'Notiz gesetzt',
    teamPlaced: '{name} auf der Lage gesetzt',
    areaDrawn: 'Fläche gezeichnet',
    circleDrawn: 'Absperrkreis gezeichnet',
    drawingCreated: 'Zeichnung erstellt',
    objectMoved: '{name} verschoben',
    objectDeleted: '{name} entfernt',
    drawingDeleted: 'Zeichnung entfernt',
    // «Zeichnung entfernt» after a lasso selection over eleven objects isn't imprecise, it is
    // wrong – the singular claims there was only one.
    selectionDeleted: '{n} Objekte entfernt',
    duplicated: 'Objekt dupliziert',
    undo: 'Aktion rückgängig gemacht',
    redo: 'Aktion wiederholt',
    journalNote: 'Notiz',
    // ⚠️ EDITING the Kroki, not just placing and removing on it (10.08.). A symbol got one row
    // when it appeared and one when it went, and everything in between — the Stockwerk, the name
    // of the Einsatzleiter typed into its field, the Anzahl, eine Ausbreitung — changed the
    // picture the Einsatz is led from without a single line in the record. Each of these names
    // the VALUE: «Stockwerk geändert» would send a reader to the replay for the one thing a
    // printed rapport cannot do.
    entityEdited: '{name}: {changes}',
    fieldSet: '{field}: {value}',
    fieldChanged: '{field} auf {value} geändert',
    fieldCleared: '{field} geleert',
    labelSet: 'Beschriftung «{value}»',
    labelCleared: 'Beschriftung entfernt',
    floorSet: 'Stockwerk {value}',
    floorCleared: 'Stockwerk entfernt',
    floorRangeSet: 'Stockwerke {from} – {to}',
    floorRangeCleared: 'Stockwerk-Bereich entfernt',
    countSet: 'Anzahl {n}',
    spreadSet: 'Ausbreitung erfasst',
    spreadCleared: 'Ausbreitung entfernt',
    // ⚠️ The note is QUOTED (reversed 11.08.; it used to be the bare «Notiz erfasst»). A note is
    // the sentence somebody wrote BECAUSE the symbol could not say it — a row announcing that
    // such a sentence exists elsewhere is no record of it, least of all on a printed Rapport
    // where the Kroki cannot be clicked.
    noteWritten: 'Notiz «{value}»',
    notesCleared: 'Notiz geleert',
    /** a Fläche / Linie / Absperrkreis given a name — same rule as the note above. Naming a shape
     *  is how «die Fläche da» becomes «Sammelplatz», and it used to reach the document without a
     *  row: the Verlauf said a Fläche had been drawn and never what it turned out to be. */
    drawingLabelSet: '{kind} «{value}»',
    drawingLabelCleared: '{kind}: Beschriftung entfernt',
    drawKinds: { area: 'Fläche', line: 'Zeichnung', circle: 'Absperrkreis' } as Record<string, string>,
  },
  // unified, append-only journal (Verlauf) shared by Lage + Plan
  journal: {
    open: 'Verlauf',
    add: 'Eintrag',
    addHint: 'Tippen für Eintrag · gedrückt halten für Sprachnachricht',
    title: 'Verlauf',
    empty: 'Noch keine Ereignisse erfasst',
    surfaceMap: 'Lage',
    surfacePlan: 'Plan',
    replay: 'Wiedergabe starten',
    // activity strip above the list: WHEN something happened, as a position rather than a row
    stripLabel: 'Zeitstrahl – tippen, um zur passenden Stelle zu springen',
    replayHint: 'Lage und Plan zu einem früheren Zeitpunkt abspielen',
    // composer
    composerTitle: 'Journaleintrag',
    textPlaceholder: 'Was ist passiert? Meldung, Beobachtung, Entscheid …',
    record: 'Aufnehmen',
    recordStop: 'Aufnahme stoppen',
    dictate: 'Diktieren',
    dictateStop: 'Diktat stoppen',
    dictateListening: 'Höre zu …',
    discardAudio: 'Aufnahme verwerfen',
    // external voice-memo import
    audioUpload: 'Audio hochladen',
    // short form for the phone row, where the three media buttons get a third of the width each
    audioUploadShort: 'Audio',
    audioImportLabel: 'Externe Audioaufnahme',
    audioStartLabel: 'Aufnahme begann',
    audioStartHint: 'Startzeit anhand der Sprachmemo kontrollieren.',
    audioStartConfirm: 'Startzeit bestätigen',
    audioImportedNote: 'Externe Audioaufnahme ({duration})',
    audioDiscardImport: 'Audiodatei entfernen',
    audioUploading: 'Wird hochgeladen …',
    audioOffline: 'Audio-Upload benötigt eine Verbindung. Datei später erneut auswählen.',
    audioTooLarge: 'Audiodatei ist zu gross. Maximum: {max} MB.',
    audioUnsupported: 'Dieses Audioformat wird nicht unterstützt.',
    audioUploadFailed: 'Upload fehlgeschlagen. Verbindung prüfen und erneut versuchen.',
    // audio player (Durchhören)
    playerOpen: 'Durchhören',
    editEntry: 'Text bearbeiten',
    removeEntry: 'Eintrag entfernen',
    entryRemoved: 'Eintrag entfernt',
    playerEntryHere: 'Eintrag an dieser Stelle',
    playerEntryPlaceholder: 'Was war zu hören? Meldung, Entscheid …',
    playerEntries: 'Einträge in dieser Aufnahme',
    playerNoEntries: 'Noch keine Einträge in diesem Zeitfenster.',
    playerSkipBack: '15 Sekunden zurück',
    playerSkipFwd: '15 Sekunden vor',
    playerSpeed: 'Wiedergabegeschwindigkeit',
    playerSeek: 'Wiedergabeposition',
    playerOffline: 'Wiedergabe benötigt eine Verbindung.',
    // speech-to-text drafts in the player (fail-closed: button only when konfiguriert)
    sttTranscribe: 'Transkribieren',
    sttRunning: 'Transkription läuft … Das kann einige Minuten dauern.',
    sttFailed: 'Transkription fehlgeschlagen: {error}',
    sttRetry: 'Erneut versuchen',
    sttErrorGeneric: 'Server nicht erreichbar',
    sttBanner: '{n} Entwürfe erkannt – prüfen und übernehmen.',
    sttTakeAll: 'Alle übernehmen',
    sttTake: 'Übernehmen',
    sttDismiss: 'Verwerfen',
    sttEmpty: 'Keine Sprache erkannt.',
    sttTaken: 'Eintrag übernommen',
    photo: 'Foto',
    photoNote: 'Foto',
    photoOpen: 'Foto gross ansehen',
    discardPhoto: 'Foto verwerfen',
    // offline media upload queue — status chip on a Verlauf row whose photo/audio is not yet
    // on the server (captured offline; will upload automatically when reconnected)
    mediaPending: 'Wird geladen',
    mediaFailed: 'Nicht geladen',
    // rows appended after the Einsatzende (archive → reopen, the correction path)
    nachtrag: 'Nachtrag',
    // system row appended when a three-way sync merge saw BOTH sides (KP tablet and
    // QR-Erfassung/server) change the SAME person's attendance to different values —
    // last-writer-wins stays, but the divergence is said, not silent (append-only record)
    attendanceConflict: 'Anwesenheit von {name}: abweichende Angaben aus QR-Erfassung und KP wurden zusammengeführt – bitte prüfen.',
    quickPhrasesAria: 'Textbausteine',
    // ── Who said it, and what kind of statement is it ──
    // Both end up in the row's TEXT (lib/journalEntry · composeJournalText); the structured
    // fields exist for filtering, not for display.
    // ⚠️ NO «Von» field any more (09.08.). It asked what the sentence already answers — whoever
    // writes «Meier meldet Kellerbrand bestätigt» has said who reported it — and a second field
    // for the same statement is a second field to fill in. What was actually wanted is that the
    // NAMES are real: spelled correctly and visible as a link (lib/journalLinks).
    linkKinds: { person: 'Person', material: 'Material', partner: 'Partner', vehicle: 'Fahrzeug', group: 'Gruppe' } as Record<string, string>,
    typeLabel: 'Art',
    // «Info» is the normal case and prints NO badge — a badge on every row is wallpaper. The
    // words come from the Führungsrhythmus (BGV Behelf Schadenplatz).
    // ⚠️ ONE spelling. There used to be a short form («Sofort») for the composer's chips and the
    // full word for the Verlauf, so the chip you pressed and the line it wrote named two
    // different things. «Sofortmassnahme» is a doctrine word — abbreviating it is what made the
    // chip read as a hurry rather than as a kind of entry.
    entryTypes: { info: 'Info', auftrag: 'Auftrag', sofort: 'Sofortmassnahme' } as Record<string, string>,
    pinMap: 'An aktueller Kartenmitte anheften',
    pinPlan: 'An aktueller Planmitte anheften',
    send: 'Erfassen',
    saved: 'Journaleintrag erfasst',
    // audio-note transcript editing (Verlauf row)
    transcriptPlaceholder: 'Transkript ergänzen',
    transcriptSave: 'Speichern',
    transcriptEdit: 'Transkript bearbeiten',
    transcriptAdd: 'Transkript ergänzen',
    // Erinnerung (reminder) mode of the composer
    modeEntry: 'Eintrag',
    modeReminder: 'Erinnerung',
    reminderTextPlaceholder: 'Woran erinnern? z. B. Lüfter prüfen, Rückmeldung Einsatzleitung …',
    reminderWhen: 'Fällig in',
    reminderExact: 'Uhrzeit',
    reminderChips: [5, 10, 15, 30, 60] as number[],
    reminderChipLabel: '+{n} min',
    reminderTomorrow: ' · morgen',
    hourUp: 'Stunde +', hourDown: 'Stunde −', minUp: 'Minute +', minDown: 'Minute −',
    reminderSend: 'Erinnerung setzen',
    reminderSaved: 'Erinnerung gesetzt',
    reminderNeedsDue: 'Fälligkeit wählen',
    // ⚠️ The row a reminder writes WHEN IT IS SET. It used to carry the bare reminder text, so
    // the Verlauf held «Lüfter prüfen» among a hundred other lines and the only row that said
    // the word «Erinnerung» was the one saying it had been done — the record showed an answer
    // with no question. The Fälligkeit belongs in it too: what was decided at 21:40 was not
    // «Lüfter prüfen», it was «Lüfter prüfen, um 22:10».
    reminderCreated: 'Erinnerung gesetzt für {t}: {text}',
    // due banner + actions
    dueTitle: 'Erinnerung fällig',
    dueOne: 'Erinnerung fällig',
    dueMany: '{n} Erinnerungen fällig',
    dueDone: 'Erledigt',
    dueSnooze: '+10 min',
    dueOpen: 'In Verlauf öffnen',
    openCount: '{n} offen',
    // ⚠️ Offene Erinnerungen are held at the TOP of the Verlauf, out of chronological order.
    // Everything else in this list is where it happened, because the Verlauf is the record —
    // but a Wiedervorlage is the one row that is about the FUTURE, and on a busy Einsatz it
    // was thirty rows up within ten minutes. Held here it cannot be scrolled past; the row it
    // came from stays in its place in the chronology, this is a second view of it.
    openRemindersHead: 'Offene Erinnerungen',
    openReminderGo: 'Zum Eintrag springen',
    doneLog: 'Erinnerung erledigt: {text}',
    snoozeLog: 'Erinnerung +{mins} min: {text}',
    // Verlauf reminder row: due label + done toggle (checklist-style)
    dueAtLabel: 'fällig {t}',
    overdueLabel: 'überfällig',
    doneState: 'erledigt',
    markDoneTitle: 'Als erledigt markieren',
  },
  errors: {
    noMicrophone: 'Kein Mikrofonzugriff. Audionotiz als Platzhalter vermerkt.',
    updateFailed: 'Aktualisierung fehlgeschlagen',
    // network failures, both with ApiError status 0 — the app falls back to its offline caches
    // either way; the wording only tells the operator WHICH kind of dead line they have.
    serverUnreachable: 'Netzwerkfehler – Server nicht erreichbar',
    serverUnreachableHint: 'Kein Netz, oder der Server ist unter dieser Adresse nicht da. Gespeicherte Einsätze bleiben offline verfügbar.',
    serverTimeout: 'Server antwortet nicht – Zeitüberschreitung',
    serverTimeoutHint: 'Die Verbindung steht, es kommt nur nichts zurück – typisch für ein sterbendes WLAN. Gespeicherte Einsätze bleiben offline verfügbar.',
    // What an HTTP status MEANS, for when the server sent no message of its own (a 502 from the
    // reverse proxy is an HTML page, not our JSON). «HTTP 502» names the plumbing; it doesn't say
    // whether the tablet, the link or the server is at fault, whether waiting helps, or whether
    // the Einsatz data is safe — which is all the operator actually needs at 3am.
    httpUnauthorized: 'Anmeldung abgelaufen',
    httpUnauthorizedHint: 'Bitte neu anmelden.',
    httpForbidden: 'Keine Berechtigung',
    httpForbiddenHint: 'Dieses Konto darf das nicht. Mit einem Konto mit Bearbeitungsrecht anmelden.',
    httpNotFound: 'Vom Server nicht gefunden',
    httpNotFoundHint: 'Diese Adresse kennt der Server nicht. Möglicherweise läuft dort eine andere Version.',
    httpTooLarge: 'Datei zu gross',
    httpTooLargeHint: 'Der Server nimmt Dateien dieser Grösse nicht an.',
    httpTooMany: 'Zu viele Versuche',
    httpTooManyHint: 'Kurz warten, dann nochmals versuchen.',
    httpRejected: 'Anfrage abgelehnt',
    httpRejectedHint: 'Der Server hat die Anfrage zurückgewiesen.',
    httpGateway: 'Server nicht erreichbar',
    httpGatewayHint: 'Der Server antwortet nicht – vermutlich startet er gerade neu. Gleich nochmals versuchen; gespeicherte Einsätze bleiben offline verfügbar.',
    httpServerError: 'Fehler auf dem Server',
    httpServerErrorHint: 'Die Anfrage kam an, der Server kam damit nicht zurecht. Nochmals versuchen – bleibt es dabei, liegt es nicht am Gerät.',
    /** the raw status, kept visible in small print: useless in the moment, decisive on the phone
     *  to whoever runs the server */
    httpCode: 'Fehlercode {code}',
  },
  atemschutz: {
    title: 'Atemschutzüberwachung',
    subtitle: 'Lückenlose Überwachung jedes Atemschutztrupps',
    empty: 'Noch kein Trupp in Überwachung.',
    emptyHint: 'Lege einen Trupp an, um die Überwachung zu starten.',
    newTrupp: 'Trupp anlegen',
    // create / edit / re-deploy form (one shared form, section labels + per-mode titles)
    formCreateTitle: 'Trupp anlegen',
    formEditTitle: 'Trupp bearbeiten',
    formRedeployTitle: 'Wieder einrücken',
    sectionAuftrag: 'Auftrag',
    sectionTeam: 'Trupp',
    auftragLabel: 'Art',
    auftragOpen: 'Auftrag offen',
    // DISPLAY labels for the Auftrag types, keyed by the auftrag `id` (appConfig.atemschutz.auftrag).
    // de = current German labels; en/fr/it translate. The stored auftrag value is always the id —
    // only the label localizes; falls back to the config label when a key is missing.
    auftragLabels: {
      retten: 'Retten',
      loeschen: 'Löschen',
      absuchen: 'Absuchen',
      sichern: 'Sichern',
      erkunden: 'Erkunden',
      anderes: 'Anderes',
    } as Record<string, string>,
    zielLabel: 'Auftrag / Ziel',
    zielPlaceholder: 'z. B. 2OG links',
    zielOtherPlaceholder: 'Auftrag beschreiben',
    zielClear: 'Auftrag / Ziel leeren',
    // Order of the cards on the board. Überfällige Trupps ALWAYS sit at the top – that is not a
    // setting, it is the reason this board exists.
    orderLabel: 'Reihenfolge',
    orderUrgency: 'Dringlichkeit',
    orderManual: 'Wie gesetzt',
    orderAuftrag: 'Auftrag',
    orderName: 'Name',
    moveBack: 'Karte nach vorne schieben',
    moveForward: 'Karte nach hinten schieben',
    leaderLabel: 'Gruppenführer',
    leaderPlaceholder: 'Name Gruppenführer',
    memberLabel: 'AdF',
    // ⚠️ NOT «(optional)». This is the row you opened in order to enter a Gast — the + beside
    // it is disabled until it says something, so «optional» described the field before it
    // existed rather than the one in front of you.
    guestNamePlaceholder: 'Name',
    addMember: 'AdF hinzufügen',
    removeMember: 'AdF {n} entfernen',
    // Trupp selection (TruppTeam) — a list to tap instead of three fixed fields. The three
    // fields could name a Trupp but not rearrange it: whoever was typed first was Gruppenführer
    // forever. The star is the correction, and it costs one tap.
    teamEmpty: 'Noch niemand im Trupp. Unten antippen.',
    // Three slots are always there — that is what a Trupp looks like (GF + 2), and an empty slot
    // says «hier kommt der nächste hin» more clearly than a sentence. The row itself picks the GF.
    // ⚠️ The slot wears its ROLE in the badge column (leaderBadge / memberLabel); this is only the
    // quiet placeholder in the name column, and it is the same en dash every other empty value in
    // the app uses — not an em dash, which read as a heavier statement than «noch niemand».
    teamSlotEmpty: '–',
    teamSearchPlaceholder: 'Person suchen …',
    teamNoMatches: 'Kein Treffer',
    leaderBadge: 'GF',
    makeLeader: '{name} als Gruppenführer',
    teamRemove: '{name} aus dem Trupp nehmen',
    // somebody who is already in another active Trupp: visible, but not selectable – one person,
    // one Trupp. Hiding them meant the search simply found nothing.
    teamTaken: 'in einem Trupp',
    // Typed by hand, i.e. with no link to the roster – a Gast, a Nachbarwehr, an AdF whose
    // roster row never synced. The SAME word the Anwesenheit uses for the same person
    // (anwesenheit.guestBadge): one thing, one name for it, on both screens.
    teamManual: 'Gast',
    teamTypeName: 'Name eingeben (Gast / Nachbarwehr)',
    teamAdd: 'Hinzufügen',
    // Leitung: the same number as on the drawn Leitung (Lage/Plan) — that is how Trupp and
    // Schlauchleitung find each other, without anybody typing anything twice.
    lineNoLabel: 'Leitung Nr.',
    lineLegacyNote: 'Früher erfasst: «{value}»',
    lineOptsLabel: 'Gezeichnet:',
    lineTakeTitle: 'Leitung {n} ist vergeben',
    lineTakeMsg: 'Auf Leitung {n} ist Trupp {from}. Neu Trupp {to} darauf?',
    lineTakeConfirm: 'Übernehmen',

    lineOptTaken: 'Trupp {name} ist auf dieser Leitung',
    lineShow: 'Leitung auf der Karte zeigen',
    linePick: 'Leitung wählen',
    linePickHint: 'Leitung auf der Lage oder im Plan antippen',
    linePickCancel: 'Auswahl abbrechen',
    lineUnlink: 'Leitung lösen',
    lineLinkedToast: 'Leitung {n} mit {name} verknüpft',
    logLineLinked: 'Trupp {name} auf Leitung {n}',
    logLineUnlinked: 'Trupp {name}: Leitung gelöst',
    pressureLabel: 'Eingangsdruck (bar)',
    newPressureLabel: 'Neuer Eingangsdruck (bar)',
    // ⚠️ «Trupp bearbeiten» shows the Eingangsdruck too. It used to be the one field the form
    // hid, so a mistyped 200 for 300 at der Anmeldung could only be corrected by deleting the
    // Trupp — and the Eingangsdruck is what every Verbrauchsrechnung and the tiefster Druck on
    // the Rapport are measured against. Correcting it does NOT touch the contact clock: this is
    // a correction of what was written down, not a new Druckmeldung (that is the card's ± ).
    editPressureLabel: 'Eingangsdruck korrigieren (bar)',
    editPressureHint: 'Korrigiert den erfassten Eingangsdruck – zählt nicht als Funkkontakt.',
    funkkanalSection: 'Funkkanal',
    funkkanalDown: 'Funkkanal runter',
    funkkanalUp: 'Funkkanal hoch',
    funkkanalUnit: 'Kanal',
    clearName: 'Name leeren',
    notPresent: 'nicht anwesend',
    noRoster: 'Keine Mannschaft verfügbar',
    officersOnly: 'nur Offiziere',
    typeName: 'Name eingeben …',
    assignedConflict: '{name} ist bereits in einem anderen Trupp.',
    // when the slot is linked but nameless — used to be a German literal in the code
    assignedFallbackName: 'Diese Person',
    cancel: 'Abbrechen',
    save: 'Speichern',
    start: 'Trupp anmelden',
    reenterSubmit: 'Einrücken',
    // Second path when re-entering: new cylinder, new Auftrag, but not under PA yet – the Trupp
    // waits as a Sicherungstrupp and is started later with «Eingerückt».
    reenterStandby: 'Bereitstellen',
    reenterStandbyHint: 'Trupp als Reserve anmelden – die Kontaktuhr startet erst mit «Eingerückt».',
    // board card
    colorLabel: 'Farbe',
    colorAuto: 'Automatisch',
    colorAutoHint: 'Farbe der Wehr für diesen Auftrag, sonst die nächste freie – jeder Trupp eine andere.',
    sinceContact: 'Seit letztem Kontakt',
    elapsed: 'Einsatzzeit',
    // Break clock: how long the Trupp has been out. The Einsatzzeit stands still from «Raus» on
    // (it is finished), this one runs instead – that is the number the Überwacher needs for the
    // recovery time before the next Einsatz.
    outFor: 'Draussen seit',
    estimated: 'Erwartet (Schätzung)',
    estimatedHint: 'Planungshilfe – bis genügend Druckverlauf vorliegt, geschätzt mit {liters} L Flasche und {rate} L/min Verbrauch. Ersetzt keine Druckmeldung.',
    estimatedHintHistory: 'Planungshilfe – aus dem bestätigten Druckverbrauch dieses Trupps hochgerechnet. Ersetzt keine Druckmeldung.',
    estimatedSourceHistory: 'aus {count} Druckwerten · Stand {time}',
    estimatedSourceFallback: '{rate} L/min angenommen · Stand {time}',
    currentPressure: 'Druck',
    lowestPressure: 'Tiefster',
    // Alarmdruck on the Trupp card. The «Schätzung» variant applies when only the projection has
    // reached the threshold – an estimate must never sound like a reported Druckmeldung.
    alarmNote: 'Alarmdruck {bar} bar erreicht',
    alarmNoteEst: 'Alarmdruck {bar} bar – laut Schätzung erreicht',
    lineField: 'Leitung',
    edit: 'Bearbeiten',
    pressureDown: '{step} bar weniger',
    pressureUp: '{step} bar mehr',
    pressureConfirm: 'Bestätigen',
    pressureConfirmHint: 'Neuen Druck bestätigen – zählt als Kontakt',
    // ⚠️ A HINT, never a block. Air does not come back, so a rising value is almost always a
    // typo — but «almost always» is not «always»: it is also how a wrong Eingangsdruck gets
    // corrected, and at 3am the app does not get to refuse what the Überwacher says they read
    // off the gauge. Shown while the value is still pending, so it can be fixed before it
    // becomes a record rather than undone afterwards.
    pressureRose: 'Höher als zuletzt ({from} bar) – vertippt?',
    // per-Trupp contact/pressure log (expandable on the card)
    verlauf: 'Verlauf',
    // ⚠️ «Alarmdruck» and «Rückzug» are the two rows the printed Atemschutz-Journal is read for.
    // Both used to be indistinguishable on it — the Alarmdruck as one «Druck» among a column of
    // them, the Rückzug as a plain «Kontakt».
    readingKind: {
      registered: 'Angemeldet', entry: 'Eingerückt', contact: 'Kontakt', pressure: 'Druck',
      alarm: 'Alarmdruck', rueckzug: 'Rückzug',
    } as Record<string, string>,
    // contact-clock state words (carry the state as TEXT, not colour alone — colourblind-safe)
    clockOk: 'Kontakt ok',
    clockWarn: 'Kontakt fällig',
    clockOverdue: 'Überfällig',
    // header overdue badge ({n} = number of überfällige Trupps) — a BUTTON: it jumps to the
    // Trupp that has been out of contact longest, the way the TopBar chip jumps to this board
    overdueBadge: '{n} überfällig',
    overdueBadgeGo: 'Zu Trupp {name} – am längsten ohne Kontakt',
    // cross-surface TopBar chip (shown on any surface while a Trupp is fällig/überfällig)
    chipHint: 'Atemschutz – antippen zur Überwachung',
    // lifecycle action buttons
    actEnter: 'Eingerückt',
    actContact: 'Kontakt',
    actRueckzug: 'Rückzug',
    actContinue: 'Fortsetzen',
    actExit: 'Raus',
    actReenter: 'Wieder einrücken',
    // A Sicherungstrupp mostly does NOT go in. Until 08.08. you could only delete it – i.e. throw
    // away the one thing proving it stood ready. It is now closed out like any other: under
    // «Draussen», with a break clock, ready to re-enter at any time.
    actNotDeployed: 'Nicht eingesetzt',
    actNotDeployedHint: 'Trupp abschliessen, ohne dass er unter AS war – bleibt für einen erneuten Einsatz bereit',
    // status word and Verlauf row for exactly this case: «draussen» claims it had been inside
    statusNotDeployed: 'Nicht eingesetzt',
    logNotDeployed: 'Trupp {name} nicht eingesetzt',
    exitConfirmTitle: 'Trupp draussen?',
    exitConfirmMsg: 'Den Trupp als draussen markieren und die Überwachung beenden?',
    remove: 'Entfernen',
    // removal happens immediately with an undo toast (no confirmation dialog)
    removedToast: 'Trupp {name} entfernt',
    place: 'Platzieren',
    placeWhere: 'Wohin platzieren?',
    placeNoTarget: 'Kein Plan vorhanden – erst ein Gebäude aus den Umrissen anlegen.',
    showOnPlan: 'Auf Plan zeigen',
    showOnMap: 'Auf der Lage zeigen',
    rosterLabel: 'Bereits erfasst',
    preEntryHint: 'Noch nicht eingerückt – «Eingerückt» drücken, sobald der Trupp unter AS geht.',
    // alarm sound toggle (per-device, persisted locally)
    alarmOn: 'Alarmton an',
    alarmOff: 'Alarmton aus',
    // OS notification when a Trupp goes überfällig while the app is backgrounded
    alarmNotifyTitle: 'Atemschutz überfällig',
    alarmNotifyBody: 'Trupp {name} überfällig – Kontakt herstellen.',
    // status labels
    status: { angemeldet: 'Angemeldet', aktiv: 'Im Einsatz', rueckzug: 'Rückzug', ueberfaellig: 'Überfällig', raus: 'Draussen' } as Record<string, string>,
    // Verlauf templates ({name}, {bar}, {status})
    logRegister: 'Trupp {name} angemeldet – Eingangsdruck {bar} bar',
    // Verlauf row for when somebody changes the safety values. WITH old and new values:
    // «geändert» alone doesn't say whether the threshold got stricter or looser.
    logSafety: 'Atemschutz-Sicherheitswerte geändert: {changes}',
    logSafetyInterval: 'Funkkontakt-Intervall {from} → {to} min',
    logSafetyGrace: 'Nachfrist {from} → {to} s',
    logSafetyFunkkanal: 'Funkkanal {from} → {to}',
    logPlaced: 'Trupp {name} auf Plan platziert',
    logPlacedMap: 'Trupp {name} auf der Lage platziert',
    placeLage: 'Lagekarte',
    logEntry: 'Trupp {name} eingerückt',
    logContact: 'Trupp {name}: Kontakt bestätigt',
    logPressure: 'Trupp {name}: Druck {bar} bar',
    // Rückzug and Fortsetzen reset the contact clock; that has to be in the Verlauf, otherwise
    // the clock jumps in the record for no visible reason.
    logRueckzug: 'Trupp {name}: Rückzug – gilt als Funkkontakt',
    logContinue: 'Trupp {name}: Einsatz fortgesetzt – gilt als Funkkontakt',
    // Fallback for when the form was saved without anything having changed.
    logEdit: 'Trupp {name}: bearbeitet',
    // The normal case: the row SAYS what changed. «Auftrag angepasst» used to appear even when
    // an AdF had been taken out of the Trupp – and that is exactly what somebody asks about
    // afterwards.
    logEditFields: 'Trupp {name}: {changes}',
    changeLeader: 'Gruppenführer {from} → {to}',
    changeMemberOut: '{names} aus dem Trupp genommen',
    changeMemberIn: '{names} dazugekommen',
    changeAuftrag: 'Auftrag angepasst',
    changeLine: 'Leitung {n}',
    changeLineCleared: 'Leitung gelöst',
    changeFunkkanal: 'Funkkanal {n}',
    changeColor: 'Farbe geändert',
    // A corrected Eingangsdruck names BOTH numbers: the record has to show what it used to say,
    // because everything derived from it (Verbrauch, tiefster Druck) was computed from the old one.
    changePressure: 'Eingangsdruck {from} → {to} bar',
    logColor: 'Trupp {name}: Farbe geändert',
    logExit: 'Trupp {name} draussen',
    logReenter: 'Trupp {name} wieder eingerückt – Eingangsdruck {bar} bar',
    logStandby: 'Trupp {name} bereitgestellt – noch nicht eingerückt',
    logAlarm: 'Atemschutz-Alarm: Trupp {name} – {status}',
    // The Alarmdruck used to be visible only on the card – the record was missing the moment the
    // Trupp had to turn back. Only on CROSSING it, not on every value below it.
    //
    // ⚠️ This REPLACES the plain `logPressure` row for that one reading – it does not follow it.
    // Both were written, so the crossing arrived as «Druck 100 bar» and «Alarmdruck 100 bar
    // erreicht» on two lines in the same minute: the same event twice, which on a printed
    // Atemschutz-Journal reads as two Druckmeldungen. `{bar}` is therefore the READING, not the
    // threshold – the number that was measured is the fact, and «Alarmdruck erreicht» already
    // says what it means. The threshold itself is station doctrine and stands on the Rapport.
    logPressureAlarm: 'Trupp {name}: Druck {bar} bar – Alarmdruck erreicht',
    // A Trupp disappearing from the board is the one action that used to leave nothing behind at
    // all – the toast was gone and the Trupp had never existed.
    logRemoved: 'Trupp {name} gelöscht',
    logRestored: 'Trupp {name} wiederhergestellt',
  },
  // FKS hose-line device-letter labels (line decoration editor + tooltips)
  lineDecor: {
    W: 'Wasser',
    S: 'Schaum',
    H: 'Hydroschild',
    P: 'Pulver',
  } as Record<string, string>,
  // data-layer messages (lib/incidents): generated incident title + client-side GeoJSON checks
  incidents: {
    migratedTitle: 'Migrierter Arbeitsstand',
    geojsonNotJson: 'Keine gültige JSON-Datei.',
    geojsonNotFc: 'Kein GeoJSON FeatureCollection.',
    geojsonNotWgs84: 'Koordinaten wirken wie LV95, nicht WGS84 [lng, lat]. Vorher nach EPSG:4326 umprojizieren.',
  },
  entities: {
    photoLabel: 'Foto',
    photoSubtitle: 'Foto-Pin',
    noteSubtitle: 'Notiz',
    fallbackObjectName: 'Objekt',
  },
  notes: {
    deleteTitle: 'Notiz entfernen?',
    deleteMsg: 'Diese Notiz enthält Text. Wirklich entfernen?',
    // note styling — shared by the Lage map and the Plan whiteboard (same controls in the
    // armed-tool dock before placing and in the detail panel afterwards)
    section: 'Notiz',
    content: 'Text',
    size: 'Grösse',
    sizeS: 'Klein',
    sizeM: 'Normal',
    sizeL: 'Gross',
    look: 'Darstellung',
    lookPill: 'Zettel',
    lookPlain: 'Klartext',
    color: 'Farbe',
    resizeHint: 'Breite ziehen',
    settings: 'Notiz einstellen',
    done: 'Fertig',
  },
  whiteboard: {
    documentListTitle: 'Planunterlagen',
    fit: 'Fit',
    pan: 'Auswahl',
    team: 'Trupp',
    draw: 'Zeichnen',
    text: 'Notiz',
    symbol: 'Symbol',
    line: 'Linie',
    area: 'Fläche',
    dockHints: {
      draw: 'Auf den Plan ziehen, um frei zu zeichnen. Farbe, Stärke und Linienart unten wählen.',
      line: 'Eckpunkte antippen. Doppeltippen oder «Fertig» schliesst die Linie ab. Stil unten wählen.',
      area: 'Eckpunkte antippen (mind. 3). Doppeltippen oder «Fertig» schliesst die Fläche ab.',
      text: 'Auf den Plan tippen, um eine Notiz zu setzen. «Textfeld» macht daraus einen mehrzeiligen Block, dessen Breite sich am rechten Rand ziehen lässt.',
      resource: 'Auf den Plan tippen, um einen Trupp zu setzen. Zum Verschieben ziehen.',
      scale: 'Die zwei Endpunkte des gedruckten Massstabs antippen, dann die reale Länge eingeben. Danach zeigen Linien mit «Länge» echte Meter.',
      measure: 'Punkte auf den Plan tippen. «Strecke» zeigt die Distanz, «Fläche» den Inhalt + Umfang – in echten Metern, sobald der Massstab kalibriert ist. Punkte ziehen zum Verschieben, doppeltippen entfernt einen Punkt.',
    },
    // Plan-Maßstab (calibrate against a printed scale bar so plan lines read in metres)
    scale: {
      tool: 'Massstab',
      promptTitle: 'Massstab festlegen',
      promptBody: 'Reale Länge der abgegriffenen Strecke (z. B. der Massstabsbalken):',
      unit: 'm',
      confirm: 'Übernehmen',
      cancel: 'Abbrechen',
      // The chip floats ABOVE the plan, so every word costs plan. The icon already says
      // «Massstab»; the text only says where you stand.
      chipCalibrated: 'Ref. {m} m',
      chipUncalibrated: 'nicht kalibriert',
      recalibrate: 'Neu kalibrieren',
      calibrate: 'Massstab kalibrieren',
      calibrateHint: 'Zwei Punkte des Massstabs antippen',
      stale: 'Massstab neu prüfen',
      saved: 'Massstab kalibriert ({m} m Referenz)',
      // #3: persist a calibration station-wide (across incidents) so plans measure out of the box
      persistTitle: 'Massstab merken?',
      saveAll: 'Für alle Pläne',
      saveThis: 'Nur dieser Plan',
      savedAll: 'Als Standard-Massstab gespeichert',
      savedThis: 'Massstab für diesen Plan gespeichert',
      needsCalibration: 'Massstab festlegen: die zwei Enden des Massstabs antippen',
      // read-only (Führungsansicht / viewer): measuring only works once somebody with write
      // rights has set the Massstab – never show a button that would fail
      needsCalibrationViewer: 'Messen erst möglich, wenn der Massstab kalibriert ist',
    },
    finishShape: 'Fertig',
    cancelShape: 'Abbrechen',
    insertVertex: 'Punkt einfügen',
    dragVertex: 'Eckpunkt ziehen · Doppeltippen zum Löschen',
    groupDeleted: 'Auswahl entfernt',
    groupDeletedN: '{n} Objekte vom Plan entfernt',
    placeText: 'Notiz auf Plan gesetzt',
    placeSymbol: 'Symbol "{name}" auf Plan gesetzt',
    placeLine: 'Linie auf Plan gezeichnet',
    placeArea: 'Fläche auf Plan gezeichnet',
    placeTeam: '{name} auf Plan gesetzt',
    selectTrupp: 'Welcher Trupp?',
    newTeam: 'Neuer Trupp',
    // A Trupp stands in exactly ONE place. Tapping it again in this list MOVES it — what was
    // meant was almost always a second Trupp. Hence greyed out instead of selectable.
    truppPlacedHere: 'schon hier',
    truppPlacedElsewhere: 'auf {where}',
    truppOnMap: 'der Karte',
    truppOnPlan: 'einem Plan',
    showTrupp: 'Im Atemschutz zeigen',
    markPosition: 'Position markieren',
    positionMarked: '{name}: Position markiert',
    clearTrail: 'Spur löschen',
    clearTrailConfirm: 'Alle {n} markierten Positionen von {name} löschen? Die Spur verschwindet von Karte und Plan.',
    trailCleared: '{name}: Spur gelöscht',
    teamColor: 'Farbe',
    trails: 'Spuren',
    trailsOn: 'Spuren einblenden',
    trailsOff: 'Spuren ausblenden',
    deleteLocked: 'Trupp mit erfasstem Verlauf – zuerst Spur löschen',
    drawCreated: 'Zeichnung auf Plan erstellt',
    placeSymbolHint: 'Auf den Plan tippen, um "{name}" zu setzen',
    textHint: 'Auf den Plan tippen, um Text zu setzen',
    teamHint: 'Auf den Plan tippen, um einen Trupp zu setzen',
    textPlaceholder: 'Notiz ...',
    blankHint: 'Leeres Blatt – mit Zeichnen, Text, Symbol oder Trupp beschriften',
    osmLoading: 'Gebäudeumrisse werden geladen …',
    osmError: 'Gebäudeumrisse (OSM) nicht erreichbar',
    osmEmpty: 'Keine Gebäude in diesem Bereich',
    osmRetry: 'Erneut laden',
    osmPickHint: 'Gebäude antippen, dann übernehmen',
    osmTransfer: 'Übernehmen ({n})',
    osmClear: 'Auswahl löschen',
    addFloorUp: 'Obergeschoss hinzufügen',
    addFloorDown: 'Untergeschoss hinzufügen',
    removeFloor: 'Geschoss entfernen',
    removeFloorConfirm: '{floor} enthält Skizzen oder Markierungen. Geschoss trotzdem entfernen?',
    floorRemoved: 'Geschoss entfernt',
    floorAdded: 'Geschoss hinzugefügt',
    buildingReplaced: 'Gebäude ersetzt',
    replaceBuilding: 'Anderes Gebäude wählen',
    replaceBuildingConfirm: 'Es bestehen Skizzen auf den Geschossen. Anderes Gebäude wählen und die bisherigen Geschosse verwerfen?',
    otherObject: 'Anderes Objekt',
    // The object decides which plans are loaded – that is why it sits on the plan surface, above
    // the plans it determines. The label names the thing first («Objekt»), then the name: what
    // you look for when you sit down is «bin ich beim richtigen Gebäude?».
    objectLabel: 'Objekt',
    objectNone: 'Kein Objekt',
    // The chip now only names the name – «Objekt» labelled the field, and that is exactly what
    // the value already says. The verb now sits where it was missing entirely: in the read-aloud
    // text.
    objectIs: 'Einsatzobjekt: {name}',
    objectSwitch: 'Einsatzobjekt: {name} – anderes Objekt wählen',
    objectSwitchShort: 'Anderes Objekt wählen',
    objectActive: 'Pläne von "{name}"',
    objectReset: 'Auf nächstes Objekt zurücksetzen',
    // tapping an object in the picker swaps the plans of EVERY module at once, so it
    // is gated behind a confirmation to avoid an accidental tap blowing away context.
    objectSwitchConfirmTitle: 'Anderes Objekt laden',
    objectSwitchConfirm: 'Die Pläne aller Module werden auf «{name}» umgestellt. Aktuelles Objekt wechseln?',
    objectSwitchConfirmCta: 'Objekt laden',
    // Gebäudeview orientation: the footprint auto-rotates so its longest axis runs
    // horizontal; the north arrow shows the applied rotation; the toggle is reversible.
    northLabel: 'N',
    northTitle: 'Nordrichtung – Gebäude auf Längsachse gedreht',
    orientNorthUp: 'Norden oben',
    orientLongAxis: 'Auf Längsachse drehen',
  },
  contextPanel: {
    titlePlaceholder: 'Bezeichnung ...',
    titleTypePick: 'Typ wählen …',
    // ⚠️ The generic Fahrzeug is the ONE symbol whose label is its identity («TLF», nicht
    // «Fahrzeug»), so it keeps an editable name — as a field down here rather than as the panel
    // header. Every other symbol's header says which symbol it is and is read-only; was etwas
    // Besonderes über eines zu sagen ist, gehört in die Notizen.
    labelField: 'Bezeichnung',
    labelCustom: 'Andere Bezeichnung …',
    floor: 'Geschoss',
    floorFrom: 'Von Geschoss',
    floorTo: 'Bis Geschoss',
    floorNone: '–',
    floorClear: 'Zurücksetzen',
    // FKS Entwicklung (spread) section
    spread: 'Entwicklung',
    spreadH: 'Horizontal',
    spreadV: 'Vertikal',
    spreadBounded: 'Grenze',
    spreadBoundedTitle: 'Entwicklungsgrenze (Ausbreitung gestoppt)',
    spreadLeft: 'nach links',
    spreadRight: 'nach rechts',
    spreadUp: 'Obergeschoss (↑)',
    spreadDown: 'Untergeschoss (↓)',
    count: 'Anzahl',
    rotation: 'Drehung',
    // ⚠️ The Anzahl gets the noun it is counting. A “Patientensammelstelle · Anzahl 12” makes a
    // reader ask «Anzahl was» on the one symbol where the number IS the message — and the Kroki
    // prints the label, so the paper inherits the question. Keyed per symbol; anything not listed
    // keeps the plain «Anzahl».
    countBySymbol: {
      'VKF Patientensammelstelle': 'Anzahl Patienten',
      'VKF Sanitaetshilfsstelle': 'Anzahl Patienten',
      'FW Verwundetennest': 'Anzahl Verwundete',
      'VKF Totensammelstelle': 'Anzahl Verstorbene',
      'VKF Sammelstelle': 'Anzahl Unverletzte',
      'VKF Rettungen': 'Anzahl Personen',
    } as Record<string, string>,
    rotationVehicle: 'Fahrzeug',
    rotationFan: 'Lüfter',
    rotationLadder: 'Leiter',
    // Lüfter airflow direction — Einblasen (blows away from the fan, Überdruck) vs Absaugen
    // (arrow reversed to point into the fan; the fan sits in the space but draws air out)
    airflow: 'Luftrichtung',
    airflowBlow: 'Einblasen',
    airflowExtract: 'Absaugen',
    center: 'Zentrieren',
    resetGps: 'GPS',
    resetGpsTitle: 'Auf GPS-Position und -Kurs zurücksetzen',
    // The Kroki is printed hours later. A Fahrzeug that has since driven home takes its symbol
    // with it — the picture then shows no TLF at an Einsatz that had one. «Festhalten» writes
    // the CURRENT position as an override; «GPS» next to it is the way back, so there is no
    // second Fahrzeug behaviour anybody has to remember.
    pinGps: 'Festhalten',
    pinGpsTitle: 'Fahrzeug hier festhalten – es bleibt stehen, auch wenn es wegfährt',
    logPinned: '{name} festgehalten',
    // Verlauf rows from the Fahrzeug feed. They answer «wann ist wer weggefahren» – the question
    // nobody can answer from memory hours later.
    logVehicleArrived: '{name} vor Ort',
    logVehicleLeft: '{name} hat den Einsatzort verlassen',
    // Remove a self-reported position from the Kommandoposten: somebody drives home with sharing
    // still on, or a phone dies on its last fix – the dot then claims a Kraft is somewhere it
    // is not.
    // short enough to fit next to «Zentrieren» in the action row – the long explanation sits in
    // the tooltip below it, not on the button
    stopSharing: 'Standort entfernen',
    stopSharingTitle: 'Selbstgemeldete Position dieser Person entfernen. Sie kann danach jederzeit wieder teilen.',
    stopSharingFailed: 'Standort konnte nicht entfernt werden.',
    // Driver of a LIVE Fahrzeug: the GPS feed knows where it is, never who is at the wheel.
    driverLabel: 'Fahrer',
    driverPlaceholder: 'Name aus der Mannschaft',
    rotateHint: 'Griff ziehen zum Ausrichten',
    // on-canvas caption override for this one symbol (Standard = follow the device default)
    caption: 'Beschriftung',
    captionDefault: 'Standard',
    captionOff: 'Aus',
    captionAuto: 'Auto',
    captionAll: 'Alle',
    notes: 'Notizen',
    notesPlaceholder: 'Allgemeine Notizen …',
    addField: 'Feld hinzufügen',
    removeField: 'Feld entfernen',
    fieldKeyPlaceholder: 'Bezeichnung',
    fieldValuePlaceholder: 'Wert',
    // ⚠️ A field whose value needs a UNIT has to say so in the box. «Kapazität: 80» is ambiguous
    // between litres and cubic metres on the one number a Wasserversorgung is planned from —
    // and the placeholder is the cheapest place to settle it, since it costs nothing to ignore.
    fieldPlaceholders: {
      'Kapazität': 'z. B. 80 m³',
    } as Record<string, string>,
    // two fields with the same label collapse into one on save – {key} = that label
    duplicateField: '«{key}» gibt es schon – nur der letzte Wert bleibt erhalten.',
    // UN-Nr → Stoff auto-fill (Gefahrentafel). unField/stoffField are the detail-row
    // keys the lookup reads/writes (must match the preset's `fields`). The summary is
    // read-only and always carries the "ungeprüft" caveat (dataset not expert-reviewed).
    unField: 'UN-Nr',
    stoffField: 'Stoff',
    unHazardTitle: 'Gefahrgut (ADR)',
    unClass: 'Klasse',
    unKemler: 'Gefahrnummer',
    unLabels: 'Gefahrzettel',
    unPacking: 'Verpackungsgruppe',
    unNoMatch: 'UN-Nr nicht in ADR-Tabelle gefunden',
    // ERG 2024 response block (bundled, offline): guide number + TIH-Distanzen — Planungshilfe
    ergGuide: 'ERG-Leitfaden',
    ergPolymerization: 'Polymerisationsgefahr (P) – Behälter kann gewaltsam bersten',
    ergIsolate: 'Isolation (kleine Menge)',
    ergProtectDay: 'Schutzabstand Tag',
    ergProtectNight: 'Schutzabstand Nacht',
    ergLarge: 'Grosse Menge',
    ergTable3: 'siehe ERG Tabelle 3 (Behälter/Wind)',
    ergDayShort: 'Tag',
    ergNightShort: 'Nacht',
    ergSource: 'Quelle: {v} (PHMSA) – Planungshilfe, nicht validiert',
    ergCameoLabel: 'CAMEO Chemicals (ERG-Details)',
    // the decoded Gefahrnummer hazards (the tactical "kann ich löschen?" answer); the
    // water line is shown red+bold when the Kemler code carries a leading "X".
    unWater: 'Reagiert gefährlich mit Wasser – KEIN Wasser einsetzen!',
    // Deep link to a Sicherheitsdatenblatt-grade source (online; opens in the browser —
    // no live auto-fetch, offline-first). GESTIS is the authoritative German hazmat DB
    // (it has no public by-UN deep link, so it opens its search). `{un}`/`{name}` fill in.
    unLookupLabel: 'Sicherheitsdatenblatt (GESTIS)',
    unLookupUrl: 'https://gestis.dguv.de/search',
    // Kemler/Gefahrnummer decoded hazard meanings (decodeKemler) — the tactical readout.
    // keyed by ADR hazard digit; `kemlerDoubled` = a doubled digit (intensified hazard).
    kemler: {
      '2': 'Gas (Austritt unter Druck oder durch Reaktion)',
      '3': 'Entzündbarer flüssiger Stoff / Gas',
      '4': 'Entzündbarer fester Stoff',
      '5': 'Brandfördernd (oxidierend)',
      '6': 'Giftig / Ansteckungsgefahr',
      '7': 'Radioaktiv',
      '8': 'Ätzend',
      '9': 'Gefahr einer spontanen heftigen Reaktion',
    } as Record<string, string>,
    kemlerDoubled: 'Verstärkte Gefahr (verdoppelte Ziffer)',
  },
  drawingEditor: {
    area: 'Fläche',
    drawing: 'Zeichnung',
    circle: 'Absperrkreis',
    radius: 'Radius',
    fill: 'Füllung',
    move: 'Verschieben',
    points: 'Punkte',
    preset: 'Stil',
    color: 'Farbe',
    width: 'Stärke',
    lineStyle: 'Linie',
    lineSolid: 'Durchgezogen',
    lineDashed: 'Gestrichelt',
    label: 'Text',
    labelPlaceholder: 'Beschriftung …',
    areaLabelPlaceholder: 'z. B. Sektor A / Abschnitt Ost',
    marker: 'Marker',
    markerPlaceholder: 'z. B. R',
    arrow: 'Pfeilspitze',
    ending: 'Abschluss',
    endingNone: 'Keiner',
    endingArrow: 'Pfeil',
    endingTeilstueck: 'Teilstück',
    content: 'Inhalt',
    contentPlain: 'Wasser',
    lineNo: 'Leitung Nr.',
    // Two Leitungen with the same number make the number ambiguous — and the number is what the
    // Atemschutzüberwachung recognises its Leitung by.
    lineNoDuplicate: 'Leitung {n} gibt es hier schon',
    trupp: 'Gehört zu Trupp',
    truppShow: 'Trupp {name} zeigen',
    truppNone: 'Kein Trupp',
    // The Trupp that laid this Leitung is back out. It stays in the field – it is the entry that
    // says who was on this Leitung – just marked as «draussen».
    truppOut: 'draussen',
    floorTag: 'Stockwerk',
    distance: 'Länge',
    // Messung group: the numbers of an already drawn line (length, Schläuche, elevation profile)
    measurement: 'Messung',
    showOnMap: 'Auf Karte',
    inputMode: 'Eingabe',
    modeFreehand: 'Freihand',
    modeNodes: 'Punkte',
    on: 'An',
    off: 'Aus',
    lock: 'Sperren',
    lockHint: 'Sperrt die Form gegen versehentliches Verschieben; tippe das Schloss in der Mitte zum Entsperren.',
    // map LockChip on a locked drawing (short-hold to unlock)
    unlockHold: 'Zum Entsperren gedrückt halten',
    unlocking: 'Entsperren …',
    connections: 'Verbindungen',
    connectedStart: 'Anfang',
    connectedEnd: 'Ende',
    connectedLines: 'Verbundene Linien ({n})',
    line: 'Linie',
    lineLabelNo: 'Leitung {n}',
    route: 'Verlauf',
    routeDirect: 'Direkt',
    routeTrace: 'Spur',
    showConnection: 'Anzeigen',
    detachConnection: 'Verbindung lösen',
    gpsFollowing: 'GPS folgt aktiv',
    gpsMovingAway: 'Fahrzeug bewegt sich weg',
    gpsContinue: 'Weiter folgen',
    gpsDetachHere: 'Hier lösen',
    gpsPause: 'Folgen pausieren',
    gpsMissing: 'GPS-Stand unverändert',
    cycleBlocked: 'Kreisverbindung nicht möglich',
    hiddenTarget: 'Ziel ausgeblendet',
    revealTarget: 'Ebene einblenden',
    removeConnectedTitle: '{name} löschen?',
    removeConnectedMessage: '{n} Linien werden gelöst.',
    removeEMessage: 'Teilstück entfernen? {n} angeschlossene Linien werden gelöst.',
  },
  topBar: {
    offline: 'Offline',
    tiles: 'Tiles',
    recording: 'REC',
    // Caveat on a stalled GPS picture: the Fahrzeuge deliberately do NOT disappear, so the
    // freeze has to be labelled – otherwise hours-old positions look as authoritative as
    // one-minute-old ones.
    gpsFrozen: 'GPS eingefroren',
    gpsFrozenHint: 'Der Live-GPS-Feed antwortet nicht. Die Fahrzeuge stehen auf ihrer zuletzt bekannten Position.',
  },
  // shared compact ±stepper chrome (Stepper.tsx — used everywhere incl. the Einstellungen sheet)
  stepper: {
    less: 'weniger',
    more: 'mehr',
    reset: 'zurücksetzen',
    typeToEnter: 'Tippen zum Eingeben',
  },
  // imperative confirm dialog (lib/ui) default button labels
  confirm: {
    ok: 'OK',
    cancel: 'Abbrechen',
  },
  // custom dropdown (Combo.tsx)
  combo: {
    customDefault: 'Eingeben …',
    empty: 'Keine Auswahl',
    officersOnly: 'nur Offiziere',
    // Deliberately NOT auto-focused: this stays a tap picker, and a keyboard that opens by
    // itself covers exactly the list it filters on a tablet.
    searchPlaceholder: 'Person suchen …',
    noMatches: 'Kein Treffer',
  },
  // Login gate (face picker + PIN pad)
  demo: {
    ribbon: 'DEMO',
    ariaLabel: 'Demo-Instanz mit synthetischen Daten',
    actionBlocked: 'In der Demo nicht möglich.',
    welcome: {
      title: 'Willkommen bei KP Front',
      intro: 'Das ist eine Demo mit erfundenen Daten – kein echter Einsatz. Probier alles frei aus.',
      reloadWarn: 'Alle Besucher bearbeiten gemeinsam denselben Einsatz – deine Änderungen sehen also alle anderen live. Sei nett zu ihnen 🙂 Um Mitternacht und um Mittag wird zurückgesetzt.',
      canTitle: 'Du kannst …',
      can: [
        'Auf Karte und Plan zeichnen und taktische Zeichen setzen',
        'Atemschutz-Trupps und Mittel führen',
        'Zwischen Lage und Plan wechseln und Objektpläne öffnen',
      ],
      knowTitle: 'Gut zu wissen',
      know: [
        'Ihr bearbeitet alle denselben Einsatz gleichzeitig – bitte nichts von anderen löschen, was ihr nicht selbst gesetzt habt.',
        'Um Mitternacht und um Mittag wird die Demo auf den Ausgangszustand zurückgesetzt.',
        'Einen neuen Einsatz kannst du in der Demo nicht eröffnen – aber den laufenden frei bearbeiten.',
        'KP Front ist eine installierbare App (PWA): am Einsatzort läuft sie im Vollbild, offline-fähig und mit eigenem Symbol.',
        'Diese Browser-Demo wird nicht installiert – volle Offline-Nutzung und Benachrichtigungen gibt es erst in der App deiner Wehr.',
      ],
      cta: 'Los geht’s',
    },
  },
  login: {
    subtitle: 'Führungsunterstützung',
    pinEnter: 'PIN eingeben',
    connectionFailed: 'Verbindung zum Server fehlgeschlagen',
    loadingRoster: 'Lade Mannschaft…',
    noUsers: 'Keine Benutzer hinterlegt',
    whoAreYou: 'Wer bist du?',
    loginFailed: 'Anmeldung fehlgeschlagen',
    pleaseWait: 'Bitte kurz warten…',
    clearDigit: 'Löschen',
    retry: 'Erneut versuchen',
  },
  // boot Splash: shown while the /me probe, the incident list or a lazy chunk settles. If a
  // stage takes unusually long the splash grows a status line + an action, so a stalled launch
  // is never a dead screen the operator can only escape by killing the app.
  splash: {
    stuck: 'Start dauert länger als gewöhnlich',
    stuckHint: 'Verbindung schwach oder Server nicht erreichbar. Gespeicherte Einsätze sind offline verfügbar.',
    reload: 'Neu starten',
  },
  // render-throw fallback (ErrorBoundary). Escalates on a repeat crash of the same Einsatz:
  // reloading auto-reopens it, so after the second crash the escape actions take over.
  errorBoundary: {
    title: 'Ein Fehler ist aufgetreten',
    body: 'Die Ansicht konnte nicht geladen werden. Deine lokalen Änderungen sind gespeichert und bleiben erhalten.',
    bodyRepeat: 'Dieser Einsatz lässt sich nicht öffnen – auch nach dem Neuladen nicht. Schliesse ihn, um zur Übersicht zu kommen; die gespeicherten Daten bleiben auf dem Server.',
    reload: 'Neu laden',
    closeIncident: 'Einsatz schliessen',
    discardLocal: 'Lokale Kopie verwerfen',
    discardLocalHint: 'Verwirft nur die Kopie auf diesem Gerät und lädt den Einsatz neu vom Server. Noch nicht synchronisierte Änderungen von diesem Gerät gehen dabei verloren.',
  },
  // PWA update prompt (UpdateBanner). A new build installs and waits (registerType 'prompt')
  // instead of reloading mid-incident; the operator applies it when it's safe.
  update: {
    // announce-only: no in-place «Neu laden» — a full app restart is the path that
    // reliably activates the waiting build (decision 2026-07-09)
    available: 'Update bereit',
    hint: 'Wird beim Neustart aktiv – App schliessen & neu öffnen.',
    dismiss: 'OK',
    updated: 'Aktualisiert – {v}',
  },
  // "Als App installieren" nudge + guide (InstallBanner/InstallGuide). Only in a plain
  // browser tab — installed (standalone) the whole surface disappears. The guide detects the
  // platform and shows ONLY this device's steps; {share} renders the iOS share glyph inline.
  install: {
    menu: 'Als App installieren',
    bannerTitle: 'KP Front als App installieren',
    bannerHint: 'Offline-fähig, Vollbild, eigenes Symbol.',
    bannerAction: 'Anleitung',
    dismiss: 'Später',
    title: 'Als App installieren',
    why: 'Installiert läuft KP Front wie eine App: offline verfügbar am Einsatzort, im Vollbild ohne Browser-Leiste, mit eigenem Symbol auf dem Home-Bildschirm.',
    nativeButton: 'Jetzt installieren',
    nativeHint: 'Der Browser fragt kurz nach – mit «Installieren» bestätigen.',
    manualIntro: 'Oder manuell:',
    installed: 'Installiert! KP Front ab jetzt über das App-Symbol starten.',
    alreadyStandalone: 'KP Front läuft bereits als installierte App.',
    ios: {
      intro: 'Auf iPad/iPhone:',
      steps: [
        'Teilen-Symbol {share} in der Symbolleiste antippen',
        '«Zum Home-Bildschirm» wählen',
        'Mit «Hinzufügen» bestätigen',
      ] as string[],
      note: 'Falls «Zum Home-Bildschirm» fehlt: Seite in Safari öffnen.',
    },
    android: {
      intro: 'In Chrome auf Android:',
      steps: [
        'Menü ⋮ oben rechts antippen',
        '«App installieren» wählen',
        'Bestätigen',
      ] as string[],
      note: 'In anderen Browsern: Menü → «Zum Startbildschirm hinzufügen».',
    },
    desktop: {
      intro: 'In Chrome oder Edge:',
      // The menu first, not the icon: the install icon in the address bar appears ONLY while the
      // page is installable and not yet installed, and Chrome has moved it several times across
      // versions. Somebody who looks for it and can't find it concludes the instructions are
      // wrong. The menu path is always there.
      steps: [
        'Browser-Menü ⋮ oben rechts öffnen',
        '«KP Front installieren» wählen und bestätigen',
      ] as string[],
      note: 'Das Menü führt den Eintrag je nach Version direkt oder unter «Speichern und teilen». Steht rechts in der Adressleiste ein Installations-Symbol, geht es auch damit. Fehlt beides, ist KP Front auf diesem Gerät bereits installiert.',
    },
    macSafari: {
      intro: 'In Safari auf dem Mac:',
      steps: [
        'Menü «Ablage» öffnen',
        '«Zum Dock hinzufügen» wählen',
        'Mit «Hinzufügen» bestätigen',
      ] as string[],
      note: '',
    },
    unsupported: 'Dieser Browser unterstützt die Installation nicht. Am besten die Seite in Chrome, Edge oder Safari öffnen und dort installieren.',
  },
  // single-editor tab lock: a second browser tab on the SAME incident is read-only
  tabLock: {
    title: 'In einem anderen Tab geöffnet',
    hint: 'Dieser Tab ist nur zum Lesen – die Bearbeitung läuft im anderen Tab.',
    takeOver: 'Hier bearbeiten',
  },
  // full-size picture viewer (openPhoto) — a photo used to open in a new tab, which leaves the
  // installed app on iOS
  photoViewer: {
    title: 'Foto',
    download: 'Herunterladen',
  },
  // running incident clock in the TopBar
  einsatzuhr: {
    title: 'Einsatzdauer – Beginn {t}',
    /** aria/labels for the tap-to-cycle clock modes */
    modeElapsed: 'Einsatzdauer',
    modeNow: 'Uhrzeit',
    modeStart: 'Einsatzbeginn',
    cycleHint: 'Tippen: Dauer / Uhrzeit / Beginn',
  },
  // self-contained location picker for the intake wizard (MapPicker)
  mapPicker: {
    title: 'Standort auf Karte setzen',
    hint: 'Auf die Karte tippen, um den Standort zu setzen',
    confirm: 'Standort übernehmen',
  },
  // weather badge + popover (TopBar/WindBadge) — condition labels, cardinals, readout rows
  weather: {
    label: 'Wetter',
    details: 'Wetterdetails',
    // friendly catch-all error — raw fetch/server error texts never reach the UI
    unavailable: 'Wetterdaten zurzeit nicht verfügbar',
    from: 'aus',
    cardinals: ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'] as string[],
    cardinalsLong: ['Nord', 'Nordost', 'Ost', 'Südost', 'Süd', 'Südwest', 'West', 'Nordwest'] as string[],
    windTitle: 'Wind {dir} ({deg}°)',
    detailsHint: ' – für Details tippen',
    meteoHint: ' – für MeteoSchweiz-Details tippen',
    windDir: 'Windrichtung',
    windSpeed: 'Windstärke',
    gust: 'Böen',
    precip: 'Niederschlag',
    station: 'Station',
    source: 'Quelle',
    meteoRadar: 'MeteoSchweiz Niederschlagsradar',
    // Target of the weather badge — the MeteoSchweiz radar page in the deployment's language
    // (every locale overrides with its own admin.ch variant). No coordinate deep link is
    // possible; {lat}/{lng} are substituted in case a future target accepts them.
    detailsUrl: 'https://www.meteoschweiz.admin.ch/service-und-publikationen/applikationen/niederschlag.html',
    conditions: {
      clear: 'Klar', fair: 'Heiter', partly: 'Teils bewölkt', overcast: 'Bedeckt',
      fog: 'Nebel', drizzle: 'Niesel', rain: 'Regen', snow: 'Schnee',
      rainShowers: 'Regenschauer', snowShowers: 'Schneeschauer', thunder: 'Gewitter', cloudy: 'Bewölkt',
    } as Record<string, string>,
  },
  // PDF rendering — status line in PdfScroller + first-load placeholder in PdfViewport (Plan)
  pdf: {
    loading: 'PDF wird geladen…',
    failed: 'PDF konnte nicht geladen werden.',
    retry: 'Erneut laden',
  },
  // Einstellungen sheet (device prefs + synced per-incident settings)
  settings: {
    title: 'Einstellungen',
    deviceGroup: 'Gerät',
    colorScheme: 'Farbschema',
    symbolSize: 'Symbolgrösse',
    symbolCaptions: 'Beschriftungen',
    symbolCaptionsSub: 'Kennwert unter dem Symbol',
    captionsOff: 'Aus',
    captionsAuto: 'Auto',
    captionsAll: 'Alle',
    offlineRadius: 'Offline-Umkreis',
    offlineRadiusSub: 'Karte & Leitungen um den Einsatz',
    keepScreenOn: 'Display anlassen',
    keepScreenOnSub: 'Bildschirm nicht abdunkeln im Einsatz',
    keepScreenOnOn: 'Ein',
    keepScreenOnOff: 'Aus',
    // Used to be called «Einsatzleiter-Ansicht»: the mode locks the tactical layer and names no
    // role – Kdt, Fourier and whoever reads along on the beamer use it just the same. The code
    // identifier stays `elView` so stored device settings keep working.
    elView: 'Führungsansicht',
    elViewSub: 'Taktik gesperrt – Journal & Symbol-Details bleiben aktiv',
    elViewOn: 'Ein',
    elViewOff: 'Aus',
    deviceFoot: 'Gilt nur auf diesem Gerät. Kleinerer Umkreis = schnellerer, kleinerer Offline-Download.',
    incidentGroup: 'Einsatz',
    contactInterval: 'Atemschutz-Funkkontakt',
    contactIntervalSub: 'Intervall bis «Kontakt fällig» (amber)',
    contactIntervalAria: 'Funkkontakt-Intervall',
    grace: 'Nachfrist',
    graceSub: 'Roter Alarm nach Intervall + Nachfrist',
    funkkanal: 'Funkkanal',
    funkkanalSub: 'Standard für neue Atemschutz-Trupps',
    syncedFoot: 'Wird mit allen Geräten synchronisiert',
    syncedFootViewer: ' · nur der Einsatzleiter kann sie ändern',
    // per-device utility: the blank paper Erfassungsblatt (hand-fill fallback), generated
    // from the current roster + Mittel catalogue — same generator as the admin's
    utilityGroup: 'Vorlagen',
    blankSheet: 'Leeres Erfassungsblatt (PDF)',
    blankSheetSub: 'Papierblatt zum Handausfüllen',
    blankSheetDownload: 'Herunterladen',
    blankSheetFailed: 'PDF fehlgeschlagen – nochmals versuchen.',
    feedbackRow: 'Rückmeldung geben',
    feedbackRowSub: 'Was umständlich war oder gefehlt hat',
    feedbackOpen: 'Schreiben',
  },
  // Rückmeldung — the feedback composer + the prompt after something went wrong. Nothing here
  // is sent automatically: the app writes the text, the operator sends it (see lib/feedbackReport).
  feedback: {
    title: 'Rückmeldung',
    // shown on the launcher when a trouble event is waiting to be asked about
    promptTitle: 'Kurz gefragt',
    promptDismiss: 'Nicht jetzt',
    promptOpen: 'Kurz schildern',
    // one per TroubleKind — the prompt asks about the specific thing that happened
    promptFor: {
      crashLoop: 'Die App ist in einem Einsatz mehrmals abgestürzt. Was hast du gerade gemacht?',
      crash: 'Die App ist zuletzt einmal abgestürzt. Was hast du gerade gemacht?',
      storageFull: 'Auf diesem Gerät war der Speicher voll. Ist dabei etwas verlorengegangen?',
      syncConflict: 'Zwei Geräte hatten unterschiedliche Stände. Hat am Ende etwas gefehlt?',
    },
    // the same labels, in the report itself
    kinds: {
      crashLoop: 'wiederholter Absturz im selben Einsatz',
      crash: 'Absturz der Oberfläche',
      storageFull: 'Gerätespeicher voll',
      syncConflict: 'Sync-Konflikt beim Zusammenführen',
    },
    subject: 'Rückmeldung',
    intro: 'Was ist passiert, und was hättest du erwartet? Ein, zwei Sätze genügen.',
    placeholder: 'z. B. «Trupp auf Rückweg gesetzt, dann war der Bildschirm weiss.»',
    techTitle: 'Das wird mitgeschickt',
    techNote: 'Sonst nichts – keine Einsatzdaten, keine Adressen, keine Namen. Die App macht '
      + 'von sich aus keinen Screenshot; ein Bild geht nur mit, wenn du es unten von Hand '
      + 'anhängst. Beim Direktversand wird davon noch weniger übertragen: statt der vollen '
      + 'Browser-Kennung nur die Geräteart, z. B. «iPad Safari».',
    // Attach a photo – direct send only, because copy and e-mail cannot carry a file.
    photoAdd: 'Foto anhängen',
    photoHint: 'Höchstens zwei, werden vorher verkleinert.',
    photoRemove: 'Foto entfernen',
    photoAlt: 'Angehängtes Foto',
    photoTooBig: 'Dieses Bild lässt sich nicht klein genug rechnen – bitte ein anderes.',
    photoOnlyDirect: 'Angehängte Fotos gehen nur beim Direktversand mit – nicht per Kopie oder '
      + 'E-Mail.',
    privacy: 'Nichts wird automatisch gesendet. Du entscheidest, ob, wie und an wen.',
    copy: 'Text kopieren',
    copied: 'Kopiert – jetzt einfügen und senden.',
    copyFailed: 'Kopieren nicht möglich – Text markieren und von Hand kopieren.',
    mail: 'E-Mail schreiben',
    send: 'Senden',
    sending: 'Wird gesendet …',
    // After sending: the server answers with what it actually filed.
    sentTitle: 'Danke – ist angekommen.',
    sentBody: 'Die Rückmeldung liegt auf eurem eigenen Server und geht von dort weiter, sobald '
      + 'eine Verbindung besteht. Bis dahin bleibt sie hier liegen.',
    sentWhat: 'Das wurde gesendet',
    sentEcho: 'Das ist die Antwort eures Servers – also wörtlich das, was er abgelegt hat, nicht '
      + 'bloss eine Vorschau.',
    sendDisabled: 'Direktversand ist auf dieser Anlage abgeschaltet. Per E-Mail oder Kopie geht es '
      + 'weiterhin.',
    sendFailed: 'Senden hat nicht geklappt – vermutlich offline. Per E-Mail oder Kopie geht es '
      + 'trotzdem.',
    close: 'Schliessen',
    tech: {
      version: 'Version:',
      locale: 'Sprache:',
      device: 'Gerät:  ',
      viewport: 'Fenster:',
      network: 'Netz:   ',
      event: 'Vorfall:',
      online: 'online',
      offline: 'offline',
      noDescription: '(keine Beschreibung)',
    },
  },
  // Offline-Bereitschaft readiness diagnostics
  offline: {
    title: 'Offline-Bereitschaft',
    // Shown in a browser tab instead of the readiness list: a tab is no reliable offline state
    // (iOS clears caches after days without use, and the tab then has to still be open at all).
    // Rather than claim a Bereitschaft that won't hold at 3am, the card says what is missing and
    // leads to the install – or says that there is none here.
    browserTitle: 'Offline erst als installierte App',
    browserBody: 'Im Browser-Tab ist nichts verlässlich gespeichert: Karten, Pläne und Leitungen können jederzeit gelöscht werden, und der Tab muss beim nächsten Einsatz noch offen sein. Installiert läuft KP Front auch offline.',
    browserInstall: 'Als App installieren',
    // Platforms with no install path (desktop Firefox …) — say honestly that there is nothing to
    // install here, instead of pointing at instructions that don't exist.
    browserNoInstall: 'Dieses Gerät bietet keine Installation an. Für den Einsatz offline KP Front auf dem Tablet oder Handy installieren.',
    syncNow: 'Jetzt synchronisieren',
    syncedAgo: 'Einsatzdaten {ago} synchronisiert',
    offline: 'Offline – lokal gespeichert',
    pending: 'Wird gespeichert …',
    error: 'Sync-Fehler – lokal gespeichert',
    agoNever: 'noch nicht',
    agoJustNow: 'gerade eben',
    agoMin: 'vor {n} Min',
    agoHour: 'vor {n} Std',
    checking: 'wird geprüft …',
    ready: 'bereit',
    notLoaded: 'nicht geladen',
    loading: 'lädt …',
    rowSymbols: 'Symbole',
    rowHazmat: 'Gefahrgut (UN/ADR)',
    rowMap: 'Karte',
    noLayer: 'kein Layer',
    rowPlans: 'Pläne',
    noObject: 'kein Objekt',
    rowLeitung: 'Leitungskataster',
    geoAllReady: 'alle {n} bereit',
    geoSome: '{cached}/{total} geladen',
    rowWeather: 'Wetter',
    weatherUnreachable: 'nicht erreichbar',
    onlineOnly: 'nur online',
    rowPersonnel: 'Mannschaft',
    personnelCount: '{n} Personen',
    rowObjectSearch: 'Objektsuche',
    // Device storage — the readiness row that never existed: a full device stores NOTHING
    // offline, no matter how green every other row is.
    rowStorage: 'Gerätespeicher',
    storageFree: '{size} frei',
    storageUnknown: 'Gerät meldet keinen Speicherstand',
    storageFullShort: 'Voll – nichts wird lokal gesichert',
    storageFull: 'Speicher voll – Änderungen sind nicht lokal gesichert',
    // Pre-flight check for «Alles für offline laden»: the offline stock and the Einsatzrapport
    // share the same storage, so a map download must not crowd the Rapport out.
    dlTightTitle: 'Wenig Speicher auf diesem Gerät',
    dlTightMsg: 'Der Download braucht ≈ {need}, frei sind {free}. Reduziert wird das ganze Gebiet geladen, aber weniger detailliert (etwa {pct} % der Kartenkacheln). Der Einsatzrapport behält so Platz.',
    dlTightConfirm: 'Reduziert laden',
    dlNoSpace: 'Zu wenig Speicher für den Offline-Vorrat (nur {free} frei). Bitte Platz auf dem Gerät freigeben.',
    loadingForOffline: 'Lädt für offline …',
    loadAll: 'Alles für offline laden',
    foot: 'Lädt Karte, Pläne, Symbole und Leitungen für diesen Einsatz auf dieses Gerät. Wetter und Objektsuche brauchen eine Verbindung und sind offline nicht verfügbar.',
    // workspace load gate (lib/workspace sanitizeWorkspace): honest reporting, never silent
    wsDropped: '{n} beschädigte Einträge beim Laden übersprungen',
    wsNewer: 'Einsatzdaten stammen von einer neueren App-Version – bitte App aktualisieren.',
    // LayerPanel offline-download button + the App map-download toasts
    layerGroup: 'Offline',
    loadMap: 'Karte offline laden',
    loadingShort: 'Lädt … {done}/{total}',
    dlDone: 'Karte offline verfügbar ({n} Kacheln)',
    dlDoneCapped: 'Karte offline verfügbar (Ausschnitt begrenzt, {n} Kacheln)',
    dlFailed: 'Offline-Download fehlgeschlagen',
  },
  // App empty state — shown when no incident is open (viewer vs. editor variants)
  emptyApp: {
    title: 'Kein offener Einsatz',
    bodyViewer: 'Zurzeit ist kein Einsatz aktiv.',
    bodyPoolOne: '1 Alarm im Pool – eröffnen und auf der Karte prüfen.',
    bodyPoolMany: '{n} Alarme im Pool – eröffnen und auf der Karte prüfen.',
    // ⚠️ The NEUTRAL sentence is the default; the one naming the Alarmquelle is the exception.
    // «übernimm einen Divera-Alarm» was shown to every station — including the ones running on
    // another source, and the ones entering every Einsatz by hand, who were being pointed at a
    // product they do not have. Which name (if any) appears comes from
    // deploymentConfig · alarmProviderName().
    bodyEditor: 'Eröffne einen Einsatz.',
    bodyEditorAlarm: 'Eröffne einen Einsatz oder übernimm einen {provider}-Alarm.',
    history: 'Verlauf',
  },
  // «Neuer Einsatz» banner — announces an Einsatz that appeared mid-session (auto-open, a
  // generic incoming alarm, or a take on another device); never switches automatically.
  incidentAlert: {
    kicker: 'Neuer Einsatz',
    switch: 'Wechseln',
    open: 'Öffnen',
    later: 'Später',
  },
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
    logMittel: '{label}: {menge} {unit} (QR, {by})',
    logAttachmentAdd: 'Rapport-Foto hinzugefügt (QR)',
    logAttachmentRemove: 'Rapport-Foto entfernt (QR)',
    logMeta: 'Rapportangaben geändert (QR): {fields}',
    title: 'Einsatz erfassen',
    invalid: 'Link ungültig oder Erfassung deaktiviert.',
    noIncidents: 'Zurzeit kein erfassbarer Einsatz.',
    noIncidentsHint: 'Hier erscheinen laufende und noch nicht rapportierte Einsätze. Fehlt euer Einsatz? Auf dem Papier-Erfassungsblatt notieren oder der Einsatzleitung melden – sie kann ihn später nachtragen.',
    whoTitle: 'Wer erfasst?',
    searchName: 'Name suchen …',
    back: 'Zurück',
    alarmedAt: 'Alarm {t}',
    saveFailed: 'Speichern fehlgeschlagen – nochmals versuchen.',
    saveFailedOffline: 'Kein Empfang – die letzte Änderung wurde nicht gespeichert.',
    retry: 'Nochmals versuchen',
    savedOk: 'Gespeichert',
    undo: 'Rückgängig',
    removedEntry: '{name} entfernt (inkl. Zeiten)',
    mittelSet: '{label}: neu {n} {unit}',
    mittelRemoved: '{label} entfernt',
    stepLess: 'Eins weniger',
    stepMore: 'Eins mehr',
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
    partnerRemove: 'Organisation entfernen',
    // header of the collapsible sections — says while collapsed whether anything is in there yet
    partnerCount: '{n} erfasst',
    partnerNone: 'keine',
    beilagenHead: 'Fotos',
    beilagenAdd: 'Foto hinzufügen',
    beilagenBusy: 'Wird hochgeladen …',
    beilagenCaption: 'Bildlegende',
    beilagenRemove: 'Foto entfernen',
    beilagenFailed: 'Foto konnte nicht hochgeladen werden.',
    beilagenCount: '{n} Foto(s)',
    beilagenNone: 'keine',
    kurzberichtPlaceholder: 'Was ist passiert, was wurde gemacht?',
    zeitenHead: 'Zeiten',
    gruppenHead: 'Alarmierung Gruppen',
    fahrzeugeHead: 'Ausrückzeiten Fahrzeuge',
    angabenHead: 'Angaben',
    einsatzleiter: 'Einsatzleiter',
    rueckName2: 'Name',
    rapportPdf: 'Rapport-PDF',
    pdfFailed: 'PDF fehlgeschlagen – nochmals versuchen.',
    sectionZeiten: 'Zeiten',
    sectionAngaben: 'Angaben',
    zeitenFilled: '{n} Zeiten erfasst',
    abschlussHead: 'Abschluss',
    pdfMissing: 'Noch leer (wird als Leerfeld gedruckt): {fields}',
    ausgerueckt: 'Ausgerückt',
    kontaktperson: 'Kontaktperson',
    kontaktpersonPlaceholder: 'Eigentümer / Melder / Verantwortliche(r)',
    von: 'von',
    bis: 'bis',
    ende: 'Einsatzende',
    endeNow: 'Jetzt setzen',
    sectionPersonen: 'Anwesenheit',
    presentCount: '{n} anwesend',
    tapHint: 'Antippen: nicht anwesend → Magazin → Vor Ort → gegangen. Zeit daneben: von = Ankunft, nach Weggang bis = Weggang.',
    tapHelp: 'Hilfe zur Bedienung',
    statePresent: 'anwesend',
    stateLeft: 'gegangen',
    sectionMaterial: 'Material',
    sectionAllgemein: 'Allgemein',
    selectPerson: 'Name wählen …',
    whoHint: 'Wird im Rapport als «Erfasst von» festgehalten.',
    cancel: 'Abbrechen',
    mittelCount: '{n} Positionen',
    pickMaterial: 'Material wählen …',
    add: 'Hinzufügen',
    sectionNotizen: 'Notizen',
    notePlaceholder: 'Notiz für den Verlauf …',
    footNote: 'Alles wird laufend gespeichert.',
    loadFailedOffline: 'Kein Empfang – bitte nochmals versuchen.',
    clockSkew: 'Die Uhr dieses Geräts weicht um {n} Minuten ab – erfasste Zeiten prüfen.',
    searchMaterial: 'Material suchen …',
    // Cross-visibility QR ↔ KP: the live-dot line in the capture header once the KP tablet
    // has the incident (editor_opened_at latch), and the quiet hint that de-emphasizes the
    // print buttons — the full rapport (incl. Lageskizze) will come from the KP.
    kpActive: 'KP-Tablet aktiv',
    kpActiveHint: 'Das KP-Tablet ist im Einsatz – der vollständige Rapport (mit Kroki) kommt von dort.',
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
  // Einsatz-Link (/l/<token>) — the view opened straight out of the alert message: no login, one
  // Einsatz, read-only. Whoever reads this is standing somewhere in the dark at night with
  // exactly this one screen – so every message says what to do now.
  incidentLink: {
    opening: 'Einsatz wird geöffnet …',
    // A 404 can be a race: the alert reaches the phone faster than the Einsatz reaches kp-front.
    // This is the only state that resolves itself.
    pendingTitle: 'Einsatz noch nicht verfügbar',
    pendingHint: 'Der Alarm ist eben erst eingetroffen. Wird automatisch nochmals versucht …',
    notReadyTitle: 'Dieser Einsatz ist nicht abrufbar.',
    notReadyHint: 'Der Link gilt nur, solange der Einsatz läuft. Falls der Alarm eben erst kam: nochmals versuchen. Sonst bei der Einsatzleitung melden.',
    invalidTitle: 'Dieser Link gilt nicht mehr.',
    invalidHint: 'Öffne den Link direkt aus der aktuellen Alarmmeldung.',
    disabledTitle: 'Einsatz-Links sind bei dieser Feuerwehr nicht freigeschaltet.',
    disabledHint: 'Die Einsatzleitung kann sie in der Konfiguration aktivieren.',
    offlineTitle: 'Kein Empfang',
    offlineHint: 'Ohne Verbindung lässt sich der Einsatz nicht öffnen. Sobald du wieder Empfang hast: nochmals versuchen.',
    errorTitle: 'Der Server antwortet nicht.',
    errorHint: 'Bitte nochmals versuchen. Bleibt es dabei: bei der Einsatzleitung melden.',
    retry: 'Nochmals versuchen',
    // the Einsatz could not be loaded after opening the link (signal gone) – the landing page
    // says so instead of showing an empty incident list
    unavailable: 'Dieser Einsatz ist gerade nicht abrufbar. Seite neu laden, sobald du wieder Empfang hast.',
  },
  // Standort teilen — the question put to your own phone and what the pill says afterwards.
  // Deliberately without marketing text: who sees what and when is spelled out in full, because
  // that is exactly the question somebody asks at 3am before tapping «Ja».
  sharePosition: {
    askTitle: 'Standort teilen?',
    askBody: 'Der Kommandoposten sieht dann auf der Lagekarte, wo du bist – damit klar ist, wer wo arbeitet (z. B. beim Wassertransport) und wer erreichbar ist.',
    askWho: 'Sichtbar nur für den Kommandoposten. Andere, die den Einsatz-Link haben, sehen deinen Standort nicht.',
    askHowLong: 'Nur solange dieser Einsatz läuft. Beim Abschluss wird der Standort gelöscht.',
    askBackground: 'Wenn du das Handy sperrst, wird nichts mehr übermittelt – die letzte Position bleibt mit Zeitangabe stehen.',
    // No more «du wirst nur einmal gefragt»: the permission persists, but the sharing itself has
    // to be switched on deliberately for every Einsatz (compass menu).
    askAgain: 'Bei jedem Einsatz musst du das Teilen selbst einschalten – es startet nie von allein.',
    pickTitle: 'Wer bist du?',
    pickHint: 'Damit dein Punkt auf der Karte einen Namen hat.',
    search: 'Name suchen',
    yes: 'Ja, Standort teilen',
    no: 'Nein, danke',
    // compass menu: the one row that switches sharing on and off
    menuOff: 'Standort teilen',
    menuOn: 'Standort teilen – ein',
    // Reasons why the row currently doesn't work. It does NOT disappear — a control that
    // vanishes into thin air is indistinguishable from a feature that was never built.
    menuClosed: 'Nur solange der Einsatz läuft',
    menuDemo: 'Demo: simuliert – dein Standort wird nicht abgefragt',
    // While sharing: stopping has to be stated just as plainly as starting — a device sending a
    // person's location must not hide the way to stop.
    menuOnHint: 'Tippen zum Beenden',
    // pill in the header
    on: 'Standort geteilt',
    starting: 'Standort wird gesucht …',
    paused: 'Standort pausiert',
    pausedHint: 'Das Handy übermittelt nichts, solange die App im Hintergrund oder das Display gesperrt ist. App wieder öffnen, dann läuft es weiter.',
    denied: 'Standort gesperrt',
    deniedHint: 'Die Standortfreigabe ist für diese Seite blockiert. Das lässt sich nur in den Browser-Einstellungen wieder erlauben.',
    taken: 'Name bereits vergeben',
    takenHint: 'Ein anderes Gerät teilt gerade unter diesem Namen. Wähle deinen Namen neu oder warte kurz.',
    failing: 'Standort kommt nicht an',
    failingHint: 'Das Handy findet deinen Standort, aber der Server nimmt ihn nicht entgegen – meist fehlender Empfang. Es wird weiter versucht.',
    // A reason for still searching, not a state of its own: indoors/in a cellar a phone happily
    // reports an accuracy of several hundred metres, and such a dot on the map would be a lie.
    impreciseHint: 'Der Empfang ist noch zu ungenau für einen Punkt auf der Karte. Draussen wird es meist innert Sekunden besser.',
    lastAt: 'Zuletzt {t}',
    stop: 'Standort nicht mehr teilen',
    change: 'Namen ändern',
    // Einstellungen: ONLY the permission, not the sharing itself. Switching it on happens in the
    // compass menu on the map, freshly for every Einsatz.
    settingsLabel: 'Standort verwenden',
    settingsHint: 'Erlaubt diesem Gerät, deinen Standort zu verwenden. Geteilt wird erst, wenn du es auf der Karte einschaltest.',
    settingsAs: 'Als {name}',
    settingsOn: 'Erlaubt',
    settingsOff: 'Aus',
  },
  // Anwesenheit list: live position next to the name. Deliberately neutral – far away is the
  // normal case (Wassertransport), not a warning.
  livePosition: {
    chip: '{d} · vor {n} min',
    chipNow: '{d} · jetzt',
    atScene: 'Am Einsatzort',
    tapHint: 'Auf der Karte zeigen',
  },
  // TopBar incident switcher dropdown
  incidentSwitcher: {
    noIncident: 'Kein Einsatz',
    savedAt: 'Gespeichert um {t}',
    startedRow: 'Einsatzbeginn {t} · {d}',
    saved: 'Gespeichert',
    badgePending: 'Nicht synchronisiert – wird gespeichert',
    badgeOffline: 'Offline – lokal gespeichert, wird synchronisiert sobald wieder verbunden',
    badgeError: 'Synchronisierung fehlgeschlagen – lokal gespeichert, wird erneut versucht',
    // Storage full: the other states promise «lokal gespeichert» – and that is exactly what does
    // NOT hold here, the changes only live for this app session.
    badgeStorage: 'Speicher voll – Änderungen sind NICHT lokal gesichert und gehen beim Schliessen verloren',
    offlineShort: 'Offline',
    errorShort: 'Sync-Fehler',
    storageShort: 'Speicher voll',
    // one-shot warning toasts (useIncidentSync) — once per episode, deliberately no permanent banner
    syncErrorToast: 'Synchronisierung fehlgeschlagen – Änderungen sind lokal gespeichert.',
    syncOfflineToast: 'Immer noch offline – Änderungen werden lokal gespeichert.',
    // Boot: the incident list came out of the offline cache
    bootOffline: 'Offline – gespeicherte Daten werden angezeigt.',
    syncNow: 'Jetzt synchronisieren',
    // The button used to run silently: on an already-synced Einsatz — the normal case — a tap
    // looked exactly like no tap at all. Now the icon spins while it runs and a message says
    // what came of it.
    syncDone: 'Alles synchronisiert',
    syncFailedToast: 'Synchronisieren fehlgeschlagen – Änderungen bleiben lokal gespeichert.',
    // group titles in the menu: this Einsatz first (header card), then WHICH Einsatz, then the app.
    incidents: 'Einsätze',
    app: 'App',
    allIncidents: 'Alle Einsätze',
    report: 'Einsatzrapport',
    // Correct Adresse, Kategorie, Stichwort — the same form as when opening. Also sits in the
    // Rapport («Aus den Einsatzdaten › Bearbeiten»); in the menu, because a wrong location gets
    // noticed long before anybody opens the Rapport.
    editMeta: 'Einsatzdaten bearbeiten',
    archive: 'Einsatz abschliessen',
    noOpenIncidents: 'Keine offenen Einsätze',
    logout: 'Abmelden',
    appVersion: 'App-Version (Build)',
  },
  // persistent banner while an archived incident is open read-only (ArchivedBanner)
  archived: {
    title: 'Einsatz archiviert',
    hint: 'Nur ansehen – zum Bearbeiten reaktivieren.',
    back: 'Zurück',
    reactivate: 'Reaktivieren',
  },
  // Einsätze history list
  history: {
    title: 'Einsätze',
    empty: 'Noch keine Einsätze.',
    emptySub: 'Eröffnete und archivierte Einsätze erscheinen hier.',
    noLocation: 'ohne Ort',
    searchPlaceholder: 'Einsatz suchen …',
    noMatches: 'Keine Treffer.',
    groupOpen: 'Offen',
    groupToday: 'Heute',
    groupWeek: 'Letzte 7 Tage',
    reactivate: 'Reaktivieren',
    reactivateConfirmTitle: 'Einsatz reaktivieren',
    reactivateConfirmMsg: 'Der Einsatz wird wieder geöffnet und ist bearbeitbar. Spätere Änderungen erscheinen im Verlauf und Rapport als Nachträge.',
    reactivateConfirmBtn: 'Reaktivieren',
    statusArchived: 'Archiviert',
    statusOpen: 'Offen',
    statusInProgress: 'In Arbeit',
    archiveConfirmTitle: 'Einsatz abschliessen',
    archiveConfirmMsg: 'Der Einsatz wird archiviert und das Einsatzende festgehalten. Spätere Ergänzungen erscheinen im Verlauf und Rapport als Nachträge.',
    archiveConfirmBtn: 'Abschliessen',
    // hard delete — Übungen only (the backend rejects everything else); deliberately NOT
    // undoable, hence the danger confirm instead of confirm-with-undo
    deleteExercise: 'Löschen',
    deleteConfirmTitle: 'Übung löschen',
    deleteConfirmMsg: 'Die Übung wird mit allen Daten (Verlauf, Fotos, Rapport) endgültig gelöscht. Das kann nicht rückgängig gemacht werden.',
    deleteConfirmBtn: 'Endgültig löschen',
    deleted: 'Übung gelöscht',
    deleteFailed: 'Löschen fehlgeschlagen',
  },
  // Abschluss-Assistent — the guided closing ritual over the EXISTING views. Every small
  // incident is a training run on the big-incident tool (practice rationale, 2026-07-08).
  abschluss: {
    leftEarly: ' · bis {t}',
    steps: {
      zeiten: 'Zeiten',
      anwesenheit: 'Anwesenheit',
      mittel: 'Mittel',
      einsatzleiter: 'Einsatzleiter',
      kontaktperson: 'Kontaktperson',
      kurzbericht: 'Kurzbericht',
      rueckmeldung: 'Rückmeldung ELZ',
    },
    ausgerueckt: 'Ausgerückt',
    ende: 'Einsatzende',
    personen: '{n} erfasst',
    stunden: 'Stunden',
    von: 'von',
    bis: 'bis',
    mittelCount: '{n} Positionen',
    mittelNone: 'Nichts verwendet',
    mittelNoneOn: 'Nichts verwendet ✓',
    complete: 'Einsatz abschliessen',
    backToRapport: 'Zurück zum Rapport',
    confirmTitle: 'Einsatz abschliessen',
    confirmMsg: 'Der Rapport wird als abgeschlossen markiert und der Einsatz archiviert. Spätere Korrekturen bleiben möglich und erscheinen als Nachträge.',
    confirmMissing: 'Noch offen: {steps}. Trotzdem abschliessen?',
    confirmBtn: 'Abschliessen',
    done: 'Rapport abgeschlossen',
    failed: 'Abschluss fehlgeschlagen',
    corrected: 'Stunden korrigiert: {name}',
    attendanceRemoved: '{name} Anwesenheit entfernt',
  },
  // Datenquellen panel (reference datasets + objects)
  datenquellen: {
    title: 'Datenquellen',
    uploaded: 'Hochgeladen',
    uploadFailed: 'Upload fehlgeschlagen',
    invalidFilename: 'Dateiname ergibt keine gültige Kennung',
    layerAdded: 'Ebene «{name}» hinzugefügt – beim nächsten Laden sichtbar',
    addLayerFailed: 'Konnte Ebene nicht hinzufügen',
    globalDatasets: 'Globale Datensätze',
    objectsCount: 'Objekte',
    replace: 'Ersetzen',
    newGeoLayer: 'Neue Geo-Ebene …',
    chooseGeojson: 'GeoJSON wählen …',
    labelPlaceholder: 'Bezeichnung (z. B. Hydranten)',
    groupPlaceholder: 'Gruppe (z. B. Wasser)',
    defaultGroup: 'Referenz',
    kindLines: 'Linien',
    kindPoints: 'Punkte',
    color: 'Farbe',
    adding: 'Lädt …',
    add: 'Hinzufügen',
    geojsonNoteBefore: 'GeoJSON in WGS84 [lng, lat]. Wird als globaler Datensatz ',
    geojsonNoteAfter: ' gespeichert.',
    incidentObjects: 'Einsatzobjekte',
    plansWord: 'Pläne',
    nearby: 'In der Nähe ({n})',
    allOther: 'Alle übrigen Objekte',
    allObjects: 'Alle Objekte',
  },
  // sync the roster with the configured personnel source
  personnelSync: {
    title: 'Mannschaft mit {provider} synchronisieren',
    unknownError: 'Unbekannter Fehler',
    syncFailed: 'Synchronisierung fehlgeschlagen',
    countNew: 'neu',
    countUpdated: 'aktualisiert',
    countUnchanged: 'unverändert',
    countStale: 'nicht mehr bei {provider}',
    querying: '{provider} wird abgefragt …',
    done: 'Synchronisierung abgeschlossen.',
    resultCreated: '{n} neu angelegt',
    resultUpdated: '{n} aktualisiert',
    resultReactivated: ' (davon {n} reaktiviert)',
    resultUnchanged: '{n} unverändert',
    resultDeactivated: '{n} deaktiviert',
    staleHide: '{n} nicht mehr bei {provider} vorhandene Personen ausblenden (bleiben für alte Einsätze erhalten, werden nicht gelöscht)',
    syncing: 'Synchronisiere …',
    sync: 'Synchronisieren',
  },
  // PlanPicker (manually pick an Einsatzobjekt)
  planPicker: {
    searchPlaceholder: 'Name oder Adresse suchen …',
    autoNextObject: 'Automatisch nächstes Objekt',
    loading: 'Objekte werden geladen …',
    loadFailed: 'Objekte konnten nicht geladen werden.',
    noObject: 'Kein Objekt gefunden.',
    planOne: 'Plan',
    planMany: 'Pläne',
    mapNote: 'Koordinaten teils ungenau – Liste ist massgebend.',
    hideMap: 'Karte ausblenden',
    showMap: 'Karte einblenden',
  },
  // time-travel replay scrubber (ReplayBar)
  replay: {
    region: 'Verlauf-Wiedergabe',
    banner: 'VERLAUF · WIEDERGABE',
    subtitle: 'Schreibgeschützte Ansicht der Vergangenheit',
    backToLive: 'Zurück zu Live',
    loadFailed: 'Verlauf konnte nicht geladen werden.',
    loading: 'Verlauf wird geladen …',
    transport: 'Wiedergabe',
    skipBack: 'Vorheriges Ereignis',
    skipFwd: 'Nächstes Ereignis',
    pause: 'Pause',
    // idle spans: what the playback skips, and what sits on the track as a gap
    skipped: 'übersprungen {span}',
    gapTitle: '{span} ohne Ereignis',
    sinceAlarm: '{span} seit Alarm',
    speed: 'Geschwindigkeit',
    timepoint: 'Zeitpunkt',
    now: 'Jetzt',
    // scrubber track marker labels (deriveMarkers)
    markerSymbol: 'Symbol gesetzt',
    markerDraw: 'Zeichnung',
    markerStatus: 'Status',
    markerDivera: 'Divera',
    markerIncidentOpen: 'Einsatz eröffnet',
    markerSave: 'Speicherpunkt',
  },
  // Einsatzrapport: print preflight (ReportPreflight) + the printed document (ReportPrintView)
  report: {
    erfasser: 'Erfasst durch',
    // print view chrome
    back: 'Zurück',
    print: 'Drucken',
    pdf: 'PDF herunterladen',
    pdfBusy: 'PDF wird erstellt …',
    pdfFailed: 'PDF konnte nicht erstellt werden',
    coverEyebrow: 'Einsatzrapport',
    blankPlan: 'Leerer Plan',
    // Haupt-Rapport form rows (value or write-in line)
    keyword: 'Stichwort',
    addressObject: 'Adresse / Objekt',
    einsatzleiter: 'Einsatzleiter',
    kontaktperson: 'Kontaktperson',
    gerettete: 'Gerettete (Personen / Tiere)',
    gerettetePersonen: 'Personen',
    geretteteTiere: 'Tiere',
    alarmierung: 'Alarmierung',
    ausgerueckt: 'Ausgerückt',
    incidentEnd: 'Einsatzende',
    rueckmeldungElz: 'Rückmeldung ELZ',
    incidentId: 'Einsatz-ID',
    zeitenHead: 'Alarmierungs- / Ausrückzeiten',
    // text blocks
    alarmMessage: 'Alarmmeldung',
    summaryHead: 'Kurzbericht / durchgeführte Arbeiten',
    partnerOrgs: 'Partnerorganisationen',
    remarks: 'Bemerkungen',
    lehren: 'Lehren / Sicherheit',
    // sign-off block closing the Haupt-Rapport (page 1)
    signoffHead: 'Unterschriften',
    sigOrtDatum: 'Ort, Datum',
    sigEinsatzleiter: 'Einsatzleiter',
    sigKommandant: 'Kommandant',
    // Personal-/Soldblatt (page 2) — full-roster tick-off; Stunden berechnet WinFAP
    personalHead: 'Personal / Anwesenheit',
    personalHint: 'Abhaken, ggf. von–bis ergänzen',
    partnerOther: 'Weitere',
    // section headers + tables
    kroki: 'Kroki',
    krokiState: '{title} · Stand {at}',
    atemschutz: 'Atemschutzüberwachung',
    truppMembers: 'Mitglieder',
    truppAuftrag: 'Auftrag / Ziel',
    truppLine: 'Leitung',
    truppEntry: 'Eintritt',
    truppExit: 'Austritt',
    colTime: 'Zeit',
    colKind: 'Art',
    colPressure: 'Druck bar',
    noPressureLog: 'Kein Druckverlauf erfasst.',
    mittel: 'Material (Menge eintragen)',
    journal: 'Einsatzjournal',
    colArea: 'Bereich',
    colEntry: 'Eintrag',
    audioPresent: 'Audio vorhanden',
    audioNotTranscribed: ', nicht transkribiert',
    photo: 'Foto',
    transcript: 'Transkript',
    noEntries: 'Keine Einträge.',
    nachtraege: 'Nachträge nach Einsatzende',
    // fallback plan name when a plan-doc has no code/title
    planFallback: 'Plan',
    // proofLabel (Prüfnachweis-Status, printed + preflight)
    proofOffline: 'Prüfung nicht möglich (offline)',
    proofIntact: 'Hash-Kette intakt',
    proofBroken: 'Hash-Kette unterbrochen',
    proofBrokenAt: 'Hash-Kette unterbrochen bei #{seq}',
    // journalArea — the "Bereich" column value for a printed journal row. The names are the app's
    // own surface names (copy.modes), so a row can be found again where it was created.
    areaManual: 'Manuell',
    areaAtemschutz: 'Atemschutz',
    areaAnwesenheit: 'Anwesenheit',
    areaMittel: 'Mittel',
    areaChecklist: 'Checkliste',
    areaRapport: 'Rapport',
    // ⚠️ «Kroki» again (10.08.), reversing the 09.08. rename to «Lage». The reasoning then was
    // that this column names SURFACES and the Kroki is the printed picture. In the hand it read
    // the other way round: somebody looking for what happened to the tactical picture searched
    // the export for «Kroki», found a column full of «Lage», and concluded the entries were
    // gone. The word people look for wins over the taxonomy.
    areaLage: 'Kroki',
    // describeDrawing — short tactical labels for a drawing in the report
    drawCircle: 'Absperrkreis',
    drawAreaLabeled: 'Abschnitt "{label}"',
    drawArea: 'Fläche',
    drawRescueAxis: 'Rettungsachse',
    drawMeasureArrow: 'Maßpfeil',
    drawLine: 'Linie',
  },
  // Einsatzrapport drucken — preflight sheet (ReportPreflight)
  wheel: {
    day: 'Tag',
    month: 'Monat',
    year: 'Jahr',
    hour: 'Stunde',
    minute: 'Minute',
    now: 'Jetzt',
    ok: 'OK',
    clear: 'Löschen',
  },
  preflight: {
    pdfFull: 'Einsatzrapport (PDF)',
    pdfBusy: 'PDF wird erstellt …',
    // The Rapport is its own surface like Anwesenheit or Mittel – no print dialog any more. The
    // title was «Einsatzrapport drucken» for as long as the sheet only opened to be printed.
    title: 'Einsatzrapport',
    // One line under the title, in the tone of the other surfaces («12 anwesend · 3 gegangen ·
    // 28 Mannschaft»): what is captured first, then the verdict. The open points are NAMED –
    // «unvollständig» on its own sends you searching.
    // The head carries the numbers; what is still missing stands next to it as its own chips and
    // is allowed to wrap — as one sentence it turned into «… noch offen: Kurzberi…», i.e. it cut
    // off exactly the information the line exists for.
    headCounts: '{n} Personen · {m} Positionen',
    headAllRecorded: 'alle Angaben erfasst',
    headStillOpen: 'noch offen',
    // a «noch offen» chip is a button: it scrolls to the thing it names and flashes it
    headOpenGo: 'Zu «{step}» springen',
    // Rapportangaben section
    // «Rapportangaben» stood as one heading over everything – one and a half screens in which
    // nothing could be found by looking. Four sections, each named after the question it
    // answers; the order stays that of the printed Rapport.
    rapportHead: 'Aus der Alarmierung',
    sectionBericht: 'Bericht & Beteiligte',
    sectionZeiten: 'Zeiten',
    sectionNachbearbeitung: 'Nachbearbeitung',
    // …split out of the same field the Alarmmeldung arrives in (see lib/alarmText): the message
    // text is the only part of it a human wrote.
    vehicleOrder: 'Ausrückeordnung',
    einsatzplan: 'Einsatzplan',
    // short names for the summary on the collapsed «Inhalt» row
    summaryAtemschutz: 'Atemschutz',
    summaryAttendance: 'Personal',
    summaryMittel: 'Material',
    summaryJournal: 'Verlauf',
    summaryAttachments: 'Fotos',
    allReady: 'Alles bereit',
    fromDispatch: 'Aus den Einsatzdaten',
    edit: 'Bearbeiten',
    alarmMessage: 'Alarmmeldung',
    alarmierung: 'Alarmierung',
    notRecorded: 'Nicht erfasst',
    summaryLabel: 'Kurzbeschrieb',
    summaryPlaceholder: 'Was ist passiert / was wurde angetroffen?',
    einsatzleiterLabel: 'Einsatzleiter',
    einsatzleiterPlaceholder: 'Wählen oder eingeben',
    kontaktpersonLabel: 'Kontaktperson',
    kontaktpersonClear: 'Kontaktperson leeren',
    kontaktpersonPlaceholder: 'Eigentümer / Melder / Verantwortlicher',
    incidentEndLabel: 'Ende Einsatz',
    // Plausibility of the Einsatzzeiten — a hint, not a block: printing always happens.
    zeitBeforeAlarm: 'Liegt vor der Alarmierung ({t})',
    zeitBeforeAusgerueckt: 'Liegt vor dem Ausrücken ({t})',
    zeitFuture: 'Liegt in der Zukunft',
    now: 'Jetzt',
    // Printing ALWAYS happens — a half-filled Rapport that gets finished by hand in the Magazin
    // is a genuine way of working. But the PDF leaves the building and is the version that gets
    // filed: so name once what is missing, and then let it go.
    exportIncompleteTitle: 'Angaben fehlen noch',
    exportIncompleteLead: 'Noch offen:',
    exportIncompleteMsg: 'Der Rapport lässt sich trotzdem erstellen – die offenen Felder bleiben leer und können von Hand ergänzt werden.',
    remarksLabel: 'Bemerkungen',
    remarksPlaceholder: 'Optional',
    lehrenLabel: 'Lehren / Sicherheit',
    lehrenPlaceholder: 'Erkenntnisse, Sicherheitshinweise (optional)',
    geretteteLabel: 'Gerettete',
    gerettetePersonen: 'Personen',
    geretteteTiere: 'Tiere',
    gruppenLabel: 'Alarmierung Gruppen',
    fahrzeugeLabel: 'Ausrückzeiten Fahrzeuge',
    ausgeruecktDerived: 'aus den Fahrzeugzeiten übernommen',
    vorOrtShort: 'vor Ort',
    zurueckShort: 'zurück',
    rueckmeldungLabel: 'Rückmeldung ELZ',
    rueckmeldungName: 'Name',
    rueckmeldungZeit: 'Zeit',
    // Sections — no longer a block on the page: printing happens immediately with whatever is
    // set; ticking happens in the menu behind the ▾ next to «Einsatzrapport (PDF)».
    sectionsHead: 'Abschnitte',
    printMenu: 'Weitere Druckoptionen',
    toggleKroki: 'Kroki',
    plansLabel: 'Pläne',
    plansAnnotated: 'Mit Anmerkungen ({n})',
    plansAll: 'Alle',
    toggleAtemschutz: 'Atemschutzüberwachung ({n})',
    toggleAttendance: 'Anwesenheit ({n})',
    toggleMittel: 'Mittel ({n})',
    toggleJournal: 'Einsatzjournal',
    toggleAttachments: 'Fotos ({n})',
    // Fotos: pictures that belong to the RAPPORT (ID, damage), not into the Verlauf.
    // ⚠️ The upload only takes `image/*`. As long as that holds, the surface is called «Fotos»
    // and not «Beilagen» – a word that promises a PDF Beilage it cannot accept.
    krokiAtLabel: 'Kroki-Stand',
    // Verlauf row for when somebody changes the Rapportangaben — the content of the document
    // that gets signed must not change without a trace.
    // «Rapportangaben geändert: Bemerkungen» said that something happened to something – the
    // least a record can say. Short fields name their new value, free text only says whether it
    // was written, overwritten or emptied (the Verlauf is not a second copy of the Rapport).
    logMetaChanged: 'Rapportangaben: {fields}',
    metaValue: '{label} «{value}»',
    metaWritten: 'geschrieben',
    metaRewritten: 'überarbeitet',
    metaCleared: 'geleert',
    // ⚠️ THE STRUCTURED FIELDS SAY WHAT THEY BECAME (10.08.). Six fields used to write nothing
    // but their own name — «Rückmeldung ELZ», «Partnerorganisationen», «Alarmzeiten» — so the
    // Verlauf recorded that a field had been touched and never what it now said. Worse, each of
    // them is edited one row at a time, and every row started its own 4-Sekunden-Fenster: three
    // taps on the Partnerliste printed three byte-identical rows, which read as a bug in the log
    // rather than as three decisions. A row that names the organisation is both useful AND
    // distinguishable from the row before it, so this fixes the duplicates by fixing the text.
    metaRueckmeldung: 'Rückmeldung ELZ durch {name} um {t}',
    metaRueckmeldungTime: 'Rückmeldung ELZ um {t}',
    metaRueckmeldungName: 'Rückmeldung ELZ durch {name}',
    metaGerettete: 'Gerettete: {value}',
    metaPartnerAdded: 'Partnerorganisation {org} ergänzt',
    metaPartnerRemoved: 'Partnerorganisation {org} entfernt',
    metaPartnerNote: 'Partnerorganisation {org} – Bemerkung: {note}',
    // an organisation whose name is still being typed: named as such rather than as «‹› ergänzt»
    metaPartnerUnnamed: 'Partnerorganisation erfasst',
    metaGruppe: 'Alarmzeit {gruppe}: {t}',
    metaGruppeCleared: 'Alarmzeit {gruppe} geleert',
    metaFahrzeugAus: '{fahrzeug} ausgerückt {t}',
    metaFahrzeugVorOrt: '{fahrzeug} vor Ort {t}',
    metaFahrzeugZurueck: '{fahrzeug} zurück {t}',
    metaFahrzeugCleared: '{fahrzeug}: Zeit geleert',
    // the two states read identically as «Material «keine»» — one of them says the opposite
    metaMittelNoneOn: 'Material: «keine verwendet» bestätigt',
    metaMittelNoneOff: 'Material: «keine verwendet» widerrufen',
    krokiOrientation: 'Ausrichtung',
    krokiPortrait: 'Hoch',
    krokiLandscape: 'Quer',
    krokiAtNow: 'Jetzt',
    krokiAtFailed: 'Lage zu diesem Zeitpunkt konnte nicht rekonstruiert werden – gedruckt wird der aktuelle Stand.',
    partnersLabel: 'Partnerorganisationen',
    partnerOrg: 'Organisation (z. B. Polizei)',
    partnerOrgShort: 'Organisation',
    partnerNote: 'Bemerkung (z. B. übernimmt Verkehr)',
    partnersNone: 'keine erfasst',
    partnerAdd: 'Organisation hinzufügen',
    attachmentsHead: 'Fotos',
    attachmentsHint: 'Fotos, die zum Rapport gehören – Ausweise, Schäden, übergebene Formulare. Sie drucken am Schluss gross genug zum Lesen und stehen nicht im Verlauf.',
    attachmentsAdd: 'Foto hinzufügen',
    attachmentsOpen: 'Foto gross ansehen',
    attachmentsCount: '{n} Foto(s)',
    attachmentsNone: 'keine',
    attachmentsCaption: 'Bildlegende (z. B. «Ausweis Lenker»)',
    attachmentsPending: 'noch nicht hochgeladen',
    attachmentsFailed: 'Foto {name} konnte nicht hochgeladen werden – es erscheint nicht im Druck.',
    // The Rapport is a surface, not a dialog box – it is closed by going back to the Lage.
    backToMap: 'Zurück zur Lage',
    toggleDetailedAudit: 'Detaillierter Prüfnachweis',
    // «Detaillierter Prüfnachweis» doesn't say what is being ticked – nobody ticks what they
    // don't understand. It is about the bookkeeping rows in the printed Verlauf (who changed
    // what when), which are otherwise filtered out. The Prüfnachweis status above is unaffected.
    // Kroki-Ausschnitt: a field on the Rapport surface (WYSIWYG), no dialog before printing any
    // more – which is also why there is nothing left to «übernehmen».
    krokiHead: 'Kroki-Ausschnitt',
    // what the collapsed section has to say for collapsing to be permissible at all
    krokiSummary: '{shape} · Stand {at}',
    framingHint: 'Karte verschieben und zoomen – gedruckt wird genau dieser Ausschnitt.',
    framingFit: 'Auf Einsatz zoomen',
    // Until 09.08. the crop did not follow along: picked once at 22:20, printed unchanged at
    // 01:30 — with everything added since then outside it, and nobody saying so.
    framingFollows: 'Folgt der Lage',
    framingFollowOn: 'Der Ausschnitt wächst mit der Lage mit. Verschieben schaltet das ab.',
    framingFollowOff: 'Ausschnitt an die Lage anpassen – und mitwachsen lassen',
    // An arrow instead of zooming out: what lies outside is usually a Hydrant two streets away,
    // and shrinking half the picture for that costs more than it gains.
    framingOutside: '{n} ausserhalb – antippen zum Anpassen',
    // Kontrolle section
    controlHead: 'Kontrolle',
    // the state chip counts what is open instead of just saying «Kontrolle»
    controlOpen: '{n} Hinweis(e)',
    proofChecking: 'Prüfnachweis wird geprüft …',
    annotatedDefault: '{n} annotierte Pläne werden standardmässig gedruckt.',
    missingTranscripts: '{n} Audioeintrag/-einträge ohne Transkript – fürs Protokoll nachtragen.',
    fixTranscripts: 'Im Verlauf ergänzen',
    // Names WHO and WHY. On paper it said «N Person(en) ohne verwertbare Zeiten» – a number over
    // an abstraction nobody could do anything with. Most common cause: an open block inheriting
    // the Einsatzende, which lies BEFORE its own start.
    unresolvedHours: '{names}: Zeiten laufen rückwärts oder fehlen – nicht in den Einsatzstunden.',
    pendingMedia: '{n} Foto/Audio noch nicht hochgeladen – wird bei Verbindung ergänzt; auf anderen Geräten evtl. noch nicht sichtbar.',
    stateNote: 'Stand: ganzer Einsatz bis Rapport-Erstellung ({at}).',
    // actions — no «Abbrechen»: a surface is left via the rail or the ✕ in the header, and there
    // would be nothing to cancel anyway (every field writes through as you type).
    openPrint: 'Druckansicht öffnen',
  },
  // Station print relay — «Ausdrucken» (preflight + capture)
  printRelay: {
    send: 'Ausdrucken',
    sending: 'Wird gesendet …',
    queued: 'An Stationsdrucker gesendet',
    // live status toast follows the job: gesendet → wird gedruckt → gedruckt / fehlgeschlagen
    printing: 'Wird gedruckt …',
    printed: 'Gedruckt',
    printFailed: 'Druck fehlgeschlagen – Drucker prüfen',
    // the same three stages as a chain INSIDE that toast — short, they stand next to each other
    stepSent: 'Gesendet',
    stepPrinting: 'Wird gedruckt',
    stepPrinted: 'Gedruckt',
    // every print goes through a confirm modal — no accidental paper (2026-07-18)
    confirmTitle: 'Ausdrucken',
    confirmMsg: 'Einsatzrapport an den Stationsdrucker senden?',
    confirmBtn: 'Ausdrucken',
    undo: 'Rückgängig',
    cancelled: 'Druckauftrag abgebrochen',
    undoTooLate: 'Zu spät – der Auftrag ist schon beim Drucker',
    failed: 'Senden an Stationsdrucker fehlgeschlagen',
    online: 'Stationsdrucker erreichbar',
    offline: 'Stationsdrucker offline',
    offlineConfirmTitle: 'Stationsdrucker offline',
    offlineConfirmMsg: 'Das Druck-Relay meldet sich gerade nicht. Der Auftrag wird gedruckt, sobald es wieder erreichbar ist. Trotzdem senden?',
    offlineConfirmBtn: 'Trotzdem senden',
  },
  // Anwesenheit surface (AnwesenheitView)
  anwesenheit: {
    title: 'Anwesenheit',
    // free remark per person for THIS Einsatz («Fahrer TLF», «abgelöst 21:40»)
    noteLabel: 'Bemerkung',
    notePlaceholder: 'z. B. Fahrer TLF',
    logNote: '{name} – Bemerkung: {note}',
    // The three Anwesenheit Verlauf rows. Until 09.08. they were German literals in the code — on
    // a French installation the journal was German in exactly these places, and the Rapport
    // prints it the way it was captured.
    logPresent: '{name} anwesend',
    logPresentAgain: '{name} wieder anwesend',
    logLeft: '{name} gegangen',
    // At the Einsatzort or still in the Magazin — the answer to «wen könnte ich noch nachziehen».
    // The entry holds only the CURRENT state; the Verlauf holds when it changed.
    ortScene: 'Vor Ort',
    ortStation: 'Magazin',
    ortToScene: '{name} an den Einsatzort schicken',
    ortToStation: '{name} ins Magazin setzen',
    logOrtScene: '{name} vor Ort',
    logOrtStation: '{name} im Magazin',
    // header line: how many are here first, then where they are
    summaryOrt: '{scene} vor Ort · {station} Magazin',
    // Somebody who isn't on the roster at all (guest, neighbouring Wehr, not synced yet).
    // Deliberately NOT a roster entry: they were here tonight – that is a statement about this
    // Einsatz, not about the Wehr.
    logGuestAdded: '{name} als weitere Person erfasst',
    addGuest: 'Weitere Person',
    addGuestTitle: 'Weitere Person erfassen',
    addGuestHint: 'Für jemanden, der nicht auf der Mannschaftsliste steht – Gast, Nachbarwehr, noch nicht synchronisiert. Wird nur für diesen Einsatz erfasst.',
    addGuestName: 'Name',
    addGuestPlaceholder: 'z. B. Muster Felix (Nachbarwehr)',
    guestGroup: 'Weitere',
    guestBadge: 'Gast',
    removeGuest: 'Person entfernen',
    // Whoever takes on a role is present too – the remark is set automatically along with it, but
    // only if none has been written by hand yet.
    // one row per person, not one for the Anwesenheit and a second one for the role
    logPresentAs: '{name} anwesend – {role}',
    roleEinsatzleiter: 'Einsatzleiter',
    // ⚠️ The SHORT form, for inside a sentence. A Verlaufszeile names the person and then
    // says what they are — «Rückmeldung an ELZ durch Widmer Céline (EL)» — and the full
    // doctrine word there is four syllables for one letter of information, on a surface
    // that is read in a hurry. The list itself keeps the whole word.
    roleEinsatzleiterShort: 'EL',
    // «Stv.» on the Einsatzleiter symbol: also a role, and without a remark the deputy was the
    // only one on the list with no reason given
    roleEinsatzleiterStv: 'Stv. Einsatzleiter',
    roleEinsatzleiterStvShort: 'Stv. EL',
    roleFahrer: 'Fahrer {vehicle}',
    // the Funktion written on an Offizier-Symbol, forwarded to that person's Anwesenheits-
    // Bemerkung — «Offizier SiBe», «Offizier Lüften». Without one: just «Offizier».
    roleOffizier: 'Offizier {funktion}',
    // somebody in an Atemschutz-Trupp — the same fact the picker states as «unter AS», written
    // onto their Anwesenheits-Zeile so the Personalblatt can tell them from the crew that stayed
    // at the Magazin. Short, because it shares a narrow column with «Fahrer TLF».
    roleAtemschutz: 'AS',
    roleOffizierPlain: 'Offizier',
    roleRueckmeldung: 'Rückmeldung ELZ',
    // Soft warning in the person picker (Atemschutz): whoever already has a role is probably
    // already committed – they can still be picked, always.
    // ⚠️ The ROLE, nothing in front of it. «schon:» read as a refusal on a row that refuses
    // nothing, and the note sits in the same slot as «in einem Trupp» / «nicht anwesend», which
    // both simply state what somebody is. So does this one.
    alreadyBooked: '{role}',
    // Hints, never blocks: the app says what it knows and lets people decide.
    conflictUnderPa: '{name} ist unter AS – Trupp {trupp}.',
    // the same thing as a short badge ON the list row — that is where it is decided, not after
    // ⚠️ «AS», not «PA» (10.08.). PA is the Pressluftatmer — the device. What this badge says
    // is that somebody is under ATEMSCHUTZ, which is the doctrine word, the name of the board
    // and the name of the whole surface. One thing, one abbreviation.
    statusUnderPa: 'unter AS',
    conflictElInTrupp: '{name} ist Einsatzleiter und zugleich im Trupp {trupp}.',
    conflictLeft: '{name} ist als «gegangen» erfasst.',
    // ⚠️ No «{total} Mannschaft». How big the Wehr is is the one number everybody already
    // knows; on the line that answers «wie steht es gerade» it was a constant among two counts
    // that move.
    // ⚠️ «gegangen» LAST, after the Ort split. The line reads left to right as «how many are
    // here, where are they» — and «gegangen» is the only count that is about people who are not
    // part of that picture any more, so it belongs at the end rather than between the two
    // numbers that describe the crew on hand.
    summary: '{present} anwesend',
    summaryLeft: '{left} gegangen',
    reload: 'Mannschaft neu laden',
    loading: 'Lädt …',
    searchPlaceholder: 'Suchen',
    clearSearch: 'Suche löschen',
    // the legend's own name — the phone shows it behind an info button
    legendTitle: 'Was bedeuten die Zeichen?',
    legendFrei: 'nicht anwesend',
    legendPresent: 'anwesend',
    legendLeft: 'gegangen',
    loadFailedTitle: 'Mannschaft konnte nicht geladen werden.',
    loadFailedHint: 'Offline oder Server nicht erreichbar. Zuletzt geladene Liste bleibt erhalten.',
    emptyTitle: 'Keine Mannschaft vorhanden.',
    // same rule as emptyApp.bodyEditor: name the source only where there is one to name
    emptyHint: 'Noch keine Mannschaft erfasst.',
    emptyHintSync: 'Synchronisiere die Mannschaft aus {provider}.',
    retry: 'Erneut versuchen',
    noMatches: 'Keine Treffer.',
    lockedTitle: 'Im Atemschutz-Trupp – zuerst Trupp draussen melden',
    notInDivera: 'Nicht mehr auf der Mannschaftsliste',
    notInSource: 'Nicht mehr in {provider}',
    weg: 'weg',
    // time chip on anwesend/gegangen rows — tap to correct a wrong auto-stamped time
    editTime: 'Zeit anpassen',
    // Zeitplan + Schichten: planning happens with whoever is here — the whole Mannschaft on the
    // axis buries the handful of present people under empty tracks. Switchable, because somebody
    // arriving in two hours must still be plannable.
    presentOnlyOn: 'Nur Anwesende – tippen für die ganze Mannschaft',
    presentOnlyOff: 'Ganze Mannschaft – tippen für nur Anwesende',
    rankFilterLabel: 'Nach Grad filtern',
    rankAll: 'Alle',
    // Return: the third tap deletes (clears), so returning gets a button of its own. It opens a
    // NEW Anwesenheit block; the first one keeps its von–bis.
    backAgain: 'Wieder da',
    backAgainHint: '{name} ist zurück – neue Zeit ab jetzt',
    blockCount: '{n} Zeiten',
    // «Block» was workshop language – nobody on the ground thinks in blocks. They are Zeiten.
    // Anwesenheit sheets: the same shape as the Schichten view, so both read the same way
    von: 'von',
    bis: 'bis',
    addBlock: 'Neue Zeit ab jetzt',
    blockSplit: '{name}: neue Zeit – die laufende wurde beendet',
    blockRemoved: 'Zeit von {name} entfernt',
    blockRemove: 'Zeit entfernen',
    blocksTitle: 'Anwesenheit – {name}',
    blocksSection: 'Erfasste Zeiten',
    blocksNone: 'Noch nicht anwesend gewesen.',
    blocksHint: 'Jede Zeile ist eine tatsächliche Anwesenheit dieser Person. Hier korrigieren, wenn eine Stempelung daneben liegt.',
    openBlocks: 'Anwesenheit von {name} öffnen',
    openBlocksNote: 'Anwesenheit von {name} öffnen · Bemerkung erfasst',
    legendNote: 'Bemerkung',
    stillHere: 'noch da',
    // Head of the time card: what this row IS. Not a switch – an Anwesenheit is running or has
    // ended, and the list decides that, not this sheet.
    running: 'läuft',
    ended: 'beendet',
    // on the head of the Zeitplan card, on hover: it looks like a heading
    flip: 'umschalten',
    done: 'Fertig',
    // Switch over the same Mannschaft, three views: who is HERE, who can be there WHEN
    // (continuous time, person-major), and who staffs WHICH window (discrete time, Schicht-major).
    // «Anwes.» and not «Anwesenheit»: only abbreviated do three segments fit on 390 px (~278 px
    // available, ~250 needed). The third one belongs here and not in the ⋯ menu – a whole way of
    // working does not sit behind three dots.
    viewList: 'Anwes.',
    viewPlan: 'Zeitplan',
    viewBands: 'Schichten',
    viewLabel: 'Ansicht',
  },
  // Schicht planning – the command form «Zeitplan» (who × time), purely planning: planned bars
  // are hollow, actual Anwesenheit is filled. The plan never writes.
  zeitplan: {
    title: 'Zeitplan',
    summary: '{planned} eingeplant · {present} jetzt da',
    summaryEmpty: 'Noch nichts geplant',
    add: 'Schicht',
    addFor: 'Schicht für {name} planen',
    from: 'von',
    to: 'bis',
    remove: 'Schicht löschen',
    removed: 'Schicht {name} gelöscht',
    // A swipe and a drag fire as easily as a mis-tap – so they get the same undo as deleting.
    // The planned⇄fixed toggle does not: a second tap takes that back.
    added: 'Schicht für {name} geplant',
    moved: 'Schicht von {name} verschoben',
    conflict: 'Doppelt eingeteilt – zwei Schichten zur selben Zeit',
    // The one mistake this form is meant to find – so it is spoken out loud instead of sitting as
    // a 12px glyph on a filled bar, where it has the lowest contrast of the whole surface (and
    // whose explanation was stuck in a `title` that a touchscreen never shows).
    // Reported, not refused: at 3am a double entry is a hint to take a look.
    conflictTitleOne: 'Eine Person ist doppelt eingeteilt.',
    conflictTitleMany: '{n} Personen sind doppelt eingeteilt.',
    conflictWho: '{name} · {from}–{to}',
    conflictMore: '… und {n} weitere',
    // The path differs per surface: on the time axis the tap switches directly, in the band grid
    // it asks first when the time reaches beyond the Wache. So the sentence names the GOAL, not
    // the mechanics – otherwise it would be wrong on one of the two.
    conflictFix: 'Eine der beiden Einteilungen antippen und auf «verfügbar» setzen – die Zeit selbst bleibt stehen.',
    conflictShort: 'doppelt eingeteilt',
    // A Schicht whose «bis» lies before its «von» is not drawn at all. This badge stands in its
    // place, so the row doesn't stay silent.
    brokenShift: 'Diese Schicht endet vor ihrem Anfang – zum Korrigieren antippen',
    now: 'jetzt',
    coveragePeak: ' · max {n}',
    coverage: 'Deckung',
    coverageHint: 'Drei Linien: grau verfügbar, blau geplant, grün tatsächlich anwesend – wo die grüne Linie einbricht, ist die Lücke.',
    // The coverage row expands: the curve says WHERE the gap is, the numbers say HOW MANY.
    // Collapsed by default – the shape reads at a glance, the digits cost three lines.
    coverageExpand: 'Zahlen zeigen – wie viele verfügbar, geplant und anwesend sind',
    coverageCollapse: 'Zahlen ausblenden',
    planned: 'verfügbar',
    actual: 'anwesend',
    emptyTitle: 'Noch keine Schicht geplant.',
    emptyHint: 'Plane pro Person, von wann bis wann sie verfügbar ist. Der Plan verändert die Anwesenheit nicht – abgehakt wird sie weiterhin in der Anwesenheitsliste.',
    legendHint: 'Hohl = verfügbar · gefüllt = eingeteilt · grün = tatsächlich anwesend',
    print: 'Zeitplan drucken',
    // TWO sheets, picked separately – they answer different questions, so which one was meant is
    // asked rather than guessed. Pick the sheet first, then the route: the sheet names its
    // content and offers printer and PDF. That keeps the confirmation before printing (paper
    // comes out of the machine before a toast has faded), without needing four menu entries.
    sheetSchichtplan: 'Schichtplan …',
    sheetVerfuegbarkeiten: 'Verfügbarkeiten …',
    sheetSchichtplanTitle: 'Schichtplan',
    sheetVerfuegbarkeitenTitle: 'Verfügbarkeiten',
    // «66 Personen · 2 Schichten · Stand 09:14» – the number doubles as a check that the filter
    // above is set the way it was meant to be
    sheetContent: '{people} Personen · Stand {t}',
    sheetContentBands: '{people} Personen · {bands} Schichten · Stand {t}',
    sheetSchichtplanHint: 'Die Wachen quer, die Namen längs, Häkchen dazwischen – das Führungsformular, wie es die Mannschaft kennt.',
    sheetVerfuegbarkeitenHint: 'Wer von wann bis wann kann, unabhängig von jeder Schicht – auch alle, die in keiner stehen.',
    pdf: 'Als PDF',
    paperMenu: 'Aufs Papier',
    printFailed: 'Zeitplan konnte nicht gedruckt werden.',
    // head of the name column – as on the printed form
    who: 'Wer',
    // from the second Schicht on, a collective button replaces the chips (the row becomes
    // unreadable otherwise)
    shiftCount: '{n} Schichten',
    editTitle: 'Schichten – {name}',
    plannedSection: 'Verfügbarkeit & Einteilung',
    actualSection: 'Tatsächlich anwesend',
    actualHint: 'Kommt aus der Anwesenheit und wird dort erfasst – der Zeitplan ändert sie nicht.',
    actualNone: 'Noch nicht anwesend gewesen.',
    plannedNone: 'Noch keine Verfügbarkeit erfasst.',
    addShift: 'Schicht hinzufügen',
    stillHere: 'noch da',
    // Head of the time card: what this row IS. Not a switch – an Anwesenheit is running or has
    // ended, and the list decides that, not this sheet.
    running: 'läuft',
    ended: 'beendet',
    // on the head of the Zeitplan card, on hover: it looks like a heading
    flip: 'umschalten',
    done: 'Fertig',
    // direct operation on the grid – like the paper form you fill in
    fromStart: 'ab Beginn',
    fromStartHint: 'Setzt den Beginn auf die Alarmzeit des Einsatzes.',
    sheetHint: 'Zeiten hier anpassen · Zustand rechts umschalten · gelöscht wird nur hier.',
    laneHint: 'Ziehen trägt Verfügbarkeit ein · Balken tippen macht daraus einen Plan · ziehen verschiebt · gedrückt halten öffnet die Schichten',
    // Three states of a row: what somebody OFFERS, what was ASSIGNED out of it, and what actually
    // happened. A bar tap switches the first two, the third comes from the Anwesenheit and is
    // never written here.
    available: 'verfügbar',
    confirmed: 'geplant',
    tentative: 'verfügbar',
    toggleHint: 'Tippen macht daraus «{state}»',
    zoomIn: 'Zeitraum enger',
    zoomOut: 'Zeitraum weiter',
    horizonUntil: 'bis {t}',
    horizon: 'Zeitraum',
    openFor: 'Schichten von {name} öffnen',
    planAt: 'Schicht für {name} planen',
    dragMove: 'Verschieben',
    dragFrom: 'Beginn ziehen',
    // right-click menu on a bar: name the states instead of cycling through them
    editEntry: 'Bearbeiten …',
    dragTo: 'Ende ziehen',
  },
  // Schichtbänder (BandGrid) — the transpose of the Zeitplan. The Zeitplan is person-major over
  // continuous time («pick a person, draw when»); here the column is a named time window and per
  // person you only decide WHO. That removes time entry entirely: one tap per cell instead of
  // open sheet · pick von · pick bis · close.
  schichten: {
    title: 'Schichten',
    // head of the name column, as on the printed Führungsformular
    who: 'Wer',
    // The ONE way in: no suggestion, no adopting from a bar, no harvesting.
    addBand: 'Schicht definieren',
    addBandFirst: 'Erste Schicht definieren',
    emptyTitle: 'Noch keine Schicht.',
    emptyHint: 'Leg die Zeitfenster an, die du besetzen willst – danach wird pro Person nur noch angetippt.',
    emptyAxisHint: 'Oder im Zeitplan pro Person frei einzeichnen.',
    // The band sheet: creating and editing share one surface
    sheetAddTitle: 'Schicht anlegen',
    sheetEditTitle: 'Schicht bearbeiten',
    labelField: 'Name',
    labelPlaceholder: 'Früh',
    // The reassurance the whole design rests on: creating one assigns nobody.
    sheetHint: 'Die Schicht wird für die ganze Mannschaft angelegt. Jede Zelle beginnt leer.',
    create: 'Anlegen',
    save: 'Sichern',
    removeBand: 'Schicht löschen',
    // What gets deleted is the BAND, not the planning: the Schichten remain as freehand ones.
    // This is the one path on which real planning would otherwise vanish silently.
    removeBandHint: 'Löschen entfernt nur die Spalte – die eingeteilten Zeiten bleiben als freihändige im Zeitplan stehen.',
    removedBand: 'Schicht «{label}» gelöscht',
    // When a band is moved: no silent coupling in either direction.
    moveTitle: 'Zeiten mitziehen?',
    moveMsg: '{n} Personen sind auf die alten Zeiten eingeteilt. Sollen ihre Zeiten mitziehen?',
    moveYes: 'Mitziehen',
    moveNo: 'Nur die Schicht',
    // Header numbers of a column. Two bare digits side by side («0  8») don't say which is which
    // – the legend in the WER column names them once for all columns, instead of labelling every
    // column twice. Counted proportionally: the number answers «wie viele habe ich in diesem
    // Fenster», not «wie viele Häkchen sehe ich».
    countsAria: '{available} verfügbar, {planned} geplant',
    // The same two words as the coverage curve in the Zeitplan – one surface, one vocabulary.
    // This used to say «frei» and «fix», which were two names for the same two states.
    available: 'verfügbar',
    confirmed: 'geplant',
    // Somebody with freehand times and no band would otherwise show up empty everywhere – like
    // somebody who offered nothing. The badge names the real time, so the grid doesn't claim that.
    ownTimes: 'eigene Zeiten ausserhalb jeder Schicht: {times}',
    ownTimesMore: '{first} +{n}',
    // Cell: a Schicht with a bandId whose times deviate from the band. It shows its real time and
    // is never deleted by tapping – there is hand-drawn planning behind it.
    deviating: '{name}: {from}–{to} statt {bandFrom}–{bandTo}',
    cellAria: '{name} in {band}',
    // One word only fits a window in which ONE state holds throughout. «Verfügbar 09–11» and
    // «geplant 10–20» inside a Wache of 07–12 are three states (nothing, offered, assigned);
    // there is no true word for that, so the cell says «teilweise» and the strip below it shows
    // where what lies.
    // A cell speaks about ITS column: if the time runs to the end of the Wache, the only news is
    // its start – and vice versa. Shorter than a full range, and more precise.
    cellFrom: 'ab {t}',
    cellUntil: 'bis {t}',
    partial: 'teilweise',
    partialHint: 'Nicht alle davon decken die ganze Schicht ab.',
    // A tap on a mixed cell has no unambiguous continuation – otherwise it would flip between two
    // states without either one ever holding for the whole window.
    resolveTitle: 'Teils verfügbar, teils geplant',
    resolveMsg: '{name} ist in {band} teilweise eingeteilt und teilweise nur verfügbar. Was soll für dieses Fenster gelten?',
    // ⚠ A Schicht has ONE state: if it reaches beyond the Wache, the change carries along.
    resolveGap: 'Der Rest der Schicht ist von dieser Person nicht abgedeckt – das bleibt so.',
    // One dragged span becomes three objects – you find that out beforehand, not afterwards.
    splitTitle: 'Wird geteilt',
    splitChanges: 'ändert sich',
    splitKeeps: 'bleibt {state}',
    // Only the middle piece changes – that is the point of the cut.
    splitNote: 'Nur das Stück innerhalb der Schicht ändert sich; ausserhalb bleibt alles, wie es ist.',
    crossTitle: 'Reicht über die Schicht hinaus',
    crossMsg: 'Diese Zeit von {name} läuft über {band} hinaus. Was soll für dieses Fenster gelten?',
    resolveAvailable: 'Alles auf verfügbar',
    resolveConfirmed: 'Alles auf geplant',
    resolveCancel: 'Abbrechen',
    conflict: 'Doppelt eingeteilt – zwei Schichten zur selben Zeit',
    // right-click on a cell: name the states instead of cycling through them
    editEntry: 'Bearbeiten …',
    scrollHint: 'Waagrecht rollen für weitere Schichten',
  },
  // Mittel surface (MittelView) — manual material capture for Rapport / resupply
  mittel: {
    title: 'Mittel',
    summary: '{lines} Positionen',
    summaryEmpty: 'Noch nichts erfasst',
    add: 'Mittel',
    viewLabel: 'Ansicht',
    viewList: 'Alle',
    viewBySource: 'In Verwendung',
    noSource: 'Ohne Zuordnung',
    categoryOther: 'Übrige',
    // trailing group for free-typed (incident-local) lines in the unified list
    customGroup: 'Weitere',
    // remaining-stock readout: dots up to 7 Stück, «noch N» beyond; aria/tooltip spells it out
    noch: 'noch {n}',
    stockAria: '{label}: noch {remaining} von {total}',
    emptyTitle: 'Noch keine Mittel erfasst.',
    emptyHint: 'Erfasse mit «+ Mittel», was verbraucht wurde – fürs Rapport und um zu sehen, ob Nachschub nötig ist.',
    emptyReadonly: 'Keine Mittel erfasst.',
    // Composer
    composerTitle: 'Mittel erfassen',
    materialLabel: 'Mittel',
    materialPlaceholder: 'Mittel wählen',
    customMaterial: 'Anderes Mittel',
    customMaterialPlaceholder: 'Bezeichnung',
    unitLabel: 'Einheit',
    unitPlaceholder: 'Einheit',
    sourceLabel: 'Quelle',
    sourcePlaceholder: 'Quelle (optional)',
    // ⚠️ The configured Fahrzeuge are the usual answer, never the whole one. Material comes off a
    // Nachbarwehr's TLF, out of the Depot, from the Werkhof, off a lorry that happened to be
    // there — and the picker offered no way to say so, so those lines were recorded with no
    // Quelle at all and the Rapport could not say where anything came from.
    sourceCustom: 'Andere Quelle eingeben …',
    qtyLabel: 'Menge',
    save: 'Speichern',
    cancel: 'Abbrechen',
    removeRow: 'Auf 0 setzen',
    // deleting happens immediately with an undo toast; the Verlauf is kept
    removedToast: '«{label}» gelöscht',
    // Verlauf rows
    logSet: '{label}: {menge} {unit}',
    logRemoved: '{label} auf 0 gesetzt',
    logDeleted: '{label} gelöscht',
    logNote: '{label} – Bemerkung: {note}',
    logStock: '{label} – Bestand: {stock}',
    noteLabel: 'Bemerkung',
    notePlaceholder: 'z. B. an Werkhof übergeben',
    // Pencil dialog on a self-captured row: correct label/unit/source/stock after the fact – it
    // is captured once and read for the whole Einsatz
    editLabel: 'Eintrag bearbeiten',
    stockLabel: 'Bestand',
    stockPlaceholder: 'optional',
    deleteLine: 'Eintrag löschen',
    // Symbol→Mittel: toast offer after placing a matching tactical symbol
    // ⚠️ A ROW in the symbol's own panel, not a toast (11.08.). As a toast the offer sat beside
    // every other toast, was missed constantly, and recorded with no Quelle — which is how the
    // Rapport filled up with «Ohne Zuordnung». A row can be found again ten minutes later.
    captureOffer: 'Als Mittel erfassen',
    captureAction: 'Erfassen',
    captureFrom: 'ab',
    captureNoSource: 'ohne Quelle',
    captured: '{label}: {menge} {unit} erfasst',
    // Retablierung per equipment row (consumable Mittel end up in the resupply list)
  },
  // Checkliste surface (ChecklistsView · ChecklistRunner · ChecklistReference)
  checklists: {
    railLabel: 'Checklisten',
    showList: 'Liste anzeigen',
    groupTasks: 'Aufgaben',
    groupTactics: 'Taktik · Stichworte',
    searchPlaceholder: 'Stichwort suchen ...',
    searchAria: 'Stichwort suchen',
    matching: 'Passend: {title}',
    noMatches: 'Keine Treffer.',
    none: 'Noch keine Checklisten verfügbar.',
    pickEntry: 'Stichwort wählen oder suchen.',
    // runner
    done: 'erledigt',
    variantLabel: 'Variante',
    pickVariant: 'Variante wählen, um die Aufgaben zu sehen.',
    milestoneTitle: 'Meilenstein – erscheint im Verlauf',
    actionLabels: { journal: 'Journal', plan: 'Plan', draw: 'Zeichnen' } as Record<string, string>,
    // reference reader: hazard-colour badge labels
    hazardLabels: { red: 'Brand', orange: 'Gefahren', green: 'Verkehr', yellow: 'Technik', blue: 'Wasser' } as Record<string, string>,
    diagramAlt: 'Diagramm Seite {page}',
  },

  // ── Admin / Verwaltung surface (the /admin back-office) ───────────────────────
  admin: {
    common: {
      configLoading: 'Konfiguration wird geladen…',
      copy: 'Kopieren',
      copied: 'Kopiert',
      confirmYes: 'Ja, ausführen',
      confirmNo: 'Abbrechen',
    },
    shell: {
      verwaltung: 'Verwaltung',
      toLageMap: '← Zur Lagekarte',
      logout: 'Abmelden',
      openSections: 'Bereiche öffnen',
      closeSections: 'Bereiche schliessen',
      navAria: 'Verwaltungsbereiche',
    },
    denied: {
      title: 'Kein Zugriff',
      body: 'Die Verwaltung ist Bearbeiterinnen und Bearbeitern vorbehalten. Du bist als {name} angemeldet.',
    },
    unlock: {
      title: 'Verwaltung entsperren',
      body: 'Die Verwaltung ist mit dem Stations-Adminschlüssel geschützt – getrennt von der Einsatz-PIN. Bitte gib den Schlüssel ein, um fortzufahren.',
      label: 'Adminschlüssel',
      submit: 'Entsperren',
      submitting: 'Wird geprüft…',
      logout: 'Abmelden',
      disabledTitle: 'Verwaltung nicht eingerichtet',
      disabledBody: 'Auf diesem Server ist kein Adminschlüssel (ADMIN_SECRET) konfiguriert. Die Verwaltung ist deshalb gesperrt. Bitte richte ADMIN_SECRET in der Deployment-Konfiguration ein.',
    },
    nav: {
      groupStation: 'Station',
      groupPersonen: 'Personen',
      groupDaten: 'Daten',
      groupSystem: 'System',
      identitaet: { label: 'Station & Karte', title: 'Station & Karte', lede: 'Name, Sprache, Markenfarbe, Logos und Startansicht der Lagekarte für diese Installation.' },
      karte: { label: 'Karte', title: 'Karte', lede: 'Startansicht der Lagekarte (Zentrum + Zoom), bevor ein Einsatz gewählt ist.' },
      doktrin: { label: 'Doktrin', title: 'Doktrin', lede: 'FKS-Vorgaben dieser Wehr: Standard-Funkkanal, AGT-Kontaktintervall und Warn-Vorlauf.' },
      journal: { label: 'Journal', title: 'Journal', lede: 'Textbausteine für den Verlauf: Vorschläge, die beim Tippen per Fuzzy-Suche vervollständigen.' },
      rapport: { label: 'Rapport', title: 'Rapport', lede: 'Wie die Einsatzstunden auf dem gedruckten Rapport gerundet werden.' },
      fahrzeuge: {
        label: 'Symbole',
        title: 'Symbole',
        lede: 'Symbol-Felder dieser Wehr und ihre Auswahllisten (schreibgeschützt). Listen werden via admin_config-CLI gepflegt; ohne Konfiguration bleibt ein Feld Freitext.',
        tip: 'Jede Liste hängt Auswahl-Vorschläge an ein Symbol-Feld – z. B. Fahrzeugtypen an «VKF Fahrzeug · Titel». Vorschläge nur; freies Tippen bleibt in der Lage immer möglich.',
      },
      ebenen: { label: 'Kartenebenen', title: 'Kartenebenen & Geodaten', lede: 'Referenzebenen dieser Wehr (Hydranten, Leitungskataster, Kanton-WMS …) mit Lade-Status sowie die geladenen Datensätze. Bearbeiten via admin_geodata-CLI; Grundkarten sind national/mitgeliefert.' },
      objektplaene: {
        label: 'Objektpläne',
        title: 'Objektpläne',
        lede: 'Modul-Katalog dieser Wehr (Kacheln M1/2-3 …, Erkennungsregeln) mit Abdeckung sowie die geladenen Objekte & Pläne. Bearbeiten via admin_config-CLI; leer = mitgelieferte Standard-Module.',
        tip: 'Der Modul-Katalog konfiguriert beides: die Plan-Kacheln in der App und das Datei-Parsing von import_einsatzplaene (der Importer holt die Liste via /api/config). «Familie» erzeugt Untermodule aus dem Dateinamen (Modul 5 - Wasser → modul5-wasser); «Kombiniert mit» füllt mehrere Slots aus einem Sammelblatt (Modul 2-3 → modul2, modul3).',
      },
      mitglieder: { label: 'Mitglieder & Zugriff', title: 'Mitglieder & Zugriff', lede: 'Wer sich anmelden darf, mit welcher Rolle und welcher PIN.' },
      mannschaft: { label: 'Mannschaft', title: 'Mannschaft', lede: 'Lokaler Personenstamm der Wehr: Handeingabe und CSV funktionieren immer; eine konfigurierte Personalquelle kann zusätzlich synchronisieren.' },
      erfassung: { label: 'Erfassung', title: 'Erfassung (Poster)', lede: 'Das Erfassungs-Poster fürs Magazin: QR-Code, über den ohne Anmeldung Anwesenheit, Material und Notizen zu einem aktuellen Einsatz erfasst werden.' },
      einsaetze: { label: 'Einsatzhistorie', title: 'Einsatzhistorie', lede: 'Alle aktuellen und historischen Einsätze mit Startzeit, Status, Herkunft, Rapportstand und letzter Änderung.' },
      divera: {
        label: 'Alarmierung',
        title: 'Alarmierung',
        lede: 'Status der konfigurierten Alarmquelle, eingehende noch nicht zugeordnete Alarme, Aktualisierung und Verbindungstest.',
        tip: 'Der «Pool» sind die von Divera übernommenen, noch nicht zugeordneten Alarme. «Aktualisieren» holt sie neu vom Server.',
      },
      traccar: {
        label: 'Fahrzeugortung',
        title: 'Fahrzeugortung',
        lede: 'Status der konfigurierten Ortungsquelle, sendende Fahrzeuge, aktuellstes Signal und Verbindungstest.',
        tip: 'Live-GPS der Fahrzeuge über Traccar. «verbunden» = Anbindung aktiv; «online» = Fahrzeuge, die gerade senden.',
      },
      statistik: {
        label: 'Statistik-Export',
        title: 'Statistik-Export',
        lede: 'Read-only-Datenfeed aller Einsätze für externe Auswertungen (z. B. Jahresstatistik).',
      },
      einsatzlink: {
        label: 'Einsatz-Link',
        title: 'Einsatz-Link',
        lede: 'Der Schlüssel, mit dem die Alarmierung Links erzeugt, die genau einen Einsatz schreibgeschützt öffnen – ohne Anmeldung.',
      },
      objekte: {
        label: 'Objekte & Pläne',
        title: 'Objekte & Pläne',
        lede: 'Hinterlegte Objekte und ihre Pläne (Modul, Version, Stand). Nur zur Ansicht.',
        tip: 'Pläne sind PDF-Sheets je Objekt, nach FKS-Modul geordnet: Modul 1 Übersicht, 2 Zugang, 3 Innen, 2-3 kombiniert, 6 Gebäudepläne.',
      },
      geodaten: {
        label: 'Geodaten',
        title: 'Geodaten & Symbole',
        lede: 'Eingespielte Referenzdaten: GeoJSON-Layer, Symbolsätze und PDFs. Nur zur Ansicht.',
        tip: 'Station-eigene Referenzdaten (Hydranten, Leitungen …). «Datensatz» = ein Layer, «Features» = enthaltene Objekte, «Quelle» = woher er stammt.',
      },
      system: { label: 'System & Wartung', title: 'System & Wartung', lede: 'Status & Wartung: Version, Datenbank, Bestand, Speicher und der Offline-Cache dieses Geräts.' },
      sicherung: { label: 'Sicherung', title: 'Sicherung', lede: 'Konfiguration als Datei sichern oder eine gesicherte Datei einspielen.' },
    },
    erfassung: {
      cardTitle: 'Erfassungs-Poster',
      body: 'Wer das Poster im Magazin scannt, kann für einen Einsatz der letzten Stunden Anwesenheit, Material und Notizen erfassen – ohne Anmeldung, ohne Schulung. Vertrauensmodell: Zugang zum Magazin = Berechtigung (wie das Klemmbrett vorher).',
      stateLabel: 'Erfassung',
      stateOn: 'aktiv',
      stateOff: 'deaktiviert',
      enableBtn: 'Aktivieren & Token erzeugen',
      rotateBtn: 'Token rotieren',
      rotateMsg: 'Neuen Token erzeugen? Alle bereits gedruckten Poster werden sofort ungültig.',
      rotated: 'Neuer Token erzeugt – Poster neu drucken.',
      disableBtn: 'Deaktivieren',
      disableMsg: 'Erfassung deaktivieren? Der QR-Code auf allen Postern funktioniert danach nicht mehr.',
      disabled: 'Erfassung deaktiviert.',
      printBtn: 'Poster als PDF (A4)',
      posterHead: 'Einsatz erfassen',
      // The steps have to match what actually happens on the phone: the name is tapped while
      // ticking off, not picked beforehand, and with a single fresh Einsatz the page opens it
      // directly (autoOpenTarget) — hence «falls gefragt».
      posterStep1: 'QR-Code mit der Handy-Kamera scannen',
      posterStep2: 'Falls gefragt: den eigenen Einsatz antippen',
      posterStep3: 'Eigenen Namen antippen – Häkchen heisst anwesend',
      posterHint: 'Kein Login, keine App. Alles wird sofort gespeichert.',
      posterFoot: 'Material, Zeiten und Kurzbericht trägt die Einsatzleitung nach.',
      failed: 'Aktion fehlgeschlagen',
      sheetBtn: 'Erfassungsblatt als PDF (A4)',
      sheetCardTitle: 'Erfassungsblatt (Papier)',
      sheetCardBody: 'Der Papier-Zwilling des digitalen Rapports: gleiche Felder, gleiche Reihenfolge – für den voll analogen Einsatz. Erzeugt aus aktuellem Mannschafts-, Material- und Konfigurationsstand; ausgefüllte Blätter fotografieren (Verlauf/Rapport-Foto) und in der App nachtragen.',
      sheetHead: 'Erfassungsblatt Einsatz',
      sheetIncident: 'Einsatz',
      sheetAdresse: 'Adresse / Objekt',
      sheetEigentuemer: 'Eigentümer / Verursacher',
      sheetGerettete: 'Gerettet',
      sheetZeiten: 'Alarmierungs- / Ausrückzeiten',
      sheetPartner: 'Partnerorganisationen',
      sheetPartnerOther: 'Weitere',
      sheetRueckmeldung: 'Rückmeldung ELZ',
      sheetZeit: 'Zeit',
      sheetDate: 'Datum',
      sheetAlarm: 'Alarmiert',
      sheetEnde: 'Einsatzende',
      sheetKontakt: 'Kontaktperson',
      // ⚠️ The section names are the Einsatzrapport's (backend · report_pdf · L) – the sheet is
      // its paper twin, and whoever transfers a filled-in sheet into the app reads both side by
      // side. Instructions like «(abhaken, ggf. von–bis)» only existed here and turned the same
      // rubric into two differently named ones.
      sheetSignatures: 'Unterschriften',
      sheetOrtDatum: 'Ort, Datum',
      sheetName: 'Name',
      sheetEl: 'Einsatzleiter',
      sheetKdt: 'Kommandant',
      sheetPersonen: 'Personal / Anwesenheit',
      sheetMaterial: 'Material',
      sheetNotizen: 'Kurzbericht / durchgeführte Arbeiten',
      hint: 'Der Link gilt für laufende und noch nicht rapportierte Einsätze; rapportierte verschwinden nach wenigen Stunden (Standard 12 h, alarms.captureWindowHours). Kein Zugriff auf Karte, Verwaltung oder archivierte Einsätze.',
      // The link IS the poster's secret — whoever sends it around hands out the whole Wache's
      // access. It says so here, because this is exactly where the link is offered for copying.
      linkWarn: 'Dieser Link ist der Poster-Schlüssel: Wer ihn hat, kann erfassen. Nach dem Verschicken (Test, Schulung) Token rotieren und Poster neu drucken.',
      testTitle: 'Vorher testen',
      testBody: 'Einsatz mit Haken «Übung» eröffnen, den Link verschicken, erfassen lassen – die Übung ist in der Erfassung als solche angeschrieben und zählt nicht in die Statistik. Danach die Übung archivieren und den Token rotieren.',
    },
    statistik: {
      body: 'Read-only-Export aller Einsätze als flache JSON-Datensätze (Metadaten, Zeiten, Anwesenheit von–bis, Material, Rapportstatus) – für externe Auswertungen wie die Jahresstatistik. Keine Schreibrechte, kein Zugriff auf Karte oder Verwaltung.',
      stateLabel: 'Export',
      stateOn: 'aktiv',
      stateOff: 'deaktiviert',
      enableBtn: 'Aktivieren & Token erzeugen',
      rotateBtn: 'Token rotieren',
      rotateMsg: 'Neuen Token erzeugen? Alle angebundenen Auswertungen müssen danach neu konfiguriert werden.',
      rotated: 'Neuer Token erzeugt.',
      disableBtn: 'Deaktivieren',
      disableMsg: 'Statistik-Export deaktivieren? Angebundene Auswertungen erhalten keine Daten mehr.',
      disabled: 'Export deaktiviert.',
      failed: 'Aktion fehlgeschlagen',
      exampleLabel: 'Abfrage-Beispiel',
      tokenLabel: 'Token',
      hint: 'Token geheim halten – er gewährt Lesezugriff auf alle Einsatzdaten inkl. Namen. Übergabe an das Auswertungs-Tool als Header X-Stats-Token (oder ?t=).',
    },
    einsatzlink: {
      body: 'Die Alarmierung hängt einen Link an den Alarm; wer ihn auf dem privaten Handy antippt, sieht genau diesen einen Einsatz – Lage, Pläne, Hydranten, Checklisten, Verlauf – schreibgeschützt und ohne Anmeldung. Vertrauensmodell: Wer den Alarm erhalten hat, darf den Einsatz sehen, bis er abgeschlossen ist.',
      stateLabel: 'Einsatz-Links',
      stateOn: 'aktiv',
      stateOff: 'deaktiviert',
      enableBtn: 'Aktivieren & Schlüssel erzeugen',
      rotateBtn: 'Schlüssel rotieren',
      rotateMsg: 'Neuen Schlüssel erzeugen? Alle bereits verschickten Links werden sofort ungültig.',
      rotated: 'Neuer Schlüssel erzeugt – sofort in der Alarmierung hinterlegen, sonst funktioniert kein Link mehr.',
      disableBtn: 'Deaktivieren',
      disableMsg: 'Einsatz-Links deaktivieren? Alle verschickten Links funktionieren danach nicht mehr.',
      disabled: 'Einsatz-Links deaktiviert.',
      failed: 'Aktion fehlgeschlagen',
      keyLabel: 'Schlüssel',
      exampleLabel: 'Link-Muster (die Alarmierung setzt ihren signierten Token ein)',
      docsLink: 'Integrations-Doku',
      hint: 'Der Schlüssel wird hier erzeugt und in die Alarmierung kopiert – KP Front nimmt keinen fremden Schlüssel entgegen und wird beim Alarmieren nie aufgerufen: Die Alarmierung signiert die Links selbst. Schlüssel geheim halten, er öffnet Lesezugriff auf jeden laufenden Einsatz. Ohne Schlüssel gibt es keine Einsatz-Links – «Deaktivieren» schaltet die Funktion ganz ab.',
    },
    incidentHistory: {
      loading: 'Einsätze werden geladen…', error: 'Einsätze konnten nicht geladen werden.', search: 'Titel, Adresse oder Herkunft suchen…',
      none: 'Keine Einsätze vorhanden.', noMatches: 'Keine Einsätze passen zur Suche.', started: 'Beginn', incident: 'Einsatz', status: 'Status',
      source: 'Herkunft', report: 'Rapport', updated: 'Geändert', open: 'offen', closed: 'abgeschlossen', complete: 'vollständig', incomplete: 'offen',
      // ⚠️ Löschen vernichtet eine Einsatzakte: Verlauf, Prüfkette, Anwesenheit, Fotos und
      // Sprachnotizen. Die Frage nennt deshalb, was verschwindet — nicht «wirklich löschen?»,
      // was nur fragt, ob man den Knopf treffen wollte. Nur für abgeschlossene Einsätze, weil
      // das Abschliessen der Moment ist, in dem jemand sagt «der Einsatz ist vorbei».
      delete: 'Löschen',
      deleteAria: '«{title}» löschen',
      deleteQuestion: 'Verlauf, Prüfkette, Anwesenheit und alle Medien von «{title}» endgültig löschen?',
      deleteOpenHint: 'Erst abschliessen',
      deleteFailed: 'Löschen fehlgeschlagen.',
      actions: 'Aktionen',
    },
    autosave: {
      retry: 'Erneut versuchen',
      saving: 'Speichern…',
      pending: 'Änderungen werden gespeichert…',
      saved: 'Gespeichert',
      sessionExpired: 'Sitzung abgelaufen – bitte neu anmelden.',
      saveFailed: 'Speichern fehlgeschlagen',
      loadFailed: 'Konfiguration konnte nicht geladen werden',
      // ⚠️ NOT an error – nothing failed and nothing is lost. Somebody (oder ein Reset, oder die
      // Kommandozeile) hat die Konfiguration inzwischen geändert, und dieser Browser-Tab kennt
      // noch den Stand von vorher. Eine solche Seite hat immer das ganze Dokument geschrieben:
      // ein seit dem Morgen offener Tab hat damit Dienstgrade, Partnerorganisationen und die
      // Atemschutz-Doktrin einer Wehr in einem Zug zurückgesetzt – lautlos.
      conflict: 'Konfiguration wurde anderswo geändert',
      conflictHint: 'Neu laden zeigt den aktuellen Stand. «Übernehmen» schreibt die Änderungen dieser Seite darüber.',
      conflictApply: 'Übernehmen',
    },
    usageBar: { aria: '{pct}% belegt' },
    identity: {
      appName: 'App-Name',
      appNameTip: 'Wird in Titelleiste, Login und Hilfe angezeigt. Leer = «KP Front».',
      accentColor: 'Akzentfarbe',
      accentColorHint: 'Markenfarbe (Login / Splash)',
      accentColorTip: 'Markenfarbe der Wehr; fliesst durch das gesamte --accent-Farbsystem (Login, Splash, Akzente).',
      pickAccentColor: 'Akzentfarbe wählen',
      language: 'Sprache',
      languageHint: 'UI-Sprache der ganzen Wehr',
      languageTip: 'Sprache aller Bedienoberflächen-Texte. Gilt für die gesamte Wehr (ein Deployment = eine Sprache); wird beim Laden der App angewendet. fr/it sind erst teilweise übersetzt und fallen sonst auf Deutsch zurück.',
      pickLanguage: 'Sprache wählen',
      kommandant: 'Kommandant',
      kommandantTip: 'Name des Kommandanten – wird auf dem Einsatzrapport neben der Unterschriftszeile «Kommandant» vorgedruckt. Leer = nur die Beschriftung.',
    },
    map: {
      centerLon: 'Zentrum – Länge (lon)',
      centerLonTip: 'Längengrad (WGS84) des Kartenstarts, bevor ein Einsatz gewählt ist.',
      centerLat: 'Zentrum – Breite (lat)',
      centerLatTip: 'Breitengrad (WGS84) des Kartenstarts, bevor ein Einsatz gewählt ist.',
      zoom: 'Zoom',
      zoomTip: 'Anfangs-Zoomstufe der Karte (höher = näher; ~16 zeigt einen Quartierausschnitt).',
    },
    journal: {
      quickPhrases: 'Textbausteine',
      quickPhrasesTip: 'Eine Zeile pro Baustein. Beim Tippen im Eintrag-Editor erscheinen passende Bausteine als Vervollständigung (Fuzzy-Suche). Leer = die mitgelieferten Standardbausteine.',
    },
    // Rounding of the Einsatzstunden. The rule deliberately does NOT appear on the printed
    // Rapport – it is the same on every sheet and belongs in the Weisung (docs/CONFIGURATION.md
    // §1b). That is why the worked example sits here: whoever changes the number immediately
    // sees what it does.
    report: {
      groupRounding: 'Einsatzstunden – Rundung',
      roundingTip: 'Gerundet wird pro Person, dann summiert – nie auf die Gesamtsumme. Sonst hinge dieselbe Zahl davon ab, wie viele Leute gekommen sind. Die ungerundete Summe steht auf dem Rapport daneben, damit die gerundete überprüfbar bleibt.',
      stepMin: 'Schrittweite (min)',
      stepMinTip: 'Auf welchen Block aufgerundet wird. 30 = halbe Stunden, 60 = ganze Stunden.',
      graceMin: 'Toleranz (min)',
      graceMinTip: 'So viele Minuten über einem Block zählen noch nicht als neuer. Verhindert, dass drei Minuten über der halben Stunde einen ganzen Block kosten.',
      example: 'Beispiel',
      exampleHint: 'Drei Personen mit {raw} ergeben gerundet {rounded}.',
      // The second number that decides what the Personalblatt says about a time.
      groupMerge: 'Anwesenheit – Zeiten zusammenfassen',
      mergeTip: 'Zwei Einträge kurz hintereinander sind fast nie zwei Einsätze, sondern ein korrigierter Fehltipp – oder Poster und Tablet haben dieselbe Ankunft erfasst. Auf dem Rapport werden sie zu einer Strecke; erfasst bleiben beide, und in der Anwesenheit steht weiterhin, was wirklich getippt wurde.',
      mergeGapMin: 'Lücke bis (min)',
      mergeGapMinTip: 'Kürzere Unterbrüche gelten auf dem Rapport als eine Strecke. 0 druckt jeden erfassten Block einzeln.',
    },
    doctrine: {
      groupFunk: 'Funk',
      groupPressure: 'Atemschutz – Druck',
      groupContact: 'Atemschutz – Kontakt',
      // Air-supply estimate: the card says «geschätzt mit 7 L Flasche und 50 L/min» – which read
      // like a station setting but wasn't one (the backend discarded both fields on save, and
      // there was nowhere to type them in).
      groupAir: 'Atemschutz – Luftvorrat',
      airTip: 'Grundlage der Schätzung «noch ≈ N bar» auf der Truppkarte. Reine Planungshilfe – die Karte sagt dazu, worauf sie beruht, und ersetzt die Druckmeldung nicht.',
      cylinderLiters: 'Flaschenvolumen (L)',
      cylinderLitersTip: 'Volumen der im Dienst gefassten Pressluftflasche. 6 oder 6,8 L sind üblich, 9 L bei grösseren Geräten.',
      estConsumption: 'Verbrauch (L/min)',
      estConsumptionTip: 'Angenommener Atemluftverbrauch eines arbeitenden AdF. Höher ansetzen heisst früher warnen.',
      groupAuftragColors: 'Atemschutz – Truppfarben',
      auftragColorsTip: 'Optional: Startfarbe je Auftrag. Leer lassen heisst «jeder Trupp eine eigene Farbe» (Identität). Wer die Lage lieber nach Rolle liest – alle Löschtrupps rot –, setzt hier eine Farbe; pro Trupp ist sie weiterhin änderbar.',
      defaultFunkkanal: 'Funkkanal (Standard)',
      defaultFunkkanalTip: 'Voreingestellter Funkkanal eines neuen Einsatzes.',
      contactInterval: 'Kontaktintervall (min)',
      contactIntervalTip: 'AGT-Kontaktintervall; nach Ablauf gilt der Kontakt als fällig (amber).',
      contactGrace: 'Nachfrist (s)',
      contactGraceTip: 'Sekunden nach dem fälligen Kontakt, bis der überfällig-Alarm auslöst.',
      alarmBar: 'Alarmdruck (bar)',
      alarmBarTip: 'Druck, ab dem der Trupp zurückgeht. Die Truppkarte schlägt ab diesem Wert an – auch wenn erst die Schätzung ihn erreicht. 0 schaltet die Schwelle ab.',
      defaultPressure: 'Eingangsdruck (bar)',
      defaultPressureTip: 'Fülldruck, mit dem der Trupp-Assistent startet (z. B. 300-bar-Flasche im Dienst).',
      pressureStep: 'Druck-Schrittweite (bar)',
      pressureStepTip: 'Schrittweite der ±Druckregler; Eingaben rasten auf dieses Raster ein.',
      pressureMax: 'Druck-Maximum (bar)',
      pressureMaxTip: 'Obergrenze der Druckeingabe (320 erlaubt eine überfüllte Flasche).',
      funkkanalMin: 'Funkkanal min',
      funkkanalMinTip: 'Untere Grenze des Funkkanal-Reglers.',
      funkkanalMax: 'Funkkanal max',
      funkkanalMaxTip: 'Obere Grenze des Funkkanal-Reglers.',
    },
    backup: {
      title: 'Sicherung',
      caption: 'Konfiguration als Datei sichern oder eine gesicherte Datei einspielen. Import ersetzt sie vollständig (ohne env-Integrationen).',
      export: 'Konfiguration exportieren',
      import: 'Konfiguration importieren',
      lastChangedBy: 'Zuletzt geändert von {name} am {date}',
      lastChanged: 'Zuletzt geändert am {date}',
      notJson: 'Datei ist kein gültiges JSON.',
      notConfig: 'Datei enthält keine gültige Konfiguration.',
      replaceConfirm: 'Diese Datei ersetzt die aktuelle Konfiguration vollständig. Die bisherige wird vorher als Sicherung heruntergeladen. Fortfahren?',
      imported: 'Konfiguration importiert.',
      invalidSchema: 'Konfiguration ungültig (422) – Datei passt nicht zum Schema.',
      importFailed: 'Import fehlgeschlagen.',
    },
    common2: {
      cancel: 'Abbrechen',
      save: 'Speichern',
      saving: 'Speichere…',
      create: 'Anlegen',
      edit: 'Bearbeiten',
      remove: 'Entfernen',
      notAvailable: 'nicht verfügbar',
      unknownError: 'Unbekannter Fehler',
    },
    infoTip: { prefix: 'Info: {label}' },
    stringList: {
      addPlaceholder: 'Hinzufügen…',
      removeItem: '{item} entfernen',
    },
    fleet: {
      filterPlaceholder: 'Symbol suchen …',
      loading: 'Symbolbibliothek wird geladen …',
      noMatches: 'Kein Symbol passt zur Suche.',
      noAttributes: 'Keine Felder.',
      fieldTitle: 'Titel',
      fieldMeaningTitle: 'Spezielle Felder',
      guideTitle: 'Felder und Eigenschaften erklärt',
      fieldGlossary: {
        Titel: 'Sichtbare Fahrzeugbezeichnung, z. B. TLF 1.', Status: 'Lageabhängiger Zustand, z. B. gerettet oder Schieber offen/zu.',
        Stoff: 'Gefahrstoffbezeichnung.', 'UN-Nr': 'Vierstellige UN-Gefahrgutnummer.', Einheit: 'Organisation oder eingesetzte Einheit.',
        Name: 'Person aus dem Mannschaftsstamm.', Funktion: 'Führungsaufgabe, z. B. Front oder SiBe.', Fahrer: 'Fahrer aus dem Mannschaftsstamm.', Typ: 'Geräte- oder Ausführungstyp.',
      },
      propsLabel: 'Eigenschaften',
      colCategory: 'Kategorie',
      colSymbol: 'Symbol',
      colField: 'Feld',
      colSource: 'Quelle',
      colOptions: 'Auswahlliste',
      controls: {
        rotation: 'Drehbar',
        rotation2: 'Zweite Drehung',
        count: 'Anzahl',
        floor: 'Stockwerk',
        floorRange: 'Stockwerk-Bereich',
        spread: 'Ausbreitung',
        airflow: 'Luftrichtung',
      },
      propertiesMeaningTitle: 'Eigenschaften',
      controlGlossary: {
        rotation: 'Symbol kann nach der Platzierung gedreht werden.', rotation2: 'Ein zweiter unabhängiger Richtungswinkel ist verfügbar.',
        count: 'Mehrere gleichartige Elemente werden als Anzahl geführt.', floor: 'Das Symbol kann einem Stockwerk zugeordnet werden.',
        floorRange: 'Das Symbol kann einen Bereich von Stockwerken abdecken.', spread: 'Richtung und Ausmass einer Ausbreitung können dargestellt werden.',
        airflow: 'Die Luftrichtung des Lüfters (Einblasen / Absaugen) kann umgeschaltet werden.',
      },
      listsMeaningTitle: 'Quelle & Auswahlliste.',
      noConfiguredLists: 'Für diese Station sind keine eigenen Auswahllisten hinterlegt. Name und Fahrer kommen aus der Mannschaft; alle übrigen Felder bleiben frei editierbar.',
      configuredLists: '„Konfiguriert“ zeigt Stationsvorschläge, „Aus Mannschaft“ übernimmt Personen. Die Vorschläge beschleunigen die Eingabe; Freitext bleibt möglich.',
      rosterField: 'Aus Mannschaft',
      rosterBadgeHint: 'wird aus der Mannschaft gefüllt',
      configuredBadge: 'Konfiguriert',
      configuredBadgeHint: 'in der Stationskonfiguration hinterlegt',
      freitextBadge: 'Freitext',
      freitextBadgeHint: 'keine Liste – Operator gibt frei ein',
      freitextValue: 'frei eingeben',
    },
    members: {
      add: 'Mitglied hinzufügen',
      addCaption: 'Benutzername zum Anmelden, Anzeigename auf den Login-Kacheln. PIN: genau {n} Ziffern.',
      username: 'Benutzername',
      usernamePlaceholder: 'z. B. fu',
      displayName: 'Anzeigename',
      displayNamePlaceholder: 'z. B. Muster Felix',
      role: 'Rolle',
      roleViewer: 'Betrachter',
      roleEditor: 'Bearbeiter',
      elViewDefault: 'Startet in Führungsansicht',
      elViewDefaultHint: 'Taktik gesperrt, Journal & Details aktiv – am Gerät umschaltbar',
      colorLabel: 'Farbe',
      colorOptional: 'optional',
      pickColor: 'Farbe wählen',
      pinLabel: 'PIN',
      pinDigits: '{n} Ziffern',
      title: 'Erfasste Mitglieder',
      caption: 'Wer sich anmelden darf und mit welcher Rolle. Mitglieder werden deaktiviert, nie gelöscht (der Verlauf bleibt erhalten).',
      loading: 'Mitglieder werden geladen…',
      none: 'Keine Mitglieder.',
      colName: 'Name',
      colUsername: 'Benutzername',
      colRole: 'Rolle',
      colStatus: 'Status',
      colLastLogin: 'Letzter Login',
      colActions: 'Aktionen',
      active: 'Aktiv',
      inactive: 'Inaktiv',
      toViewer: '→ Betrachter',
      toEditor: '→ Bearbeiter',
      deactivate: 'Deaktivieren',
      reactivate: 'Reaktivieren',
      resetPin: 'PIN zurücksetzen',
      guardSelf: 'Du kannst dein eigenes Konto nicht ändern oder deaktivieren.',
      guardLastCmd: 'Das letzte aktive Bearbeiter-Konto kann nicht deaktiviert oder herabgestuft werden.',
      guardSelfRole: 'Du kannst deine eigene Rolle nicht ändern.',
      guardLastCmdRole: 'Das letzte aktive Bearbeiter-Konto kann nicht herabgestuft werden.',
      guardSelfDeactivate: 'Du kannst dein eigenes Konto nicht deaktivieren.',
      guardLastCmdDeactivate: 'Das letzte aktive Bearbeiter-Konto kann nicht deaktiviert werden.',
      guardLabel: 'Geschützte Aktionen für {name}',
      newPinPrompt: 'Neue PIN für {name} ({n} Ziffern):',
      pinInvalid: 'PIN muss genau {n} Ziffern haben.',
    },
    roster: {
      // Name format — one order for the whole Wehr. It sits here because the effect is visible
      // directly below it in the list.
      nameOrderTitle: 'Namensformat',
      nameOrderCaption: 'Gilt überall: Mannschaftsliste, Anwesenheit, Karte, Rapport und Druck.',
      nameOrderLabel: 'Reihenfolge',
      nameOrderTip: 'Divera liefert «Nachname Vorname» – so sind auch Mannschaftslisten und Soldblätter sortiert. Die Umstellung wirkt sofort auf alle Geräte; bereits gedruckte Rapporte und abgeschlossene Einsätze behalten ihre Schreibweise.',
      nameOrderLastFirst: 'Nachname Vorname · Meier Hans',
      nameOrderFirstLast: 'Vorname Nachname · Hans Meier',
      sourceHint: 'Spalten: name (Pflicht), rank (optional). UTF-8, kommagetrennt, mit Kopfzeile. Provider-Identitäten werden durch die Synchronisation verwaltet.',
      addPerson: 'Person hinzufügen',
      addPersonCaption: 'Name der Person eingeben.',
      name: 'Name',
      namePlaceholder: 'z. B. Meier Hans',
      csvImport: 'CSV importieren',
      csvTemplate: 'Beispiel-CSV herunterladen',
      importing: 'Importiere…',
      imported: '{n} importiert',
      skipped: '{n} übersprungen',
      syncDivera: 'Mannschaft mit Divera synchronisieren',
      diveraNotConfigured: 'Divera nicht konfiguriert',
      syncProvider: 'Mit {provider} synchronisieren',
      providerNotConfigured: 'Keine Personalquelle konfiguriert · CSV und Handeingabe verfügbar',
      title: 'Erfasste Personen',
      caption: 'Personenstamm der Wehr. Personen werden deaktiviert, nie gelöscht (der Verlauf bleibt erhalten).',
      showInactive: 'Inaktive anzeigen',
      loading: 'Mannschaft wird geladen…',
      none: 'Keine Personen erfasst.',
      colName: 'Name',
      colRank: 'Grad',
      colSource: 'Quelle',
      colStatus: 'Status',
      colActions: 'Aktionen',
      rankNone: '–',
      sourceDivera: 'Divera',
      sourceManual: 'manuell',
      active: 'Aktiv',
      inactive: 'Inaktiv',
      deactivate: 'Deaktivieren',
      reactivate: 'Reaktivieren',
    },
    data: {
      testConnection: 'Verbindung testen',
      testing: 'Teste…',
      testOk: 'OK',
      testOff: 'nicht konfiguriert',
      testErr: 'Fehler',
      genericError: 'Fehler',
      stateConnected: 'verbunden',
      stateUnavailable: 'nicht verfügbar',
      stateNotConfigured: 'nicht konfiguriert',
      poolLoading: 'Pool wird geladen…',
      poolCount: '{n} Alarm im Pool',
      poolCountPlural: '{n} Alarme im Pool',
      poolUnavailable: 'Pool nicht verfügbar',
      refresh: 'Aktualisieren',
      refreshing: 'Aktualisiere…',
      lastAlarm: 'Letzter Alarm',
      alarmFallback: 'Alarm {id}',
      noneInPool: 'keiner im Pool',
      address: 'Adresse',
      vehiclesLoading: 'Fahrzeuge werden geladen…',
      vehicleCount: '{n} Fahrzeug',
      vehicleCountPlural: '{n} Fahrzeuge',
      onlineCount: '{n} online',
      positionsUnavailable: 'Positionen nicht verfügbar',
      server: 'Server',
      freshestSignal: 'Aktuellstes Signal',
      colDevice: 'Gerät',
      colStatus: 'Status',
      colLastSignal: 'Letztes Signal',
      colSpeed: 'Tempo',
      online: 'online',
      offline: 'offline',
      unknown: 'unbekannt',
      noPlans: 'keine Pläne',
      objectsLoading: 'Objekte werden geladen…',
      objectsUnavailable: 'Objekte nicht verfügbar.',
      objectsError: 'Objekte konnten nicht geladen werden.',
      objectsNone: 'Keine Objekte hinterlegt.',
      objectsHintBefore: 'Objekte und ihre Pläne werden serverseitig eingespielt – per ',
      objectsHintAfter: ' aus dem privaten Datenrepository. Hier erscheinen sie danach zur Ansicht.',
      mapLoading: 'Karte wird geladen…',
      noLocation: 'kein Standort',
      geodataLoading: 'Daten werden geladen…',
      geodataUnavailable: 'Daten nicht verfügbar.',
      geodataError: 'Daten konnten nicht geladen werden.',
      geodataNone: 'Keine Referenzdaten eingespielt.',
      geodataHintBefore: 'Hydranten, Leitungskataster und weitere Layer werden serverseitig geladen – per ',
      geodataHintAfter: ' aus dem privaten Datenrepository. GeoJSON muss WGS84 sein.',
      colDataset: 'Datensatz',
      colType: 'Typ',
      colVersion: 'Version',
      colUpdated: 'Stand',
      colFeatures: 'Features',
      colSource: 'Quelle',
      justNow: 'gerade eben',
      // Units abbreviated the same way everywhere: min · s · h (that is how the steppers and the
      // Verlauf rows write them too) – «Min.» and «Std.» next to them read like a different unit.
      relMin: 'vor {n} min',
      relHour: 'vor {n} h',
    },
    objectsMap: {
      showAll: 'Alle zeigen',
      showAllTitle: 'Alle Objekte zeigen',
    },
    modules: {
      empty: 'Keine Module konfiguriert.',
      usingDefaults: 'Keine eigenen Module konfiguriert – es gelten die mitgelieferten Standard-Module.',
      summary: '{modules} Module · {objects} Objekte · {plans} Pläne',
      coverage: '{covered}/{total} Objekte',
      code: 'Kürzel',
      title: 'Titel',
      colModule: 'Modul',
      colProps: 'Eigenschaften',
      colCoverage: 'Abdeckung',
      order: 'Reihenfolge',
      orientation: 'Ausrichtung',
      orientationPortrait: 'Hochformat',
      orientationLandscape: 'Querformat',
      detection: 'Erkennungsregel',
      detectionNone: 'keine Regel',
      combinedWith: 'Kombiniert mit',
      familyBadge: 'Familie',
      familyHint: 'erzeugt Untermodule aus dem Dateinamen',
      viewerBadge: 'Nur Ansicht',
      viewerHint: 'PDF ohne Zeichnen',
      objectsTitle: 'Objekte & Pläne',
    },
    layers: {
      filterPlaceholder: 'Ebene suchen …',
      loading: 'Wird geladen …',
      empty: 'Keine Referenzebenen konfiguriert.',
      noMatches: 'Keine Ebene passt zur Suche.',
      summary: '{total} Ebenen · {loaded} geladen · {missing} fehlen · {external} extern',
      colLayer: 'Ebene',
      colType: 'Typ',
      colStatus: 'Status',
      colRender: 'Darstellung',
      maxZoomVal: 'Max. Zoom {n}',
      statusLoaded: 'Geladen',
      statusMissing: 'Nicht geladen',
      statusExternal: 'Externe Quelle',
      features: '{n} Features',
      updated: 'Aktualisiert {date}',
      group: 'Gruppe',
      opacity: 'Deckkraft',
      colorDay: 'Farbe Tag',
      colorNight: 'Farbe Nacht',
      symbol: 'Symbol',
      geometry: 'Geometrie',
      geometryPoint: 'Punkte',
      geometryLine: 'Linien',
      maxZoom: 'Max. Zoom',
      attribution: 'Quelle',
      source: 'Quelle',
      datasetsTitle: 'Geladene Datensätze',
    },
    branding: {
      logo: 'Logo',
      logoHint: 'Anmeldebildschirm',
      reportLogo: 'Rapport-Logo',
      reportLogoHint: 'Kopf des gedruckten Einsatzrapports – leer = Logo oben',
      favicon: 'Favicon',
      faviconHint: 'Browser-Tab',
      usingDefault: 'Standard',
      upload: 'Bild auswählen',
      uploading: 'Wird hochgeladen…',
      remove: 'Entfernen',
      removeConfirm: 'Dieses Bild entfernen?',
      uploadFailed: 'Hochladen fehlgeschlagen',
      removeFailed: 'Entfernen fehlgeschlagen',
      iconsNote: 'App-/Startbildschirm-Icons werden beim Build gesetzt (separat).',
    },
    system: {
      loading: 'Systemdaten werden geladen…',
      refresh: 'Aktualisieren',
      liveSnapshot: 'Live-Systemstatus',
      updatedAt: 'Stand {time}',
      healthSummary: 'Systemzustand',
      server: 'Server',
      reachable: 'erreichbar',
      error: 'Systemdaten konnten nicht geladen werden.',
      notAvailable: 'nicht verfügbar',
      version: 'Version',
      versionTip: 'Stand dieser Installation. «Release» = veröffentlichte Version (steht in den Release Notes), «Commit» = Git-Stand des Servers, «Umgebung» = Produktiv- oder Entwicklungsbetrieb.',
      release: 'Release',
      commit: 'Commit',
      branch: 'Branch',
      environment: 'Umgebung',
      production: 'Produktion',
      development: 'Entwicklung',
      database: 'Datenbank',
      databaseTip: 'Lebenszeichen der Datenbank: eine einfache Test-Abfrage. «OK» = Server erreicht die Datenbank.',
      ok: 'OK',
      error2: 'Fehler',
      inventory: 'Bestand',
      inventoryTip: 'Datensätze in der Datenbank dieser Installation.',
      incidentsTotal: 'Einsätze (gesamt)',
      incidentsOpen: 'Einsätze (offen)',
      personnelActive: 'Mannschaft (aktiv)',
      users: 'Benutzer',
      referenceData: 'Referenzdaten',
      domain: 'Bereich',
      status: 'Status',
      active: 'aktiv',
      personnelProvider: 'Personalquelle',
      alarmProvider: 'Alarmquelle',
      vehicleProvider: 'Ortungsquelle',
      configured: 'konfiguriert',
      notConfigured: 'nicht konfiguriert',
      // Verbindungen — every consumer/producer of this deployment, read-only
      connectors: 'Verbindungen',
      connectorsTip: 'Alle Anbindungen dieser Installation – Provider (Divera/Traccar) und alle Konsumenten/Produzenten – nur Anzeige. Konfiguriert wird per Umgebungsvariablen bzw. Admin-Bereich (Erfassung, Statistik).',
      connection: 'Verbindung',
      directionIn: 'eingehend',
      directionOut: 'ausgehend',
      connOnline: 'online',
      connOffline: 'offline',
      connLastSeen: 'Zuletzt gemeldet: {time}',
      connPrintRelay: 'Stationsdrucker (Print-Agent)',
      connCapture: 'Erfassungs-Poster (QR)',
      connStats: 'Statistik-Export',
      connDiveraWebhook: 'Divera-Webhook',
      connAlarmWebhook: 'Generischer Alarmeingang',
      connPush: 'Web Push (Alarmierung)',
      connStt: 'Speech-to-Text',
      storage: 'Speicher',
      storageTip: 'Objektspeicher des Servers (Fotos, Pläne, Referenzdateien) und die Auslastung des zugrunde liegenden Datenträgers.',
      mediaUsed: 'Belegt (Medien)',
      files: 'Dateien',
      directory: 'Verzeichnis',
      diskUsed: 'Datenträger belegt',
      diskUnavailable: 'Datenträger-Auslastung nicht verfügbar.',
      free: 'Frei: {size}',
      offlineCache: 'Offline-Cache (dieses Gerät)',
      offlineCacheTip: 'Der Offline-Cache (Service-Worker) dieses Geräts: gespeicherte Karten, Pläne und App-Dateien für den Einsatz offline. Zahlen gelten nur für DIESES Gerät, nicht für den Server.',
      cacheReading: 'Cache wird gelesen…',
      cacheUnavailable: 'In diesem Browser nicht verfügbar.',
      usedQuota: 'Belegt / Kontingent',
      storageEstimateUnavailable: 'Speicher-Schätzung nicht verfügbar.',
      cacheStorage: 'Cache-Speicher',
      cacheSummary: '{caches} · {entries} Einträge',
      cache: 'Cache',
      entries: 'Einträge',
      clearCaches: 'Caches leeren',
      clearing: 'Leere…',
      cleared: 'geleert',
      clearConfirm: 'Offline-Cache auf DIESEM Gerät leeren?\n\nDie gespeicherten Karten, Pläne und App-Dateien werden gelöscht. Beim nächsten Laden werden sie neu vom Server geholt (Internet nötig). Anmeldung und Server-Daten bleiben unberührt.',
      offlineCacheCaption: 'Lokale Wartung: leert nur den Offline-Cache auf DIESEM Gerät. Beim nächsten Laden werden die Dateien neu geholt. Anmeldung und Server bleiben unberührt.',
    },
    // Error reports going outside. Default: off. The tone here is deliberately sober – the
    // installation belongs to the Feuerwehr, we ask, we don't merely inform.
    telemetry: {
      title: 'Fehlerberichte an die Entwicklung',
      caption: 'Standardmässig aus. Nichts verlässt diese Anlage, solange das hier nicht '
        + 'eingeschaltet ist.',
      tip: 'Betrifft nur automatische Absturzberichte im Hintergrund. Die Rückmeldung, die eine '
        + 'Bedienerin selbst abschickt, läuft unabhängig davon – dort ist der Knopf die '
        + 'Zustimmung. Was in beiden Fällen übertragen wird, steht unten wörtlich.',
      loading: 'Wird geladen…',
      loadError: 'Status konnte nicht geladen werden.',
      // First-time question: no answer is pre-selected, none is emphasised.
      askCaption: 'Einmal entscheiden – bis dahin wird nichts gesendet.',
      askQuestion: 'Sollen Abstürze dieser Anlage automatisch an die Entwicklung gemeldet '
        + 'werden?',
      askYes: 'Ja, Abstürze melden',
      askNo: 'Nein, nichts senden',
      askLater: 'Beides lässt sich hier jederzeit wieder ändern.',
      onBadge: 'Fehlerberichte',
      onState: 'eingeschaltet',
      offBadge: 'Fehlerberichte',
      offState: 'aus',
      lockedBadge: 'Fehlerberichte',
      lockedState: 'vom Betreiber gesperrt',
      explain: 'Eingeschaltet werden bereinigte Absturzmeldungen an die Entwicklung gesendet: '
        + 'App-Version, Geräteart, Fehlertyp. Keine Adressen, keine Namen, keine Einsatzdaten, '
        + 'keine IP. Jede einzelne Übertragung steht unten und zusätzlich im Server-Log.',
      lockedNote: 'Auf dieser Anlage ist der Versand per Umgebungsvariable abgeschaltet '
        + '(KP_TELEMETRY_ENABLED=0). Dieser Schalter kann daran nichts ändern – so gedacht: '
        + 'wer die Anlage betreibt, entscheidet vor allen anderen.',
      turnOn: 'Einschalten',
      turnOff: 'Ausschalten',
      installId: 'Kennung dieser Anlage',
      noInstallId: 'Diese Anlage hat noch keine Kennung – es wurde noch nie etwas gesendet.',
      rotate: 'Neue Kennung',
      rotateConfirm: 'Neue Kennung erzeugen? Bereits gesendete Berichte lassen sich danach '
        + 'nicht mehr mit dieser Anlage in Verbindung bringen.',
      sentTitle: 'Was diese Anlage gesendet hat',
      nothingSent: 'Noch nichts – weder gesendet noch in der Warteschlange.',
      pendingNote: 'Noch nicht übertragen: wird beim nächsten Versuch nachgeholt, sobald eine '
        + 'Verbindung besteht.',
      chError: 'Absturz',
      chReport: 'Rückmeldung',
      stSent: 'gesendet',
      stPending: 'wartet',
    },
  },
} as const

export type Copy = typeof de
