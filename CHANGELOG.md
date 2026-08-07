# Changelog

All notable changes to KP Front are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**What the version number means for a deployment** – KP Front is a self-hosted app, not a
library, so the number answers one question: *how much attention does this update need?*

| Bump | What it means for you |
| --- | --- |
| **MAJOR** | Operator action required – a breaking config change, a migration that can't be rolled back, a new mandatory env var, a Postgres major. Read the notes before updating. |
| **MINOR** | New features. Migrations run automatically on boot; `docker compose pull && docker compose up -d` is enough. |
| **PATCH** | Fixes only. Always safe to take. |

Releases are labels on a `main` commit that CI already proved green – prod and the demo deploy
continuously from `main`, so a tag exists for *other* stations, not for us. Put differently:
every published image has already been carrying live incidents at Feuerwehr Oberwil before it
was tagged.

**Why still 0.x?** Because exactly one fire station runs this in production, and a 1.0 claims
more than that. It becomes **1.0 when a second station is running it in the field** – not when
the feature list feels complete. Until then, read 0.x as *"not yet proven anywhere but
Oberwil"*, **not** as *"we may break things without warning"*: the table above holds today and
will keep holding.

`0.1.0` is the initial public release: the git history was squashed for the open-source launch,
so this file – not the log – is the record of what shipped up to that point.

## [Unreleased]

### Added

- **The Einsatzrapport takes Beilagen.** Photos that belong to the REPORT rather than to the
  Verlauf – an ID document, a damage close-up, a handed-over form. They are captured in the
  rapport dialog (or at the Erfassungs-Poster, below), carry a caption, and print at the end
  **one plate per page, large enough to read** – which is the only reason to photograph a
  document in the first place. Deliberately not a Verlauf row: the Verlauf is a timed record of
  what happened, and a picture of somebody's licence is neither an observation nor a moment.
  Beilagen live in the incident's media store like every other incident medium.

- **Partnerorganisationen can be recorded.** The field had been in the model – and on the
  printed rapport – for months, but nothing ever wrote it, so every rapport fell back to the
  tick-off row from the station config and «Polizei war da» was all the paper said. It is now a
  **checklist over the station's own list**: every organisation is on screen, ticked or not, and
  ticking one reveals the single free line that is the point of the block – «Wm. Keller,
  übernimmt Verkehr ab Kreisel». The one that turns up anyway can still be typed in. Screen and
  paper ask it identically, in the rapport dialog and at the Erfassungs-Poster.

- **The printed Partnerorganisationen are a real form.** Every configured organisation prints
  with an **empty box**, not just the ones that were ticked on screen – a rapport gets corrected
  on paper as often as on screen, and an organisation that turns out to have been there needs
  somewhere to put the tick. A blank list of names could never say «die Polizei war NICHT da»,
  which on paper is the whole point of the block.

- **Remarks on Material and on people.** «3 Sack» says how much, «an Werkhof übergeben» says
  what happened to it; «Meier» says who was there, «Fahrer TLF, abgelöst 21:40» says what they
  did. Both print with their row. The Mittel remark rides the append-only log the way the
  quantity does (a value sets, `null` clears, omitted keeps), so a remark never disturbs a
  quantity and a quantity never wipes a remark.

- **The Kroki can be printed as of a chosen moment.** «Die Rettung ist abgerückt, sie fehlt auf
  dem Rapport» has an honest answer and a dishonest one. The dishonest one is a collage of
  everything ever placed – a Lage that never existed, with two vehicles in one spot at
  different times. The honest one is to name the moment: the Kroki row offers **«Jetzt» or a
  time**, and a chosen time reconstructs the Lage from the event journal – the same fold the
  Wiedergabe uses, so paper and replay can never disagree. Vehicles come from the recorded GPS
  samples for that instant. The caption dates the PICTURE, not the printing.

- **The Erfassungs-Poster (QR) can contribute Beilagen.** The poster is where the paperwork
  gets done, so the photos that belong to the rapport belong there too. The token's key set was
  **deliberately widened** by `attachments` (`CAPTURE_WORKSPACE_KEYS`), with exactly one new
  write route for the bytes: `POST /api/capture/incidents/{id}/media`, **photos only**, one
  reachable incident, the same content-type allowlist and size cap as the editor upload, behind
  the same per-IP rate limit. No audio there – that would be a recording of people, and the
  clipboard by the door is not for that. The tactical picture stays invisible to the token. See
  `docs/ALARM-INTEGRATIONS.md`.

- **Trupp colours.** Every Atemschutz-Trupp can be given one – in the Trupp form, on its map
  marker, or on its plan chip; all three write the TRUPP, so board, Lage and plan agree. A
  chosen colour is used as chosen, duplicates included: «alle Löschtrupps rot» is a legitimate
  way to read a Lage. A station can seed one per Auftrag (`doctrine.auftragColors`, Admin ▸
  Doktrin); empty keeps today's one-colour-per-Trupp.

- **A break clock in the Atemschutzüberwachung.** The Einsatzzeit is finished at the «Raus» and
  stands still; «Draussen seit» runs instead – the recovery time before that crew can go back
  in.

### Fixed

- **Photos were missing from the printed Rapport.** The upload was the culprit, not the print:
  the server takes jpeg/png/webp only, a phone hands over a 4–12 MB HEIC. The POST failed, the
  row kept its local `blob:` URL, the offline queue retried something that could never succeed
  – and the picture silently never reached the paper. Photos are now re-encoded **before the
  first attempt** to a JPEG of at most 2200 px: a type the server takes, a size that fits under
  any deployment's upload cap, and still far more than A4 can print. Applies to journal photos
  and to Beilagen; a Beilage that still fails now says so instead of quietly not printing.

- **The Einsatzdauer kept counting on a finished Einsatz.** An archived incident opened from
  the Verlauf counted on from `now` and claimed days of Einsatzdauer for something that lasted
  forty minutes last Tuesday. It stops at the Einsatzende.

- **An archived Einsatz was only apparently read-only.** The banner has always said «Nur
  ansehen – zum Bearbeiten reaktivieren», but the checklist, Anwesenheit, Mittel and the whole
  rapport dialog could still be changed – and saved. The unlock is «Reaktivieren», once and
  with its own confirm; edits after it stay badged as Nachträge, which is what that is for.

- **A contact clock was allowed to jump backwards.** On the public demo the time offset was
  re-derived on every page load, so a plain reload threw every contact clock back – a Trupp at
  0:35 came back as 0:08. On a monitoring surface that is the one direction a clock must never
  move: the time since the last Funkkontakt read shorter than it was. The offset is now
  anchored once per incident and seed.

- **«Bereitstellen» sent the Trupp in.** A wrapper swallowed the standby flag, so a re-equipped
  Trupp started a contact clock while it was still standing at the vehicle – exactly the case
  the fork exists to prevent.

- **A GPS vehicle was rotated twice.** A live vehicle is `kind: 'vehicle'`, not a placed
  symbol, so it fell out of the vehicle branch and the marker rotated the already-rotated glyph
  again: the body turned twice and the baked-in name tilted with it. The name stays horizontal;
  only the body rotates.

- **A photo left the app.** Tapping a picture went through `target="_blank"`, which on an
  installed iPad hands it to Safari – leaving a running Einsatz to look at a photo of it.
  Pictures open in the app now, with a download.

- **Prints came out of the station printer back-to-front.** A printer that ejects face-up
  delivers a reversed stack. The relay path now reverses the document
  (`report.reversePrintOrder`, switch it off for a printer that ejects face-down); the
  downloaded PDF stays in reading order, because that one is read on a screen.

- **Ein GPS-Fahrzeug kann einen Fahrer bekommen.** Der Feed weiss, wo ein Fahrzeug ist, nie wer
  darin sitzt – und genau das braucht die Einsatzleitung, um es zu erreichen. Der Fahrer wird am
  Fahrzeug gesetzt, aus der Mannschaft, steht auf der Beschriftung und druckt auf dem Kroki wie
  bei einem von Hand gesetzten Fahrzeug. Er überlebt den nächsten GPS-Poll, der das Symbol sonst
  neu baut.

- **Der Live-Standort in der Anwesenheit ist wieder eine Markierung, keine Ablesung.**
  «63 m · jetzt» hinter jedem Namen war eine zweite Zahlenspalte neben dem, wofür die Liste
  gelesen wird – den Namen. Es bleibt das Symbol, direkt links neben der Uhr; die Angabe steht
  im Tooltip, und ein Tipp zeigt die Person weiterhin auf der Karte.

- **Die Geschoss-Skizze kam halb hochkant und halb quer aus dem Drucker.** Each page was shaped
  by the number of storeys that happened to land on it – two gave an upright sheet, one a wide
  one – so a building with an odd number of floors printed in two orientations. Every page keeps
  the same grid now; a page short of a storey leaves its lower band empty, which is what a stack
  with nothing above it looks like.

- **Die Kroki-Vorschau zeigt, was gedruckt wird.** Sie zeichnete nackte Linien – der eine
  Bildschirm, dessen ganze Aufgabe «so kommt es heraus» ist, zeigte weniger als das, was
  herauskam: Teilstück-Gabel, Endetikett («Leitungsnummer · Inhalt · Stockwerk · Trupp»),
  Distanz- und Beschriftungs-Chips fehlten, gestrichelte Linien erschienen durchgezogen und jede
  Linie gleich dick. Jetzt dieselben Bausteine wie auf der Lagekarte, unter derselben
  Beschriftungs-Einstellung wie der Export.

- **Das Kroki trägt einen Nordpfeil.** Auf dem Bildschirm weiss man, wie man schaut; auf Papier
  nicht – und ein Kroki ohne Nordmarke lässt sich weder neben einen Plan legen noch gegen das
  Gelände lesen.

- **Das Einsatzjournal beginnt auf einer eigenen Seite.** Es ist eine Beilage, keine Fortsetzung:
  bisher fing es dort an, wo der unterschriebene Teil gerade endete – die ersten Einträge standen
  im Weissraum unter den Unterschriften, und beides las sich als ein Dokument.

- **Die Geschoss-Skizze hatte einen Kasten um jede Stockwerk-Beschriftung.** «2. OG» wurde als
  breite Textbox gezeichnet statt als Pille: eine fehlende Breitenangabe bedeutet laut Vertrag
  die einzeilige Pille, der Code setzte aber eine Standardbreite ein.

- **Auf dem Personalblatt ist auch der Beginn grau, wenn jemand von Anfang an dabei war** – eine
  Zeile, die auf beiden Seiten grau ist, muss niemand prüfen. Und die Zeitspalte passt sich an
  ihren Inhalt an: mit Datum brach «02.08. 14:41 – 04.06. 11:00» bisher auf zwei Zeilen um.

- **Das Kroki-Fenster ist nicht mehr durchscheinend.** Der Rapport dahinter schlug durch genau
  die Karte, die man durch dieses Fenster beurteilen soll.

- **Die Datums-Eingabe hatte am Rechner keine Datumswahl.** Der Auswahl-Dialog zeigte eine grosse
  leere Fläche mit nur der Uhrzeit darin: die Räder sind eine Finger-Bedienung, und mit Tastatur
  wurde nichts an ihre Stelle gesetzt. Jetzt Tag · Monat · Jahr als Auswahlfelder neben der Zeit.

- **Die Demo widersprach sich selbst.** Der Alarm lag 14 Minuten zurück, die Mannschaft hatte sich
  aber vor 20 Minuten eingetragen – sechs Minuten *vor* dem Alarm – und der erste Trupp ging in
  derselben Minute ins Gebäude, in der der Pager losging. Genau das, was die neue
  Zeiten-Plausibilität anzeigt: die Demo fiel durch die eigene Prüfung.

- **«Einsatz abschliessen» schliesst nur noch sich selbst.** Der Einsatzrapport wurde vorsorglich
  mitgeschlossen – auf der Demo, wo die Aktion gar nicht ausgeführt wird, verlor man damit seinen
  Platz für etwas, das nie passiert ist.

- **Was über den QR-Poster erfasst wird, steht jetzt im Verlauf.** Anwesenheit, Material,
  Rapportangaben und Beilagen liessen sich über das Poster ändern, ohne dass eine einzige Zeile
  entstand – dieselbe Handlung am Tablet schrieb immer eine. Jede Zeile trägt «(QR)», weil im
  Rechtsdokument sichtbar sein muss, dass sie nicht von einer angemeldeten Person stammt.

- **«Einsatzstunden 0:00» bei vier Anwesenden.** Ein noch offener Anwesenheitsblock leiht sich
  das Einsatzende – war das unplausibel (etwa ein vertipptes Datum), ergab jede Person eine
  negative Dauer, die auf 0 gekappt wurde. Vier Leute, null Stunden, und nichts sagte warum. Ein
  Block, der vor seinem Anfang endet, ist jetzt **nicht auswertbar** statt «gemessen und
  nichts», und das Blatt schreibt hin, wie viele Personen deshalb in keiner der beiden Summen
  stehen. Die Zahlen stehen ausserdem auf einer eigenen Zeile, die Rundungsregel als Fussnote
  darunter – als ein Satz lief das über die ganze Seitenbreite und die zwei Zahlen, die
  überhaupt jemand überträgt, lagen mittendrin.

- **Ein Klick ins Bild zoomt.** Der Zeiger zeigte eine Lupe, aber ein Klick tat nichts – der Zoom
  lag hinter Doppelklick, Mausrad und Zwei-Finger-Geste, von denen das Bild keine anzeigt.
  Klick hinein, Klick heraus; die anderen Gesten bleiben.

- **Der Rapport hat ein eigenes Logo.** Die Marke der App wird auf einem Bildschirm im
  Vorbeigehen gelesen, die des Rapports auf Papier von einer Gemeinde oder einer Versicherung –
  Stationen wollen dort zu Recht ein anderes Zeichen, und eines mit dem vollen Namen liest sich
  in einer Kopfzeile schlecht, auf einem Briefkopf richtig. **Admin → Branding → Rapport-Logo**;
  leer bedeutet weiterhin das Logo darüber, niemand muss zweimal hochladen.

- **Ein Eintrag riss einen von der Karte weg.** Nach «Erfassen» ging der Verlauf immer auf – auch
  wenn der Eintrag über den Knopf am unteren Rand oder über eine Checkliste begonnen wurde. Der
  Verlauf bleibt jetzt, wie er war: wer ihn offen hatte, sieht ihn weiter, wer auf der Karte
  arbeitete, bleibt dort. Gespeichert wird es ohnehin bestätigt.

- **In der Bildlegende einer Beilage liessen sich keine Leerzeichen tippen.** Die Legende wurde
  bei jedem Tastendruck beschnitten, also war das eben getippte Leerzeichen weg, bevor der
  nächste Buchstabe ankam – «Ausweis Lenker» wurde «AusweisLenker». Aufgeräumt wird jetzt einmal,
  beim Verlassen des Feldes.

- **Die Partnerorganisationen drucken als vollständige Liste.** Wie beim Personal: jede Ortschaft
  aus der Stationsliste mit eigenem Kästchen – angekreuzt oder eben nicht – und eine leere Zeile
  am Schluss für die, an die niemand gedacht hat. Ein Abschnitt, der nur die Angekreuzten zeigt,
  kann nicht sagen «die Polizei war NICHT da». Die Demo bringt jetzt auch eine Liste mit.

- **Wer die Atemschutz-Sicherheitswerte verstellt, hinterlässt eine Spur.** Kontaktintervall und
  Nachfrist entscheiden, wann ein Trupp als fällig und als überfällig gilt – wer einen davon
  mitten im Einsatz verschiebt, verschiebt alle Uhren des Atemschutz-Boards gleichzeitig, und das
  hinterliess bisher gar nichts: die Rekonstruktion konnte sehen, dass ein Trupp überfällig
  wurde, aber nicht, dass die Schwelle unter ihm verschoben worden war. Die Zeile trägt **alten
  und neuen Wert** – «geändert» allein sagt nicht, ob die Grenze strenger oder lockerer wurde.

- **Auch die Rapportangaben schreiben eine Zeile.** Einsatzleiter, Endezeit, Gerettete,
  Partnerorganisationen, die Alarm- und Fahrzeugzeiten – der Inhalt des Dokuments, das
  unterschrieben wird – änderten sich bisher spurlos. Eine Zeile pro Speicherung, die sagt
  *welche* Felder es waren.

- **Ein Übungsrapport sah aus wie ein Einsatzrapport.** Ob ein Einsatz eine **Übung** war, stand
  nirgends auf dem Papier – dabei ist es das Einzige, was ändert, *was das Dokument überhaupt
  ist*, und Übungen fliessen nicht in die Statistik ein. Ein Übungsrapport, der sich wie ein
  Ereignis liest, widerspricht den Zahlen dahinter. Er steht jetzt über dem Titel, vor allem
  anderen.

- **Die Kategorie hiess auf dem Rapport «Stichwort».** Sie ist die Kategorie – das Stichwort ist
  der Titel darüber. Jetzt heisst sie, was sie ist.

- **Die Adresssuche verlor die Strasse, sobald man die Postleitzahl tippte.** «storchenweg 8,
  410» kam mit sechs Treffern zurück, von denen keiner ein Storchenweg war. Eine PLZ hat vier
  Ziffern – eine halb getippte galt nicht als eine, also hängte die App die eigene Ortschaft
  noch dazu. Die Anfrage trug zwei Ortschaften, und der Kartendienst antwortete, indem er auf
  die ZAHLEN passte und den Strassennamen fallen liess. Sobald jemand selbst eine Ortschaft
  schreibt, bleibt die Anfrage jetzt unangetastet – und **die eigene Gemeinde steht zuoberst**,
  wenn es eine Strasse in mehreren Dörfern der Region gibt.

- **The station's logo prints on the Rapport.** The uploaded Logo (Admin → Branding) sits above
  the title as a letterhead – the rapport leaves the building, to the Gemeinde, the Versicherung
  or the GVB, and should say whose it is before it says what happened. Deliberately modest, and
  resolved on the server from the station's own configuration rather than sent along with the
  print, so nothing else can put a picture at the top of a document that gets signed. An SVG is
  rendered; a missing or unreadable file simply prints nothing.

- **The Kroki crop window collapsed into a strip.** Centring the frame cancelled its stretch, so
  it fell back to a width of nothing and took its own height with it – the ± buttons and the
  hint ended up floating over the header and the footer. The frame is sized explicitly now.

- **Everything that adjusts the crop sits under it, not on it.** The ± buttons and the
  Kroki-Stand floated over the very picture they were there to adjust, and the ± column landed
  on the slider's right end. They share one bar below the map, so the map stays entirely map and
  nothing has to be repositioned when the frame changes shape. The crop also gives the window's
  chrome its room back: on a laptop the sheet was tall enough to clip «Ausschnitt übernehmen»
  off the bottom.

- **The Rapport says which times were measured and which it worked out.** Somebody still on
  scene when the rapport prints had no Bis-Zeit at all, so the sheet WinFAP reads the hours off
  said nothing about them. The incident's own end fills that in now – and prints **grey**,
  along with a start derived from the alarm, so a line that is grey on both ends is one nobody
  has to check and a black one is a time somebody actually recorded. On an Einsatz past
  midnight the clocks carry their **date**: «08:23 – 09:00» reads as 37 minutes when it was 25
  hours.

- **The Anwesenheits-Übersicht flagged everybody as having left.** «· bis 09:00» stood behind
  every name, because an open block was filled with the Einsatzende before being displayed –
  so the one thing the line exists to show, who went home early, was the one thing invisible in
  it. Only a recorded departure gets a time; for everyone else the ticked name is the statement.

- **The Kroki remembers how it was framed.** Crop, moment and orientation are kept with the
  Einsatz, so a second copy – a correction, one for the Gemeinde – comes out of the same window
  instead of being set up from scratch each time, on any device.

- **The Kroki can print upright.** A Lage that runs north–south was letterboxed into a
  landscape sheet with white down both sides. **Hoch · Quer** sits in the crop window, starts on
  whichever fits the Lage, and the page follows it – the crop window has the proportions of the
  sheet, so what is framed is what comes out.

- **The Atemschutz-Beilage printed «loeschen».** The Auftrag was sent to the printer as the
  value it is STORED as instead of the one it reads as. It also lays its lines out on one tab
  stop now – Mitglieder, Auftrag / Ziel, Leitung, Eintritt each started wherever their own label
  ended – and the section heading is no longer smaller than the Trupp names underneath it.

- **The Details box was mostly dotted lines under things that were already filled in.** A line
  is an invitation to write, so it is drawn where there is nothing to read – an empty
  Kontaktperson still gets one – and the values share one tab stop per column instead of each
  starting after its own label. «Gerettete (Personen / Tiere)» is just **Gerettete**; the value
  on the line says which.

- **The Unterschriften read «Einsatzleiter · Céline Widmer: ____».** The name belongs to the
  role that signs, so it is a value now – «Einsatzleiter: Céline Widmer ____» – and the line to
  sign on stays whether or not the name above it is known. The demo fills a Kommandant, so both
  lines show what a station's own configuration does.

- **The printed Kroki lost every label on it.** A symbol carries what was typed onto it – the
  Einsatzleiter's name, a Fahrer, a Bezeichnung – and the map has always shown it. Only Trupps
  and Notizen ever sent theirs to the print, so a Kroki that read perfectly on screen came out
  as unlabelled glyphs. The paper now carries the same labels, in the same setting
  («Beschriftungen»), as the screen it was framed on.

- **Impossible Einsatzzeiten now say so.** A rapport is written hours later, and «04.06.2025»
  reads exactly like a correct date in a field showing one line. An Ende before the Ausrücken,
  an Ausrücken before der Alarmierung, or a time in the future is now named right under the
  field it belongs to – as a **hint, not a barrier**: an Einsatz over midnight is normal, and a
  correction made at 3am is worth more than a form that refuses it.

- **Datum und Zeit are asked as two things, not one string.** The desktop got a bare
  `TT.MM.JJJJ HH:MM` text box, which is where a mistyped year comes from in the first place.
  Both now open the same picker on every device – a day/month/year selector beside the clock,
  with typing still available inside it. The **Rückmeldung ELZ** gained the day it was missing:
  it defaults to today, and offers the incident's other days for the call that went out
  yesterday.

- **The Kroki «Stand» said in eleven words what the slider can show.** «Lage wird
  rekonstruiert …» needed a fixed slot beside the control so its coming and going didn't resize
  the bar under the finger. The reconstruction now reports itself as a thin bar running along
  the track it belongs to.

- **The printed Material amounts didn't line up.** «1 Stk» started wherever its label happened
  to end, so a column of quantities sat at a different place on every row, and a three-line
  remark dragged its amount down the page with it. Amounts hang on the right edge and stay on
  their own line.

- **Personen und Tiere didn't line up either.** On the Erfassungs-Poster the two counters were
  each only as wide as their own word, so the steppers staggered. They share one column now.

- **A Verlaufszeile with several photos kept only one of them.** Attaching three pictures to one
  entry uploaded all three and recorded the last one. Each upload wrote the row's whole picture
  list, and it read that list from the moment the callback was built rather than from the moment
  the upload landed – so every one of them wrote a list of exactly one. The pictures were on the
  server the whole time, with nothing pointing at them. The swap happens in the journal store
  now, which reads the row as it is when the picture actually arrives.

- **Offline, a Verlaufszeile with several photos lost all but the last.** The upload queue held
  one entry per row, so the second picture of an entry evicted the first before either could be
  sent – on the surface whose entire promise is that a capture survives no signal and a reload.
  The queue keys on the picture now, and each entry remembers which one it stands for, so the
  upload that lands later replaces its own picture instead of appending a duplicate.

- **Session picture links were written into the append-only record.** A row's `blob:` URLs –
  valid only inside the tab that made them – rode along into the journal on the server, where
  they are permanent and meaningless: a broken thumbnail on every other device and after every
  reload. Only real, uploaded pictures reach the record now; the pending ones stay on screen
  until they land.

- **A pasted paragraph made the whole Rapport unprintable.** A remark on a person or on a
  Material line prints inside a fixed cell, and a cell cannot be split across pages – so past
  about three thousand characters the composer failed and the rapport could not be printed at
  all, with an error naming no field. A remark that long is truncated on paper instead: printing
  must never be blocked by what somebody typed, and refusing to accept the text would only have
  moved the failure somewhere the operator can do even less about it.

- **Partnerorganisationen could be edited on a rapport that cannot be edited.** The block sits
  below the read-only section, so on an archived Einsatz – and for a viewer – the tick-offs and
  the free line stayed live: the edit was accepted on screen and silently never saved. Same
  failure the read-only Rapportangaben fixed a day earlier, in the one place that had grown past
  the guard.

- **The Kroki could print a caption for a picture it wasn't showing.** While the reconstruction
  for a chosen moment is still running – and after one fails – the sheet falls back to the
  current Lage, but the caption still said «Stand 21:14». On a document that is a legal record,
  no caption is the honest answer.

- **Three of the new things could not be found.** The Kroki moment sat behind the sections
  fold, the Partnerorganisationen behind a «+» at the bottom of a long section, and the Mittel
  remark existed only in the «Quelle» view – not the default one, which is a plain bug. Now: the
  Kroki «Stand» lives on the crop screen every print already goes through, the station's partner
  list is offered as TICK-OFFS the way the paper form asks it (ticking reveals that partner's one
  free line), and a Mittel line offers its remark wherever an amount was recorded. A person's remark also shows
  in the Anwesenheit row – a remark nobody sees is a remark nobody keeps up to date.

- **Anwesende und Einsatzstunden stehen auf dem Rapport.** One line under the roster: how many
  people were there, and how long – `6 Anwesende · Einsatzstunden 14:35 (gerundet 16:00)`. The
  first figure is **raw**, summed to the minute, because that is what actually happened. The
  second is the Sold convention: each person's own time rounded up to the next block, but only
  once a few minutes past the previous one, then summed – **per person, never on the total**,
  which would otherwise make the same Einsatz answer differently depending on how many people
  came. The station sets the block and the grace (`report.hoursRounding`, default 30 / 5 minutes,
  `docs/CONFIGURATION.md` §1b), and **the paper prints the rule next to the number** – a rounded
  figure nobody can reproduce is a figure nobody trusts. The per-person Stunden columns stay off
  the paper as decided in 2026-07: WinFAP computes those from the recorded von–bis. This is the
  summary for whoever signs the sheet.

- **Beilagen scale now.** Two photos and fifty are different documents. Up to eight print as
  large plates – the reason to photograph a driving licence is to read it off the paper. Beyond
  that they become a numbered contact sheet, three across: fifty pictures are six sheets instead
  of twenty, and what the paper is for at that count is *which pictures exist*. Either way each
  carries its number **B7**, so the Verlauf, a phone call and the paper can name the same
  picture, and every page names its Einsatz in the footer – a rapport gets stapled, unstapled and
  passed around, and a loose sheet that does not say which Einsatz it belongs to cannot be put
  back. Whether the photos print at all stays the Beilagen toggle in the rapport dialog; the
  downloaded PDF always carries everything.

- **The printed rapport ejected a blank sheet.** Every Anhang section both *opens* with a page
  break and *closes* by switching the page template back – so two adjacent sections put two
  breaks in a row and produced a page carrying nothing but its footer (between the Kroki and the
  Beilagen), and a rapport whose last section was the Kroki, the plans or the Beilagen ended on
  one. Sections stay independent – each may legitimately be absent – so the breaks are collapsed
  once, at the end.

- **Personal and Partnerorganisationen drifted out of line, like Material did.** Both laid their
  two halves out as shared table rows, so one person's remark set the height for whoever happened
  to sit opposite them and from there down the columns no longer shared a baseline. Each half is
  its own column now. It also **can't crash any more**: independent columns are indivisible
  flowables, and a roster longer than a page took the whole rapport down with a layout error
  (reproduced at 120 people) – they are laid out in page-sized chunks, measured rather than
  guessed at, so the ordinary one-page case is still exactly two columns.

- **The sections print in the order the app asks for them.** Anwesenheit → Material →
  Partnerorganisationen: our own people, our own material, then everyone else – the same
  sequence as the rapport dialog on screen, so filling in and checking the paper follow one
  order. «Material (Menge eintragen)» is just **Material**; the amount stubs say that already.

- **A Beilage no longer claims a whole page.** Four photos meant four sheets. The app is where
  these are looked at – on paper they only have to be readable – so plates are capped and flow
  two to three per page, image and caption sharing a left edge and never separated by a break.

- **A picture opened underneath the surface that opened it.** The full-size viewer had no
  layer of its own, so it shared the base scrim: opened from the Verlauf, from the rapport's
  Beilagen or from the poster, it landed *behind* the sheet that launched it and read as «das
  Bild öffnet nicht». It now sits above everything, and the picture **zooms** – wheel, pinch,
  double-tap – because a document is usually photographed for one detail on it.

- **The Mittel remark dialog was invisible.** It mounted, took the focus and swallowed the tap,
  but `.ui-dialog` on its own positions nothing – every other dialog pairs it with a sheet class
  that supplies the geometry, and this one did not. Same class of bug, twice in one afternoon:
  the pencil now opens the standard sheet, beside the count it annotates rather than out at the
  row's edge.

- **The Kroki «Stand» slider reconstructed on every notch.** Dragging it fired one full
  reconstruction per step, so the busy line blinked, the picture redrew mid-drag and the sheet
  flickered. It now reconstructs when the thumb comes to rest, the busy slot keeps its space
  instead of resizing the bar under the finger, and the readout carries the **date** as well as
  the time – on a long Einsatz «21:14» does not say which day.

- **The printed Material sheet drifted out of line.** The two columns shared table rows, so one
  material with a four-line remark stretched the row on the *far* side too and from there down
  nothing sat on the same baseline. Each half is its own column now and simply flows past the
  other.

- **The Erfassungs-Poster asked one section three different ways.** «Angaben» had grown two
  blocks that each expand into a stack of their own, with a label stranded in the left gutter
  next to them. **Partnerorganisationen** and **Beilagen** are now sections like Personen and
  Material – every block on that page opens and closes the same way – and a section's header no
  longer floats free of the body it belongs to.

- Smaller things on screen: the left rail centred its labels instead of putting them next to
  their icons (the UA stylesheet centres text in a `<button>`), the module chips were wider
  than their column and pushed the rows apart, the rapport's section list was more air than
  content, «Erweitert» was a second door in front of a door, the Kroki crop now gets the screen
  instead of a postcard (with ± on the map), the colour picker is one scrolling row instead of
  a wall of swatches, and a freshly placed Notiz grows with its text instead of starting as a
  paragraph-wide box.

### Fixed

- **The scheduled Objektplan-Pull matched nothing and said nothing.** `plans/index.json` names,
  per row, the **publisher's** object id. A deployment's own object ids are unrelated — the two
  id spaces overlap by zero — but the pull compared them directly, so every row resolved to
  "unknown object" and was skipped. It fails safe (no deletions, no wrong writes) and the
  scheduler only logs when something changed, so a run that stored nothing and a run that had
  nothing to do produced identical output. Observed on a production deployment: **582 reference
  datasets, all `uploaded`, zero `snapshot`**, after the job had run hourly since it shipped.

  Objects gain **`source_key`** — the station's own stable key for the object, whatever its
  pipeline calls it (a folder name, an Objekt-Nr, a row id). Publishers already emit it; the
  pull now matches on it. It is **opaque**: this app stores and compares it, never parses it,
  and no id-derivation scheme lives here.

  Also fixed in passing: the dataset id was built from the publisher's UUID, so the upload door
  and the pull door would have created **two datasets for one plan**. It is now built from the
  local object, matching what `admin_objects` writes.

  **For a deployment that uploads plans by hand: nothing changes and no key is needed.** For one
  that runs a scheduled pull, set `sourceKey` on each object in the objects manifest (your
  importer already knows it) and re-run the import — it upserts by id, so that is also the
  backfill. Until a key is set the pull skips, exactly as before, but the log now names the
  `source_key` that found no object instead of an id nobody can look up.

  Migration `c7d8e9f0a1b2` adds the column: additive, nullable, partial-unique on non-NULL.

### Changed
- **An alarm now opens its Einsatz by itself; the take-wizard is gone.** The link in the alert
  reached the responder before the Einsatz existed here. An alarm landed in a pool and only became
  an incident when somebody at the Magazin took it through an intake wizard – so every responder
  who tapped their Einsatz-Link on the way in was told *«Einsatz nicht (mehr) verfügbar»* until a
  colleague got to a tablet, and the people furthest from the station waited longest for the Lage
  they most needed. The wizard was buying a clean record at the price of the Einsatz, which is the
  wrong trade at 3am: correcting a dropdown afterwards costs seconds. Every intake path now opens
  the incident on arrival – the Divera poll and webhook, the generic `POST /api/alarms`, and the
  link exchange itself, which opens an alarm still sitting in the pool rather than answering a dead
  end. The expert corrects Stichwort, Kategorie, **Priorität** and Ort afterwards, from the review
  banner on the running Lage or the Einsatzdaten panel one tap behind it.

  What keeps the figures honest is not the wizard but `editor_opened_at`, a latch that has always
  been stamped the first time an **editor** opens an incident's workspace and never for a viewer or
  a link guest. An incident now exists for every alarm that ever arrived – test alarms,
  Nachbarhilfe, re-dispatches – so the statistics export drops the ones no editor ever opened
  (`?include_unconfirmed=1` returns them, for a consumer that wants alarm volume rather than the
  Einsatz count). Incidents from before the latch existed are backfilled from the evidence that a
  human was in the loop, so a station's reported history does not move when it upgrades.

  The split-dispatch guard is untouched and now carries more weight than it did: while an Einsatz is
  running, a new alarm still waits in the pool, because it is far more likely a Nachalarm of the
  same Einsatz than a second one – and with no human take left, that guard is the only thing between
  a re-dispatch and a duplicate. The EL opens or attaches it from the incoming-alarm banner as
  before. `alarms.autoOpen` and its keyword/priority filters are retired: they defaulted to off, so
  the stations that never opted in were exactly the ones whose links were dead. Existing config
  files keep validating – the keys are accepted and ignored – and
  `POST /api/divera/pool/{id}/take` keeps working, as an open-**or-correct** call that applies the
  EL's corrections to the incident the alarm already has instead of minting a second one.

- **The alarm keyword list existed twice in the estate, nothing compared the copies, and it was
  named after somebody else's alerting provider.** The map from an alert's Stichwort to an incident
  category, and the keyword list deciding which alerts are high priority, were written
  independently here and in KP Rück – the same 19 title keywords, same order, same casing, arrived
  at twice – and had already begun to drift: one side knew `GASLECK`, the other did not. A third
  copy sat in this app's German UI strings under a comment asking whoever edited the map to keep it
  in sync, enforced by nothing. All three now read one checked-in data file,
  `backend/app/data/alarm_keywords.json`, vendored byte-for-byte into both products with a checksum
  pinned on each side and a CI job that diffs this repo against KP Rück – the same mechanism the
  telemetry sanitiser already uses, and chosen over a shared package because both products promise
  self-hosters separate images, separate releases and no runtime coupling. A test that catches
  drift is worth more here than a library that removes it.

  **Nothing in that file is Divera's**, which is why it is not called `divera_keywords.json` any
  more: the keywords are German fire-service words and the categories are the FKS
  Schadenkategorien. Divera is how those words reach *this* station – the delivery, not the
  definition – and naming the shared vocabulary after one deployment's provider made it look like
  a Divera feature to every other station. Same reasoning that retired `divera_id` in favour of
  `source`/`source_ref`. The Divera client, its access key and its poller keep their names,
  because those genuinely are the Divera attachment.

  **A station can now bring its own vocabulary.** Until now the words were a constant compiled into
  the app: a brigade alerting in French, or with a different Stichwort set, or off a different
  system entirely, had no setting at all – it had to patch a file that is checksum-pinned in two
  repositories, and its own build went red the moment it did. `alarmKeywords` in the deployment
  config now replaces the shipped vocabulary **wholesale** for that deployment –
  no per-keyword merging, because two half-lists that combine somewhere are unreadable at 3am and
  «which keywords are running» must have one answer in one place. To add a single keyword, copy
  the shipped file and add your line to the copy (`docs/CONFIGURATION.md §1a`). An invalid block –
  a lowercase keyword that would never fire, a duplicate that makes the later one unreachable, a
  category the app has no label for – **fails the config load and writes nothing**, rather than
  being dropped quietly, because a vocabulary that is silently ignored classifies alarms wrongly
  and says nothing about it. `GET /api/config` answers `alarmVocabulary` – shipped or ours, and
  how many words – so the question is answerable with one request instead of a database session.

  **Behaviour is unchanged for a station that sets nothing**, which is every station today. The
  resulting maps are character-for-character what they were, order included, and a test pins them
  that way; the one keyword this side was missing is a no-op under its matcher. Two things
  deliberately stayed out of the shared file and are named in it rather than quietly unified: the
  **display labels**, because this app stores German strings in the database while KP Rück stores
  keys and the two disagree on a capital letter – migrating a stored value in a released product
  over that is not warranted – and the **matching rule**, because KP Rück requires word boundaries
  on short keywords like `GAS` where this app matches substrings. That second one changes which
  alerts come out high priority (`GAS` fires on *Gasflasche* here, and on *Gasse* there), and
  neither behaviour is unambiguously right, so it is recorded as a known divergence rather than
  decided unilaterally on the alerting path.

  A station's own vocabulary is **not** echoed by the public `GET /api/config`. That endpoint is
  public so the login screen can brand itself, and the vocabulary turns out to be the one section
  with no unauthenticated reader — matching is entirely server-side and nothing in the frontend
  reads the words. An admin session still receives the full block, which matters more than it
  sounds: the admin UI does a full-document `PUT`, so a section the admin never received is one
  the next unrelated edit would silently delete. The `alarmVocabulary` summary — source, schema
  version and counts, never the words — stays public, so "is my override live?" needs no session.

### Added
- **The roster-snapshot contract is published — the schema, not yet the feature.** A station whose
  personnel list lives somewhere else entirely (a municipal HR system, a cantonal register, a
  nightly script) has had two options: retype it, or export a CSV by hand every time somebody
  joins. `roster.source` gains a third value, **`"snapshot"`**, for the case where that system
  publishes a JSON file and this deployment reads it — documented in
  [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) §4c beside the CSV contract it is a sibling of,
  with a versioned JSON Schema ([`docs/roster-snapshot.schema.json`](docs/roster-snapshot.schema.json)),
  a worked example (`backend/roster.snapshot.example.json`) and an offline validator
  (`uv run python -m app.roster_snapshot validate my-roster.json`) so a producer can prove a file
  conforms without a deployment to try it against.

  **Nothing fetches such a file yet.** The value is accepted and served, the provider is listed in
  the capability registry as `implemented: false`, and a station set to `"snapshot"` behaves exactly
  like `"manual"`. The schema ships first on purpose: it is a contract other people's systems write
  to, and a contract that emerges from whatever the first importer happened to need is one nobody
  else can implement.

  What it carries is short and deliberate — a stable `external_id`, a display name, an optional
  Dienstgrad **key**, `active`, and `identities`, a list of `(provider, external_id)` pairs that
  says "the person this file calls `pers-0001` is the one your alerting system calls 4711" without
  either product growing a column named after a vendor. What it does **not** carry is the point:
  no medical fields, ever — no Untersuchung, no Tauglichkeit, no Impfung — and that is held by a
  test that fails on any medically *shaped* key in German, English, French or Italian rather than
  by a sentence in a document. A file carrying one is refused whole, with the key named. There is
  no free-form `metadata` map and no raw `qualifications` list for the same reason: a string map's
  keys are data, so nothing can see inside it.

- **Objektpläne can now be fetched by the deployment instead of pushed into it.** Keeping a plan
  library current meant handing the system that maintains it this deployment's `ADMIN_SECRET` –
  the key to the entire admin API, config, branding and user accounts included – so that a nightly
  job could upload PDFs. The credential outlived the task, sat in someone else's environment, and
  could not be revoked without revoking the operator's own admin access. A station can now point
  the deployment at an **S3-compatible bucket** its plan library publishes to, and it fetches for
  itself with a read-only key nobody else holds: `plans/index.json` states each plan's object,
  module, size and **sha256** – metadata, never bytes – so a run over an unchanged library is one
  small request and only a checksum that actually moved is downloaded. What arrives goes through
  the very same code path a manual upload takes, so both doors write the same
  `plan:<obj>:<module>` dataset and there is no second set of rules to drift. A malformed or
  incomplete index refuses the whole run rather than ingesting half of it, a plan that vanishes
  from an index is never deleted, and the upload size cap holds for the pull too. Provider-neutral
  by construction – endpoint, bucket, prefix, region and keys are all environment, so MinIO, a
  hosted bucket or anything else S3-compatible works. Opt-in and fail-closed: no store configured,
  no job scheduled, nothing changed – and the existing push path keeps working exactly as before,
  so a station can run both while it gains confidence. Details in
  `docs/objektplaene-architecture.md`; the new column is nullable, so the migration runs on boot
  with nothing for the operator to do.
- **The alarm can now carry a link into the incident.** A responder on the way in has the alert
  text and nothing else: the Lage the FU is building exists, but reaching it means being a user of
  this app on a device the station handed out, which most of the people driving in are not. The
  alerting system – any of them, the URL is composed by the sender, not requested from KP Front –
  can now put a link in the alert that opens that one incident read-only on a personal phone: the
  map, plans, hydrants, Personen and Verlauf a `viewer` sees, and nothing that writes, prints,
  generates a PDF or calls a paid service. It is signed with a station key held by the alerting
  system and deliberately not with the app's own `SECRET_KEY`, the reachable API is an allowlist
  rather than a blocklist so routes added later are not granted by default, and closing the
  Einsatz revokes every link to it on the spot. Opt-in and fail-closed – no key set, no
  surface – and the new column is nullable, so the migration runs on boot with nothing for the
  operator to do. The key is generated, rotated and switched off under Daten › Einsatz-Link in
  the admin UI; rotating it invalidates every link already sent out, the way rotating the
  Erfassungs-Poster token stops every printed poster at once.

- **The statistics export now carries the reference the alerting system printed on the alarm.**
  A fire department's authoritative record lives in its administrative system, not here – this app
  is the runtime tool. Matching one to the other without a shared key means date, time and address,
  and measured over five closed years of one department's data that lands at **73%**. The misses
  are not spelling variance a fuzzy matcher could absorb: they are the two systems recording a
  *different place*, the dispatcher naming a landmark or a stretch of road where the runtime tool
  names the nearest street. Widening the time window and fuzzy-matching the street buys 0.3
  points, so there is no tuning that rescues it. The alerting system already prints a stable
  reference on the paper report; carrying that reference through makes the match exact for
  anything entered from it.

  `GET /api/stats/incidents` therefore ships **two** fields, and they are not the same thing:
  `source_ref` is the alarm's own id in the alerting system – provenance – while **`alarm_ref`** is
  the reference that was printed. Nothing vendor-specific enters the contract; a second alerting
  integration fills the same field. Three caveats consumers need, all in `docs/STATS-EXPORT.md`:
  the printed reference is derived from the **address** on at least one alerting system, so it
  repeats – across eight years it repeated for 52.9% of incidents – which means it must be matched
  **inside a time window** and a repeat reported as ambiguous, never as a match; an incident can
  absorb a second alarm, so the field is looked up rather than joined, because a join would emit
  that incident twice and duplicate an Einsatz in an official total; and an export where the field
  is empty everywhere is **not a failure** – it means nobody has transcribed one yet, which is a
  habit at the station rather than a fault in the software. Count matches by reference against
  matches by date+time+address and the difference tells you which.

### Fixed
- **The Alarmierungszeit was the time somebody picked up the tablet.** Measured against a fire
  department's own paper records: on 36 of 36 incidents the statistics export published
  `alarmiertAt: null`, and `started_at` — the field documented as the Alarmierungszeit, printed
  on the Rapport under «Alarmierung», and the only thing an external statistics system can join
  on — was the moment the record was created in the database. Street-matched pairs were between
  three hours and nine *days* apart. The cause was not one bug but a field nobody ever wrote:
  Divera sends the alarm's own timestamp, KP Front parsed it, and then dropped it — the webhook,
  the poller's auto-open and the pool take all let the database's «now» stand instead, even
  though the intake wizard hides its own time field on the take path specifically because it
  promises the alarm's time is kept. Now every intake path records the time the alarm actually
  went out (Divera's `ts_create`, or a `started_at` from a generic sender), and the two human
  paths — opening an Einsatz by hand, and correcting the time in the Einsatzdaten panel — mark
  it as human-asserted. The export's `alarmiertAt` is no longer null on anything that knows its
  alarm time: it now resolves the same way the Rapport-PDF and the Erfassung already did.
- **…and where it is still unknown, it says so instead of guessing.** Every incident now records
  *where* its alarm time came from (`started_at_source`: from the alerting system, from a human,
  or unknown), because the honest answer for a record that never had one is «this is the
  record-open time», not a plausible timestamp that a statistics join will happily believe. The
  export publishes that provenance, publishes `created_at` alongside it so the pick-up-the-tablet
  delay stays measurable in its own right, and returns `alarmiertAt: null` rather than passing an
  insert time off as an alarm time. **Existing incidents are repaired where the evidence still
  exists and left alone where it does not:** an alarm whose Divera timestamp survives in the
  stored payload gets its real time back, a time a human had already entered by hand is
  recognised as theirs and never overwritten, and everything else keeps the value it has with the
  provenance left empty — a deployment whose alerts never carried a timestamp will see nulls, and
  that is the true answer rather than a fabricated one. Correcting the time in the Einsatzdaten
  panel upgrades any such record. Consumers of `GET /api/stats/incidents`: `started_at_source`
  and `created_at` are new fields, `alarmiertAt` is populated far more often than before, and
  rows with no known alarm time should be skipped by a time-based join rather than matched —
  see `docs/STATS-EXPORT.md`.

## [0.4.0] – 2026-08-01

Two threads. A review pass before publishing the repository more widely – every claim in the
documentation checked against the code, three of them promises the code did not keep. And a run of
operational fixes that only a real incident could have produced: the call of 31 July is the reason
several of the entries below exist.

### Added
- **`incident.created` now names the alarm it came from.** The webhook said "a Divera incident was
  opened" without saying which one, so a receiver holding something back for one particular alarm
  could only guess. The milestone chain is exactly that case: it holds group and vehicle times that
  KP Front rejects with a 404 until the incident is open there. With `source_ref` – the Divera alarm
  id it files them under anyway – it can listen for this event and deliver in the same moment
  instead of waiting out its own interval. For a manually opened incident there is no source alarm;
  the field is then null, but present.

### Fixed
- **The Rapport for the 31 July incident printed without its alarm times.** Groups and vehicles had
  been alerted and the times were complete everywhere they should be – journal, workspace,
  database – and the time grid on the paper was still empty. Two independent causes. The first was
  the rule itself: the field-classification decision made the whole grid disappear as soon as
  anything had been captured digitally, which meant the better the automatic capture worked, the
  less stood on the signed report. The fully automated incident the milestone integration was built
  for produced a sheet with no alarm or dispatch times at all. That decision is reversed – the grid
  always prints, captured values as times, missing ones as `__:__` to be completed by hand. The
  second was a lost write: a vehicle that leaves the geofence and reaches the scene moments later
  fires two milestones in one breath, and on 31 July the Pikett officer's "ausgerückt" and "vor Ort"
  were five milliseconds apart. Both journal lines were written, but the second write had read the
  workspace before the first and overwrote it afterwards. That write is now a compare-and-set on
  `workspace_rev` with a re-read. **The Pikett dispatch time from that incident stays missing in
  production** – editing a real operational record by hand was deliberately not part of the fix.
- **A hanging push notification could block alarm intake.** `pywebpush` passes `timeout` through to
  `requests`; unset it is `None`, meaning unbounded. And `notify_new_alarm` is awaited inline in
  both the Divera webhook and the generic alarm intake, so a push service that accepted the
  connection and then went quiet hung the *alarm* – and an alarm that does not arrive is the worst
  failure this system has. Delivery was also serial, so twenty registered devices against a dead
  service cost minutes on the alarm path. Now 10 s per endpoint, fanned out concurrently: one
  timeout in total however many endpoints are dead. Unexpected errors are logged and the
  subscription is *kept* – unsubscribing on an unknown error would silently retire a working device.
- **A captive portal logged the operator out instead of reporting "unreachable".** A 200 with a
  non-JSON body is a hotel or guest wifi answering on the backend's behalf. The unguarded
  `JSON.parse` raised a `SyntaxError` rather than an `ApiError`, so the callers' `status === 0`
  offline branches never ran: the incident list discarded its cache, and `AuthProvider` put the user
  back at the login screen with an intact offline cache sitting right behind it.
- **A frozen GPS feed looked exactly like a stationary fleet.** `useVehicleLayer` discarded
  `gps.error`. When the Traccar feed fails the vehicles correctly stay at their last known position
  – a vehicle that vanishes reads as "abgerückt", not as "feed gone" – but the symbols then looked
  precisely as authoritative as they had a minute earlier, and the FU makes positioning decisions on
  them. After three missed polls (60 s at `pollMs=15s`) the vehicles carry "GPS · veraltet (n min)"
  and an amber "GPS eingefroren" chip appears in the top bar. Amber rather than red: a frozen
  position is a caveat, red belongs to the overdue Trupp. Vehicles stay non-draggable throughout –
  making them movable would have been a worse bug than the one being fixed.
- **The pre-migration backup had never run – on any instance.** The image pulled
  `postgresql-client` from bookworm, so version 15, while the documented stack runs
  `postgres:16-alpine`, and pg_dump refuses to dump a server newer than itself. `start.sh` caught
  the failure, printed one warning line nobody read, and migrated anyway. The first fix pinned the
  client to 16 and repaired the self-hosted path while leaving the more important one open: Railway
  production runs Postgres 18.4. The client is now pinned to the highest server the image will ever
  face (`ARG PG_CLIENT_MAJOR`), `start.sh` compares client against server at runtime, and – the
  change that matters – **a pending migration with no usable dump now aborts the start** instead of
  warning past it. A safety net that fails silently is worse than none, because you plan around it.
  A plain restart with no pending migration never enters the block; deliberate override is
  `ALLOW_MIGRATION_WITHOUT_BACKUP=1`. Dumps are written to `.part` and renamed only after `gzip -t`,
  so a directory of fragments can no longer rotate away the last good backup.
- **The demo-reset guard sat in the CLI; the scheduler did the deleting.** `reset()` drops every
  incident – journal and hash chain with it, through `ON DELETE CASCADE` – and all personnel. The
  `KP_DEMO_RESET=1` check lived in the `if __name__ == "__main__"` block, so it covered the command
  line only, while `scheduler.py` imports `reset` and awaits it directly. The unattended path, the
  one running on a timer, went straight past the check onto whatever database `DATABASE_URL` named
  at that moment. The module docstring meanwhile stated it could "never be pointed at a real
  station's database by accident". The check now sits inside `reset()` itself, so every caller is
  covered by construction rather than by remembering.
- **A build from source baked the root `.env` into the image.** `.dockerignore` listed
  `backend/.env`, but the `Dockerfile` does `COPY . .` and both `docker-compose.yml` and
  `DEPLOYMENT.md` tell an operator to put `.env` in the repository root. `SECRET_KEY`,
  `POSTGRES_PASSWORD`, `ADMIN_SECRET`, `DIVERA_ACCESS_KEY`, `TRACCAR_PASSWORD`, `VAPID_PRIVATE_KEY`
  and `STT_API_KEY` therefore landed in an image layer, and in any exported build cache.
  Demonstrated rather than assumed: with the old file the `.env` is present in the built image, with
  the new one it is gone. **Only building from source was affected – pulling the published images
  never was.**
- **"Wird gedruckt" now shows where the job actually stands.** The station-printer toast said "Wird
  gedruckt …" and nothing else, blended visually into the button it sat on, and disappeared
  mid-job. The missing icon was a typo – `printJobToast` sent `icon: 'print'` while the sprite only
  knows `printer`, so the running stage of all things rendered as bare text. The three stages are
  now a chain: completed keeps its tick and steps back, the running one carries the icon, the
  pending one stays visible as a dot. Below 600 px every stage except the running one drops its
  label. The failure case deliberately keeps a sentence rather than the chain, because "Druck
  fehlgeschlagen – Drucker prüfen" is the instruction. The toast also survives navigation now:
  `<Overlays/>` hung in only one of the capture poster's three return branches, so tapping "back"
  during printing lost the display while the job carried on unseen.
- **The telemetry veto in `PRIVACY.md` did nothing — twice over.** The page tells an operator to
  put `KP_TELEMETRY_ENABLED=0` in their compose file and promises it "outranks the admin switch".
  `Settings` has no `env_prefix`, so the field bound to `TELEMETRY_ENABLED` and the documented
  `KP_` spelling matched nothing; and `docker-compose.yml` passed no telemetry variable into the
  container at all, so even the correct name in `.env` would have done nothing — compose's `.env`
  is interpolation-only. Consent still defaults to off in the database, so nothing was ever
  transmitted, but a station that had *enforced* the ban per the documentation had enforced
  nothing. Both halves are fixed and pinned by tests, including one that fails if the compose
  fallbacks ever become blank — blank means "off" to this app, so an innocent-looking
  `${KP_TELEMETRY_ENABLED:-}` would silently disable telemetry for every deployment.
- **The browser no longer calls Overpass directly.** `README.md` promised "every external service
  is proxied by the backend (the browser never calls a third party)". The «Umrisse» surface
  POSTed the incident's bounding box straight from the browser to three public Overpass mirrors,
  one of them hosted in Russia — and it is prefetched on every incident open, so this was the
  normal path, not an edge case. It now goes through `/api/overpass/buildings`; the mirror race
  and its timeouts moved server-side unchanged. `OVERPASS_MIRRORS` makes the list configurable,
  so a station can point it at its own Overpass or switch the surface off. A test scans the
  frontend for direct third-party `fetch()` calls so the README claim cannot quietly lapse again.
- **The capture poster could read and rewrite the tactical map.** `ALARM-INTEGRATIONS.md`
  promised the poster token reaches "attendance/material/journal/Einsatzende – no map, no admin,
  no history". Both workspace endpoints handed out and accepted the whole `map_workspace_json`.
  They are now scoped to the three keys the capture form actually uses; reads are projected and
  writes merge over the server's copy, so a capture save cannot drop what it cannot see. This is
  a token that goes to people outside the command post, so the narrow reading is the right one.

### Changed
- **`SEED_PIN` is now required in production when seeding is on.** The bundled seed file is user
  `fu` with PIN `000000` and role `editor`, and `SEED_DATABASE` defaults to true — so
  `docker compose --profile tls up -d` on a public domain produced an internet-facing editor
  account whose PIN is printed in the README. The backend now refuses to boot rather than create
  it. **Existing deployments are unaffected:** the PIN is only demanded when an account would
  actually be created, so a station whose users already exist upgrades untouched.

### Documentation
- The demo resets nightly, not every two hours; `ARCHITECTURE.md` said the incident document
  lives in `localStorage` when it has been IndexedDB since 0.3.0; `CONFIGURATION.md` documented an
  Atemschutz `mindestBar` key that does not exist (the real one is `alarmBar`, and the second
  60-bar tier was deliberately dropped) — a station setting it got no error and kept the default;
  the cross-repo print example was wrong in four ways; and `just demo-off` — without which the
  documented evaluation path leaves you unable to create an incident — appeared in no document at
  all. `PRIVACY.md` now also names the three services that receive a location (tiles, Overpass,
  geocoding), which are ordinary third parties rather than a channel to the maintainer.
- Wiedergabe, Statistik-Export and Rückmeldung were missing from the README despite shipping;
  the last one matters because the Integrations table claims to enumerate everything that leaves
  the deployment.
- **Plain HTTP on the LAN is not an equivalent fallback, and `DEPLOYMENT.md` now says so.** KP Front
  is a PWA: service worker, web push, geolocation and microphone exist only in a secure context. An
  operator who follows the guide and runs the box on `http://10.x.x.x` loses all four, silently, on
  the one application whose entire purpose is a bad network. Both ways out (DNS-01, `tls internal`)
  are documented, including the second iOS step everyone forgets. §2 also gained a real system-
  requirements table, the fact that images are built for amd64 *and* arm64 – so a Pi needs a 64-bit
  OS – and the rule against microSD or a USB stick as the system disk.
- `reset_roster` and `demo_export` are documented rather than dead. Both turned up in a hunt for
  dead code: no module imports them and no document mentioned them, because they are deliberate
  maintenance tools invoked by hand as `python -m app.X`, which an import analysis cannot see.
- Screenshots were retaken, and the harness that produces them now covers the README images too.
- The README points at `RUNNING-BOTH.md` in the kp-rueck repository for running both apps on one
  box, rather than duplicating a document that would drift.


## [0.3.0] – 2026-07-28

The **Zeitplan** release: a long incident is a staffing question, and it finally has a surface.
Around it, a release about *getting back out* – the app was already hard to crash, but a handful of
states could only be cleared by restarting it, or in one case by resetting the browser – and about
the app looking like one app rather than a dozen surfaces that each decided for themselves.
Everything below has been running in production at Feuerwehr Oberwil.

### Added
- **Rückmeldung – the app asks after a mishap, and can now send it.** After a crash the launcher
  offers to file a report. It could previously only be copied or mailed; there is now a **Senden**
  button, and afterwards the sheet shows what the *server* actually stored – a preview written by
  the sender is a promise, one returned by the receiver is a check.

  Alongside it, and deliberately separate, is a second channel for **background crashes**, which
  a deployment has to switch on first. The distinction is the whole design: pressing Senden by
  hand *is* the consent, the same as sending an e-mail. Nobody is watching when a background
  crash fires, so that channel defaults to off – and off means a NULL column, which is what every
  existing installation updates into. It is enabled in the **admin area, never on the device**:
  the fire service is the controller, not whoever happens to be holding the tablet.

  What leaves the building is built field by field in `app/telemetry/scrub.py` – nothing is passed
  through or spread, so a field nobody wrote a line for cannot leak. Free text is scrubbed too,
  because the value is usually *in* the message: paths, e-mails, phone numbers, IPs, coordinates
  (WGS84 and LV95), UUIDs, tokens, street names with house numbers, and the full user agent
  reduced to «iPad Safari» so it can't fingerprint. Every payload is written to the station's own
  log before it is sent and kept verbatim in `telemetry_outbox` – two copies on your own
  infrastructure, and the admin sheet shows the same table. `KP_TELEMETRY_ENABLED=0` overrides
  every switch in the UI. See [`PRIVACY.md`](PRIVACY.md), which also answers the IP question
  honestly, including the part that can't be solved in code.
- **arm64 images.** The published image builds for `linux/arm64` as well as `linux/amd64`, so an
  ARM host (Hetzner CAX, Oracle Ampere, a Raspberry Pi) can run it. The Vite stage builds on the
  native build platform, so the multi-arch build doesn't emulate the slow part.
  [`DEPLOYMENT.md`](docs/DEPLOYMENT.md) said `linux/amd64` for one release longer than that was
  true; it now names both, and says what an older release looks like when you try it on an ARM
  machine (`no matching manifest for linux/arm64/v8`) and how to run one anyway.
- **Zeitplan – the Schichtenplanung, as a second view of the Anwesenheit.** A long incident is not
  a staffing problem you can hold in your head at 04:00, and the question it asks – *who is still
  going to be here at six, and how many is that?* – had no surface. The Anwesenheit answers *who is
  here now*; this answers *who will be*, on the same list of people, one tap away on the same
  screen.

  It is a grid of who × when: one row per person, one lane of time each, worked directly the way
  the paper Führungsformular is filled in. A shift carries one of three states, and the distinction
  is the whole point of the surface: **verfügbar** (they said they could), **eingeteilt** (you are
  counting on them), and **anwesend** – which is not a plan at all but the recorded attendance,
  drawn in from the Anwesenheit and read-only here. **The Zeitplan never writes attendance.** You
  can plan a shift for somebody who never turns up, and the record will keep saying so; ticking
  people in and out stays exactly where it was.

  Underneath runs the **Deckung**: three step lines counting available, planned and actually
  present across the whole span, so a gap is something you see the shape of rather than something
  you work out. It folds open to the numbers, because the curve says *where* and only a digit says
  *how many*. Multi-day incidents get day boundaries and dates on the axis – past midnight, «07:29»
  alone never said which morning.

  It prints as the **Führungsformular «Zeitplan»** (A4 landscape, monochrome – it is rules and bars,
  and a colour cartridge is a consumable), rendered server-side like the rapport, and a viewer may
  print it: somebody arriving to take over the shift should be able to print the sheet they are
  walking into without an editor PIN.
- **Anwesenheit: somebody who leaves and comes back is two times, not one contradiction.** The
  record carried a single `checkedInAt`/`leftAt` pair, so a second «anwesend» kept the first
  arrival *and* the old departure – the person stood there as present and signed off at once, and
  the second stretch existed nowhere at all. Times are a **list** now; first arrival and last
  departure stay derived from it (the latter simply missing while somebody is back, because they
  are not gone), so Rapport, statistics export and the QR sheet read on unchanged and an entry
  written before this projects its old pair. Nothing to migrate, both shapes stay readable
  forever.

  The words followed the data: «Block» was workshop language that had slipped into the surface –
  on the Platz nobody thinks in blocks – so it is «Erfasste Zeiten», and «Neue Zeit ab jetzt»
  says what the button actually does, which is end the running one and open the next. And the
  time left the row: a tile that read «ab Beginn» took most of the width and squeezed the name to
  «B…», the one thing that list may never do. The row answers *who is here*, the sheet answers
  *since when* – and the sheet can show **all** of a person's times, which the tile never could.
- **One time picker on every device, and it knows which days the incident touches.** `TimeField`
  had two personalities: a wheel popover under a finger, a bare text input at the desk. Everything
  added in recent rounds lived only in the popover branch, so for three rounds one of the two
  implementations was being fixed while the other was the one being tested. The trigger now opens
  the same popover everywhere, and typing is not gone but **pulled into it**: a text field sits
  above the wheels and carries them as you type, so a keyboard stays a keyboard and gets the same
  days and the same shortcuts as the finger.

  Those days are a third wheel listing only the days the incident actually touches – deliberately
  not a date picker: no month, no year, no 31 rows, and no wheel at all for an incident that ends
  the same evening, so the normal case pays nothing. Before this, which day a `HH:MM` meant was
  inferred from the old timestamp, and «put this row on Wednesday» could only be said by deleting
  the row and writing a new one. **«ab Einsatzbeginn»** now carries the time it would set – a
  shortcut without its number is a promise you cannot check before tapping it – and **«noch da»**
  replaces the wastebasket on «bis», which said the opposite of what it did: emptying a «bis»
  means the person never left, and it is also the way back out of a mistyped «gegangen».
- **Atemschutz: «Wieder einrücken» has a second exit – «Bereitstellen».** It knew only one way
  back, which was straight in. The reported case is the other one: fresh cylinder, new order, and
  the Trupp waits as Sicherungstrupp. It used to stand in the incident immediately with the
  contact clock running on a crew that is standing next to the vehicle – a clock that inevitably
  goes overdue without anything having happened. «Bereitstellen» puts the Trupp exactly where a
  freshly registered one lies: angemeldet, no clock. AdF rows can be removed again as well.
- **A line that is already drawn can be measured.** Length and Schläuche were reachable only by
  tracing the line a second time with the measuring tool, and the elevation profile not at all –
  it lived solely in the transient measuring path. The line editor carries a **«Messung»** group:
  length and Schläuche stand there at once, the profile folds open and only then fetches
  swisstopo, so a tap on a line stays silent offline. Plan does the same in its calibrated metres,
  minus the profile – a building plan carries no elevation data.

### Fixed
- **A Modul-5 sub-sheet's label fits the plan rail again.** The rail read
  «RWA · Migros – modul5-rwa» and ran straight off its 216px edge. Modul 4 and the Modul-5
  sub-sheets have no fixed tile in the catalog, so their label comes from the data — the PDF's
  filename. A station that names its file `Wasser.pdf` hands over exactly the right word; ours
  carry the object name plus the raw module key, which is neither short nor a name. The filename
  is now taken only when it *looks* like a sub-sheet name, and otherwise the sub-slot key out of
  the id is used, which is the structural part and always clean: `modul5-rwa` → «RWA»,
  `modul5-wasser` → «Wasser». The monogram in the chip is unchanged, so the collapsed rail still
  reads as before. A long label additionally truncates with an ellipsis instead of being sliced
  off mid-word — what stands in that tile is station data, and "it fits today" is not a property
  we control.
- **No more states that only an app restart could clear.** A sweep across every state and
  transition that could strand the app turned up three classes, none of which offered a way out
  on screen:
  - **Boot could hang forever with nothing to tap.** No `fetch` had a timeout, and the field
    failure isn't a refused connection but a half-open one – a dying access point, one bar of
    LTE, a captive portal – where `fetch` hangs for minutes. The deployment config is awaited
    *before* the first render, so the result was a literally blank white page: no splash, no
    error boundary, nothing. Killing the app didn't help, because it hung again. Requests now
    time out (20 s; uploads 5 min), boot is bounded by a 4 s budget after which the offline cache
    is used and the app renders anyway, and the splash grows a status line and a **«Neu starten»**
    action after 9 s. Verified against a real blackhole server that accepts TCP and never answers:
    first paint after 4.8 s instead of never.
  - **A crash could loop.** The error boundary's only action was «Neu laden» – and boot reopens
    the last incident automatically, so if *that* incident's data threw during render, reloading
    landed straight back in the same crash. Crashes are now counted per incident and survive the
    reload: the first offers **«Einsatz schliessen»** (loses nothing), a second crash on the same
    incident adds **«Lokale Kopie verwerfen»** with a warning and demotes «Neu laden», which is
    demonstrably the action that does not help.
  - **A lost WebGL context left a blank map.** iPadOS releases the context under memory pressure
    or after a long spell in the background, and MapLibre does not rebuild itself – so the map
    became an empty rectangle surrounded by working chrome, which doesn't even read as a crash.
    The first loss now heals silently and keeps your current view; a second within 60 s offers
    **«Karte neu aufbauen»** rather than looping through remounts.
- **A full device no longer loses incident data.** The offline cache wasn't just unprotected
  against a full disk, it was **silent** about it – worse than a visible crash for an
  Einsatzrapport. Three defects, each reproduced against a fake IndexedDB before being fixed: a
  failed write was swallowed so the *old* value was served back as current (including a stale
  "nothing to sync" flag), the localStorage fallback threw on every save because a workspace blob
  never fits there, and the fallback turned out to be **write-only** – the copy was written and
  never found again. Now: map tiles are evicted before incident data (a tile reloads in seconds,
  the Lagekarte never), the sync indicator gains a **storage** state that is loud only while
  there is unsynced work, Offline-Bereitschaft shows the free space it actually has, and
  «Alles für offline laden» checks first and offers **«Reduziert laden»** if the download won't
  fit.
- **Replay no longer throws on a long incident.** A `RangeError` could end the scrub.
- **The setup and deployment guides no longer name a version.** They walked a new station through
  `git checkout` of one specific tag and pinned `KP_FRONT_TAG` to one specific number – both of
  which go stale the moment the next release lands, and a doc that names a tag which does not
  exist stops the installation dead. The clone step now resolves the newest tag itself
  (`git tag -l 'v*' --sort=-v:refname | head -n1`), and the pinning table talks in `X.Y.Z` / `X.Y`
  and links to the releases page for the actual numbers.
- **Rückzug and Fortsetzen are radio contacts, and the clock now knows it.** Press Rückzug and the
  card stayed red: «seit letztem Kontakt» counted stubbornly on, although somebody had just spoken
  to the Trupp. Neither button is ever pressed spontaneously – a Rückzug is ordered by the EL or
  the Truppüberwacher or reported by the Trupp, and Fortsetzen means you reached them and sent
  them back in. Both are a radio contact by definition. The damage was never the wrong number, it
  was the habit: a board that shows «überfällig» right after a reported contact trains its watcher
  to click red away.
- **«HTTP 502» is not an error message.** That was the entire text on the launcher, above a
  «Erneut versuchen» button. It names the plumbing – not whether the tablet, the line or the
  server is at fault, not whether waiting helps, and not whether the incident data is still there,
  which at 3am is all that counts. The raw form had a cause: a 502/504 comes from the reverse
  proxy as an HTML page, so there is no `{detail}` to display, and `statusText` is an English
  protocol phrase that is empty over HTTP/2 – leaving exactly «HTTP 502».
- **«Eintrag» opens on the tablet again (#70).** The composer is opened from the `pointerup` of
  the tap/hold gesture; iPadOS delivers that same tap's compatibility click *afterwards*, when the
  dialog already stands. Every sheet renders a backdrop, so Base UI's dismissal runs in
  «intentional» mode where exactly one `click` closes it, and its suppression only covers a press
  that began *inside* the popup – impossible here. The tap closed its own sheet immediately: on
  the tablet the button looked dead. An outside press within 400 ms of opening is now discarded –
  nobody opens a sheet and deliberately taps it away in four tenths of a second – centrally in
  Sheet and Overlay, so no other surface walks into the same trap.
- **A parked vehicle points where it stands (#70).** `lastCourse` lives for the session only and
  was filled exclusively from positions with movement – but the normal case at an incident is the
  opposite: the tablet is opened when the vehicles have long been standing. Nobody drove under our
  eyes, so after every reload every vehicle pointed neutrally east. The reported course is now
  taken on first sight of a device: Traccar keeps the last position's course, and that *is* the
  direction the vehicle stands in. Driving still wins afterwards, and a device that never reports
  a course stays neutral, without a direction arrow.
- **Phone and top-bar chrome, the round that keeps the frame from overflowing.** The update notice
  took half the screen because its OK button wrapped to its own line (a flex row wraps by basis
  widths, so a content-width text column pushes the button down before it shrinks itself); the
  bottom bar shows again where you are after a reload; the navigation had silently become a
  sidebar on the phone, from an `@media` in the middle of a block; the top bar's gap at
  861–875px that the previous attempt left open is closed; the Atemschutz alarm no longer swells
  out of the bar; the «Eintrag» FAB sat on other buttons and now has one corner to itself; and the
  draw editor's detail column fits on smaller tablets.
- **The detail panel let go when you reached for a tool.** Selecting a symbol and then picking
  Linie, Fläche, Notiz or Team left its panel open – and the panel is drawn straight over that
  tool's own bar, over its ✓/✕ and its colours, so the tool you had just chosen could not be used
  until you thought of Escape. On a phone the panel is a half-height sheet and covered the toolbar
  outright. The cause was that there was no single place to clear up: six callers each wrote their
  own reset list and the lists had drifted apart. Falling out with it: the symbol picker opening
  over a live panel, a lasso selection surviving every placement and drawing its rings over
  unrelated objects, switching surface freezing an armed tool and a half-drawn line and restoring
  them minutes later, and replay starting with a «Welcher Trupp?» picker over the past.
- **Trupp cards stand on one line, and say their state in full.** Three 44px buttons squeezed the
  status word down to «ÜBERFÄ…» at every card width; it no longer shrinks at all, and the actions
  wrap below it instead. Cards in a row now share a height – the ragged bottoms made a wall of
  Trupps something you had to re-scan for each card's action bar – and the pressure estimate fits
  on two clean lines instead of a four-line staircase. Ziel, Leitung and a hand-typed name have a
  maximum length at last, so a long one cannot blow the card open.
- **Dialogs stopped sliding in from off-centre.** The opening animation set `transform`, which
  replaced the `translate` that centres the journal composer and the confirm card – so both
  started half their own width off-centre and slid into place. That slide was the «janky» open; it
  was never the timing. Three cards also carried a `backdrop-filter` over an opaque surface: it
  painted nothing and made the map behind them re-blur on every frame. The object picker and Help
  now open with the same animation as everything else instead of appearing instantly.
- **Night mode is night mode again in four more places.** `--warn` and `--muted` were never
  declared, so a stale-scale chip, a feedback warning and two PDF labels rendered the day colour
  after dark; draft and measure lines on the map did the same. Two disabled controls were not
  dimmed at all and looked tappable while doing nothing.
- **«keine Fahrzeugdaten» is gone from the replay bar.** It appeared on every replay at every
  station, because the Traccar sample capture was never wired up – so it announced the absence of
  something nobody had asked for and then reassured you that the tactical picture replays, which
  it always does. There is nothing an operator can do with either half.

### Changed
- **One look for every button.** A sweep found twelve combinations of size and weight for the one
  role «button label», six opacities for «disabled» and eight radii off the scale. None of that was
  a decision; all of it was drift. Now: every button `--r-sm`, two type sizes (12.5/700 compact,
  14/700 standard) and weight 800 only for the single action of a surface. Height is a separate
  axis – the twelve combinations happened because people enlarged the *label* when they wanted a
  bigger *target*. Rows, list items, tiles and field triggers are not buttons; what lies on the map
  – handles, vertices, pins, colour swatches – stays round, because that is how map furniture is
  told apart from controls.

  **Red no longer fills an action**; it means danger and delete, nothing else. Every primary button
  reads one token, and in night mode it inverts – the label was never the problem there (11.6:1),
  the button was: dark-on-dark measured 1.14:1 against the sheet it sat on, so the one action of a
  form had no visible edge. And each colour carries one meaning again: amber warns without being
  critical, red means broken or act now, blue and grey are ordinary status. A failed transcription
  turns red, «in progress» and the print queue turn blue as the Zeitplan already had them, and the
  replay banner goes neutral – it is a mode, and it had been sitting in the same colour as an
  Atemschutz warning, competing for the same glance. The rules are written down in `AGENTS.md`.
- **A note has one form: it is a text field.** There used to be two, and the choice was asked at
  the moment you want to write rather than after there is a word on the paper – «which shape?»,
  before anything exists to shape. The one-liner was also the half that kept coming back every
  round: on the map it ran out of its own paper (a word without spaces – a substance name, a
  hydrant number – simply left the Zettel and stood bare on the map), and it never agreed with the
  panel about line breaks. So the form choice in the panel and the toggle in the toolbar are gone,
  together with the confirm-question when converting back. Enter makes a new line everywhere,
  ✓/Esc/tapping beside it finish. A saved note without a width – from the one-liner era or from
  before it – falls back to the default width on both surfaces and in print: there is nothing to
  migrate.

  What changed with it is where the settings sit. While the note tool is armed they are in the
  **toolbar**, where no text field exists yet for them to steal focus from, and whatever you pick
  there (form, size, Zettel or Klartext, colour) the next note brings along. Afterwards the same
  settings live only in the detail panel, which opens **at the gear** rather than on placing, and
  closes when the note is deselected – it should not stand there longer than the thing it
  describes. The gear is always visible: letting it appear once text was in was meant as restraint
  and read as a bug. Typing still happens on the surface itself (double-tap); the panel is for
  when you need room.
- **Atemschutz has one pressure threshold, not two: the Alarmdruck (100 bar).** There were briefly
  two — amber from the Rückzugsgrenze, red from a Mindestdruck — and the lower one was never
  agreed doctrine anyway. The reason for dropping it isn't thrift: someone below their turn-back
  pressure is already on the way out, so a second colour further down says nothing new and only
  teaches that the first one was survivable. One threshold, and it is the loud one.

  `rueckzugBar` + `mindestBar` become a single **`alarmBar`**, surfaced in the admin area as
  «Alarmdruck (bar)»; **`0` switches it off**. The louder of the logged Druck and the projection
  counts, and when only the projection has crossed, the card says so. Still silent — the contact
  clock remains the one audible alarm.

  > **No action required.** An older config carrying `mindestBar` / `rueckzugBar` is ignored
  > rather than rejected, so there is nothing to migrate; set `alarmBar` if 100 isn't your number.
- **The station print agent moved, and now serves both KP systems.** `tools/print_agent.py` is
  retired; the agent lives in kp-rueck at
  [`tools/print-agent/`](https://github.com/feuerwehr-oberwil/kp-rueck/tree/main/tools/print-agent)
  and speaks both protocols, so a station running KP Front *and* KP Rück runs one service
  instead of two agents on the same box reaching the same printer room.

  **KP Front's endpoint contract is unchanged** — the agent was ported to it, not the other way
  round — including the behaviour that matters: a queued CUPS job counts as pending rather than
  failed, and `lp` options still append after the A4/duplex/monochrome defaults. Writing your own
  agent against the documented endpoints remains entirely reasonable.

  > **No action required.** An existing Pi keeps working, and the environment variables it
  > already uses are read unchanged. When you do migrate, **stop the old agent first** — two
  > agents polling one queue both claim jobs, so each job prints once, from whichever asked
  > first. See [`tools/PRINT-AGENT.md`](tools/PRINT-AGENT.md).
- **[`RUNNING-BOTH.md`](https://github.com/feuerwehr-oberwil/kp-rueck/blob/main/docs/RUNNING-BOTH.md)**
  for stations running both systems on one host: the places two independent stacks collide
  (ports, variable names that mean different things, alarm secrets), plus a mapping table for
  the variables the two projects name differently. It lives in the kp-rueck repository as a
  single copy and is linked from here — a second copy drifted within a day, and half-right
  instructions about a silent port collision are worse than none.
- **The generic alarm intake reserves the same `source` slugs as KP Rück.** Both now reject the
  union of the two lists, so a station feeding one dispatch system into both apps can't pick a
  name that one accepts and the other rejects.
- **Day-one documentation for a station that isn't us.** A new
  [`docs/SETUP.md`](docs/SETUP.md) walks the ordered path from an empty Docker host to a usable
  board, [`SUPPORT.md`](SUPPORT.md) says plainly what may be expected from a one-person project
  and what 1.0 will mean, and [`docs/ALARM-INTEGRATIONS.md`](docs/ALARM-INTEGRATIONS.md) now
  carries a stability promise for the intake contract plus the real differences to KP Rück.
- **More of the gate that stands behind a published image.** The build stage had been on **Node 20
  for three months after its end of life** – every Node vulnerability disclosed since then was one
  nobody would ever patch for that line. It runs on Node 24 (Active LTS, security support into
  2028) now, and the reason it went unnoticed was the more interesting half: dependabot watched
  npm, pip and GitHub Actions but had no `docker` ecosystem, so base images were the one
  dependency class that never produced a pull request – and the one a station actually runs. That
  is watched now. **mypy is a blocking gate** across the whole backend tree at zero findings (from
  70, with no `ignore` as a shortcut); deliberately not `strict`, whose core switch produces
  several hundred hits of the «write `-> None` on a route handler» kind – annotation debt, not
  defects. And **`just ci`** runs what CI runs, in CI's order: the section used to recommend
  `just lint && just test` before a push, which ran `ruff check app tests` while CI runs
  `ruff check .` *and* `ruff format --check .` – so the recommended routine could not find the
  thing that turned main red.
- **Managed hosting is no longer implied.** The deployment docs promised something that isn't on
  offer; they now give the honest answer instead.
- `docs/openapi.json` had drifted **31 endpoints** behind the code. It is current, and a test
  now fails if it drifts again.
- Dead code removed across the frontend (236 → 214 lint warnings), and the DCO sign-off check is
  enforced again after being lost in a rebase.

## [0.2.0] – 2026-07-25

The first release with **published container images**: self-hosting no longer needs a Node/uv
toolchain on the VPS. Everything else here has been running in production since `0.1.0`.

### Added
- **Published images on GHCR.** `ghcr.io/feuerwehr-oberwil/kp-front:0.2.0` (plus `0.2` and
  `latest`) is built, booted and smoke-tested by CI on every tag. `docker-compose.yml` now pulls
  by default and `KP_FRONT_TAG` in `.env` pins the version, so updating is
  `docker compose pull && docker compose up -d`. Building from source stays supported – see
  [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) §5.
- **Keyboard control of the whole surface:** number keys address the modules, letters switch
  surfaces, and tools, undo/redo and the panels all have shortcuts – so a station with a
  keyboard-equipped tablet dock can drive KP Front without touching the screen.
- **Phone/mobile editing round 2:** swipe to page between sections and through the individual
  plan documents (including an edge-swipe over the canvas), the tool-option dock became a
  horizontal bar that hugs its content, the Einsatzuhr got a distinct icon per mode, and Mittel
  gained an «Alle» tab.
- **Symbol pack grown:** VKF **Rauch** as a real symbol with detail modal and spread, **Boot**,
  **Drohne**, Lüfter airflow toggle (Einblasen/Absaugen), and Drehleiter/Hubretter as composite
  symbols with an independent slewing boom you drag by the cage tip (reach + bearing). Every
  driven vehicle now has a **Fahrer** picker, and the EL card leads with the name plus a deputy.
- **Atemschutz: expected-pressure Schätzung** derived from the Trupp's own consumption history
  (labelled as *Schätzung*, with its assumptions visible), a free-text Funkkanal, and an opt-in
  soft pip on «Kontakt fällig» (off by default).
- **Print relay status you can trust:** the «An Stationsdrucker» button now reports
  gesendet → wird gedruckt → gedruckt as a live toast, the agent claims jobs by long-poll
  (near-instant, ~10× less traffic from the station Pi), and the editor prewarms map tiles.
- **Persistent plan-scale calibration** per station: a Massstab measured once on a plan document
  is remembered instead of being recalibrated at every incident.
- **Per-team Spuren toggle:** each Trupp's trail is switched on its own eye icon, replacing the
  single global trail switch.
- **Replay trims its scrub range** to the span where changes actually happened, so an 8-hour
  incident with 20 minutes of drawing doesn't scrub through hours of nothing.
- **Optional scheduler heartbeat** (dead-man's-switch) for deployments that want external
  alerting when the background scheduler dies.
- **Demo-mode deployment support:** `DEMO_RESET_SECONDS` runs the incident/roster reset
  in-process (fail-closed, default off – production stays off), seeding a pre-filled example
  incident, with auto-login and a welcome modal explaining what a visitor can and can't do.
- **Help content** for Rapport & Abschluss, Erfassung per QR, and Massstab in Funktionen & Hilfe.

### Changed
- **All modal surfaces now sit on [Base UI](https://base-ui.com/)** (sheets, confirm dialogs,
  menus, popovers) behind the existing `src/lib/overlays/` wrappers, so focus trap/restore,
  scroll-lock, Esc, outside-click and ARIA behave identically everywhere instead of being
  hand-rolled per surface. The non-modal map tool-docks stay bespoke on purpose – a focus trap
  would break map interaction.
- **Lage ↔ Plan parity** pushed further: identical selection halo and pop, the same drag deadzone
  and orb touch-pad, teams that rest as a compact dot and expand to a pill on selection, and one
  shared placement dock (close · keep-placing lock · info hint) for both surfaces.
- **One control vocabulary** in the details modals and the Einsatzrapport: a single segmented
  control and a consistent row rhythm instead of per-modal variations.
- **Left rail and top bar decluttered:** duplicate glyphs removed, plan tabs grouped, and the
  Einsatzuhr menu labelled.
- **Touch/text sweep** toward the 3am tenet: rank chips and time inputs to 44px, shared 44px
  hit-pads on dock and journal buttons, symbol captions to 12.5px.
- **Sync got cheaper on tablets:** the 304 poll reads only `workspace_rev` instead of the whole
  workspace blob, and the incident list defers its heavy JSONB column.
- **Wind arrow follows map rotation** like the compass does.

### Fixed
- **Undo gaps closed** (the standing rule is that every mutation is undoable): logging an
  Atemschutz pressure, taking an alarm with one tap, and «Raus» + clearing Anwesenheit are all
  undoable now, and «Eröffnen» can no longer dead-end.
- Dismissing an alarm on the landing screen with «×» is **per-device** and no longer hides it
  for the whole crew.
- **Speech-to-text re-transcribe race:** a re-transcribe started after a delete could leave the
  job stuck in `running` until the orphan check force-failed it («Serverneustart …»). The job row
  is committed before the background task reads it, and a failing transcription now logs
  server-side instead of being swallowed.
- **Line/hose drawing polish:** fork-aligned Teilstück ports, a sticky (de-twitched) magnet,
  endpoints that move instead of detaching, fill-circle snapping, clearer red indicators, and a
  centred × on the detach chip.
- **Plan documents recover from a failed load** – PDF/Umrisse loading has a timeout, evicts a bad
  cache entry, and offers «Erneut laden» instead of a permanent blank board. The board canvas is
  also measured whenever it remounts, fixing a plan that rendered at the wrong size.
- A **viewer-only** plan no longer reserves an empty tool-bar lane, and the Ebenen dock closes
  when focus moves elsewhere.
- Mobile layout fixes: update-banner sizing, views-popover height, the team-time stack, the
  Mittel toggle, uniform settings rows, and a PIN pad whose bottom row stayed reachable on short
  viewports.
- Personnel dropdowns in the Einsatzrapport render above the modal instead of behind it.
- Batch from the field-feedback round: BMA red dot, plan centring, Trupp on plan, Mittel,
  readiness modal, demo create-block, rapport spinner, and the outline cache.
- Hubretter boom heading is independent of the vehicle's and stays drawn on top (it is
  turntable-mounted), and the Drohne glyph matches the size of the rest of the pack.

## [0.1.0] – 2026-07-19

### Added
- Deployment-admin auth separated from the incident role: the `/admin` UI and admin-write API
  (config, branding, system, user CRUD, geodata/objects) gate on an `ADMIN_SECRET` session, with
  the `admin_geodata`/`admin_objects` push CLIs authenticating the same way. Fail-closed.
- `just` task runner covering the full lifecycle (setup, dev DB, dev servers, lint/test both
  stacks, build, config-as-code helpers, demo data), plus `just init-env` to generate a `.env`
  with strong secrets.
- Committed config/manifest templates (`backend/config.example.json`,
  `backend/geodata.manifest.example.json`, `backend/objects.manifest.example.json`) and a
  synthetic Musterdorf demo dataset (`examples/demo-data/`, `just demo-load`).
- API reference: committed OpenAPI schema (`docs/openapi.json`, `just openapi`), `docs/API.md`,
  and an `EXPOSE_API_DOCS` flag to opt the interactive docs into production.
- `NOTICE`, `CODE_OF_CONDUCT.md`, and this `CHANGELOG.md`.
- `/ready` readiness endpoint (probes the database and the storage volume, 503 on failure);
  the compose healthcheck and Railway `healthcheckPath` now use it instead of the static
  `/health`.
- Backup tooling: `scripts/backup.sh` (Postgres dump + storage-volume tarball with retention,
  cron-ready) and an automatic pre-migration `pg_dump` in `start.sh` whenever a migration is
  pending (newest 5 kept on the storage volume).
- Confirm-with-undo on the two lossy Gebäude operations (remove floor, replace building) –
  the removed storey/stack and its sketches are restorable from the toast.
- Automatic sync retry with backoff: a failed workspace flush (server error or network drop)
  now re-flushes on 5s→60s backoff instead of waiting for the next manual edit.
- CI security scanning: a blocking gitleaks secret scan of the tracked tree, an advisory
  `pnpm audit` (mirroring the backend's `pip-audit`), and a CodeQL workflow that activates
  automatically once the repository is public.
- Single-editor tab lock (Web Locks): a second browser tab on the same incident is read-only
  with an "In einem anderen Tab geöffnet" banner and a one-tap "Hier bearbeiten" take-over –
  two tabs can no longer race the shared sync cache.
- The Verlauf is now a first-class append-only journal store (server rows + offline outbox)
  instead of an array inside the synced workspace blob – the one unbounded domain no longer
  re-syncs wholesale on every edit. Older incidents migrate lazily and losslessly (the blob
  echoes their rows until each is on the server, then ships empty); transcripts and uploaded
  media URLs are appended enrichment patches, never in-place edits.
- The sync channel is gzip-compressed in both directions (responses via middleware, large
  request bodies via CompressionStream) – repetitive workspace JSON shrinks ~8–10× on
  field LTE.
- The Einsatzende is now first class: archiving stamps `closed_at` (confirm dialog; reopen
  keeps it), both transitions self-document in the Verlauf, post-closure rows carry a
  Nachtrag badge and print in their own Rapport section, the Verlauf gains calendar-day
  separators, and reminders due before closure no longer alarm on reopen.
- Journal Textbausteine: while typing, standard phrases fuzzy-complete the current fragment
  (tap or Tab to accept); the phrase list is station-editable in the admin Journal section.
- Mittel capture + Retablierung: placing a matching tactical symbol (Lüfter, Pumpe, …) on
  Lage or Plan offers logging the material with one tap (never automatic); equipment lines
  carry a Retablierung status (zurück / vor Ort geblieben / defekt) and the Rapport gains a
  «Retablierung / Nachschub» worksheet – refill list, flagged equipment, and still-open
  lines. Catalogue items take optional `symbol` and `verbrauchbar` keys in the deployment
  config; without a `symbol` key a label↔symbol-name match still applies.
- Web Push (VAPID) for killed-app alarms: a server-side sweep recomputes Atemschutz
  überfällig + due Wiedervorlagen from the synced data (same doctrine fallbacks as the
  client) and notifies every subscribed browser – the "tablet stays foregrounded" rule
  becomes a fallback once a deployment sets its VAPID keys.
- New-alarm push: a NEW Divera alarm (webhook or poll) immediately pushes «Neuer Einsatz:
  Stichwort – Adresse» to every subscribed browser, best-effort (a broken push path never
  breaks the intake). VAPID pair generation without Node:
  `cd backend && uv run python -m app.gen_vapid`.
- Tactical symbols: FKS damage signatures (Beschädigung, Teil-/Totalzerstörung) and
  Überschwemmung added to the own-artwork pack (70 signs).

### Changed (assets)
- The tactical symbol pack is now KP-Front-authored artwork (`public/tactical-symbols.json`,
  generated by `tools/gen_symbols.py`, corps-reviewed against the official FKS Faltkarte
  11/2022) – all 66 signs redrawn as clean geometric primitives, same names/categories. The
  backend overlay dataset id moved from `symbols:firegis` to `symbols:tactical`; the legacy
  dataset in existing deployments is simply no longer fetched.

### Removed
- The real station plan PDFs (`public/plans/modul*.pdf`) and the FireGIS symbol-extraction
  tools – station plans are deployment data served from the database; the module tiles in the
  bundled catalog no longer reference any repo asset.
- `public/firegis-symbols.json` and the FireGIS curation scripts, replaced by the authored
  pack above (the last FireGIS-derived asset in the tree).

### Changed
- Smoother app updates: an update discovered right after launch (before any interaction) now
  applies silently instead of asking – the banner only appears for deploys landing mid-work.
  Applying an update shows a calm "Neue Version wird geladen" cover, a watchdog guarantees the
  reload, and the next launch confirms the new build with a toast. The menu's update check
  reports its verdict inline on the button (with a distinct offline message), and standby
  tablets re-check on wake instead of waiting for the hourly poll.
- Incident roles migrated from the legacy `commander` value to `editor`/`viewer` end to end.
- Atemschutz contact timing: the amber "Kontakt fällig" now starts AT the 5-min interval
  (FKS standard) and the hard überfällig alarm fires after a configurable Nachfrist
  (`contactGraceSec`, default 60 s ⇒ red at 6:00). Replaces the previous pre-warning model;
  the old `contactWarnLeadSec` doctrine/setting key is ignored.
- The container now runs as a non-root user (uid 10001). **Existing self-hosted volumes
  created by older root containers may need a one-time
  `docker compose run --rm --user root app chown -R app:app /data/storage`.**

### Fixed
- The Divera webhook now fails closed: with no `DIVERA_WEBHOOK_SECRET` configured it rejects
  all posts (403) instead of accepting unauthenticated alarms. Polling is unaffected.
- A render error on the login screen, landing list, or admin surface now shows the recoverable
  error card instead of a white screen (root-level error boundary + guarded boot init).

[Unreleased]: https://github.com/feuerwehr-oberwil/kp-front/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/feuerwehr-oberwil/kp-front/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/feuerwehr-oberwil/kp-front/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/feuerwehr-oberwil/kp-front/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/feuerwehr-oberwil/kp-front/releases/tag/v0.1.0
