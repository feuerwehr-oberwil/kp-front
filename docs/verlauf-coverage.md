# Was im Verlauf steht – und was nicht

Der **Verlauf** ist die menschenlesbare Einsatzchronik. Er ist *keine* Protokollierung jeder
Bedienhandlung, und das ist Absicht: ein Journal, in dem jedes Verschieben eines Symbols steht,
ist eines, in dem man den Funkspruch nicht mehr findet.

Diese Seite hält fest, **welche Handlung wo landet**, damit sich niemand darauf verlässt, dass
etwas im Verlauf steht, das dort nie hingeschrieben wurde. Stand: 2026-08-24.

## Es sind zwei Aufzeichnungen, nicht eine

| | Verlauf | Audit-/Replay-Strom |
|---|---|---|
| Geschrieben von | `log()` / `logPlan()` → `journal.append` | `emit(op, payload)` (`src/lib/useAuditEvents.ts:36`) |
| Landet in | `POST /api/incidents/{id}/journal` | `POST /api/incidents/{id}/events` |
| Form | Zeilen in Klartext, append-only | maschinenlesbar, **hash-verkettet** |
| Sichtbar | im Verlauf, im gedruckten Rapport | nur in der Wiedergabe / Prüfung |

`backend/app/models.py:523-532` sagt es selbst: der Audit-Strom ist *"the hash-chained AUDIT
record of committed domain actions"*, der Journal-Store *"the operational journal store"*.

**Wichtig:** `emit()` erzeugt **keine** Verlaufszeile. Alles, was unten als *nur Audit* steht,
ist rechtlich festgehalten, aber für niemanden sichtbar, der den Verlauf liest.

Dazu kommt eine dritte, kleine Quelle: der Server schreibt Lebenszyklus-Zeilen selbst
(`append_system_row`, `backend/app/api/journal.py:96`) – Einsatz abgeschlossen, wiedereröffnet,
Nachalarm, automatische Archivierung.

## Atemschutz: der Zyklus steht vollständig drin

Ein neu angemeldeter Trupp erzeugt eine Verlaufszeile – «Trupp {name} angemeldet»
(`useTruppActions.ts` · `logRegister`). Wer meint, das fehle, sieht meist, dass der Verlauf beim
Anmelden nicht auf dem Schirm ist: Atemschutz ist eine eigene Ansicht.

**Seit 2026-08-17 geschlossen** (stand hier vorher als Lücke): Löschen (`logRemoved`),
Wiederherstellen (`logRestored`) und der Truppfarben-Wechsel (`logColor`) schreiben ihre Zeile.
Ein gelöschter Trupp wird ohnehin nur noch weich entfernt (`removedAt`) und druckt weiter auf dem
Rapport als «Von Tafel entfernt».

Alles Übrige am Atemschutz steht im Verlauf: Platzieren, Funkkontakt, Druckmeldung, Statuswechsel,
Bearbeiten, Wiedereinrücken, Leitung verknüpfen/lösen, Alarm-Eskalation.

⚠️ **Zwei Kontaktarten sind seit 2026-08-19 eigene Arten**, nicht mehr «Kontakt»: der **Austritt**
(«Ausgerückt») und der **Wiedereinstieg** nach einem Rückzug. Die Sicherheitsuhr ist davon
unberührt – ein Wiedereinstieg setzt sie zurück wie ein Kontakt –, aber das gedruckte
Atemschutz-Journal liest sich dadurch als Chronologie statt mitten im Einsatz abzubrechen.

⚠️ **Der Alarm wird einmal pro Turnus geschrieben**, nicht pro Tick. Eine überfällige Kontaktuhr
schrieb früher alle paar Sekunden dieselbe Zeile; die nächste ist erst nach einem Funkkontakt
fällig, der die Uhr zurückgesetzt hat. Ton und Systemmeldung hängen bewusst **nicht** daran.

## Bewusst still

| Bereich | Warum |
|---|---|
| Zeitplan / Schichten | `src/lib/useShiftActions.ts:16-19`: *«attendance is a RECORD … a plan is not, and logging each nudge of a chip would bury the operational journal under bookkeeping»* |
| Checklisten | nur Meilensteine erzeugen eine Zeile (`src/lib/useChecklistActions.ts:34`) |
| Zeichnungen bearbeiten (Farbe, Stil, Geometrie) | Bedienhandlung, kein Ereignis – siehe die Doktrin-Notiz unten |

Die Doktrin dazu steht in der AdFU-Ablaufbeschreibung: *«Der Verlauf ist keine automatische
Einsatzchronik … Der AdFU sollte nicht jede Bedienhandlung protokollieren.»*

## Die Meldeleiste (23.08.) schreibt nichts Eigenes

Die Meldeleiste – der eine Meldungsstreifen unter der Top-Bar, der die neun Banner ersetzt hat –
ist eine **Anzeige, keine Aufzeichnung**: dass eine Meldung erschien oder weggewischt wurde, steht
nirgends. Was auf ihr *getan* wird, läuft durch dieselben Handler wie überall sonst und schreibt
deshalb dieselben Zeilen:

- **«Erledigt»** auf einer fälligen Wiedervorlage hängt die Erledigt-Zeile an
  (`useReminders.ts` · `doneLog`), **«+10 min»** die Verschiebe-Zeile – exakt die Zeilen, die der
  Abhak-Ring im Verlauf schreibt. Eine Pflicht pro Zeile: seit dem 23.08. hat **jede** fällige
  Wiedervorlage ihre eigene Zeile auf dem Streifen («2 Erinnerungen fällig» nannte zwei und
  erledigte eine).
- Die **Atemschutz-Alarmzeile** liest denselben Fold, der den Ton spielt, und schreibt nichts
  Neues – die Verlaufszeile des Alarms entsteht wie bisher einmal pro Turnus (siehe oben).
- **Wegwischen (✕), Übernehmen-Navigation, «Zum Trupp»** schreiben nichts – Ansicht, nicht
  Inhalt. Das Übernehmen eines Alarms selbst schreibt über seinen bestehenden Pfad.

## Zeichnungen: Erstellen, Benennen und Löschen stehen drin – Arrangieren nicht

Die Durchsicht vom 21.08. hielt fest, dass das Wort **«Fläche»** auf dieser Seite nicht vorkam.
Der Befund war eine Lücke der *Doku*, nicht des Verlaufs – so sieht die Wahrheit aus
(`src/lib/useMapDrawing.ts`, Copy-Schlüssel in `config/copy/de.ts` · `log`):

- **Erstellen schreibt:** «Fläche gezeichnet» (`areaDrawn`), «Zeichnung erstellt»
  (`drawingCreated`, Linien/Freihand), Absperrkreis (`circleDrawn`). Auf dem Plan: «Fläche auf
  Plan gezeichnet» / «Linie auf Plan gezeichnet» (`Whiteboard.tsx`) – **seit dem 23.08. mit
  Annotation, Punkt und Stockwerk**, damit der Sprung aus der Zeile das Objekt selektiert statt
  nur das Gebäude zu öffnen. Ältere Zeilen bleiben ohne Koordinaten (append-only) und öffnen wie
  bisher nur den Plan.
- **Benennen schreibt eine Zeile** – «Fläche «Sammelplatz»» (`drawingLabelSet` /
  `drawingLabelCleared`), beim Verlassen des Felds, nicht je Tastendruck: der Name ist die eine
  Bearbeitung, die sagt, was die Form *ist*, und erreichte das Dokument früher stumm.
- **Löschen schreibt** «Zeichnung entfernt» / «{n} Objekte entfernt».
- **Arrangieren schreibt nicht:** Farbe, Stil, Geometrie, Eckpunkte sind Bedienhandlung und
  landen nur im Audit-Strom (`draw.edit`) – das ist die bewusste Stille aus der Tabelle oben,
  und sie gilt für die Fläche wie für jede andere Zeichnung.

Warum in einem echten Log trotzdem 0 «Fläche»-Treffer stehen können: gezeichnet wird auf der
Lage vor allem mit Linien und Symbolen – die Zeile entsteht, sobald jemand eine Fläche zieht.

## Was eine Verlaufszeile seit dem 17.08. tragen kann

Die Zeile ist nicht mehr nur Text und Zeitpunkt. Vier Eigenschaften sind dazugekommen, und alle
vier sind **Eigenschaften eines Eintrags**, keine eigenen Zeilenarten – das ist der Grund, warum
sie ohne Migration auf bestehende Einsätze passen:

| Eigenschaft | Was sie bedeutet | Wo sie sichtbar wird |
|---|---|---|
| **Pendenz** (offener Ring) | die Zeile ist nicht erledigt; eigener Thread aus **Meldungen** | oben im Verlauf, dringend zuerst; auf dem Rapport als «Aufträge / Pendenzen» mit «offen» |
| **Fälligkeit** (Erinnerung) | Wiedervorlage mit **Tag** und Uhrzeit; ein vergangener Moment wird abgelehnt | Uhr in der Metazeile; auf dem Rapport «fällig HH:MM» |
| **Korrektur** | eine getippte Zeile wurde umgeschrieben; beide Wortlaute bleiben im Datensatz und in der Hash-Kette | «korrigiert HH:MM»; auf dem Rapport zusätzlich «ursprünglich: ‹…›» |
| **Transkript-Abschnitte** | Worte einer Sprachnotiz, je mit Offset in die Aufnahme | Untertitelzeilen unter der Zeile, auf Papier gleich |

⚠️ **Korrigierbar ist nur, was ein Mensch getippt hat** – Composer-Einträge, Meldungen,
Nachdokumentation. **Nie**, was die App über eine Handlung geschrieben hat: «Trupp 2 eingerückt»
ist die Aufzeichnung eines Vorgangs, und diesen Satz umzuschreiben hiesse, das Journal eine
Handlung behaupten zu lassen, die so nie stattfand. Die Art allein kann die beiden nicht
unterscheiden (ein Checklisten-Haken ist auch eine Zeile), das Icon muss mitreden.

⚠️ **Eine Pendenz hängt am Lebenszyklus-Ereignis, nie an `entryType: 'auftrag'`.** An das Feld
gebunden wäre jede je geschriebene Auftragszeile – laufende Einsätze wie Archiv – zu einer ewig
offenen Pendenz geworden, die niemand abhaken kann.

⚠️ **Wiederholungen werden beim LESEN zusammengefasst**, nicht beim Schreiben (`lib/verlauf` ·
`repeatRuns`): die erste Zeile steht mit einem «6×»-Vermerk, alle Wiederholungen bleiben im
append-only-Datensatz. **Von Hand geschriebene Zeilen werden nie zusammengefasst** – wer zweimal
dasselbe tippt, meinte es zweimal.

**Seit dem 23.08. gibt es den Chip vor der Zeile nicht mehr** – die Zeile ist ein Raster aus
Zeit · Scheibe · Satz · nachgestellten Fussnoten. Die 26px-Scheibe trägt den **Bereich, den der
gedruckte Rapport nennt** (Anwesenheit, Mittel, Atemschutz, Auftrag …; die Zuordnung selbst kam
am 19.08.), und wird bei einer Pendenz zum Abhak-Ring; Nachtrag, «korrigiert» und «6×» stehen als
Fussnoten hinter dem Satz statt davor. ⚠️ **Geändert ist nur, was gezeichnet wird** – was
geschrieben, gedruckt und gehasht wird, nicht: die Zeile rendert `e.text` byteweise, und alte
Zeilen mit alten Icons werden von den bisherigen Regeln weiter genau gleich eingeordnet (beides
durch Tests festgenagelt, `Journal.test.tsx`).

## Geschlossen (2026-08-07)

- **Die Erfassung schreibt in den Verlauf.** Jede Poster-Mutation läuft über `saveAction`
  (`src/lib/captureClient.ts`), das nach dem angenommenen Workspace-Schreibvorgang eine Zeile
  anhängt – mit «(QR)», weil im Rechtsdokument stehen muss, dass keine angemeldete Person
  dahintersteht. Best effort: der Zustand ist bereits gespeichert, und ein Poster ist ein Handy
  an der Magazintür – ein fehlgeschlagener Journal-Schreibvorgang darf den Tap nicht scheitern
  lassen, wird aber laut geloggt.
- **Rapportangaben und Partnerorganisationen schreiben eine Zeile** – eine pro Speicherung, die
  sagt, *welche* Felder sich geändert haben (`changedReportMetaFields`, `src/lib/report.ts`).
- **Die Atemschutz-Sicherheitswerte schreiben eine Zeile, mit altem und neuem Wert**
  (`changedSafetySettings`, `src/lib/workspace.ts`). Kontaktintervall und Nachfrist entscheiden,
  wann ein Trupp als fällig und als überfällig gilt – wer einen davon mitten im Einsatz
  verschiebt, verschiebt alle Uhren des Atemschutz-Boards gleichzeitig. «Geändert» allein würde
  nicht sagen, ob die Schwelle strenger oder lockerer wurde.

## Seither geschlossen (2026-08-17 bis 2026-08-19)

Drei der sechs Lücken unten sind zu. Sie stehen benannt hier, damit niemand sie aus einer alten
Fassung dieser Datei wieder aufmacht:

- **Einen Anwesenheitsblock entfernen** schreibt seine Zeile (`useAttendanceActions.ts` ·
  `abschluss.attendanceRemoved`). Dazu ist die **Anwesenheit jetzt insgesamt widerrufbar**, mit
  eigenem Stack und einer Korrekturzeile im Verlauf, die nennt, wer verschoben wurde.
  ⚠️ Diese Zeile trägt das Icon `people`, **nicht** `undo`: der Bereich wird aus dem Icon
  abgeleitet, und `undo` ist auch das des Atemschutz-Rückzugs – die Zeile druckte deshalb unter
  «Atemschutz». Ältere Zeilen werden über die Copy-Vorlage nachträglich richtig eingeordnet.
- **Eine Zeichnung benennen** schreibt **eine** Zeile statt einer je Tastendruck. Das Feld patcht
  still während des Tippens (ein Undo-Schritt für die ganze Bearbeitung) und schreibt beim
  Verlassen oder mit Enter, was das Label *ist* – statt den Weg dorthin zu erzählen.
- **Die Bemerkung einer Partnerorganisation** erreicht den Verlauf und damit das gedruckte
  Journal. Sie ging vorher nur ins Rapportfeld. Auch das **Löschen** einer Bemerkung sagt es jetzt.

**Teilweise geschlossen:** Korrekturen an Alarmierungszeit, Adresse, Stichwort und Priorität
erzeugen ein Audit-Ereignis (`meta.change`, `_TRACKED_META` in `backend/app/api/incidents.py`) –
aber weiterhin **keine Verlaufszeile**. Wer den Verlauf liest, sieht die Korrektur nicht.

## Lücken – bekannt, noch nicht geschlossen

Diese sind **nicht** durch die Doktrin gedeckt: es geht um den Inhalt der Aufzeichnung selbst,
nicht um Bedienhandlungen. Nach operativer Tragweite geordnet.

1. **Korrekturen an den Einsatzdaten** stehen im Audit, nicht im Verlauf (siehe oben).
   `started_at` ist ein Feld des Rechtsdokuments und trägt eigens ein
   `started_at_source = "manual"` – aber die Änderung selbst liest niemand im Verlauf nach.
2. **Leitungsnummer einer gezeichneten Linie ändern** nur im Audit (`useTruppActions.ts` ·
   `atemschutz.line.renumber`). Über diese Nummer wird zugeordnet, welcher Trupp an welcher
   Leitung arbeitet – die Zuordnung lässt sich also still verschieben. ⚠️ Seit dem 19.08. zieht
   ein Renumber die Nummer auf den Trupp nach (**über den Anker, nie über die Nummer**), die
   Zuordnung *stimmt* also – aufgezeichnet ist die Verschiebung trotzdem nur maschinenlesbar.
3. **Einzelne Plan-Annotation löschen** nur im Audit (`src/components/useBoardDoc.ts` ·
   `removeAnno`), während das Gruppen-Löschen eine Zeile schreibt (`Whiteboard.tsx`).
4. **Rapport-Beilagen** hinzufügen/entfernen nur im Audit, die Bildlegende gar nicht
   (`src/IncidentWorkspace.tsx`, Rapport-Beilagen-Block).
5. **Fahrer eines GPS-Fahrzeugs** und **Gebäude/Stockwerk anlegen** haben keinen Kanal.

*(Die Dateipfade sind bewusst ohne Zeilennummern: die Datei ist zweimal daran veraltet, dass
`IncidentWorkspace.tsx` sich verschoben hat, nicht daran, dass sich das Verhalten änderte.)*

## Wenn du etwas ergänzt

- Eine Handlung, die den **Inhalt der Aufzeichnung** ändert, gehört in den Verlauf.
  Eine Handlung, die nur die **Ansicht** ändert, gehört höchstens in den Audit-Strom.
- Löschen und Anlegen gehören in denselben Kanal. Die Asymmetrie ist es, die Leute glauben
  lässt, es werde gar nichts erfasst.
- Der Verlauf ist append-only: eine Korrektur ist eine neue Zeile, nie eine geänderte.
