# site/ – die öffentliche Landingpage (kp-front.ch)

Statische Seite, kein Framework – aber seit der zweiten Sprache **generiert**:

```
site/
  index.template.html   ← Struktur und Markup (Text steht hier NICHT)
  content/config.json   ← welche Sprachen es gibt, und unter welcher URL
  content/de.json       ← der deutsche Text – die Grundlage
  content/fr.json       ← die Übersetzung, über de.json gelegt
  landing.css           ← das gemeinsame Design von KP Front und KP Rück
  fonts/                ← Sora + Spline Sans Mono (variable, gehostet, kein CDN)
  shots/                ← Screenshots aus einer echten Instanz (generiert, WebP)
  capture.mjs           ← nimmt shots/ neu auf
  build.mjs             ← baut aus Vorlage + Texten die Seiten

  index.html            ← gebaut, eingecheckt, wird ausgeliefert
  fr/index.html         ← dito
  dist/…/index.html     ← alles eingebettet, nicht eingecheckt
```

## Bauen

```bash
node site/build.mjs          # schreibt index.html, fr/index.html und dist/
node site/build.mjs --check  # schreibt nichts, meldet nur Abweichungen (das macht die CI)
```

⚠️ **`index.html` und `fr/index.html` sind Ergebnisse, keine Quellen.** Wer dort hineinschreibt,
verliert es beim nächsten Bauen. Trotzdem sind beide eingecheckt: GitHub Pages liefert `site/`
unverändert aus, die Seite im Repo **ist** die Seite im Netz. Damit das nicht auseinanderläuft,
prüft die CI (`node site/build.mjs --check`) bei jedem Push, dass die gebauten Seiten zum Stand
von Vorlage und Texten passen.

## Sprachen

Deutsch ist die Grundlage, jede weitere Sprache **überlagert** sie – dieselbe Mechanik wie in der
App (`src/config/copy/`). Eine Übersetzung schreibt nur, was sie übersetzt; alles andere fällt
sichtbar auf Deutsch zurück, und `build.mjs` meldet nach jedem Lauf, wie viele Texte das sind.

Eine dritte Sprache ist **ein Eintrag in `content/config.json` und eine Datei in `content/`** – an
der Vorlage ändert sich nichts. Umgekehrt gilt: **eine Sprache wird erst ausgeliefert, wenn sie in
`config.json` steht.** Ein halb übersetztes `it/` ist schlimmer als gar keins.

Bewusst entschieden und nicht aus Versehen so:

- **Umschalter sind zwei Textlinks**, keine Flaggen, kein Dropdown, kein Cookie. Echte Links,
  damit sie crawlbar bleiben und ein geteilter Link seine Sprache mitbringt.
- **Keine Weiterleitung nach `Accept-Language`.** Ein deutschsprachiger Feuerwehrmann, den eine
  Browsereinstellung nach `/fr/` schickt, ist schlimmer als ein Umschalter, den er sieht.
- **Die Screenshots bleiben deutsch, auf jeder Sprachfassung.** Sie kommen aus einer echten
  Instanz; nachgestellte Bilder wären eine Behauptung. Die FR-Seite sagt das in einer Zeile –
  und dazu, dass die App selbst Französisch spricht.
- **Eine Übersetzung, die keine französischsprachige Feuerwehr-Person gelesen hat, sagt das
  oben auf der Seite** (`notice` in `fr.json`). Diese Zeile verschwindet, wenn jemand
  gegengelesen hat – sie ist kein Dekor.

## Screenshots aktualisieren

```bash
node site/capture.mjs                        # gegen https://demo.kp-front.ch
node site/capture.mjs --base http://localhost:5188
node site/capture.mjs --only lage,mittel     # nur einzelne Bilder
node site/capture.mjs --scale 2 --docs-only  # README-Bilder in 2x nachziehen
node site/build.mjs                          # danach neu bauen
```

`capture.mjs` fährt eine laufende Instanz mit Playwright an (aus `node_modules`, keine
zusätzliche Abhängigkeit), erzwingt den Tagmodus über das Prefs-Cookie, überspringt den
Demo-Willkommensdialog, blendet die DEMO-Banderole aus und schiesst jede Ansicht in 1500 × 937.
Neue Bilder kommen als neuer Eintrag in die `shots`-Liste im Skript **und** als Eintrag unter
`shots.items` in `content/de.json` – die Dateinamen sind der Vertrag zwischen beiden. Der
Dateiname steht nur in `de.json`; die Übersetzungen erben ihn und beschriften nur.

**Das Format ist WebP** – dieselbe Aufnahme wiegt rund halb so viel wie das JPEG von früher, und
encodiert wird im Chromium, den Playwright ohnehin mitbringt (keine zweite Abhängigkeit, kein
`cwebp` auf dem Rechner). Drei Ausgaben statt einer, alle aus derselben Aufnahme:

| Datei | wofür |
| --- | --- |
| `<name>.webp` (1500 px) | die Kacheln und die Lightbox |
| `lage-992.webp` | das Hero-Bild auf Telefonen und 1x-Bildschirmen – breiter als 992 px wird es nie gezeigt (`.wrap` = 1040 px minus 2×24 px) |
| `lage.jpg` | **nur** die Linkvorschau (`og:image`): WhatsApp, Facebook und Co. zeigen kein WebP |

Die kleine Fassung und das JPEG entstehen an dem einen Shot, der im Skript `hero: true` trägt.

Zwei Dinge zur Demo: sie wird von Besuchern mitbenutzt und jede Nacht um 00:00 zurückgesetzt.
Für saubere Bilder also am besten kurz nach dem Reset aufnehmen – oder mit `--base` gegen eine
lokale Instanz fahren.

## Kontakt

Drei Wege, alle ohne eigenes Backend: zwei vorausgefüllte GitHub-Issue-Templates
(`.github/ISSUE_TEMPLATE/bug_report.md` und `feature_request.md`) und ein Formular, das an einen
externen Formulardienst postet. Ohne JavaScript bleibt das Formular ein gewöhnlicher POST.

Wer die Templates umbenennt, muss die `?template=…`-Links in `index.template.html` mitziehen.

## Design

Das Aussehen («Schweizer Plakat × Tageslicht») steckt komplett in `landing.css`, und **diese
Datei ist in kp-front und kp-rueck identisch**. Wer das Design ändert, kopiert sie ins andere
Repo hinüber – sonst laufen die beiden Schwesterseiten auseinander. Nur Vorlage und Texte
unterscheiden sich: Inhalt, Bilder und die gegenseitige Verlinkung
(`kp-front.ch` ⇄ `kp-rueck.ch`).

## Hosten

`site/` ist direkt ausrollbar (statische Dateien, keine Server-Logik). `dist/index.html` und
`dist/fr/index.html` sind dieselben Seiten als je eine einzige Datei mit eingebetteten Schriften
und Bildern – zum Weitergeben oder für einen Host, der nur eine Datei annimmt.

### README-Bilder

Shots mit `docs:` schreiben denselben Seitenzustand zusätzlich als PNG nach `docs/screenshots/` –
das ist der Grund, warum die README-Bilder früher ein halbes Jahr älter waren als die
Landingpage. Beide Ausgaben entstehen aus einer Aufnahme, wollen aber nicht dieselbe
Auflösung: die Landingpage bindet die Bilder inline ein (1x, Seitengewicht zählt), die
README-Bilder werden auf GitHub vergrössert betrachtet.

```bash
node site/capture.mjs                    # Landingpage-WebP (1x) + README-PNGs
node site/capture.mjs --scale 2 --docs-only --only lage,gebaeude,atemschutz,mittel
```

`--docs-only` lässt die Bilder der Landingpage unangetastet. Aktuell liegen die README-Bilder bei 3000 px Breite.
