# Plan-Marken für Modul 6 (Gebäudeplan)

Damit die App einen Gebäudeplan selber lesen kann, setzt du beim Zeichnen drei Sorten
winziger Text-Marken auf das Blatt. Der Server liest sie beim Import und weiss dann:

* **welche Seite welches Geschoss ist** – EG, 1OG, 1UG …, in der richtigen Reihenfolge;
* **wie die Geschosse übereinanderliegen** – über gemeinsame Punkte, die Treppenhäuser;
* **wo das Gebäude auf der Karte liegt** – über zwei bekannte Koordinaten.

Ohne Marken muss das alles im Admin von Hand gesetzt werden. Mit Marken ist es ein Klick.

Eine Marke ist **echter Text im PDF**, nicht eine Zeichnung. Sie beginnt mit `§`
(Paragraf-Zeichen, auf der Schweizer Tastatur `⇧3`). Alles andere – Ring, Winkel,
Zielkreuz – ist Zierde und dem Server egal.

> **Die Mitte des Textkastens ist der Punkt.** Bei allen drei Sorten. Das Symbol drumherum
> sitzt nur mit, damit die Mannschaft die Stelle auf Papier auch sieht.

---

## Die drei Sorten

### 1. Geschoss und Verbindungspunkt – `storey.svg`

```
§EG
```

Eine pro Grundriss, gesetzt **auf das Treppenhaus**. Erlaubt sind:

| Tag | heisst | Tag | heisst |
| --- | --- | --- | --- |
| `§EG` | Erdgeschoss (0) | `§0` | dasselbe, numerisch |
| `§1OG`, `§2OG` … | 1./2. Obergeschoss | `§+1`, `§+2` … | dasselbe, numerisch |
| `§1UG`, `§2UG` … | 1./2. Untergeschoss | `§-1`, `§-2` … | dasselbe, numerisch |
| `§DG` | Dachgeschoss – ein Stock über dem höchsten OG | | |

Nach einem Leerzeichen darf ein Anzeigename folgen, den die App statt des Kürzels zeigt:

```
§-1 Tiefgarage
§0 Erdgeschoss
```

Hat das Gebäude nicht ein Treppenhaus über alle Geschosse, bekommt die Marke zusätzlich
einen Punktnamen – siehe [Mehrere Treppenhäuser](#mehrere-treppenhäuser).

### 2. Bereichsecken – `corner-tl.svg` / `corner-br.svg`

```
§[EG        §EG]
```

**Optional.** Nur nötig, wenn mehrere Grundrisse auf **derselben Seite** liegen – auf einem
A0/A1-Blatt mit sechs Geschossen im Raster zum Beispiel. `§[EG` markiert die obere linke,
`§EG]` die untere rechte Ecke dieses Grundrisses. Das Kürzel dazwischen ist dasselbe wie in
der Geschoss-Marke.

Liegt nur eine Zeichnung auf der Seite, lässt du sie weg – dann ist die ganze Seite der
Bereich.

Eine Ecke darf **zusätzlich den Punktnamen** der Zeichnung tragen, die sie umrahmt
(`§[1OG.A` … `§1OG.A]`). Das braucht es nur, wenn ein Geschoss aus mehreren Zeichnungen besteht
– dann sagen die Ecken selber, welche Zeichnung sie meinen, statt es der Lage zu überlassen:
[Ein Geschoss aus mehreren Zeichnungen](#ein-geschoss-aus-mehreren-zeichnungen).

### 3. Koordinaten – `geo.svg`

```
§GEO 2612345.6 1264321.2
```

LV95, Ostwert dann Nordwert, in Metern, ein Dezimeter genau. Gesetzt auf einen Punkt,
dessen Koordinaten ihr kennt – eine Hausecke aus dem Katasterplan, ein Hydrant.

WGS84 geht auch, Breite dann Länge; die Grössenordnung unterscheidet die beiden:

```
§GEO 47.51470 7.55470
```

---

## Mehrere Treppenhäuser

Nicht jedes Gebäude hat einen Punkt, den es auf **jedem** Geschoss gibt: der Anbau reicht
vom UG bis ins 1. OG, das Haupttreppenhaus vom EG bis unters Dach. Dann gibt es keine
Stelle, die alle Grundrisse teilen.

Darum darf eine Geschoss-Marke nach einem **Punkt** einen **Punktnamen** tragen – und ein
Grundriss darf mehrere Marken haben, eine pro Punkt, den er mit einem anderen Geschoss
teilt:

```
§EG.A          §1OG.A     §1OG.B          §2OG.B
```

Zwei Geschosse mit demselben Punktnamen werden an dieser Stelle übereinandergelegt: EG und
1. OG am Punkt `A` (Haupttreppenhaus), 1. OG und 2. OG am Punkt `B` (Nordtreppe). Das
1. OG trägt beide Marken, weil es an beide Geschosse anschliesst.

Der Punktname ist **ein bis acht Buchstaben oder Ziffern** (`A`, `B`, `T2`). Ein
Anzeigename folgt wie bisher nach einem Leerzeichen:

```
§1OG.B Nordtreppe
```

**Ohne Punktnamen ist es Punkt `A`.** `§1OG` heisst genau dasselbe wie `§1OG.A` – wo ein
Treppenhaus durch das ganze Haus geht, schreibst du wie bisher nur `§EG`, `§1OG`, `§2OG`,
und bestehende Blätter bleiben unverändert gültig.

> **Die Kette wird in EINEM Rahmen aufgelöst.** Du musst nicht jedes Geschoss ans EG
> hängen. EG–1OG am Punkt `A`, 1OG–2OG am Punkt `B`: die App rechnet daraus trotzdem eine
> einzige Lage, jedes Geschoss liegt am Ende im selben Rahmen wie das EG.

Jedes Geschoss braucht also **einen** Punktnamen, der auch auf einem Geschoss steht, das
selber – direkt oder über die Kette – am Geschoss 0 hängt. Fehlt er, meldet der Prüflauf
`Geschoss +2 hat keinen gemeinsamen Verbindungspunkt`; das Geschoss bleibt unverbunden und
muss im Admin von Hand verbunden werden.

Eine Eckmarke darf denselben Punktnamen tragen wie die Geschoss-Marke der Zeichnung, die sie
umrahmt – `§[1OG.B` … `§1OG.B]` gehören zu `§1OG.B`. Bei **einer** Zeichnung pro Geschoss braucht
es das nicht (`§[1OG` genügt, der Grundriss hat einen Bereich, egal wie viele Treppenhäuser er
hat); bei mehreren ist es der empfohlene Weg – siehe
[Ein Geschoss aus mehreren Zeichnungen](#ein-geschoss-aus-mehreren-zeichnungen).

---

## Ein Geschoss aus mehreren Zeichnungen

Ein langes Gebäude wird oft nicht als ein Grundriss pro Stock gezeichnet, sondern flügelweise:
das EG passt aufs Blatt, das 1. OG steht als **zwei** Zeichnungen daneben, West und Ost. Es sind
einfach zwei Bereiche desselben Geschosses:

* **eine Geschoss-Marke in jeder Zeichnung, mit eigenem Punktnamen.** Der Westflügel bekommt
  `§1OG.A` – dort, wo im EG `§EG.A` steht – und der Ostflügel `§1OG.B`, am Treppenhaus, das im
  EG `§EG.B` trägt. Jede Zeichnung hängt an ihrem eigenen Punkt.
* **ein Eckpaar pro Zeichnung, mit demselben Punktnamen.** `§[1OG.A` / `§1OG.A]` um den
  Westflügel, `§[1OG.B` / `§1OG.B]` um den Ostflügel. **So herum ist es empfohlen:** die Ecken
  sagen dann selber, zu welcher Zeichnung sie gehören, und es ist egal, wo im Rahmen die
  Geschoss-Marke sitzt – auch wenn sie an einer Hilfslinie aus dem Grundriss herausragt.
* **Punktnamen weglassen darfst du trotzdem.** `§[1OG` / `§1OG]` ohne Namen paaren sich wie
  bisher über die Geometrie – jede obere linke Ecke nimmt die nächste untere rechte rechts
  unterhalb von ihr –, und die Zeichnung bekommt die Geschoss-Marke, die **innerhalb** ihres
  Rechtecks liegt. Benannte und unbenannte Paare dürfen auf einem Geschoss gemischt werden.
* **Nach dem Punktnamen darf ein Name für die Zeichnung stehen**, den die App auf der Kachel
  zeigt: `§1OG.A Westflügel`. Ohne Namen heisst sie «Teil 1», «Teil 2».

```
§EG.A Erdgeschoss      §EG.B          §1OG.A Westflügel        §1OG.B Ostflügel
§[EG          §EG]     §[1OG.A     §1OG.A]     §[1OG.B     §1OG.B]
```

Das EG bleibt dabei **eine** Zeichnung mit zwei Treppenhaus-Marken; nur das 1. OG ist geteilt.
Alle Zeichnungen eines Geschosses liegen auf **derselben Seite** – ein Geschoss, eine Seite,
und darum weiterhin eine Passung pro PDF.

> **Ohne Verbindungspunkt wird nicht geraten.** Zwei Bereiche und nur eine Geschoss-Marke: die
> zweite Zeichnung sagt nirgends, wo sie liegt, und wird darum nicht übernommen. Der Prüflauf
> schreibt `§1OG: zweite Zeichnung ohne Verbindungspunkt (§1OG.B fehlt)`. Dasselbe gilt, wenn
> der Punktname eines Flügels auf keinem anderen Geschoss vorkommt. Bei **benannten** Ecken
> heisst dieselbe Lücke `Bereichsecken für Ebene +1 · Punkt B, die kein §-Marker erklärt` – das
> Eckpaar `§[1OG.B` … `§1OG.B]` steht da, die Marke `§1OG.B` dazu fehlt.

In der App bleibt das **ein** Geschoss: eine Kachel im Gebäudestapel, beide Zeichnungen darin,
jede an ihrem Platz. Auch Symbole, Trupps und Tuschzeichnung bleiben pro Geschoss.

Zum Ausprobieren liegt [`sample-modul6-parts.pdf`](sample-modul6-parts.pdf) in diesem Ordner –
EG als eine Zeichnung mit zwei Treppenhäusern, 1. OG als West- und Ostflügel.

---

## Platzierungsregeln

1. **Treppenhaus, auf beiden Geschossen an derselben Stelle.** Der Verbindungspunkt ist
   das, was die Geschosse übereinanderlegt. Nimm einen Punkt, den es auf beiden
   Grundrissen gibt und der auf beiden an derselben Gebäudestelle liegt: eine
   Treppenhaus-Ecke, ein Liftschacht, ein Achsenkreuz. Wenn du in Affinity auf allen
   Geschossen dieselbe Zeichnungsvorlage hast, kopierst du die Marke einfach von Stock zu
   Stock – dann stimmt es automatisch. Gibt es keinen Punkt für alle, nimm mehrere
   ([Mehrere Treppenhäuser](#mehrere-treppenhäuser)).
2. **Ein Punktname pro Grundriss nur einmal.** Zwei `§EG` auf einem Blatt sind ein Fehler
   und werden beim Prüflauf gemeldet – `§EG.A` und `§EG.B` dagegen sind zwei Punkte
   desselben Grundrisses und richtig so.
3. **Eckmarken nur bei mehreren Zeichnungen pro Seite** – und dann konsequent beide, für
   jeden Grundriss. Auch für jede einzelne Zeichnung eines geteilten Geschosses
   ([Ein Geschoss aus mehreren Zeichnungen](#ein-geschoss-aus-mehreren-zeichnungen)); dort
   nimmst du am besten den Punktnamen der Zeichnung mit in die Ecke: `§[1OG.A` … `§1OG.A]`.
4. **`§GEO` mindestens zweimal, auf dem Geschoss 0** (EG bzw. `§0`). Die Seite mit
   Geschoss 0 ist die Seite, an der die App das Gebäude auf die Karte legt. Zwei Punkte
   ergeben Lage, Massstab und Drehung.
5. **Die beiden `§GEO`-Punkte weit auseinander**, möglichst über die Diagonale des
   Gebäudes. Je näher sie beieinander liegen, desto stärker wirkt sich ein Vermessungs-
   fehler auf die Drehung aus. Faustregel: mindestens die halbe Gebäudelänge.
6. **Sichtbar oder unsichtbar ist deine Wahl.** Der Server liest nur den Text.
   Empfohlen: das Symbol sichtbar, aber klein – höchstens 8 mm auf dem Blatt, dann hilft
   es der Mannschaft, das Treppenhaus zu finden. Der Tag-Text darin ist winzig (3–4 pt)
   und darf weiss auf weissem Grund stehen; er ist trotzdem lesbar.
   ⚠️ **Weiss ist nicht dasselbe wie ausgeblendet.** Eine ausgeblendete Ebene wird gar
   nicht exportiert – dann ist der Tag weg. Ebene sichtbar lassen, Text weiss färben.
7. **Ein Tag ist ein Textobjekt.** Nicht umbrechen, nicht auf einen Pfad legen, keine
   Silbentrennung, keine Sperrung, die Zeichen auseinanderreisst. Zwischen `§GEO`,
   Ostwert und Nordwert genau ein Leerzeichen. Der Server liest die Marken **objektweise**:
   was in einem Textrahmen steht, gehört zusammen, und was in einem anderen steht, ist eine
   andere Marke – auch wenn beide auf derselben Grundlinie und nur Millimeter auseinander
   stehen. Eine Ecke darf darum auch in einem Rahmen mit anderem Text stehen (`§2OG]` neben
   einer Titelzeile): gelesen wird nur ihr eigenes Wort. Einzige Ausnahme: stehen die Zahlen
   eines `§GEO` in einem zweiten Rahmen direkt daneben, werden die beiden zusammengefügt.

---

## In Affinity Publisher

1. **SVG als Asset ablegen.** Die vier Dateien aus diesem Ordner ins Dokument ziehen und
   als Asset speichern – Details in [`affinity-assets.md`](affinity-assets.md).
2. **Platzieren und Text anpassen.** Marke auf die Stelle ziehen, Textwerkzeug rein,
   `§EG` durch das richtige Kürzel ersetzen. Textrahmen zentriert auf den Punkt – die
   Mitte des Rahmens zählt, nicht die linke Kante.
3. **Schrift wählen, die `§` hat.** Arial, Helvetica, Frutiger – alle gängigen haben es.
4. **Exportieren: Datei → Exportieren → PDF.**

   ⚠️ **Der eine Schalter, auf den es ankommt: «Text als Kurven» muss AUS sein.**
   (Englische Oberfläche: *Text as curves*.) Er steht im Export-Dialog unter **«Mehr …»**
   Ist er an, werden alle Buchstaben in Vektorformen umgewandelt – das PDF sieht identisch
   aus, enthält aber keinen einzigen Text mehr, und der Import findet nichts.

   Daraus folgt:

   * **Voreinstellung «PDF (für Export)» nicht verwenden** – die schaltet «Text als
     Kurven» ein. Nimm **«PDF (für Druck)»** oder **PDF/X-4** und kontrolliere den
     Schalter danach trotzdem von Hand.
   * **Keine PDF/X-Voreinstellung, die Schriften in Kurven wandelt.** PDF/X-4 behält
     Text; ältere X-1a-Wege einzelner Druckereien wandeln um – im Zweifel nach dem Export
     prüfen (siehe unten).
   * **«Rasterisieren» auf «Nichts» oder «Nicht unterstützte Eigenschaften»** – niemals
     «Alles». «Alles» macht aus der ganzen Seite ein Bild.
   * **Schriften einbetten.** Standard in Affinity; nicht abschalten. Ohne eingebettete
     Schrift kommen bei manchen Lesern statt `§EG` Fragezeichen heraus.
   * **Einzelne Objekte nicht «In Kurven umwandeln».** Was du im Layout für einen Effekt
     in Kurven wandelst, ist danach kein Text mehr – bei Marken also nie.

---

## Prüfen, bevor du das Blatt abgibst

```
just plan-markers pfad/zum/Modul-6.pdf
```

Der Trockenlauf liest das PDF genau so, wie es der Server beim Import tut, und schreibt
eine Zeile pro gefundenem Tag – Seite (`p1` = erste Seite), Tag-Text, Position normalisiert auf die Seite (`0…1`, Ursprung
oben links) und was der Server daraus liest – danach der ganze Geschoss-Stapel und allfällige
Warnungen:

```
sample-modul6.pdf: 1 page(s), 8 marker(s)
  p1   §EG                            x=0.2381  y=0.4953   floor     storey +0
  p1   §[EG                           x=0.0285  y=0.1115   corner_tl region top-left of storey +0
  p1   §EG]                           x=0.4476  y=0.9128   corner_br region bottom-right of storey +0
  p1   §1OG                           x=0.7381  y=0.4953   floor     storey +1
  p1   §[1OG                          x=0.5285  y=0.1115   corner_tl region top-left of storey +1
  p1   §1OG]                          x=0.9476  y=0.9128   corner_br region bottom-right of storey +1
  p1   §GEO 2612345.6 1264321.2       x=0.0714  y=0.8152   geo       map point 47.529508 7.602574 (WGS84 lat lon)
  p1   §GEO 2612415.6 1264411.2       x=0.4047  y=0.2091   geo       map point 47.530316 7.603506 (WGS84 lat lon)

Floor pack: 2 storey(s), fit page 1, 2 map pair(s)
  +0    –                page 1   region 0.0285 0.1115 0.4476 0.9128       reference
  +1    –                page 1   region 0.5285 0.1115 0.9476 0.9128       joins +0
  no warnings
```

* **Gar keine Zeile** → der Export hat den Text in Kurven gewandelt. Zurück zu Punkt 4
  oben.
* **Ein Geschoss fehlt** → die Marke liegt in einer ausgeblendeten Ebene, oder der Tag ist
  in zwei Textobjekte zerfallen.
* **`§GEO` ohne Zahlen** → die Zahlen stehen in einem eigenen Textrahmen, der nicht direkt
  rechts neben `§GEO` auf derselben Grundlinie sitzt. Zusammenschieben oder in denselben
  Rahmen schreiben.

Stimmt etwas nicht, steht statt `no warnings` eine Zeile pro Fehler – mit dem Code und dem
Satz dazu, z. B. `⚠ [corner_missing] §4OG]: Ecke unten rechts fehlt – §[4OG hat kein
Gegenstück; ohne beide gilt die ganze Seite.` **Dieselben Zeilen stehen nach dem Import auch
im Admin**, unter der Kopfzeile des Plan-Editors: der Server schreibt sie beim Lesen der
Marken auf die Planzeile, und in der Objektliste steht dann «Marker unvollständig» statt
eines Status. Korrigieren muss man sie im PDF – der nächste Export liest sich selbst neu ein.

Zum Ausprobieren liegen in diesem Ordner zwei A3-Musterblätter, beide erzeugt von
[`make-sample.py`](make-sample.py): [`sample-modul6.pdf`](sample-modul6.pdf) mit zwei
Grundrissen, allen drei Markensorten und dem Massstab 1:500, und
[`sample-modul6-parts.pdf`](sample-modul6-parts.pdf) mit einem Geschoss aus zwei Zeichnungen.
Bei geteilten Geschossen schreibt der Prüflauf die Zeichnung hinter die Ebene – `+1/2` ist die
zweite Zeichnung des 1. OG:

```
Floor pack: 2 storey(s) in 3 drawing(s), fit page 1, 2 map pair(s)
  +0    Erdgeschoss      page 1   region 0.0381 0.1351 0.4381 0.8893       reference
  +1/1  Westflügel       page 1   region 0.5333 0.1351 0.7333 0.8893       joins +0
  +1/2  Ostflügel        page 1   region 0.7428 0.1351 0.9428 0.8893       joins +0
```

---

## Was danach im Admin passiert

Beim Hochladen oder beim nächsten Sync liest der Server die Marken. Mit mindestens zwei
`§GEO`-Punkten auf dem Erdgeschoss-Blatt ist der Plan sofort **«Freigegeben»** – die Marken
sind deine eigene Aussage, niemand muss ihr noch zustimmen. In der Objektverwaltung steht beim
Plan dann:

* die **Geschossliste ist ausgefüllt** – Seite, Kürzel, Anzeigename, in der Reihenfolge
  vom obersten zum untersten Stock;
* die **Verbindungspunkte sind gesetzt**, die Geschosse liegen also schon richtig
  übereinander;
* der **Kartenfit ist gesetzt**, gerechnet aus den `§GEO`-Punkten, und im Einsatz verwendet.

Du schaust nur noch drüber. Stimmt etwas nicht, korrigierst du es an Ort und Stelle –
«Freigabe zurücknehmen» stellt den Plan zurück in die Prüfliste, der Vorschlag bleibt dabei
erhalten.

Ohne `§GEO` sind die Geschosse trotzdem vorausgefüllt; nur die Karten-Ausrichtung machst du
dann von Hand.

Ein Blatt ohne Marken funktioniert weiterhin: es wird wie bisher von Hand zugeordnet.
