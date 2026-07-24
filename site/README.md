# site/ – die öffentliche Landingpage (kp-front.ch)

Statische Seite, kein Build-Framework. Was hier liegt, ist die Seite:

```
site/
  index.html      ← Inhalt und Struktur (das hier bearbeiten)
  landing.css     ← das gemeinsame Design von KP Front und KP Rück
  fonts/          ← Sora + Spline Sans Mono (variable, gehostet, kein CDN)
  shots/          ← Screenshots aus einer echten Instanz (generiert)
  capture.mjs     ← nimmt shots/ neu auf
  build.mjs       ← baut die Ein-Datei-Variante nach dist/
  dist/index.html ← alles eingebettet, nicht eingecheckt
```

## Screenshots aktualisieren

```bash
node site/capture.mjs                        # gegen https://kp-front-demo.up.railway.app
node site/capture.mjs --base http://localhost:5188
node site/capture.mjs --only lage,mittel     # nur einzelne Bilder
node site/build.mjs                          # danach die Ein-Datei-Variante neu bauen
```

`capture.mjs` fährt eine laufende Instanz mit Playwright an (aus `node_modules`, keine
zusätzliche Abhängigkeit), erzwingt den Tagmodus über das Prefs-Cookie, überspringt den
Demo-Willkommensdialog, blendet die DEMO-Banderole aus und schiesst jede Ansicht in 1500 × 937.
Neue Bilder kommen als neuer Eintrag in die `shots`-Liste im Skript **und** als `<img>` in
`index.html` – die Dateinamen sind der Vertrag zwischen beiden.

Zwei Dinge zur Demo: sie wird von Besuchern mitbenutzt und jede Nacht um 00:00 zurückgesetzt.
Für saubere Bilder also am besten kurz nach dem Reset aufnehmen – oder mit `--base` gegen eine
lokale Instanz fahren.

## Kontakt

Die Seite hat bewusst **kein Formular**: Rückmeldungen laufen über vorausgefüllte
GitHub-Issue-Templates (`.github/ISSUE_TEMPLATE/bug_report.md` und `feature_request.md`) und
über die Mailadresse. Anhänge zieht man ins Issue, es gibt keine Kontingente und wir betreiben
kein Backend dafür.

Wer die Templates umbenennt, muss die `?template=…`-Links in `index.html` mitziehen. Sobald ein
eigener Endpoint für Nachrichten mit Anhängen steht, kann das Formular wieder an derselben
Stelle einziehen (die Markup-Variante steht in der Git-Historie).

## Design

Das Aussehen («Schweizer Plakat × Tageslicht») steckt komplett in `landing.css`, und **diese
Datei ist in kp-front und kp-rueck identisch**. Wer das Design ändert, kopiert sie ins andere
Repo hinüber – sonst laufen die beiden Schwesterseiten auseinander. Nur `index.html`
unterscheidet sich: Inhalt, Bilder und die gegenseitige Verlinkung
(`kp-front.ch` ⇄ `kp-rueck.ch`).

## Hosten

`site/` ist direkt ausrollbar (statische Dateien, keine Server-Logik). `dist/index.html` aus
`build.mjs` ist dieselbe Seite als eine einzige Datei mit eingebetteten Schriften und Bildern –
zum Weitergeben oder für einen Host, der nur eine Datei annimmt.
