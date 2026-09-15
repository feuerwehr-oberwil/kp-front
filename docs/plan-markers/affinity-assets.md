# Die Marken als Affinity-Assets

Kurz, weil es kurz ist. Ausführlich zu den Marken selbst: [`README.md`](README.md).

## Einmalig einrichten

1. Neues Dokument, **Datei → Platzieren …**, die vier SVG wählen. Ziehen statt platzieren
   geht auch.
2. Affinity importiert jede Datei als **Gruppe**: die Linien als Kurven, den Tag als
   **echtes Textobjekt**. Prüfen: Gruppe aufklappen, das Textobjekt trägt im Ebenen-Panel
   ein «T». Steht dort stattdessen «Kurve», wurde beim Import umgewandelt – dann Import
   wiederholen und beim Platzieren nichts umwandeln lassen.
3. Alle vier Gruppen markieren → **Ansicht → Studio → Assets** → Zahnrad → *Kategorie
   hinzufügen* «Plan-Marken» → *Unterkategorie hinzufügen* «Modul 6» → **Aus Auswahl
   hinzufügen**.

Danach liegen sie in jedem Dokument im Assets-Panel und werden per Ziehen platziert.

## Was beim Umgang zu beachten ist

* **Die SVG kommen in mm.** Ein Asset ist 8 × 8 mm gross (`geo.svg` 28 × 8 mm, weil die
  Koordinaten breiter sind als die Marke). Auf einem A1-Blatt wirkt das winzig – das ist
  Absicht. **Nicht skalieren**: Skalieren zieht die Schriftgrösse des Tags mit, und ein
  auf 300 % gezogener Tag steht plötzlich mitten im Grundriss.
* **Die Farbe ist ein fixer Blauton `#1f6feb`**, kein Token – das ist Druck, kein UI. Passt
  er nicht zu eurem Blatt, in der Gruppe umfärben; dem Server ist die Farbe egal.
* **Text weiss färben statt Ebene ausblenden**, wenn die Marke unsichtbar sein soll.
  Ausgeblendete Ebenen exportiert Affinity gar nicht.
* **Schrift ersetzen ist erlaubt.** Die SVG nennen `Helvetica, Arial, sans-serif`; Affinity
  nimmt beim Import die erste vorhandene. Jede Schrift geht, solange sie `§` enthält und
  eingebettet wird.
* **Nach dem Duplizieren von Stock zu Stock nur den Text ändern**, nie die Gruppe in Kurven
  wandeln (**Ebene → In Kurven umwandeln** ist hier der Feind, genau wie «Text als Kurven»
  beim Export).
