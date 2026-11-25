# Copy and wording

Where UI text lives and which word a screen uses: the copy mechanics (`src/config/copy/`, German
first, all four locales), then the wording decisions that apply across surfaces. Moved here from
AGENTS.md on 2026-10-08 (the wording) and 2026-10-18 (the mechanics), wording unchanged.

## Copy mechanics and language

- **Domain language is German** (Atemschutz, Trupp, Einsatz, Verlauf, …); keep terms
  accurate. **All user-facing strings live in `appConfig.copy.*`** – never hard-code UI text in
  a component; add a key and reference it. Lint enforces it (`kp/no-literal-copy`, an error):
  units and coordinate systems that read the same in every language (km/h, mm/h, km, bar, min,
  ppm, LV95, WGS84) and names inside `<code>`/`<kbd>` may stay literal.
- **Prose language split: technical English, user-facing German.** Everything technical –
  `docs/`, READMEs, `CHANGELOG.md`, code comments, commit messages – is written in English;
  German appears there only as domain terms and as «quoted» UI copy. User-facing text is German
  with i18n overlays (below). The gitignored internal station documents under `docs/` are the
  exception and may stay German.
- **i18n / multilingual copy lives in `src/config/copy/`.** German (`de.ts`, assembled from one
  module per surface in `de/<surface>.ts`) is the canonical base and the source of the `Copy`
  type; `en.ts` (full) / `fr.ts` / `it.ts` (each split the same way) are
  `Localizable<Copy>` partial overlays **deep-merged over German**, so any missing key falls
  back to the German string – a half-translated locale is always complete. `appConfig.copy` is
  a **getter** returning the active locale's catalogue (`copy/getCopy()`); read sites are
  unchanged (`appConfig.copy.x.y`). Locale is a **per-deployment** setting (one brigade = one
  language), resolved **once at boot** (`/api/config` `identity.locale` → `de-CH`) by
  `applyLocale()` in `main.tsx`. It's set in deployment config (CLI/config file first; admin UI
  can inspect/basic-edit Station › Identität › Sprache), NOT per device. **Add a new string to
  `de/<surface>.ts` first** (it defines the shape); translate in the other locales as desired.
  Two caveats: (1) module-level captures like `const C = appConfig.copy.x` freeze the language
  at import – read inside the component/function instead; (2) a few copy values are structural
  DATA keys, not labels (`contextPanel.unField`/`stoffField` match the non-localized preset
  fields, intake `kategorien` mirrors the backend) – leave these untranslated
  (German fallback). The document language follows the displayed catalogue, including a fallback
  to German when a requested overlay cannot load.
- Help text is per device (`lib/helpDevice`).

## Removing is «Entfernen», «gelöscht» is a Feuer

⚠️ **The two acts never share a verb** (decided 25.09.2026): taking a tactical object off the
picture is «Entfernen» / «… entfernt» — button, confirm and Verlauf row, Karte and Plan, every
object kind (`copy · remove`, `log.objectDeleted` …) — so «gelöscht» only ever means an
extinguished Feuer. That holds for EVERYTHING on the picture (audited 25.09.2026 after the second
staging walk-through): a Trupp taken off the board («Trupp N entfernt»), a marker's Spur, a
Gebäude storey («Geschoss 3. OG entfernt», now written by the act itself), a plan group — pinned
by `config/copy/removalWords.test.ts`. Rows already written keep their «gelöscht»
(append-only). «Löschen» stays for records that are not on the picture (an Ansicht, a Schicht,
a Checkliste, a Verlauf-Eintrag, a Mittel line).

## Words

- **The map surface is «Karte», the printed picture is «Kroki» – user-facing copy no longer says
  «Lage»** (2026-09-01). The word meant three things at once (the surface you draw on, the
  tactical picture that gets printed, and the doctrinal *Lage* of an Einsatz), so a row could
  read «auf der Lage platziert» while the tab beside it said «Karte» and the Rapport column said
  «Kroki». The rule now: the surface and everything about placing things on it is **Karte**; the
  rendered/printed snapshot is **Kroki** (the Rapport's `areaLage` value has said so since
  10.08.); real doctrine compounds – *Lage- und Einsatzführung*, *Lagebeurteilung*, *Lagerapport*
  – keep their word, because they are the fire service's terms and not ours. ⚠️ Code identifiers
  are NOT part of this: `mode 'map'`, `surface: 'map'`, `areaLage`, `placeLage`, `lagePickSub`
  and friends keep their names, and so does `alarmText.ts`'s `LINK_PREFIX = 'Lage & Pläne:'`,
  which is a **wire literal** matching what the external alerting gateway (fwo-divera ·
  `src/api/sms.py`) emits – renaming it would break link extraction on every real alarm.
- **A storey is a «Geschoss», the Plan surface an «Arbeitsfläche» – never «Stockwerk» or
  «Whiteboard» in user-facing copy** (2026-09-23: the controls, the Plan stack, the admin and
  OG/UG already said Geschoss while the help and the Verlauf rows said Stockwerk). Already-written
  Verlauf rows keep their wording (append-only); code identifiers (`floor`, `floorTag`,
  `whiteboard.*`, `Whiteboard.tsx`) keep their names.
- **The place is «Verlauf», the thing is «Eintrag» – on every screen** (29.09.2026). The composer
  is «Neuer Eintrag», its save line «Eintrag erfasst» (a toast only for a placeable photo since
  17.11.2026), the checklist action chip «Verlauf», the
  Führungsansicht «Verlauf & Symbol-Details», the detail sheet's meta line «… · von Hand erfasst». «Journal» appears
  on screen nowhere. **«Einsatzjournal» stays ONLY as the printed Rapport section's name**
  (`app/report · "journal"`, `copy.report.journal`, and the «Abschnitte» toggle that names that
  section) – the paper term. The printed Atemschutz section is «Atemschutzüberwachung», never
  «Atemschutz-Journal». en/fr/it keep their own place word (Log / Journal / Diario) and the same
  entry word (Entry / Entrée / Voce). Code identifiers (`journal.*`, `Journal.tsx`, `jr-*`,
  `jc-*`) keep their names. **One count, one word: «{n} anwesend»** – the chooser, the
  Anwesenheit head, the Rapport's «Personal & Material» row, the signature sheet and the PDF say
  the same word for the head count (the Rapport said «erfasst», the sheet «Personen», the PDF
  «Anwesende» until 17.11.2026).

## One word per fact (3am sweep, 13.11.2026)

One line per rule from the design-language sweep (`words.md`, WORD.1–WORD.13); en/fr/it follow
with their own pair (saved / synced · enregistré / synchronisé · salvato / sincronizzato; network ·
réseau · rete).

- **«abschliessen / Abschluss» is closing a record** – the Einsatz, an Objektbesuch – and nothing
  else. The ✓ that ends a drawing is «fertig», a line's cap is the «Linienende», leaving a
  surface is «Zur …» / «Zurück» (WORD.1).
- **«gespeichert» = safe on this device, «synchronisiert» = reached the other devices, «Netz» =
  the network** (owner, 13.11.2026: «we use "synchronisiert" everywhere» – round 2's «übertragen»
  is gone again). The noun is «Synchronisierung»; «Sync» as a bare word, «lokal gespeichert»,
  «Upload», «Verbindung» (for the network) do not appear in operator copy. Personnel import from
  an external system is a «Abgleich» (WORD.2) – «Mit Divera abgleichen», «beim nächsten
  Abgleich», «Personalabgleich», never «synchronisieren» for the roster. A photo, audio or Beilage
  still only on this device is «noch nicht synchronisiert» behind the upload arrow on every
  surface – the Verlauf row, the Rapport's Beilage, the Objektbesuch thumbnail, the closed
  Einsatz's message – and «Nicht synchronisiert» once it failed; never «Wird geladen», which reads
  as a download (duck sweep FEEDBACK.7, 17.11.2026).
- **«Personal» is the roster, «Mannschaft» the crew of a Trupp** – Personalliste, the
  Arbeitsmappe's «Personal» sheet, «Name und Fahrer kommen aus dem Personal». KP Rück draws the
  same line (Mannschaft = the crew of an Einsatz/Auftrag) – consistency sweep 17.11.2026,
  XAPP-04. The Dienstgrad tier «Mannschaft» (Offizier · Unteroffizier · Mannschaft) is the Swiss
  rank class and stays.
- **Never claim a state the code has not verified.** A lost response is «… nicht bestätigt», an
  unreachable request «Server nicht erreichbar», a timeout «Keine Antwort» – not «Kein Netz»
  (WORD.2/6). «Server» is allowed on an operator screen for this one meaning (owner, 13.11.2026:
  a bare «Nicht erreichbar» left open WHAT was not reachable).
- **The Atemschutz surface is «Trupps» on screen**, «Atemschutzüberwachung» only in print,
  «Tafel» only the Plan's template pages; a Trupp leaves «die Überwachung», not «die Tafel» (WORD.3).
- **«sichern» is the Auftrag only**; a file leaving the app is «herunterladen» (WORD.4).
- **A ✕ or a button that empties a pad or a field is «leeren»** (WORD.5, extends the line below).
- **A failure after the operator's own act says the state it leaves** («Nicht gelöscht – bleibt
  in der Liste», «… – erneut versuchen»), never only «X fehlgeschlagen»; a hint says what to do,
  not why the network did it, and is dropped when it would only repeat the title (WORD.6). Where
  the server could not be asked, the act still leads and the reason goes into it in brackets:
  «Alarm nicht übernommen (Server nicht erreichbar) – erneut «Öffnen», es entsteht kein zweiter
  Einsatz» (`lib/actFailed`, rare-user round F8, 17.11.2026).
- **A permission denied long ago names where its switch is on THIS device** – iPhone app, Safari
  tab, Android, desktop (`lib/permissionPath`) – never «in den Browser-Einstellungen» alone, and a
  tap that needs it is never silent («Standort gesperrt – erlauben unter …»; F9, 17.11.2026).
- **A confirm button never starts with «Ja,»** – it is the verb of the consequence, «Teilen» not
  «Weitergeben», «Drucken» not «Ausdrucken» (WORD.7).
- **A confirm's button repeats the verb of its title** («… aufheben?» → «Link aufheben») or names
  who gets what («Trupp {to} auf Leitung {n}») (WORD.8).
- **A tool ⓘ is one line: the gesture and the finish**; what the editor offers is the editor's
  job (WORD.9).
- **An empty state names the button that fills it, in the button's own words** (WORD.10).
- **A plan on the map is «verknüpft» / a «Verknüpfung»; its quality is «Genauigkeit»**;
  «Referenz», «Passung» and «Deckung» are not words for it; its scale chip says «Massstab»; copying
  it to another Modul is «Kopieren» (WORD.11).
- **A recording made in the app is a «Sprachnotiz», an imported one an «Audiodatei».** Durations
  are number, space, unit: «12 min», «2 h», «40 s». No «Update» on a screen – «Neue Version» (WORD.12).
- **An abbreviation a volunteer may not hold gets its long form once**: «Notfall-Leitfaden
  (ERG)», «unter Atemschutz» (not «AS»); doctrine shorts (ELZ, EL, GF, KP) stay (WORD.13).

## One word per idea (rare-user round, 17.11.2026)

The owner's word list (`final.json`, groups W1–W6; picked one by one on 17.11.2026). en/fr/it
follow with their own word for each idea.

- **What stays open is a «Pendenz»; a Pendenz with a time is an «Erinnerung»; urgent is
  «dringend».** One lifecycle (`reminder.op`): created without `dueAt` = Pendenz, with `dueAt` =
  Erinnerung (it rings, snoozes, raises the Meldeleiste row). Only an Erinnerung can be
  «überfällig». «Wiedervorlage» and «Prio. 1» appear on no screen («↻ 10 min» on a done row sets an
  «Erinnerung»; the Tafel's «!» is «Dringend»); «Auftrag» stays the kind of entry. ⚠️ The Tafel
  page «Aufträge / Pendenzen» and its «Prio.» column head are the FKS paper form's words and stay.
  Code identifiers and comments may keep «Wiedervorlage».
- **A station catalogue entry is an «Objekt», one with an Einsatzplan an «Einsatzobjekt», a single
  house from the register a «Gebäude».** «Stationsobjekt» and «Haus» are gone from the screen: the
  Karte panel's kicker reads Einsatzobjekt / Objekt / Gebäude / Gesetzter Punkt, the switch
  «Objekt | Dieses Gebäude», the search group and the Ebenen row «Objekte». «Objekte» also means
  the tactical things on the Einsatz map (`common.groupN`) – no clash, Karte & Objekte draws none.
- **A time in the Zeitplan is «verfügbar» (offered) or «eingeteilt» (assigned)** – the one flag
  `Shift.confirmed`, the same word in Zeitplan and Schichten. «geplant» / «eingeplant» name no
  state: a fresh drag is «Verfügbarkeit für {name} erfasst».
- **A row in an editor or in Einstellungen names what appears or happens, not the mechanism**:
  a line end's routing is «Mitziehen» (Direkt | Spur – «Verlauf» is only the Verlauf), a hose's
  preset is its «Inhalt», the captions switch reads «Aus | Kurz | Alle».
- **A button is named after what happens on the tap**: the Trupps' QR is «Trupps teilen» (nothing
  is handed over – this device keeps everything), the offline Meldung's door «Was offline da ist»;
  «Melden» on Karte & Objekte reports a fault.
- **A door that shows only a number says WHAT is counted in its title / screen-reader name** –
  «Verlauf – 3 Pendenzen offen», «Rapport: 2 offen», «Offene Einsätze: 1». A head that stands next
  to its noun («Pendenzen · 3 offen») keeps the short count.
- **A time of day ends on «Uhr», a duration never** (owner pick UX journeys B2·43, 25.11.2026: a
  walker read the Notfall banner's «00:15» as the Einsatz clock's «5:00»): «Notfall seit 00:15 Uhr»,
  «drin seit 00:15 Uhr», «letzter Kontakt 22:10 Uhr» – «5:00», «drin 10:00 min» stay bare. The
  heads stay wordless (the Einsatz clock's ⌛ and the save stamp «✓ 22:09», 13.11.2026). The Trupps
  copy holds it (`copy.test` · every German `{time}` is followed by «Uhr»); a column of times under
  a «Zeit» head (the Rapport's tables, the Trupp's own log) needs no word per cell. Open: the
  Verlauf rows, the Rapport and the banners outside the Trupps.

## Failure, clear and search copy

- **Failure copy has two shapes, and they are not interchangeable** (settled 2026-08-27 after a
  sweep found 35 of one and 20+ of the other with no rule between them):
  - *«X nicht <Partizip> – <was bleibt / erneut versuchen>»* – the action the operator just
    triggered failed (the toast right after the button). It is a **fragment** and names the
    state it leaves; a bare «X fehlgeschlagen» is no longer enough (WORD.6, 13.11.2026).
  - *«X konnte nicht … werden»* – the failure is about a **named thing** the operator did not
    just act on, or the sentence has to carry *which* object failed («Plan konnte nicht
    hochgeladen werden»). Losing the object name to shorten it is the wrong trade.
  - **Punctuation follows the last segment, not the string.** A string ends with a period only
    when its final segment is a full clause (subject + finite verb): «… – Änderungen sind auf diesem
    Gerät gespeichert.» keeps it, «Nicht gelöscht – bleibt in der Liste» does not.
    Headings and titles never take one, even when they are full clauses («Ein Fehler ist
    aufgetreten»). The rule is per locale – French «La suppression a échoué.» is a clause where
    German «Löschen fehlgeschlagen» is a fragment, and both are right.
  - **A retry sentence says what happened, the button says «Erneut versuchen»** (29.09.2026) —
    never «… nochmals versuchen» in the sentence next to it; one button word in every locale.
- **A ✕ that empties a pad or a field says «leeren», never «löschen»** (29.09.2026) — «löschen» is the
  delete verb. `copy.clear` «Leeren», `copy.clearSearch` «Suche leeren»; no per-surface «Suche löschen» copies.
- **A search field's placeholder is «<Thing> suchen …», or bare «Suchen …» where the surface
  already names the thing** (swept 18.09.2026: «Suchen», «Name suchen», «Suchen oder Name
  eingeben …» and three-dot `...` all existed side by side). Always the ellipsis character with a
  space before it, in every locale. A string that serves only as `aria-label`/button text is
  the plain infinitive («Im Verlauf suchen»); a key used for BOTH keeps the placeholder form.
