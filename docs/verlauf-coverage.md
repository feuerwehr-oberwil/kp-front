# Was im Verlauf steht – und was nicht

Der **Verlauf** ist die menschenlesbare Einsatzchronik. Er ist *keine* Protokollierung jeder
Bedienhandlung, und das ist Absicht: ein Journal, in dem jedes Verschieben eines Symbols steht,
ist eines, in dem man den Funkspruch nicht mehr findet.

Diese Seite hält fest, **welche Handlung wo landet**, damit sich niemand darauf verlässt, dass
etwas im Verlauf steht, das dort nie hingeschrieben wurde. Stand: 2026-08-07.

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

## Atemschutz: anmelden steht drin, löschen nicht

Ein neu angemeldeter Trupp **erzeugt** eine Verlaufszeile – «Trupp {name} angemeldet»
(`src/lib/useTruppActions.ts:92`). Wer meint, das fehle, sieht meist eines von beidem:

- Der Verlauf ist beim Anmelden nicht auf dem Schirm – Atemschutz ist eine eigene Ansicht.
- **Das Löschen eines Trupps schreibt nichts** (`src/lib/useTruppActions.ts:474`, nur `emit`).
  Ein Zyklus aus Anlegen → Löschen → neu Anlegen sieht deshalb aus, als sei nichts erfasst
  worden. Dasselbe gilt für das Wiederherstellen (`:482`) und den Truppfarben-Wechsel (`:150`).

Alles Übrige am Atemschutz steht im Verlauf: Platzieren, Funkkontakt, Druckmeldung, Statuswechsel,
Bearbeiten, Wiedereinrücken, Leitung verknüpfen/lösen, Alarm-Eskalation.

## Bewusst still

| Bereich | Warum |
|---|---|
| Zeitplan / Schichten | `src/lib/useShiftActions.ts:16-19`: *«attendance is a RECORD … a plan is not, and logging each nudge of a chip would bury the operational journal under bookkeeping»* |
| Checklisten | nur Meilensteine erzeugen eine Zeile (`src/lib/useChecklistActions.ts:34`) |
| Zeichnungen bearbeiten (Farbe, Stil, Geometrie) | Bedienhandlung, kein Ereignis – siehe die Doktrin-Notiz unten |

Die Doktrin dazu steht in der AdFU-Ablaufbeschreibung: *«Der Verlauf ist keine automatische
Einsatzchronik … Der AdFU sollte nicht jede Bedienhandlung protokollieren.»*

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

## Lücken – bekannt, noch nicht geschlossen

Diese sind **nicht** durch die Doktrin gedeckt: es geht um den Inhalt der Aufzeichnung selbst,
nicht um Bedienhandlungen. Nach operativer Tragweite geordnet.

1. **Einen Anwesenheitsblock entfernen** schreibt nichts (`src/lib/useAttendanceActions.ts:94`),
   während das Leeren des ganzen Eintrags eine Zeile erzeugt (`:71`) – und das Entfernen des
   letzten Blocks *ist* dasselbe. Vermutlich schlicht übersehen.
2. **Korrekturen an Alarmierungszeit, Adresse, Stichwort, Priorität** haben weder Audit-Event
   noch Verlaufszeile (`backend/app/api/incidents.py:222-233`). `started_at` ist ein Feld des
   Rechtsdokuments und trägt eigens ein `started_at_source = "manual"` – aber nicht, wann und
   durch wen.
3. **Einzelne Plan-Annotation löschen** nur im Audit (`src/lib/useBoardDoc.ts:54`), während das
   Gruppen-Löschen eine Zeile schreibt (`src/components/Whiteboard.tsx:1291`).
4. **Leitungsnummer einer gezeichneten Linie ändern** nur im Audit
   (`src/IncidentWorkspace.tsx:2557`). Über diese Nummer wird zugeordnet, welcher Trupp an
   welcher Leitung arbeitet – die Zuordnung lässt sich also still verschieben.
5. **Rapport-Beilagen** hinzufügen/entfernen nur im Audit, die Bildlegende gar nicht
   (`src/IncidentWorkspace.tsx:931`, `:955`, `:948`).
6. **Fahrer eines GPS-Fahrzeugs** (`src/IncidentWorkspace.tsx:2491`) und
   **Gebäude/Stockwerk anlegen** (`:2815`, `:2831`) haben keinen Kanal.

## Wenn du etwas ergänzt

- Eine Handlung, die den **Inhalt der Aufzeichnung** ändert, gehört in den Verlauf.
  Eine Handlung, die nur die **Ansicht** ändert, gehört höchstens in den Audit-Strom.
- Löschen und Anlegen gehören in denselben Kanal. Die Asymmetrie ist es, die Leute glauben
  lässt, es werde gar nichts erfasst.
- Der Verlauf ist append-only: eine Korrektur ist eine neue Zeile, nie eine geänderte.
