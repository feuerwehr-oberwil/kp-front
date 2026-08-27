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

- **Georeferenz – ein Plan und die Karte zeigen dieselbe Stelle.** Ein Modul-Plan wird über
  gemeinsame Landmarken mit der Karte verknüpft: auf dem Blatt antippen, auf der Karte antippen,
  fertig. Ab drei Punkten nennt die Passung eine mittlere Abweichung in Metern – bei zwei Punkten
  steht dort bewusst «aus 2 Punkten» und **keine Zahl**, weil zwei Punkte immer exakt aufgehen und
  eine 0.0 m dort die selbstbewussteste Lüge der App wäre. Danach spiegeln sich Symbole und
  Fahrzeuge als *Zwillinge* auf beide Flächen, jede Projektion ist eine gewöhnliche Zeile in
  «Ebenen», und ein Objekt lässt sich mit «Hierher übertragen» endgültig auf die andere Fläche
  verschieben – angeschlossene Leitungen werden dabei sauber gelöst, nicht verwaist. Eine fertige
  Passung überträgt sich auf weitere Module desselben Objekts. Lupe auf beiden Seiten, damit man
  die Hausecke trifft und nicht das Dach daneben.

- **FireHub (Tercero) alarms, without a second integration to learn.** A station on FireHub now
  points its «Einsatzstart» and «Einsatzende» webhooks at `POST /api/firehub/webhook` and gets the
  same result every other intake path gives: a start **auto-opens the incident**, an end **stamps the
  Einsatzende** on its Rapport (`reportMeta.endedAt ?? closed_at`, so an operator-entered time still
  wins) without closing the card – retiring the Einsatz stays the operator's call. It is a payload
  adapter over the existing provider-neutral intake, not a new pipeline: no server-side key, no DB
  migration, deduped on the **stable `opsID`** (never the volatile `opsNumber`), and authenticated
  with the same `alarm_webhook_secret` as the generic webhook – put in the URL as `?secret=…`, because
  FireHub's schema and headers are fixed and cannot carry a custom auth header. The address is composed
  from `street` + `city` (a payload field Tercero is adding, degrading to street-only until it ships);
  FireHub sends no coordinates yet, so the pin is geocoded. Listed in the capability registry
  (`GET /api/system` › integrations) as a discoverable dispatch-system choice. See
  [`docs/ALARM-INTEGRATIONS.md`](docs/ALARM-INTEGRATIONS.md).

- **The Meldeleiste – one strip, one ranking, everything visible.** Nine banners used to compete
  for the same screen edges with nothing but z-index deciding who could be read: the worst realistic
  stack on an iPad in landscape covered the due Wiedervorlage – the one message whose whole doctrine
  is «stays up until handled» – with the one that could have waited. They are one strip under the top
  bar now. Every pending message is a row, ranked by class before time (Atemschutz-Alarm → Alarm →
  Wiedervorlage → GPS → Prüfen → Tab-Sperre → Update → Installieren), and with nothing pending the
  strip is not in the DOM at all. A first cut kept the rest behind a +n disclosure; measured against
  real use the strip holds zero or one message almost always, so the queue went the same week –
  alles offen, nothing privileged, no «which one did I just act on». Row bodies are inert – only
  labelled buttons act, plus the permanently underlined title of a message that has somewhere to go
  (permanent, not hover-only: this runs on an iPad). «Nur ansehen» left the layer to become a mode
  chip beside the Einsatzname, and the intake review shrank to a «Passt / Bearbeiten» row – one that
  yields while an alarm is pending, because confirming one Einsatz's data while looking at another's
  is a nonsense question.

- **An Atemschutz-Alarm that sounds now says what it is for.** The escalating tone, the wake lock and the
  OS notification always fired app-wide, but away from the board their cause was a small chip and a
  dot – a noise the operator had to investigate rather than act on, and since low pressure joined
  the tier, genuinely ambiguous. Each Trupp in alarm now has its own Meldeleiste row at rank 1 –
  above the dispatch, because a fresh alarm can wait twenty seconds and a Trupp out of air cannot –
  naming which Trupp and why: «Atemschutz überfällig» or «Alarmdruck erreicht», with bar and limit.
  The tier is read from the same fold that plays the tone, so «tone implies row» holds by
  construction. No ✕ (an overdue Trupp is ended by a Funkkontakt or a Druckmeldung, not a tap), and
  deliberately not muted by the bell – this row is exactly what must stay readable after the bell is
  pressed. ⚠️ Found on the way: a pressure alarm posted «Kontakt herstellen» as its OS notification.
  Air does not come back on the radio; title and body follow the reason now.

- **One labelling pass decides on the Lage, instead of six that don't.** Captions,
  Trupp names, end tags, readouts and radii were placed by six independent loops with no collision
  test between any of them – at the exact zoom where captions appeared, every one overlapped every
  other on a Zimmerbrand. `lib/labelPass.ts` is the one arbiter now: fixed rank, exempt set first,
  one collision test per candidate, computed in screen pixels. Nothing moves – no spiral, no leader
  lines, because a name drawn 88px from its symbol is a small untruth and on a Lagekarte position is
  the whole point. A label that does not fit is suppressed and comes back by itself on zoom-in; the
  current selection is never suppressed, a tapped marker rises above the pile, and hand-placed
  labels are pinned. (The interim 6px «a name is hidden here» ink dot lasted half a day and is gone
  – zooming in already answers what it said.) German captions break at compound seams, on the Plan
  too.

- **Drawings survive a building change – and the rail has one building tile instead of two.** «Umrisse» and «Gebäude» were two rail entries for one goal; they are one tile now, showing
  the OSM picker while no building exists and the floor stack once one does – the way back to the
  picker is a chip, not a second rail entry. And changing the footprint no longer silently re-points
  every mark at different ground: each annotation is carried old frame → ground → new frame, floors
  are inherited, and anything landing off the new sheet is dropped and counted, never clamped – a
  clamped mark asserts a position that is false. ⚠️ The tiles merge, the plan IDs do not: older
  Verlauf rows, Trupp chips and annotated Rapport pages keep resolving.

### Changed

- **«Löschen» means gone, «Entfernen» means only unlinked.** A consistency pass read every German
  string in both KP apps – 3 862 here, 3 245 in KP Rück – and the call sites behind them. kp-rück
  already kept a rule this app did not: the generic delete button said «Entfernen» and sat under
  nine dialogs whose own title asked «löschen?». It says «Löschen» now, and the places that really
  do only unlink – Standort, Organisation, ein Trupp, der die Atemschutz-Tafel verlässt – keep
  «Entfernen». ⚠️ Read the verb before you tap: the word now tells you whether the thing comes back.

- **One word per thing.** «Mittel» was the rail label for a surface the help called Material twice
  and the printed Rapport called Material – it is **Material** everywhere now, and the [[M]]
  shortcut finally stands for the word on screen. «Personal» is the Mannschaftsstamm (the admin
  list), matching KP Rück, and the help stops giving the Anwesenheit surface a second name. The
  same pass settled the rest of the vocabulary: errors read «X fehlgeschlagen», progress is passive
  («wird geladen …»), «Erneut versuchen» is the only retry, a new record is «erstellt» while a list
  entry is «hinzugefügt», and empty states say «Noch keine X.» when it still comes during the
  Einsatz but «Keine X konfiguriert.» when the station has to set it up. Typography follows: «…»
  with a space, guillemets, en dashes, Swiss ss. English, French and Italian were pulled onto the
  same rules – each had drifted the same way the German had, and the Material rename had reached
  only their menu entry. ⚠️ The translations are mechanical where the German decided a meaning; the
  Personal/Mannschaft split is German-only, and a native speaker should decide whether French and
  Italian want two words for it.

- **The Verlauf row carries one classification column instead of twelve decorations.** The row is a
  four-track grid now – time · disc · sentence · trailing footnotes. The 26px disc carries the
  Bereich and becomes the ring for a Pendenz; footnotes (Nachtrag · korrigiert · 6×) trail the
  sentence instead of preceding it, so every sentence starts at one x and a done item no longer
  reads «PENDENZ Pendenz erledigt: …» – the word printed twice. ⚠️ The record is append-only: old
  rows keep classifying exactly as before, and what is written, printed and hashed did not change –
  the row renders `e.text` byte for byte, both pinned by tests.

- **The Kroki preview draws the sheet, not a second picture.** The server turns every label
  into a numbered disc with a legend and decides membership by whether the disc fits inside the
  crop; the framing preview drew full captions and no legend, scale bar, north dial or attribution
  plate – so the single most consequential effect of the pan was invisible exactly where the pan
  happens. The preview is the sheet now: numbered discs, the legend under the crop, the furniture in
  the server's own fractions. The fit test uses the true printed radius while the drawing keeps a
  15px floor, and amber means exactly one thing on this surface – «this will not be on the sheet».

- **Pendenzen and log are two stacked scroll areas, instead of one with a lid.** The Pendenzen
  block was sticky inside the log – capped, clipped, «Aufklappen» to see past it, the log frozen
  while it was open, and rows sliced in half behind its opaque edge. It is a sibling above the log
  now, its own scrollbar, `max-height: 45%` with content height as the floor. The slicing is not
  fixed so much as made impossible: nothing is positioned over anything. ⚠️ Reverses a documented
  decision – the «two scrollbars» objection was about two overlapping ones, which these are not.

### Fixed

- **Vier Halte-Gesten, ein Ring.** «Entsperren» trug als einziges einen 4-px-Balken in einer
  schwebenden Karte, mit eigener Dauer (700 ms) und ohne die 250 ms Ruhe, die jede andere Halte-Geste
  abwartet, bevor überhaupt etwas erscheint – ausgerechnet auf dem einzigen Antippfeld einer
  gesperrten Fläche, das man am ehesten streift. Es trägt jetzt denselben Ring wie Knoten löschen,
  Verbinden und Lösen, an derselben Uhr (`lib/nodeHold`), blau wie alles, was etwas zurückgibt.
  ⚠️ Dabei fiel ein echter Fehler auf: der eigene 700-ms-Timer wurde beim Verschwinden des Chips
  **nicht** abgeräumt – ein Chip, der mitten im Halten wegfiel (Werkzeugwechsel, Sync), entsperrte
  die Fläche 700 ms später trotzdem.

- **Der Fortschrittsring log unter «Bewegung reduzieren».** Die globale Regel
  `@media (prefers-reduced-motion: reduce) { * { animation-duration: .001ms !important } }` schlägt
  jede lokale Ausnahme – der Verbinden-Ring stand also sofort voll, während die Verweildauer noch
  350 ms zu laufen hatte. Ein Ring ist keine Zierde, sondern die Aussage «so lange noch»; er wird
  jetzt in JS getickt und kann von einer Zier-Regel nicht mehr stummgeschaltet werden.

- **«Ebenen» legte sich auf die Detail-Karte.** Beide belegen denselben Platz rechts neben der
  Werkzeugleiste – auf dem Telefon dieselbe untere Kante –, und die Ebenen-Karte liegt darüber. Die
  vergrabene Detail-Karte blieb durch den Hintergrund hindurch antippbar. Jetzt tritt sie zurück,
  solange ein Dock offen ist, **ohne die Auswahl wegzuwerfen**: der Halo bleibt, die Karte kommt
  zurück, sobald «Ebenen» zugeht. Gleiches gilt für die Zwillings-Karte.

- **Die Detail-Karte folgt der ausgeklappten Werkzeugleiste.** Ihr Abstand war eine feste Zahl
  (`right: 116px`), während jede andere Fläche daneben die Rail-Breite mitliest. Ausgeklappt lagen
  116 px der Karte unter der Leiste, bei gezogener Leiste bis zu 180 px.

- **Auf dem Telefon bleiben «Löschen» und «Zentrieren» stehen.** Die Fusszeile scrollte im Sheet mit
  – auf einer Zwillings-Karte mit fünf Aktionen bis auf drei Reihen ganz unten. Sie ist jetzt
  angeheftet (durch Layout, nicht `position: sticky` – das ist in einem Blur-Scroller auf iOS
  unzuverlässig); die Beschriftungs-Zeile scrollt weiter mit, denn sie ist der seltene Griff.

- **Die neueste Meldung konnte unter der Faltkante liegen.** Der Toast-Stapel hatte eine Höhe
  bekommen, aber kein verlässliches Ende: bei einem Schwall begann der Bereich beim ÄLTESTEN, und die
  Pille mit «Rückgängig» stand unsichtbar darunter. Ausserdem legte sich die verschobene Toast-Spur
  exakt auf die Meldeleiste – dieselbe Verdeckung, die sie vermeiden sollte, nur oben statt unten.

- **Ein einziger fehlerhafter Georeferenz-Eintrag löschte alle Massstäbe.** Das Dokument wurde als
  Ganzes geprüft: eine unbrauchbare Koordinate in *einem* Plan liess die ganze Station auf
  «kalibrieren» zurückfallen, sichtbar nur im Server-Log. Jetzt fällt genau der defekte Eintrag weg.

- **Der Rückzugs-Alarm liess sich auf 0 stellen.** Ein geleertes Feld in der Verwaltung nahm den
  Niederdruck-Alarm still von **beiden** Wegen – Server-Push und Gerät. Das Feld hat jetzt Grenzen.

- **A reviewer with fresh eyes found the places where the app contradicts itself.** An
  external user test read the surface against itself. The Atemschutz hints told the operator to
  press «Eingerückt» where the button says «Einrücken» – in all four languages; the Tafel hint
  offered «Zeichnen, Text» where the dock names Linie, Fläche and Notiz; the AS settings explained
  a colour in English («amber») on an otherwise German surface; and «Erwartet (Schätzung)» said
  estimate twice without saying pressure once – it is «Geschätzter Druck» now. Two real bugs rode
  along: the keyboard help rendered the «]» shortcut as raw brackets, because a literal bracket in
  the chip markup is `[[]]]` and the copy had `[]]]`; and the icon sprite defined `bell` twice,
  which is invalid HTML – the definition matching `bell-off` is the one that stays.

- **A delete dialog claimed the deed before the question was answered.** «Auswahl entfernt» – a
  toast string – was serving as the heading of the confirm dialog for a multi-object delete, so the
  question announced its own outcome. It has a title of its own. Two other destructive dialogs
  confirmed with «OK» where every sibling names the verb, and the ✕ in the symbol palette was
  labelled «Schliessen» although it only clears the search – one of four labels for that one
  gesture, all «Suche löschen» now.

- **The workbook named sheets that do not exist.** Renaming the surface from «Mittel» to
  «Material» briefly renamed it in the workbook copy too – but the sheets in the Excel file are
  literally called Mannschaft, Mittel and Mittel-Bestände, so the text promised sheets an operator
  would not find. It quotes the real names again. ⚠️ Renaming those sheets is a data-format change,
  not a copy change; if they are ever renamed, the parser and every station's saved file move too.

- **A deliberate Einsatz choice survives the reload.** Boot preferred the newest alarm-created
  Einsatz unconditionally – no freshness window, no memory that the operator had already decided
  otherwise – and then stamped its own pick into the cookie, so a stale alarm re-confirmed itself on
  every reload and could make another Einsatz unreachable for as long as it stayed open. The alarm
  must now be inside the same freshness window the pool banner uses *and* have appeared after the
  operator last opened something by hand; a genuinely new alarm still wins, which is the case the
  rule exists for.

- **A Pendenz can be ticked off where you see it – and the plan jump lands on the symbol.**
  Down in the log the same item showed ring, «fällig» and pen but no way to mark it done; the row's
  ring now calls the same handler as the pinned tick – one path to one state. And plan placement
  rows carry the annotation, the point and the floor, so «Symbol auf Plan gesetzt» selects it
  instead of merely opening the Gebäude. ⚠️ Rows written before can never grow coordinates (the
  record is append-only) and degrade to exactly the old behaviour.

- **The Atemschutz board says what the alarm has long known.** Low pressure has been a tier-2 alarm
  app-wide since 10.08. – tone, OS notification, NavRail dot, TopBar chip – but card, row, badge and
  sort read the contact clock alone: a Trupp at 40 bar with a fresh Kontakt had the whole app
  screaming while its card stayed green. `truppAlarm()` is now the one place a tier is decided, so
  board and alarm cannot drift apart again; the status word stays the lifecycle state, because a
  pressure alarm must never print «Überfällig». Same pass: Undo on Eingerückt / Rückzug /
  Fortsetzen – a mis-tap silenced an overdue Trupp and wrote a false line into an append-only
  record – and a standby Trupp with a low bottle no longer sounds a tone its chip denied.

- **Plan undo survives the surface switch.** Plan history lived in the Whiteboard, which
  unmounts on every surface switch – drawing on a plan, hopping to the Verlauf and coming back left
  nothing to undo, while the Lage always survived this. The stacks live on the owning surface now,
  still keyed per plan document. Same pass: the line presets (Rettungsachse, Pfeil) were declared
  but never rendered on either surface and exist now, from one component on both; the Plan's
  hand-rolled modals go through `lib/overlays` and own Escape outright; starting a Sprachnotiz no
  longer un-lights the armed map tool.

- **A corrected time keeps its own day.** The Rapport's Gruppen and Fahrzeuge rows seeded the
  day picker from today, so correcting a Monday Ausrückzeit on Wednesday filed it as Wednesday –
  silently, on the sheet that becomes the printed record. Those were the last two call sites
  carrying the trap. The print-section toggles also survive ordinary navigation now, and Capture's
  base button no longer fills four buttons – including a Cancel – with the brand red reserved for
  the one primary.

- **The entry composer's ✕ closes, instead of deleting.** It looked like every other ✕ in the
  app, all of which merely close, and it destroyed the typed draft with no confirm and no undo – one
  glyph with two meanings is unlearnable at 3am. The draft guard now keeps Type, Fälligkeit, clip
  and photos too (only an imported audio file is let go, and that loss is spoken out loud), and a
  failed audio upload no longer leaves the sheet standing over an emptied store.

## [0.8.0] – 2026-08-22

### Added

- **An Ausbreitung points in four directions, and each one carries its own boundary.** A fire running
  along a façade to *both* sides and stopped at only one Brandmauer could not be drawn: horizontally
  the symbol knew `'E' | 'W'` – either/or – and a boundary belonged to the AXIS rather than to the
  arrow, so one `vBounded` put a bar on both vertical arrows whether it was true or not. All four
  directions are independent now and each carries its own bar, drawn across it the way the symbol
  prints it. The boundary is never locked: tapping it on an arrow that is off means «dorthin, und
  dort gestoppt» and switches the direction on, because the ordinary case must not cost two taps.
  ⚠️ The old shape sits in every Einsatz that ever had an Entwicklung, running and archived, and
  the workspace blob is **not** migrated – a rapport from 2025 still prints from it years later.
  Nothing reads the fields raw; everything goes through `normalizeSpread`, and `kroki.py`'s
  `_spread_dirs` mirrors it line for line so paper and screen cannot drift apart.

- **«Entfällt» is an answer – on screen and on paper.** A Fehlalarm has no
  Kontaktperson and an Ölspur is never reported back to the ELZ, and neither step had a way of
  saying so: the rapport of a routine Einsatz could not reach complete, so «Angaben fehlen noch»
  stood in front of every print until it was being tapped away unread. Both fields now take the
  same escape the Mittel step has had all along – a recorded «Entfällt» that satisfies the step and
  is logged in the Verlauf as the deliberate answer it is. On paper it prints as **–** in the value
  column, where a field nobody answered keeps its empty write-in rule: «gibt es nicht» and
  «vergessen» stay two different statements on a sheet that gets signed.

### Changed

- **Jedes «Einsatz abschliessen» geht durch dieselbe Tür.** The Einsatz-Menü row and «Alle
  Einsätze» archived plainly – no `report_done_at`, none of the seven steps checked – while the
  identically labelled Rapport path stamped and counted. Both doors run the one counting confirm
  now and end in `completeRapport`; the menu row shows the open-point badge *before* the press, the
  confirm button says «Trotzdem abschliessen» when points are open, and a failed close or reopen is
  reported instead of swallowed. One word pair for the lifecycle throughout: abschliessen / wieder
  öffnen.

- **The bars' drag handle goes with the words, not with the input device.** The decision was
  already made and only half carried out: with «Beschriftung · Wörter» on, the expand chevron is not
  rendered at all, because there is nothing left to expand once the word stands under the sign. The
  drag handle was the remainder the same thought had missed. It is gone whenever the words are on,
  on every device – and it stays everywhere when they are off, because then it is the only way to
  see a label at all. ⚠️ The earlier condition was `pointer: coarse`, which was both too wide and
  too narrow: it left the handle on the desktop and would have missed an iPad on a trackpad, which
  reports `pointer: fine` and is exactly the device the rule was written for.

### Fixed

- **«Beschriftung · Wörter» never reached the bar on the plan.** The setting promises the word
  under every sign in *both* rails and kept that promise on the Lage only: the Whiteboard renders the
  same `<ToolRail>` – its own comment says so – but never passed it `labels`. One setting, two rails,
  and one of them was not listening. ⚠️ Threaded through as a prop rather than a second
  `useDevicePrefs()` in the Whiteboard: that hook keeps its own state per call site, so a second call
  would have made a copy that goes stale the moment the setting is switched.

- **The bars' footer buttons cut their words off, the tools above them did not** – same frame,
  same font. The browser's own `padding: 1px 6px` on a `<button>`: `.vrail-tool` zeroes it,
  `.vrail-nbtn` never did, so twelve pixels that stand in no rule of ours left a foot button 64 px
  for a label where a tool had 76. That is why «Absperrkreis» (75 px) and «Vergrössern» (70 px) did
  not fit. Measured in the built bundle, in Sora, against the real rail: all 23 labels of both rails
  fit now, and it needed **no** shorter words – the established terms stay.

- **A print job in the queue is not a printed Rapport.** «Ausdrucken» stamped
  `reportMadeAt` the instant the job left the device – including right after the dialog that had just
  said the printer was offline – so the app offered to close an Einsatz whose rapport existed on no
  sheet of paper anywhere. The open job lives on the workspace now and shows as an amber band under
  the Rapport head, polled every 15 s, and the stamp waits for the relay to say *done*. A relay 404
  is its own answer («swept after 7 days, outcome unknown» – cleared without stamping), and cancel
  distinguishes cancelled / late / gone / unreachable instead of dressing a network failure up as
  «zu spät».

- **The bell in Atemschutz only promises what it can keep.** Three honest states instead of an
  action label, including a silent «Ton nicht freigegeben» whose tap retries the unlock: the tone
  needs an AudioContext the browser only releases inside a gesture, and nothing guaranteed one. The
  unlock now rides the first touch of every Einsatz rather than the Trupp form alone. The mute
  finally covers **both** channels – the OS kept posting «Atemschutz überfällig» every 30 s past a
  bell that said off – and it is scoped to one Einsatz per device, so a tablet muted at a drill in
  February is armed again for the next real alarm.

- **The tile download counted attempts, not hits.** The progress bar reaches 100 % whatever
  happens – it counts attempts finished, and must, or a dead host would hang it – so «fertig» said
  nothing about «geklappt»: on dead WLAN in the Magazin it toasted a green «Karte offline verfügbar
  (0 Kacheln)». The result buckets stored / notFound / failed now, a 404 counting as final (no
  coverage at a layer's edge is not a miss that «Weiterladen» could ever fill), and four outcomes get
  four messages – green only when everything fetchable arrived.

- **A Leitung's label sat on top of the Leitung.** The boxed end tag («1 · S · +2 · Müller
  H.») was drawn 72 % along the last segment, centred on the line, and its box is opaque – so on
  paper it covered the last quarter of the very Leitung it names, the line appeared to stop dead at
  the tag, and the Teilstück fork past it read as a second, unattached mark. It is pushed clear along
  the segment's normal now, by the box's own reach in that direction plus half the stroke, on the
  side away from the line's centre of mass – so a hose that loops back is labelled outside its bend –
  and clamped inside the sheet, because a tag that is cut off says nothing.

- **The Kroki frame now shows what the sheet shows.** Four ways the preview disagreed with the
  paper it previews. The words rendered at plain screen size while the symbols beside them were
  scaled, so in Hoch they came out about 1.7× too big; on top of that a **second** print reference
  for Hoch inflated everything scaled by a further 1.6×, on the reasoning that the server sizes
  symbols in absolute pixels on an orientation-dependent canvas – it does not, it scales every rule
  by `width / 1050` for both shapes. The tag stacked onto two rows where `kroki.py` joins every part
  onto one. And it was anchored at a hand-dragged `endLabelAt`, a field no payload the server sees
  ever carries, so the crop was showing a position that cannot come out. ⚠️ Consequence worth
  knowing: **a tag you drag on the Lage does not move on the paper** – making the sheet follow the
  hand is a payload and server change, not a preview one. The Teilstück fork is scaled as a whole
  instead of being handed a smaller width (`forkDims` floors the spine at 14 px, so a scaled-down
  width simply hit the floor and left a full-size comb on a hairline), and its bearing stops reading
  the raw last segment – a hose drawn with a finger routinely ends in a 3 px vertex that carries no
  direction.

- **The loading ping sat on top of the work.** The in-workspace splash stands in for the map, and it was a
  transparent `position: fixed` sheet above everything: while the tiles and the symbol pack loaded,
  the brand pulse and the station wordmark were painted straight across the Rapport, the rails and
  the panels – all perfectly usable – with nothing behind them to say what they belonged to. A
  working screen looked broken. It sits at the map's own layer now, and only the stalled state comes
  forward, because at that point it carries a «Neu laden» button and an action behind an open dialog
  is not an action.

## [0.7.0] – 2026-08-21

### Added

- **A Schema in a Checkliste opens as a picture, and it is the viewer every other picture uses.**
  A Kommandoakten page scaled into a 14px reading column is a picture *of* a diagram, not one that
  can be read, and looking harder was the only option. The preview is a button with a magnifier
  now; it opens full-screen, starts fitted, and takes the same gestures as a Verlauf photo –
  pinch, wheel, drag, double-tap onto the point under the finger, panning bounded by the image's
  own overhang. On a wide screen the reader runs in two columns, so a figure or a wide table now
  spans both, the way a plate sits in a printed page instead of in half a column. ⚠️ The viewer
  offers **no** «herunterladen» for a Schema: the document belongs to the BGV and is one tap from
  its source, and a copy pulled out of the app goes stale silently while the page in the app is
  kept current. The button is switched off for this one caller (`download: false`), not removed –
  for a Verlauf photo, a Rapport-Beilage and an Objektfoto, getting the file out *is* the point.

- **The landing page answers «and what if we run both?» before the mail arrives.** The KP-Rück
  section named the sister app and stopped there, so the obvious next question – how much is set
  up twice – was answered only by a document in the other repository. Five rows now say what is
  shared (one alarm payload, one Divera key, one print agent in the Magazin, one roster file, one
  Stichwort list) and one line says what deliberately stays apart: database, updates and login.
  Neither app needs the other to run, and the page says that in the same breath, so nobody reads
  «works together» as «depends on». All four languages, from the same `content/*.json`.

- **The Telefonliste's numbers stand under each other, and a step reads as a step.** The list is
  twelve separate tables, one per heading, and each one sized its columns to its own longest line
  – so the number sat somewhere else in every block and the eye had to find it again on every
  scroll. A fixed column width puts all of them on one line. In the same reading surface, a
  bullet at level 0 is a STEP and one at level 1 is a detail of it; they differed by 16px of
  indent and nothing else, so a screenful read as a flat wall. The step keeps full ink and a
  filled dot, the detail is damped and gets a hollow one.

- **The Wehr's own paperwork sits on the Rapport, pre-filled.** Every station has forms that live
  outside this app and still have to be filled in afterwards – a Getränkeabrechnung for the
  Gemeinde, a Schadenmeldung, an internal form. `report.links` (Verwaltung › Rapport) puts them
  under the Fotos as a list to tick off, and the URL can carry placeholders – `{stichwort}`,
  `{ort}`, `{datum}`, `{einsatzleiter}` and five more – that are filled in from the running
  Einsatz when the link is opened, so a Google Form comes up with Anlass and Datum already in it
  instead of blank. The tick is per-incident and shared across devices, merged per link so two
  people ticking two different forms keep both. **Configure none and the section does not exist**
  – no empty card explaining a feature a station does not use. It never reaches the paper: the
  rapport is the record, a to-do list of links is not part of it, and neither is it an
  Abschluss-Assistent step that could hold up an archive. Nothing is ever ticked automatically –
  opening a form says nothing about whether it was submitted, so the app asks once, when the
  operator comes back from it. ⚠️ A placeholder sends incident text to whoever hosts the form,
  and the configured links are served by the public config endpoint – both are spelled out in
  `docs/CONFIGURATION.md` §1d and `PRIVACY.md`.

- **Filters are one button per surface, and the search line is the same line everywhere.**
  Grad, Status and Kategorie were an inline segmented track and a legend strip – two rows of
  chrome above the list you came for, over controls that are barely reached in the field. They
  are dropdown buttons now, at every size, and multi-select: picks inside a facet OR together
  («Of + Wm» is the Kader), facets AND with each other. Ort is deliberately not its own facet –
  only somebody who is here can be «Vor Ort», and as a separate group the two could be combined
  into a contradiction whose only honest answer is an empty list.

- **Einsätze nobody ever came back to are swept up.** Closing an Einsatz is a deliberate act, and
  somebody who does not know the act exists never performs it, so incidents that *were* worked on
  and then left open accumulated forever. `alarms.staleIncidentDays` is a second, much longer
  clock for exactly those, kept apart from `autoArchiveDays`, which only ever swept alarm noise
  nobody had recorded anything on. Both archive **reversibly**, neither stamps `report_done_at` –
  the Rapport was not finished and the record must never claim it was – and each writes its own
  Verlauf row naming the clock that ran out. An Einsatz that disappears off the list without a
  word is the failure mode this sweep must not have.

- **The landing page speaks English and Italian**, laid over the German base the same way French
  is. Both carry the same visible line French does: no firefighter who speaks the language has
  read them yet. Terminology follows the national bodies rather than a dictionary, and the app's
  own glossary rather than a translator's – SCBA, not «breathing apparatus».

- **The Wiedergabe shows what was written.** The Verlauf now runs under the scrubber as a lane of
  ticks, and the entry the playhead stands in reads along the bottom of the bar like a subtitle,
  narrating the Einsatz while it plays. «im Verlauf» opens the Verlauf landed on that row, and –
  the other direction – **every row in the Verlauf sets the moment** during a Wiedergabe, so the
  whole picture reads as it did when the line was written. Rows the playhead has not reached are
  dimmed: they had not been written yet.

- **The station's lists are one Excel file you edit and give back.** Verwaltung › Daten ›
  **Arbeitsmappe** downloads the Wehr's Mannschaft, Dienstgrade, Fahrzeuge, Mittel,
  Mittel-Bestände, Quellen, Partnerorganisationen and Symbolfeld-Optionen as one `.xlsx`,
  editable in Excel, Numbers or LibreOffice and uploaded back. The Mittel-Katalog and the
  Dienstgrade in particular had no browser route at all. **Before anything is written the
  screen says what would happen** – per sheet: how many rows are new, how many change, and what
  would be *deactivated* (people, never deleted – Einsätze resolve their names through those
  rows) or *removed* (list entries), named rather than counted, plus every refused row with its
  sheet and row number so it can be found in the operator's own file. Cancelling writes nothing.
  There is **no «Ersetzen» mode**: a row's absence from a sheet that is present is the only way
  anything goes away, and a sheet the file does not carry is not touched at all – a workbook
  with no `Fahrzeuge` tab leaves the fleet alone, while a `Fahrzeuge` tab holding only its
  header clears it, on purpose, after saying so. The file is parsed on the server and only the
  key paths it has sheets for are rewritten, so nothing else in the configuration can ride along
  and the write stays undoable through «Letzte Änderungen». Ids are treated as the join keys
  they are: a Kennung Excel turned into a date or a number is refused with the cell quoted back
  rather than silently rewritten, formulas never import as their own text, and
  `mittel.catalogue[].when` – a rule no spreadsheet column can express – is carried over
  untouched. ⚠️ **It is not a backup**: it covers the list-shaped data only, and the page says
  so. Name, Sprache, Karte, Doktrin, Alarmierung, Logos, Objektpläne, Kartenebenen and die
  eigenen Formulare stay with the Sicherung's JSON export.

- **An entry can stay open until somebody ticks it off.** The BGV form «AUFTRÄGE / PENDENZEN»
  wants Was · Wer · Prio · Erteilt · Erledigt, and three of those columns already fell out of the
  append-only Verlauf – what was missing was a way to say a line is *not finished*. The ring
  beside Info · Auftrag · Sofortmassnahme says it, and its menu is the whole model in one list: a
  new open item, an urgent one, or a **Meldung** on one already open. Open items sit at the top of
  the Verlauf, dringend first then oldest, each carrying its own thread; a Meldung is written in
  the ordinary composer, pre-linked, which is why it can be a Sprachnotiz or a photo without a
  line of new code. «Wer» is read off the sentence rather than asked for – the composer already
  marks known names, and a Trupp is titled by its Gruppenführer. On the Rapport the section prints
  after the Verlauf it comes from, with «offen» where nobody ticked the item off: the one thing
  somebody has to take away from the Einsatz. ⚠️ Tracking hangs off the lifecycle event, never off
  `entryType: 'auftrag'` – keying it to the tag would have turned every Auftrag row already
  written, live incidents and archive alike, into an eternally open Pendenz nobody can tick off.
  Old rows stay plain text; there is no migration.

- **A journal entry can say when it has to come back.** The composer used to ask first which KIND
  of row you were writing – «Eintrag» or «Erinnerung» – and that answer took everything the
  ordinary sheet has away from the reminder: Art, Foto, Sprachnotiz, the ring, the link to an open
  Pendenz. «Auftrag erteilt» and «um 22:10 nachfassen» had to be two rows about one thing. A due
  time is a **property** of an entry now, like the ring beside it: a clock in the meta row, preset
  minutes and «Uhrzeit …» in one popup. The exact dialog carries a **day**, because «that time,
  and if it has passed then tomorrow» was right most of the time and silent the rest – on the one
  surface where a Wiedervorlage set for the wrong day is a check nobody makes; a moment already
  gone by is refused rather than rolled forward. Clock and ring keep each other honest: a
  Fälligkeit opens the ring (a banner nobody can tick off has no answer), and closing the ring
  drops the time. A Meldung may carry one too, riding on the note rather than on a snooze row, so
  the sentence stays in the item's thread. ⚠️ A **Pendenz** deliberately has no Fälligkeit – nobody
  checks in at a set time on a Schadenplatz, so a due date would only alert the person who set it.
  Both derive from the same events and share one list; only the dated one can alarm.

- **A typo can be corrected, and the line says that it was.** A wrong Strassenname or a Trupp
  number off by one had no way out: the journal is append-only, so the choices were a second line
  saying «oben falsch» – which the Rapport prints as two contradictory rows – or leaving the error
  standing on a signed document. Correction is offered on everything a **person** typed: composer
  entries, Meldungen, Nachdokumentation written in the player. **Never on what the app wrote about
  an action** – «Trupp 2 eingerückt» is the record of something that happened, and rewriting that
  sentence would make the log state an action that never happened that way, the one thing this
  journal exists to prevent. The correction is itself an appended row, both wordings stay in the
  record and in the hash chain, and the line then reads «korrigiert HH:MM», because a corrected
  line that looked untouched would quietly pass its new words off as the ones spoken at the time.

- **A voice memo's words are its transcript, section by section.** Typing in the player wrote a
  free-standing «Manuell» row that looked unrelated to the recording, while the memo itself kept
  asking for its transcript. On a memo the composer is «Transkript ergänzen» now: each save
  appends a **section** – offset into the recording plus the words – onto the memo's own row, and
  confirmed STT segments land there too. **Tapping a section opens it for fixing** in place (the
  small play circle still seeks); the fix replaces that section's words, with no «korrigiert» mark
  and no new Verlauf line, because the recording is the original and stays. Clearing the words
  removes the section. Imported recordings keep «Eintrag an dieser Stelle» – a Funk-Mitschnitt
  genuinely has entries at moments. Recordings also **play at 0.5×**, which for a radio message
  that came in fast or garbled is the one speed that makes transcription possible.

- **The Atemschutz Journal prints as a chronology, Austritt and Wiedereinstieg included.** The
  Austritt lived only in the sheet's header, so the pressure log simply stopped mid-Einsatz and
  the reader had to look up to learn whether the crew ever came out. And a Fortsetzen after a
  Rückzug was recorded as a plain «Kontakt» – true, the Trupp was reached, but the sheet then said
  a Trupp withdrew and never went back. Both are their own kind now («Ausgerückt» /
  «Wiedereinstieg»); the safety clock is untouched, a Wiedereinstieg resets it exactly as a
  Kontakt does. Reverses the documented «a Fortsetzen stays a plain Kontakt».

- **A Trupp in Rückzug is held to a lower Alarmdruck.** The Alarmdruck is the line at which a crew
  has to turn round. A crew in Rückzug *has* turned round – the order is given and they are
  walking out – and holding them to the same number meant the card warned for the whole way back.
  A warning that runs for ten minutes straight is one nobody looks at any more, and it was running
  beside the Trupps that still had to be watched. Below the Rückzug line it speaks up again, and
  that says something worth hearing: this crew is taking too long to get out. `alarmBarRueckzug`
  (default 50) per station; set it equal to `alarmBar` and nothing changes. ⚠️ This is **not** the
  second line the 27.07. decision rejected – that one was a «Mindestdruck» under the Alarmdruck on
  the way *in*, and it stays rejected: a crew still working has exactly one turn-back pressure.

- **The name list says which Trupp somebody is in, and «EL» is the current one.** Two people
  called Meier are one Einsatz, not an edge case, and the suggestion list offered both spellings of
  the problem: two identical rows, one of them wrong. The chip now carries what the person is
  doing right now – «Trupp 2», «Sicherungstrupp» – read off the Atemschutz board. That context is
  shown and never inserted and never printed: it answers «which Meier» at the moment of typing and
  stops being true ten minutes later, so it has no business in a record read six months on. The
  role suffix beside it («EL») is the opposite – stable for this Einsatz – and keeps printing.
  «EL» itself used to resolve to whoever the roster sort happened to put on top, so after a
  handover the journal could name a person who handed over an hour ago, on the one post the whole
  Schadenplatz is keyed to. The Bemerkung is stamped when written and the newest holder wins;
  resolved at render time as before, so an Ablösung re-labels the older lines too.

- **Beilagen herunterladen (ZIP), for the digital Ablage.** Photos and recordings left the app one
  at a time and only through the viewer – there was no way to archive an Einsatz's media in
  original quality. The output menu's last row fetches every stored Beilage byte-identical, named
  `foto-01-…` / `audio-01-…` in Aufnahme order, plus a `manifest.json` with a SHA-256 per file so
  an archive copy can be verified against the record years later. Full user session only,
  deliberately **not** on the link-token allowlist: the QR poster contributes media, it does not
  carry the whole Einsatz away. Disabled while uploads are still in flight.

- **The printed Kroki carries a Massstab, and the fit follows the action.** The frame fit let a
  circle's *radius* widen the extent – so the Absperrkreis, the biggest and least informative
  object on the picture, dictated the scale and shrank every symbol, Trupp and Leitung to a fleck.
  A circle now contributes only its centre; the ring may clip, its radius is in the legend either
  way. This changes what the fit **offers** – the chosen WYSIWYG crop is untouched. And the sheet
  gets a Massstabsbalken bottom-left (1/2/2.5/5 ladder, four alternating segments), so it answers
  «wie weit ist das?» without a drawn circle happening to say so.

- **One gesture removes a node, on every line and both surfaces.** Deleting a node was three
  different things: a 500 ms press with no feedback at all on the map, the same press *or* a
  double-tap on the plan, and a right-click on a desktop. Nothing on screen said a delete was
  coming, so the only way to learn the press was to lose a node to it. It is one gesture
  everywhere now – Lage-Zeichnung, Messung, laufender Entwurf, Plan-Zeichnung, Plan-Messung – with
  250 ms of stillness before *anything* appears (a node being moved must never flash red), then
  the app's own detach chip beside the node with a ring that fills to 900 ms. Let go early and
  nothing happened; move past 10 px and it is a drag. ⚠️ The plan's double-tap delete is **gone**:
  iOS does not deliver `dblclick` reliably, the map never had it, and on a dense line a stray
  second tap removed a node with nothing to see it coming.

- **A line can be extended, and «hier könnte einer sein» looks the same everywhere.** The Lage's
  drawings had no midpoint handle at all – inserting meant hitting the line's invisible 18 px band
  with nothing on screen saying that was possible, while Messung and Plan had a «+» for years. All
  three carry it now, **dashed and hollow**: filled blue it read as a node that already exists, so
  a five-segment line looked like an eleven-point one. Extending is new: until now a hose that
  grew had to be drawn a second time and magnetically attached, which produces a second Leitung
  with its own number and its own Trupp link. An arrow grip sits past each open end, pointing the
  way the line runs; dragging it appends one point and the grip moves to the new end. Lines only –
  a Fläche has no end to grow from.

- **Visit and demo-feature counting, off unless `VISIT_STATS=true`.** The landing page produced no
  logs at all and the demo's Railway edge logs are wiped on every deploy, so «does anybody look at
  this, and at which parts» had no answer. Two aggregate tables – no per-hit rows, no cookies, no
  localStorage, no geo, no third party. Uniques come from an HMAC over IP + User-Agent with a salt
  that rotates at midnight and is never stored, so linking two days' records is not something this
  *declines* to do, it is something it **cannot** do; the raw IP is never written or logged. Two
  load-bearing gates: it is **off by default**, because stations run this same image and analytics
  must never be silently on for somebody else's Wehr, and the landing beacon is accepted only from
  the published site's origins. Read with `python -m app.admin_visits` or `GET /api/admin/visits`.
  `PRIVACY.md` documents the whole mechanism.

- **The landing page says «and is it ours», not just «is this for us».** A fire chief reading it
  asks two questions in a row, and the page answered only the first. What happens to our data, and
  what do we owe whom, was buried in the FAQ three sections down, phrased as «Open Source» rather
  than as what that actually buys you. The «Für wen / Für was» band now carries both. Also on the
  page: **Betriebsfeuerwehren** join the named audience – a Werkfeuerwehr runs the same Einsatz
  under the same 3-am constraint – and a Dokumentation item that promised «Partnerorganisationen
  mit eigenem Formular» now describes what the app actually has, namely the Partnerorganisationen
  block on the printed rapport. All four languages.

- **Anwesenheit is undoable.** Its own stack over the synced slice, driven by the same ↶ ↷ as the
  map, with a correction row in the Verlauf naming who moved. On a phone the pair sits in the
  Anwesenheits-Kopfzeile, because the top bar drops it as soon as an Atemschutz chip claims the
  room. A Bemerkung now also survives a row cycled to «frei» and back.

- **The composer knows the posts, the arrows and what this Einsatz has already said.** «EL» and
  «Stv. EL» are vocabulary: written as the post they print the holder («EL (Widmer Céline)»),
  written as the name they print the post – both directions of one fact, matched whole-word, or
  two letters light up inside Melder, Keller and Schnellangriff. «→» and «←» are ordinary
  suggestions, offered while the sentence ends on somebody. On an empty field the start chips are
  «EL →» first, then the phrases this Einsatz has already used, then the station's list; they stay
  until something is actually typed, so a second chip appends to the first. ⚠️ `stripUnprintable`
  was deleting the arrow itself – it sits in the Unicode arrows block that guard strips because
  the Rapport is Helvetica. The app keeps the character; the **paper** gets «->», mapped once
  where the report payload is built.

- **Help covers Anwesenheit, Mittel and Zeitplan.** Three of the seven surfaces had no main
  section at all, including the tap cycle every AdF meets first. All four locales. Alongside it, a
  device preference puts the **word under every rail glyph** for anybody who does not know the
  sixteen icons yet (the expand chevron steps aside while it is on), undo toasts can be flicked or
  ✕'d out of the way, and the Verlauf button carries the open Pendenzen as a colour rather than as
  a badge the Atemschutz chip covered up.

- **A crawler can find the page and read what it is.** `/robots.txt` and `/sitemap.xml` answered
  404; both come out of the build now, from the same `config.json` as the pages, so a fifth
  language shows up in the sitemap by being added once rather than twice. One structured-data
  `@graph` with SoftwareApplication and Organization, assembled in `build.mjs` rather than written
  into the template – `JSON.stringify` keeps it valid JSON where the template's substitution does
  not escape, and one apostrophe in a description would have turned the block into something no
  crawler reads. Deliberately no FAQPage. Six of eight meta descriptions ran past the ~160
  characters a search result shows, the French one at 228; all eight now sit between 124 and 154.

### Changed

- **All four locales are complete, and a half-translated one fails the build.** Every locale is a
  partial overlay deep-merged over German, so a forgotten string never breaks anything – it just
  quietly renders in German, and a Romand crew meets it for the first time during an Einsatz.
  567 strings were missing in English, 867 in French and Italian. All 2 277 are translated now,
  and the gap is a build error rather than a discovery in the field.

- **The Eintrag sheet fits a phone with the keyboard up.** It was capped against the whole screen
  while being lifted by the keyboard, so a tall sheet grew out of the TOP: the mode tabs, the ✕
  and half the line being typed were gone, with no way to scroll to them. It is capped against
  what the keyboard leaves now, nothing inside it shrinks, and the three media buttons drop their
  labels into one strip of icons while typing – so Aufnehmen · Audio · Foto stay on screen
  instead of below a fold, which is exactly when a hand in the field needs them. The sheet also
  lost a good deal of noise: one blue thing («Erfassen»), one gap (8px, sideways and downwards),
  and suggestion words that no longer look like the ART chips they sit above.

- **An audio row in the Verlauf is one row again.** «Durchhören» and «Transkript ergänzen» were
  two full-width buttons that never fitted side by side on a phone, so every voice memo was a
  three-line block with an amber button shouting louder than the entry it belonged to. They are
  icon buttons in the row itself now; the missing-transcript state keeps its amber on the icon's
  frame.

- **The scrubber says one thing.** Its rail carried a coloured dot per audit event – and freehand
  drawing emits one per stroke, so a busy minute was a smear of overlapping circles that could
  neither be read nor aimed at. The rail is now filled where work happened and broken where
  nothing did; what was written gets its own lane.

- **The printed Lage reads like the one on screen.** Held side by side, the Kroki on paper was a
  weaker copy of the live map in three separate ways. It was **soft**: placed about 180 mm wide and
  rendered at 1600 px – 141 dpi, below what a laser printer resolves – so every glyph edge and
  every marker number came out blurrier than the same picture on the tablet. Now ≈183 dpi, which
  enlarges nothing, because `ref_width` scales the drawing rules with the render on purpose. The
  **symbols were small**: the print multiplier eased down to 70 % of the on-screen band, meant to
  stop a close-up crop merging four glyphs into one blob and taking far more than that away – the
  floor is 85 % now, and the numbered markers, which *are* the labels on paper, grew with it. And
  the **legend was far from the picture**: one column of «1 …» ran half the page down for a Lage
  with eight labelled things, squeezing the picture itself and leaving number 8 a hand's width
  from the disc it belongs to. Two columns, directly under the frame. ⚠️ `kroki_symbol_mul` stays
  mirrored in `src/lib/krokiPayload.ts` – if the two drift, the framing modal stops showing what
  the Rapport prints.

- **A line the app repeats says so once, with a count.** An überfällige Kontaktuhr wrote «Trupp X –
  Überfällig» every few seconds and an undo tapped six times wrote six identical rows, so the
  Verlauf and the printed journal filled with the same sentence while nothing happened – which is
  how an Überwacher learns to stop reading them. Two halves: the alarm is recorded once per
  **Turnus** now, the next line owed only after a Funkkontakt has reset the clock; and repeats
  already in the record collapse **for reading**, the first line standing with a «6×» marker on
  screen and on paper. Nothing is hidden – every repeat stays in the append-only record and the
  count is shown rather than swallowed – and hand-written rows are never collapsed: somebody who
  typed it twice meant it twice.

- **An audio row keeps one editor, and its transcript becomes the row.** Every voice memo offered
  two stacked text editors – the transcript field and the wording-correction pen, each with its
  own Abbrechen/Speichern, and neither closed the other. The pen is gone from audio rows: their
  words live in the transcript, and the transcript icon is the one way to write them. Once a
  transcript exists it shows as the row's text, linked names and all, instead of «Audionotiz (4s)»
  plus the same words repeated below. The chip in front of the row now names the **Bereich the
  printed rapport names** – Anwesenheit, Mittel, Atemschutz, Auftrag, Pendenz – instead of saying
  «Lage» on everything the generic logger wrote; only the map surface keeps its on-screen name,
  where the print says «Kroki».

- **Several photos on one entry print side by side.** A journal row with four pictures stacked
  them at the column's full width, so one entry pushed the next a page and a half down – on
  exactly the entry the multi-photo row was built for, since one damage is rarely one picture. Two
  per row up to four, three beyond that; a single picture keeps the full width, because one
  picture is an illustration. The legend under «Aufträge / Pendenzen» is gone with it: it
  explained four things the table already says out loud, and a caption that repeats its own table
  teaches the reader to skip captions.

- **Every inline editor opens with the caret at the end.** Transcript, wording correction, marker
  fix, a rename in the Verwaltung, a Mittel note – all of them got the browser default, caret at
  position 0, inviting typing in front of the words instead of after them.

- **The Erinnern menu counts upward whichever way it opens.** The minute chips were listed 60 → 5
  on the «bottom-up because the popup opens upward» convention, which reads as an unsorted list
  the moment the positioner flips the popup. Ascending always.

- **The landing page shows its hero instead of fading it in.** PageSpeed put the LCP of
  kp-front.ch at ~3.6 s and blamed 3.0 s of that on «element render delay» – the gap between the
  hero picture being downloaded and being painted. The picture was there the whole time; it was
  invisible on purpose, running through a keyframe that starts at opacity 0. A browser does not
  count an element it has not painted, so the whole animation went into the measurement one to
  one. It moves with `transform` only now – same entrance, visible from the first frame. On the
  same critical path: `fetchpriority="high"` on that image, both fonts preloaded (declared inside
  `landing.css`, they were discovered only after it had loaded *and* parsed – a 770 ms chain for
  the two faces the first screen needs), and screenshots in WebP with a second small copy of the
  hero for 1× screens. All ten pictures together went from 1036 to 512 KiB. One JPEG survives
  because it has to: `lage.jpg` is the `og:image`, and link previews still show no WebP.

- **The Arbeitsmappe no longer promises an undo the Mannschaft never had.** Four places said
  «Letzte Änderungen» could undo a workbook import. That is true for the lists and false for the
  crew, which is the headline use case: personnel are rows in their own table, and `keep_previous`
  runs only when a config section actually changed – so an import touching only the Mannschaft
  sheet writes no history row at all. What the copy says instead is what actually limits the
  damage: a person missing from the sheet is **deactivated and never deleted**, so undoing it is a
  re-activation, and the export taken before an import is the file that puts the roster back. The
  one genuinely irreversible edit is a rename of a person carrying a provider identity, which
  drops the stored first/last split – the preview already warns when that would happen. Corrected
  in the in-app Hilfe and the import confirmation (all four locales), `docs/API.md` and
  `docs/CONFIGURATION.md` §9h.

### Removed

- **«An aktueller Kartenmitte anheften» on a journal entry.** It stored the centre of whatever
  happened to be on screen – neither where the author stood nor where the event was – and nothing
  was ever drawn there; the only payoff was that the row could later fly the map back to that
  spot. The question it was really being asked is «wie sah es da aus?», which the Wiedergabe now
  answers properly by scrubbing the whole picture to the moment. Rows written before this keep
  their coordinate and stay clickable.

### Fixed

- **A dispatch system could open an Einsatz with a blank title.** `{"title": "   "}` satisfied
  the minimum-length check on `POST /api/alarms`, so three spaces became a nameless incident on
  the board while KP Rück refused the same body outright. Title, text, address, `source_id` and
  `number` are now trimmed, and an all-whitespace value counts as absent — a dispatch system
  sending one gets told, instead of the operator finding an unnamed Einsatz. Found by the shared
  intake conformance corpus on its first run against this side, which is the entire argument for
  having one.

- **One dispatch payload now really does work against both KP Front and KP Rück.** The two apps
  had converged the *shape* of `POST /api/alarms` and left the *limits* apart, with nothing
  comparing them. `RESERVED_ALARM_SOURCES` claimed in a comment to be the union of both apps'
  internal slugs and was missing `feld`, so a sender calling itself that was accepted here and
  refused there. The portable subset is now pinned as cases in
  `docs/alarm-intake-conformance.json`, byte-identical in kp-rueck, together with the payloads
  the two legitimately answer differently so that list cannot grow unnoticed; kp-rueck's
  `alarm-contract-drift` CI job compares the two copies. See
  [`RUNNING-BOTH.md`](https://github.com/feuerwehr-oberwil/kp-rueck/blob/main/docs/RUNNING-BOTH.md)
  §3 – it lives in the kp-rueck repo, one copy – for the five rules that keep a body portable.

- **The camera never opened from ＋ · Foto on a phone.** Safari opens a file chooser only for an
  input it actually renders, and all three file inputs were `hidden`, so `click()` was a silent
  no-op: the target lit up and nothing happened. This also affected «Foto» and «Audio» inside the
  composer.

- **The Wiedergabe never had the Verlauf at all.** It read it from the reconstructed workspace
  blob, which returns only the frozen legacy echo since the journal moved to its own append-only
  store – empty on every incident created since. So the new lane and caption were blind, and so
  was the *existing* gap detection: a stretch where somebody only wrote entries counted as
  silence and was skipped. The Verlauf is append-only, so the live list is the finished list;
  it is handed in rather than reconstructed.

- **Holding «Eintrag» no longer leaves a recording behind.** The hold offers Sprachnotiz · Foto
  and acts on RELEASE, onto whichever target the finger let go over; the button itself becomes
  the ✕, so releasing where you started cancels the whole gesture. A plain tap settles on the
  click rather than on pointerup, because iOS drops the pointerup often enough that every tap on
  the phone FAB used to resolve as a hold and start recording.

- **The app could be dragged up the screen, and the bottom bar travelled with the keyboard.**
  `overflow: hidden` on the body is a suggestion on iOS – the document still scrolls, which is
  both of those bugs. A body that is itself `position: fixed` has nothing to scroll. What is left
  is iOS panning the *visual* viewport to lift a focused field; the top bar and the nav rail now
  translate back to where they would be with no keyboard at all, and let the keyboard cover what
  it covers, the way a native tab bar does.

- **Typing «sani» offered Schneider Melanie and Wyss Daniel.** Both are subsequence matches –
  every letter present, in order, somewhere – and with a handful of terms in a station's
  vocabulary those coincidences filled all four suggestion slots. What is typed must now begin
  one of the term's words, at every length; the score still ranks what survives, it just no
  longer decides who qualifies.

- **The «Rückmeldung ELZ» chip in the Abschluss-Kontrolle flashed the Einsatzende too**, because
  its marker sat on the grid the two share. A step has to point at the fields that make it go
  away and no others.

- **The connector between two Verlauf entries reached the next one only on single-line rows.** It
  was a fixed 16px stub hanging off the node; an audio entry is twice that tall, so the line
  stopped in mid-air. Each row now draws its own half.

- **`just ci` was missing the only step that parses CSS.** A stray brace in a stylesheet passed a
  fully green local run and would have turned main red – `tsc` and `eslint` never open a
  stylesheet. The landing page's drift check was absent for the same reason.

- **Abschluss und Archivieren deleted the upload queue outright.** Offline at Einsatzende – the
  normal case – that dropped the photos and voice memos the Rapport had just promised to send «bei
  Verbindung». The workspace drains the queue before the handover, so uploads still patch their
  Verlauf rows; what cannot go up is kept for the next open, and both the confirm and the toast
  say so.

- **«Wieder einrücken» replaced a Trupp's readings.** The first deployment's entry pressure and
  every reading taken during it vanished from the Atemschutz page of the Rapport. It appends now;
  `currentRunStart` marks where the running deployment begins, for the Eingangsdruck correction
  and for the card's own log.

- **Deleting a Trupp erased it.** It stamps `removedAt` instead: gone from the board, still on the
  Rapport as «Von Tafel entfernt», and reachable again through «Entfernte Trupps» – so the
  six-second toast is the fast door, not the only one. Trupps that came back keep their slot on
  the board and read grey, and `editTrupp` got the same confirm-with-undo its siblings have.

- **The Lage map re-fitted to the whole incident on every WebGL recovery**, overruling the framing
  `resumeViewState` had just restored – once a minute under memory pressure, which reads as a map
  that zooms itself out. One shot per incident now.

- **An Anwesenheit undo was filed under Atemschutz.** «Anwesenheit zurückgenommen: …» printed
  under the wrong Bereich because the row carried icon `undo`, which is also the
  Atemschutz-Rückzug's, and the Bereich is derived from the icon. New rows carry `people`; the ones
  already in the record are read off the copy template that wrote them, so old rapports classify
  right too.

- **The Atemschutz card's Leitung chip said «Ltg 1» beside a hose tagged «Ltg 3».** The Trupp
  stores a copy of the Leitungsnummer stamped at link time, and renumbering the drawn hose patched
  only the drawing. A renumber from the DrawEditor (Lage or Plan) now syncs the number onto the
  Trupp anchored to that line – matched **by anchor only, never by number**, so «one Leitung = one
  Trupp» holds – and the card reads the drawn hose at render time, so stale copies heal themselves
  while a deleted hose falls back to the stored number. The renumber sync also skipped any Trupp
  that was «raus», which is exactly the card whose chip is still on the board; only a soft-deleted
  card stays untouched now.

- **«Wie gesetzt» reordered itself when a Trupp ran überfällig.** The überfällig float ran before
  the sort-mode branch, so the one mode whose promise is «rows stay where you put them» moved the
  board the moment a Kontakt clock crossed interval + grace, and dropped the row back when the
  Kontakt was booked. In «Wie gesetzt» the red card state does the alarming on its own; the float
  stays in the derived sorts, where the order is recomputed anyway.

- **«überfällig» re-logged itself on every reload.** The severity map lives in a ref, so it starts
  empty on every mount, and a Trupp who was *already* überfällig read as a fresh crossing and got
  another «Atemschutz-Alarm: … Überfällig» line – every reload, every resume from a killed PWA,
  every HMR update, while nothing had happened. A crossing is now one this session actually
  watched, per Trupp rather than one global first-pass flag, because the roster arrives
  asynchronously with the workspace. The tone and the OS notification are deliberately **not**
  gated on this: somebody overdue when the app comes back has to be heard at once. It is only the
  Verlauf line that must not be written twice.

- **Naming a Fläche left one Verlauf row per keystroke.** Typing «Sicherung» into a drawing's label
  wrote eleven rows, eleven audit events and eleven undo steps, on both surfaces – and the Verlauf
  is what the Einsatz is read back from, so a word typed into a text field pushed everything else
  on the screen out of view. The field patches live while typing (silent, one undo checkpoint for
  the whole edit) and writes its row on blur or Enter, saying what the label *is* rather than
  narrating the way there.

- **A Partnerorganisation's remark never reached the record.** An organisation added with its
  remark logged only the arrival, while «avisiert, ETA 20 min» – the operational half – went into
  the Rapport field and nowhere else, so it never reached the Verlauf or the printed journal.
  Both lines are written now, and clearing a remark says so too: the old condition skipped an
  empty new value, so deleting one was the single edit on that block that left no trace at all.

- **A pressure is printed only where somebody measured one.** Kontakt and Rückzug rows carry the
  last value anybody reported, not a reading taken at that moment – the board fills them in so the
  card can show what is known. In the Rapport's pressure column that turned into «300 bar» beside
  a Kontakt twenty minutes after the last real reading: a number that looks measured, on a
  document that gets signed. The column stays empty for those rows now, on paper and on the card's
  log. The value itself is not deleted anywhere.

- **Corrections print their first wording, and a Pendenz says so.** The app promises «Der
  ursprüngliche Wortlaut bleibt im Protokoll», but the PDF printed only the latest wording with no
  mark; a corrected row now prints «korrigiert HH:MM · ursprünglich: ‹…›» as a muted sub-line.
  A Pendenz raised by the ring fell through to «Manuell» in the Bereich column – the branch ran
  before the `entryType` check, so even a typed Auftrag with Erinnerung lost its word – and the
  Erinnerung time appeared nowhere on paper; the column says «Pendenz» now, an Auftrag stays
  «Auftrag», and the Aufträge/Pendenzen section prints «fällig HH:MM» under «Was». And one rescued
  person is «1 Person», not «1 Personen».

- **The Stand slider lost its barcode.** Two decays at once: the moments were read from a
  *replayed* workspace's timeline, which reconstructs as empty since the Verlauf moved out of the
  blob into the row store, and the read happened once, when the panel became visible, capturing
  the journal rows before they had loaded. The journal moments are derived reactively from the
  live timeline now – the same rows the Verlauf's own strip ticks. The ticks also read like that
  strip rather than like decoration: one 1.5 px tick per recorded moment at its exact position,
  instead of half-percent quantisation over a hairline ruler.

- **An audio row's text wrapped one character per line.** On a phone the entry line carries its
  chips, its text and three trailing buttons, which left the text about 26 px – and with
  `overflow-wrap: anywhere` its min-content width is one character, while `min-width: 0` removed
  the automatic minimum that would have protected it. «Audionotiz (6s)» came out as fourteen lines
  of one letter each. The row wraps now: the text drops under the chips and uses the full width
  when it cannot sit beside them.

- **The Pendenzen ring asked a different question depending on how the sheet was opened.** The ○
  switch was hidden while writing a Meldung and the same choices lived on the header link instead,
  so the control moved from the bottom of the sheet to the top and re-targeting a Meldung meant
  reaching for the other end of the card. The ring stays in both modes now and carries that mode's
  rows, including «Neue Pendenz» and «Dringende Pendenz» in the same places they sit everywhere
  else – both of which unlink on the way, since a draft still carrying the link would have filed
  the line as a Meldung and dropped the choice without saying so. The header line goes back to
  being a label. Two pieces of polish with it: the menu's pinned rows keep the list's own 44 px
  pitch instead of standing 4 px looser, and no separator is drawn above the topmost pinned row
  when nothing precedes it.

- **The audio player claimed to be offline in dev.** StrictMode's double-mount ran the sheet's
  audio effect cleanup between the two mounts, and the cleanup set `a.src = ''`, which makes a
  media element fire `error` while `onerror` was still attached – so the first, throwaway mount
  latched errored and the healthy second mount could not clear it. Handlers are detached before
  teardown now, and the flag resets per row. Production builds never double-mount, which is why
  the iPad never showed this.

- **`just dev` answered «Falsche PIN» for every PIN.** PINs are bcrypt over an HMAC peppered with
  `SECRET_KEY`, and the recipe started uvicorn from `backend/` where no `.env` exists –
  pydantic-settings found nothing and minted a throwaway key per boot. The recipe passes exactly
  that one variable from the root `.env` into the server. Only that one: the rest of the file is
  the docker deployment's config and has no business in a dev server. ⚠️ A `backend/.env` symlink
  would fix logins too, but it silently feeds a key to every process started from `backend/`,
  including the CLI tests that assert the no-key notice.

- **The media archive endpoint blocked the event loop while it built.** An archive of hour-long
  recordings must not stall every other request while it is written; the ZIP build moved into
  `asyncio.to_thread`.

## [0.6.0] – 2026-08-12

### Added

- **The landing page speaks French, and it is generated rather than written twice.**
  `site/index.html` used to be the page; it is now the *output* of `site/index.template.html`
  plus one text file per language (`site/content/de.json`, `fr.json`). German is the base and
  every other language is laid over it – the same overlay mechanism as `src/config/copy/` – so a
  translation writes only what it translates, a gap falls back to German *visibly*, and
  `build.mjs` prints the coverage after every run. A third language is one entry in
  `content/config.json` and one file in `content/`; the template does not change. The switcher is
  two plain text links (no flags, no dropdown, no cookie, and deliberately **no
  `Accept-Language` redirect** – a German-speaking firefighter sent to `/fr/` by a browser
  setting is worse than a switcher he can see), with `hreflang` alternates both ways and a
  per-language `canonical`. The duplicate-per-language alternative was cheaper today and drifts
  on every design change – and `landing.css` is byte-identical across kp-front and kp-rueck, so
  drift would cost twice.
  ⚠️ **The built pages are committed**, because GitHub Pages serves `site/` verbatim: the page in
  the repo *is* the page on the web. `node site/build.mjs --check` runs in CI so a stale build
  fails loudly instead of silently serving yesterday's text.
  ⚠️ **The French page carries a visible line saying no French-speaking firefighter has read it
  yet.** It is not decoration – it comes off when somebody has. Screenshots stay German on every
  language: they come from a real instance, and restaged ones would be a claim rather than a
  proof. The page says that too.

- **The landing page names what shipped since it was last written** – Zeitreise (replaying an
  incident minute by minute, waits skipped), Standort teilen, a Schlauchleitung belonging to a
  Trupp, Truppfarben, Partnerorganisationen, photos as Rapport-Beilagen, and the Kroki as of a
  chosen moment. Plus an eighth step in the night's timeline: the debrief, which is the only
  place Zeitreise is actually used.

- **Every name in a Verlaufszeile links itself.** The «Von» field is gone – it asked for
  something the sentence already says, and it only ever knew people. In its place one
  vocabulary: crew, Mittel, Partnerorganisationen, Fahrzeuge and Alarmgruppen, matched against
  the line as it is typed, longest match first so «Meier Anna» wins over «Meier». Matches are
  tinted per kind in the composer, in the Verlauf, and – via a markup field on the row – in the
  printed Rapport. Suggestions start at **two** letters instead of three, but at exactly two only
  a word start counts: two letters of fuzzy subsequence would put half the Mannschaft under every
  «im» somebody types.

- **A locked roster row points at the Trupp that locks it.** Tapping somebody who is under PA used
  to open the Atemschutzüberwachung and leave the finding to whoever tapped – on a page of cards
  the Trupp they were sent to was often off-screen, so «why can I not tick this person» was still
  a search. The row carries the Trupp id now: the card scrolls itself into view and flashes a
  ring. The ring is **ink**, not a status colour – every hue on that card already means something
  (blau angemeldet, grün aktiv, amber Rückzug, rot überfällig), so a blue ring around a blue card
  said «angemeldet» twice and «look here» not at all.

- **A plan entry can pin its own bytes, and the deployment can insist on it.**
  `objects.manifest.json` accepts a `sha256` per plan; where it is set,
  `admin_objects validate|load|push` refuse to publish anything else under that module. That
  half runs in the publishing tree, so it only ever catches a *current* manifest beside a stale
  PDF – see **Fixed** below for the half that does not. The half that holds is server-side:
  `admin_objects push` now declares every plan's digest to the API, `PUT /api/objects/{id}/plans/{module}`
  verifies any digest it is given on **every** deployment, and `REQUIRE_PLAN_DIGEST` makes one
  *mandatory* for an automated publish – on automatically for the public demo, off for a station
  so an older CLI keeps working. A person picking a PDF in the admin UI is never asked for one:
  they have no tree to be stale. ⚠️ These are *wrong-tree* checks, not corruption checks.

- **Every search box forgives an umlaut and one typo.** `lib/search` is now the single decision
  about what a typed query finds, and every list that had its own substring test uses it:
  Anwesenheit, both person fields, the Trupp form, the shared Combo, «Standort teilen», the symbol
  palette, the Plan-Picker, the Datenquellen list. Umlauts match in *either* direction («Mueller»
  finds Müller and «Müller» finds Mueller, because both sides are folded the same way), accents
  fold away («Celine» finds Céline), and one wrong, missing, extra or swapped letter still finds
  the name — from four characters up, and only at a word start. Below that, one edit matches half
  the Mannschaft, which is worse than no match at all.

- **A name typed anywhere is somebody who was there.** Typing a name is how a Gast, a Nachbarwehr
  or an AdF whose roster row never synced gets onto an Einsatz — and only two surfaces recorded
  one. Everywhere else the name stopped on the object it was typed onto: a Fahrer on a vehicle, a
  «Stv.» on the Einsatzleiter glyph, the Einsatzleiter on the Rapport. So an Einsatz could be led
  by somebody the Anwesenheit had never heard of, and the Personalblatt printed from it is also
  the Soldblatt. Every person field now files the name under an id — the roster's if it names one
  of ours, a fresh Gast's otherwise — and a Gast gets the job («Fahrer TLF») in the same act, on
  one row, in one Verlaufszeile.
  ⚠️ The free-type escape in a dropdown commits when the field is LEFT, not per keystroke.
  «Muster Felix» typed letter by letter would otherwise have put thirteen people on the list.

- **«Trupp finden» — one list of every Trupp standing anywhere.** Lage markers and plan chips,
  Atemschutz or not; tapping a row goes there. The Atemschutz card could already jump to its own
  Trupp, but only to that one: a team marker dropped straight onto the Lage, or a chip on a
  Gebäude storey, was reachable only by remembering which surface it went onto and then finding it
  among the symbols. It searches the PEOPLE in a Trupp too — you know who went in, not which
  number they were given — and lives on the Trupp tool's own dock, because reaching for that tool
  is already the gesture for «etwas mit einem Trupp».

- **The Einsatzleiter symbol is a pair, with a handover.** Its two rows read «EL» and «Stv. EL»
  instead of «Name» and «Stv.» — the value on one row and the job on the other never read as the
  two halves of one job — and a ⇄ between them swaps the two in one commit, which re-files both
  people through the same path a normal edit takes. The stored keys are unchanged, so the Kroki,
  the map caption and every Bemerkung keep reading exactly as they did.

- **Every replaced station config is kept, and can be put back.** Each write to
  `deployment_config` now stores the document it replaces, with when and by what (api / cli /
  branding); `admin_config history` lists them and `restore <id>` puts one back — and the restore
  is kept too, so stepping back is reversible. This is the part that matters for a real station:
  the demo can be repaired by re-running its reset, and Oberwil cannot — there is no seed file to
  rebuild a station from, and until now a bad write was simply permanent. `admin_config load`
  additionally exits 2 rather than emptying a section that currently has content.

- **An archived Einsatz can be deleted — by an admin, from the Verwaltung.** A real Einsatz was
  undeletable by anybody, so a duplicate created when two people took the same alarm sat in the
  Verlauf and in the statistics forever. Two doors, because they answer different questions:
  an **Übung** is deletable by any editor at any time (it exists to be thrown away), a **real
  Einsatz** takes an admin session and has to be **archived** first.
  ⚠️ Archived is the gate, not a nicety: it is the operator saying the Einsatz is over, and the
  only moment at which «löschen» is a decision rather than an accident. Deleting one destroys an
  Einsatzakte — Verlauf, hash-chained Prüfkette, Anwesenheit, photos, voice memos.

- **`POST /api/alarms` accepts KP Rück's payload.** The endpoint exists in both apps with the same
  path and the same purpose and took incompatible bodies: `source_id` was required here and
  optional there, so a relay written against KP Rück got a 422. It is optional here too now —
  without it there is nothing to dedupe on, so a redelivery creates a second incident, which is
  the sender's trade to make. `number` is declared and ignored (an Einsatz here has no field for
  it), so it appears in the OpenAPI contract instead of being dropped silently.

- **A symbol knows which material it is, where it came from, and says so where you look.** The
  symbol→Mittel capture was a guess delivered in a toast: missed constantly, and gone for good
  once it timed out. It is a row in the symbol's own detail panel now — it cannot time out, and it
  is still there ten minutes later when you remember. A catalogue entry may name the variant it
  is (`when: {Typ: "Exhauster"}`, or a LIST of clauses, any one of which matching is enough),
  because one symbol is routinely several materials: a station has Lüfter, Hochleistungslüfter and
  Exhauster and exactly one «VKF Luefter mobil» to place. A Lüfter set to *saugen* is an
  Exhauster whatever its Typ says, so the airflow reads as a pseudo-field.

- **A person's Bemerkung collects every job they held.** The Offizier symbol forwards its
  «Funktion» («SiBe», «Lüften») onto the person's Anwesenheits-Zeile, correcting that Funktion
  re-files them, and being in a Trupp writes «AS» — the same fact the Trupp picker already stated
  in the other direction. The Personalblatt could not tell an AdF who stood at the Magazin from
  one who was under Atemschutz.

- **Tauchpumpe and Wassersauger**, the two pumps FKS has no sign for, drawn in the house pack —
  plus kit that is carried inside can now name the storey it is on, and the storeys, counts and
  capacities that were missing from other symbols.

- **The demo is a configured station**, not a bare one: Dienstgrade, Symbolfeld-Listen, a second
  finished Einsatz, a station mark, and a Trupp made of roster rows rather than of typed names.

### Changed

- **«Trupp anlegen» asks in the order it is answered.** Who goes in and with how much air come
  first; Art, Auftrag/Ziel, Leitung, Farbe and Kanal follow. The Auftrag no longer blocks
  «Trupp anmelden» – a Trupp standing at the door must not wait on a field it can be given a tap
  later – so the card shows a dashed **«Auftrag offen»** chip until it has one, and tapping that
  chip opens the form. The gap is visible instead of silent. Three slots are drawn at rest (GF +
  2) and a bigger Trupp simply grows the box; Druck and Kanal use a smaller stepper, because they
  are set once, bare-handed, before anybody is under PA. Measured at 1024×768 the whole form
  stands without scrolling, with room left for the drawn-Leitung chips to wrap. On a phone it is
  a full-height sheet rather than a centred box ~180px shorter than the screen.

- **A Gast under PA is one person, not two.** A hand-typed name now keeps the id the Anwesenheit
  files them under, so the roster row locks and wears the PA badge and the picker says «in einem
  Trupp». Added by name alone they were two unrelated records that happened to read alike.

- **The Ort on a roster row is a glyph.** Spelling «Vor Ort» / «Magazin» out cost ~60px of every
  row – enough that «Baumann Michael» truncated. Haus + blau for the Magazin, Pin + ink for the
  Einsatzort, both glyphs named in the legend beside the three status dots, where the blue
  «Bemerkung» dot is now named too. The counts get a full-width row of their own, and the QR
  read-out a quieter one under them: sharing the title line with the view tabs left them ~250px,
  which is five stacked lines on a 700px panel and an ellipsis on a phone.

- **«AS», not «PA», everywhere it is written.** PA is the Pressluftatmer — the device. What the
  badge, the picker hint and the Bemerkung say is that somebody is under *Atemschutz*, which is
  the doctrine word, the name of the board and the name of the surface. One thing, one
  abbreviation.

- **The Alarmquelle is named only where there is one, and only by its own name.** Copy that said
  «Divera» on installations that do not run it, or named the source where the source is irrelevant,
  now says neither.

- **The symbol's detail rows are a label and a value, with nothing announced over them.** The
  section titles and rules above them claimed a different KIND of thing started there; of 81
  symbols, 30 carry no such row at all and exactly one carries four. The panel header names the
  symbol, so the name is not also a field inside it.

- **A Gebäude is oriented by its WALLS, not by its bounding box.** The floor stack asked whether
  the rotated bounding box is nearly square — a page-fit question — and an L- or U-shaped
  building answers «yes» while its walls run unmistakably in one direction. The Schloss on the
  demo stood tilted 21°, corners into the sheet, because its min-area box measures 0.98 high by
  wide. It now rotates whenever one direction family holds at least half the wall length (mod 90°,
  since the four walls of a rectangle are one family), stays north-up when no direction dominates
  — a round tank, a scattered outline — and takes the SMALLER of the two turns that square the
  walls, so the sheets stay as close to the Lage's orientation as squaring allows.
  ⚠️ `orientDeg` is stored per building, so nothing already placed moves.

### Fixed

- **⚠️ The public demo served generated placeholder Objektpläne again – twice on 09.08., and the
  second time the manifest pin did not stop it.** It had shipped drawn Modul 1 and 2-3 sheets
  since 07.08. and retired its Modul 6 on 08.08.; both times all three came back – the
  placeholders *and* the retired module. Nothing failed and nothing was logged: `admin_objects
  push` publishes whatever PDFs the tree it runs in happens to hold.

  The first diagnosis, written here that afternoon, blamed the nightly workflow for checking out
  a stale tree. **That was wrong**, and worth recording as wrong: the 08.08. scheduled run
  checked out `c72f9b3`, whose tree already held the drawn sheets (594'110 / 211'100 bytes) and
  no Modul 6 at all. Both regressions came from **outside CI** – somebody ran
  `scripts/demo-reset.sh` against the live demo from an old local checkout, the second time from
  one at `v0.1.0`. That reset restores *everything* the tree holds, so July's `config.json` came
  back with the plans: `helpIntro`, the map centre, `4104 Musterdorf`, and a brandmark reset to
  none.

  The `sha256` a plan may pin cannot catch this, and it is worth being precise about why: an old
  checkout carries an old manifest **and** an old `admin_objects`, so both the digest and the
  code that would check it are absent together. A guard that ships in the artifact it is guarding
  can only catch a *partially* stale tree. The one participant in a publish that is never stale
  is the server, so that is where the refusal moved: `PUT /api/objects/{id}/plans/{module}` takes
  a `sha256` and verifies it everywhere, and under `REQUIRE_PLAN_DIGEST` – on by default for the
  public demo, and derived from `DEMO_RESET_CRON` rather than from `demoMode`, which the bad
  publish overwrites – an automated publish that declares *nothing* is refused outright. A client
  that cannot name its own bytes is by construction older than the check.

  Two smaller doors closed with it: `scripts/demo-reset.sh` now states which commit it is before
  it touches anything (HEAD must equal `origin/main`, `examples/demo-data` must be clean,
  `KP_DEMO_RESET_ALLOW_STALE=1` to override) – checked *before* the wipe, so a refusal really is
  "nothing happened" – and the workflow checks out `ref: main` explicitly instead of the SHA the
  cron happened to queue from.

- **The Kroki preview drew hoch symbols 1.6× too small.** The crop scales every decorated marker
  by `previewWidth / PRINT_REF_WIDTH` so what stands on the screen is what lands on the sheet, but
  one reference is not enough: the Kroki renders at 1600×940 quer and 1000×1400 hoch, and a symbol
  is sized in *absolute* pixels on that canvas. The same 40px symbol is 2.5 % of a landscape sheet
  and 4 % of a portrait one. Measured after: quer 3.20 % of the crop's width, hoch 5.12 %.

- **A roster column could paint over the one beside it.** `min-height: 0` on both columns of the
  Trupp form was permission to be squeezed below their own content – which is what lets the crew
  list fill the leftover room, and which a grid row does not scroll but *overdraws*. Stacked on a
  phone that put the whole roster straight through Eingangsdruck and Funkkanal. The permission
  belongs to the Trupp column alone, and on a phone to neither.

- **The Erfassungs-Poster's search bar hung outside its card**, and named three tap states where
  there are four. The sticky band undoes the card padding with negative margins while a
  `max-width` capped its width, so it sat 14px past the list on the left and 14px short on the
  right; the field itself carried the band's own colour and read as a white bar rather than a
  field. The ⓘ now says «nicht anwesend → Magazin → Vor Ort → gegangen», in all four locales.

- **The Atemschutz page of the Rapport sized its label column per Trupp**, so a block carrying
  «Auftrag / Ziel» put its values ~14mm in while the next – «AdF 1» and nothing else – put them
  ~8mm in. Every block started at a different x and the pressure logs stepped in and out with
  them. Widest label on the page wins, for all of them.

- **The roster grid was off-centre in its own panel.** `scrollbar-gutter: stable` reserves the
  scrollbar's width *inside* the padding box, so on the ordinary short list the rows sat 22px from
  the left edge and 33px from the right – an empty strip nothing explained.

- **⚠️ A stale Verwaltung tab could revert the whole station, and did — three times.**
  `deployment_config` has no partial writes: the Verwaltung, both CLIs and the backup importer all
  replace the complete document, and the Verwaltung AUTOSAVES a debounced full-document PUT of a
  client-side draft. So a tab holding an older draft won by default. On 11.08. the public demo
  lost `identity.assets` (both logos), `roster.ranks`, ALL of `doctrine` — including `alarmBar`,
  the Atemschutz turn-back pressure — `report.partnerOrgs` and the point on «Stk.» in one write,
  hours after a reset had reported every step OK. It surfaces as unrelated features quietly
  switching off, never as an error, which is why a missing logo was diagnosed as a script-ordering
  problem three times. Three layers now: the branding slots are **server-owned** (written by the
  upload endpoints, never by the document the UI replaces); a write must carry **`If-Match`** with
  the version it read or it is refused with **428**; and because the tab that does the damage is
  by definition an OLD one that sends no header, a request that a browser fingerprint identifies
  (`Sec-Fetch-Site`, `Origin`) is refused *without* one, while a CLI push is not.

- **A storey badge you can read on the symbol that carries one.** The signed floor (+1, −2) was
  printed in the SYMBOL's own colour on a white chip — so on a yellow BMA it was yellow on white,
  on the one badge whose whole job is to be read at a glance. Ink on the surface colour now, in
  the app and in the printed Kroki, where it matters more because nobody can zoom in on paper.

- **The delete on an Atemschutz card is no longer cut in half.** Six actions need 264px of buttons
  and the card's minimum column was 270px, so the last one — the delete — was pushed past the
  card's rounded edge and clipped by its overflow, reading as a control the card was not offering.
  The column minimum is 288px, the smallest width that keeps the row whole and still under the
  300px that once cost a landscape tablet its third card.

- **The action on a red toast stops turning white on hover.** It carries `.btn`, whose `:hover`
  paints the light surface colour — a white block on the red «Sync-Fehler» pill with the near-white
  label vanishing into it.

- **«Wohin platzieren?» fits its two rows.** It borrowed the Trupp form's fixed 760px height, so a
  picker whose whole content is a title and two options stood as a column of empty glass.

- **Textbausteine complete mid-sentence**, not only when the line starts with one.

- **The Kroki legend lists only what the picture actually shows**, and its crop follows the Lage.

- **⚠️ EL and Stv. EL replace each other on a person's Bemerkung.** They share no leading word, so
  the merge rule appended rather than replaced and whoever stepped back read as «Einsatzleiter,
  Stv. Einsatzleiter» — an Anwesenheitsliste claiming somebody is both, on the row the Rapport
  quotes. Reachable before the ⇄ existed, by moving a name between the two fields by hand.

- **The demo shows the building that is actually there.** Its floor stack carried a hand-made
  symmetric cross while the «Umrisse» sheet beside it drew the real neighbourhood from
  OpenStreetMap — the same Einsatz showing two different buildings at one address. It now carries
  the real 39-vertex footprint, generated through the app's own maths rather than by hand. The
  BMA-Fehlalarm moved onto a real building too, instead of an empty patch of ground.

- **Nothing in a panel scrolls sideways**, on a phone or anywhere else, and the whole header of a
  sheet drags it rather than a grip somewhere in it.

- **A Trupp that carries only names is still a Trupp** — every surface that answers «who is
  already committed» from ids was blind to one, so its Anwesenheits-Zeile did not lock and the
  Fahrer picker said nothing about somebody under Atemschutz.

- **The Rapport**: no Kroki without a Lage and portrait by default; the Kontaktperson is its own
  requirement with its own target; the Verlauf says what CHANGED rather than which field was
  touched; a Trupp that never went under PA did not come out of anything.

- **The 10.08. testing round** — one dot per card, a warning that goes somewhere, and the
  landing page's French follow-ups (it reads as French now, and the switcher works off
  kp-front.ch).

## [0.5.0] – 2026-08-08

### Added

- **The rapport prints the number WinFAP actually joins on.** «Einsatz-Nr» sits in the details
  box beside the Alarmierung: the alerting system's own reference for the alarm, short form (its
  first four hex) first because that is what gets typed, the full reference behind it so the slip
  in the hand and the sheet on the desk can be checked against each other. It is the same value
  `/api/stats/incidents` exports as `alarm_ref`, resolved **server-side** in
  `compose_report_from_payload` rather than sent by the client, so a rapport printed from a stale
  tab cannot put a different number on paper from the one the exporter sends. A missing reference
  prints no row rather than an empty label, because an empty label invites a guess. The
  «Einsatz-ID» left the footer with it – this app's own incident UUID joins nothing, and two
  number-ish things on one sheet is how the wrong one ends up in the record system. ⚠️ It is an
  address key, not an incident key: 52.9 % of Einsätze share it with another, so it removes the
  address disagreement from the ±3 h join – it does not replace the join. See
  [`docs/STATS-EXPORT.md`](docs/STATS-EXPORT.md).

- **A half-typed entry survives leaving the surface.** Every «… erfassen» form lives on a
  surface, and surfaces unmount when another is chosen in the rail – start recording a Mittel,
  the radio goes, jump to the Verlauf, come back, and the half-filled form was gone with nothing
  said. Drafts are kept outside the component that owns them, dropped on submit but **not** on
  cancel («weg» and «ich mache gleich weiter» look identical from inside a form, and losing the
  entry is the more expensive mistake), and dropped wholesale when the incident changes so the
  next Einsatz can never be handed the previous one's entry.

- **A measured segment carries a «+» in its middle.** The Plan has had one per segment for as
  long as it has been able to measure; the Lage map only let a point be inserted by tapping the
  line itself, which is a 2.5px dashed stroke to aim a gloved finger at. Both surfaces now offer
  the same handle in the same place, on the same segments – an area's closing edge included – so
  a node lands between two others without the aim. Tapping the line still works and inserts at
  exactly the same index; the two routes read one rule rather than each keeping its own copy.

  The dock's «Punkt in der Mitte setzen» went with it. It solved the same aiming problem by
  moving the map under a fixed centre, but it could only ever APPEND – the correction actually
  needed mid-measurement is a point *between* two others, and a dock button that looks like it
  places a point but never puts one where you are looking is the worse kind of almost-right.

### Changed

- **`app.css` is a manifest, not a stylesheet.** It had reached 5'480 lines — 56 % larger than
  when it was first written down as the biggest obstacle for anyone working in this repo — and
  the global styles now live in `src/styles/NN-*.css`: tokens, base, map, one file per surface.
  Nothing about the rendered page changed, and that is checked rather than asserted: every line
  lands in exactly one part, in order, and the emitted CSS bundle came out identical down to its
  content hash (the same hash the running demo was already serving). The numbering **is** the
  cascade — `20-touch-floors.css` is last because its `(pointer: coarse)` targets have to beat
  every surface above it, so a new block goes where it belongs and gets renumbered, rather than
  being appended for tidiness. For self-hosters this changes nothing; for anyone editing the app
  it is the difference between searching one 5'000-line file and opening the right one.

  The same treatment started on `Whiteboard.tsx`, which had grown the other way (1'650 → 2'516):
  Plan-Maßstab and Messen moved out whole into `usePlanMeasure`, together with the two prompt
  surfaces that were sitting 1'800 lines away from the state they read. The rest of that file is
  still one component and still too big.

- **The Einsatzrapport is a surface, not a sheet.** It sits in the left rail under Material (key
  `R`) and behaves like Anwesenheit and Mittel: the rail stays put and the page changes under it.
  It is filled in ACROSS an Einsatz – a sentence here, a time there, jump to Anwesenheit because
  somebody arrived, come back – which a modal was the wrong shape for, and choosing the Kroki
  crop used to put the operator two dialogs deep on the one screen that has to stay legible at
  3am. From 1080px up it splits into the form you TYPE on the left and the round-up you TICK OFF
  on the right; the DOM order is untouched, because it is the printed order and tests pin it.
  There is no ✕ and no «Abbrechen» – a page is left by choosing another surface.

- **«Abschnitte» moved onto the print button.** What goes on the paper is several decisions in a
  row, and a dialog to open, tick and close for each one was the long way round something done
  while looking at the button that prints. They are checkbox rows in the menu on the `▾` half of
  «Einsatzrapport (PDF)» now, under a heading that names them, and the menu stays open as they
  are flipped. Printing prints; the picker is there for the rare sheet that leaves something out.

- **The readiness chip appears only when something is wrong.** A green «Alles bereit» spent a
  control on the most contested row of the surface to announce that nothing had happened, and
  taught the eye to skip exactly the spot a warning appears in. What is still missing is named as
  chips under the title instead – and «noch offen» now includes the Rückmeldung ELZ, which needs
  both halves: a name with no time does not say when it was given, a time with no name does not
  say who gave it.

- **The surface shortcuts are the first letter of the German word.** `K` Karte · `C` Checkliste ·
  `A` Atemschutz · `P` Personal · `M` Material · `R` Rapport. The old set had grown one letter at
  a time – `H` for Checkliste, `W` for Anwesenheit, `I` for Mittel – and not one of the three
  could be derived from anything. Taking `C`/`P`/`M` displaced three tools, which follow the same
  rule rather than landing on whatever was free: Lasso → `W` (Wählen), Absperrkreis → `U`
  (Umkreis, which is what it draws), Koordinaten → `X`. Surfaces resolve before tools, so a
  letter claimed for a surface silently swallows a tool – the three moved in the same change.

- **The Einsatzobjekt sits with its plans.** It decides WHICH plans load, so it belongs on the
  Plan surface rather than in the incident menu. The chip joined the Maßstab in the stage's
  bottom-left corner and reads the **address**: «Mühlemattstrasse 8» is shorter than «Schloss
  Bottmingen» and is what an Einsatz is actually called by. The name stays the label in the
  picker, which is where an object is searched for.

- **Overlays are one design system.** The confirm card and the Atemschutz Trupp modal were flat
  `--surface` with their own radius while seventeen sheets are `--glass` at `--r-hero`, so a
  confirm opening over a sheet was visibly a different colour of card. `.btn` – the dense
  map-dock button – was being used inside dialogs, where `.ip-btn` is the house family. And
  `--mono`, which is for figures, had spread to micro-labels, so one sheet set every label in
  Spline Sans Mono while the dialog beside it set the same label in Sora. Destructive confirms
  take the outline danger rather than a solid red fill, which is what every other delete in the
  app wears. Every «… erfassen» is a modal, including Mittel: one that behaved differently was
  worse than either pattern applied everywhere.

- **The demo seed is the demo as it was arranged, not as it was first written.** The command
  picture had been rearranged on the live demo and would have been thrown away at the next
  nightly reset: five symbols moved (the Rettung onto floor 1, the Lüfter turned 111° → 23°), the
  Angriffsleitung reshaped, and the two Atemschutz-Trupps' Aufträge swapped — Trupp 1 löscht, Trupp
  2 rettet, with the Ziele shortened to what actually fits a card («2. OG», «Rettung 2OG») and
  Trupp 2 left without a Leitungs-Nummer, so the demo shows both sides of the hose↔Trupp link at
  once. The scene keys were captured into `incident.workspace.json`; the Trupps had to go into
  `build_demo_workspace` instead, because their clocks are rebuilt relative to each reset and a
  frozen timestamp in the data file is exactly what that code exists to avoid.

- **Messen works on the demo's plans without calibrating first.** The reset now seeds a STATION
  plan calibration (`deployment_config.plan_scales_json`) — Modul 1 against a 100 m reference,
  plus the generated Gebäude floor-stack. Station-level rather than a `planScale` in the scene
  file on purpose: a per-incident calibration overrides the station one, so seeding it in the
  scene would have left every incident except the seeded one uncalibrated. `admin_config load`
  only writes `config_json`, so the reset script's step 2 cannot wipe what step 1 puts there.

### Removed

- **The demo's Modul 6 is gone, and the plan generator with it.** The Schloss ships a hand-drawn
  Modul 1 and Modul 2-3; Modul 6 was the last generated placeholder and never got a drawn
  replacement, so the demo now shows two real sheets instead of two real ones and a filler. The
  `modul6` slot itself is untouched – it is a module preset every station can fill, and the app
  still places a Trupp there when an object has no building footprint; this object simply has no
  sheet for it. `gen_plans.py` went with it: once Modul 6 was out, the only thing the script could
  still do was overwrite the two hand-drawn PDFs with generated ones, and the demo-data README was
  pointing at it as the way to «regenerate» them. `gen_water.py` stays – the water GeoJSON really
  is generated.

  ⚠️ A plan can be added to a running deployment but never removed: there is no `DELETE` for
  `/api/objects/{id}/plans/{module}`, no CLI subcommand, and neither `admin_objects load` nor
  `push` prunes what the manifest no longer lists. The demo escapes this only because its full
  reset drops every `ObjectSite` first, so the re-pushed manifest is authoritative. A station that
  retires a Modul currently has to reach into the database.

### Fixed

- **A measured Strecke was shaded like a Fläche.** The measure fill layer took every geometry it
  was given, and a fill layer closes a LineString into a ring – so a route that bent back on
  itself came out tinted, which on the one tool whose two modes are «Strecke» and «Fläche» reads
  as the wrong mode being active. It now filters to Polygon, the guard the in-progress draft
  layer beside it has carried all along.

- **Correcting the Einsatzdaten wrote eight fields every time.** `started_at` was the expensive
  one: it round-trips through a formatter that drops seconds, and the backend stamps
  `started_at_source = "manual"` for any `started_at` it receives — so fixing a typo in the
  address rounded a 03:14:37 alarm to 03:14:00 and told the statistics consumer, whose only use
  for that field is «did a human assert this», that one had. Edits diff against what the incident
  looked like when the panel opened. With it: the ✕ that clears the location did nothing (an
  omitted key is not written), a failed Meldungstext fetch enabled the save that blanks it,
  clearing the Stichwort renamed the Einsatz to its address, the address menu never closed so the
  next tap rewrote the location, and «Speichern» sat below the fold because the action row was
  inside the scrolling body — which `Modal` gave no way to avoid, for any of its consumers.

- **A guest, once added, could not be removed.** Two independent bugs shut both routes at once,
  quietly. The row's third tap deliberately refuses to cycle a guest back to «frei», because for
  a hand-added person that attendance entry is the ONLY record they were ever here. And the
  Zeiten sheet, which is where «Person entfernen» lives, looked its person up in the roster
  alone, found nobody and silently did not open.

- **Opening the print menu took the app down.** The heading added above «Abschnitte» rendered a
  bare group label, which reads the id it has to announce out of a group context and throws when
  there is none. A heading opens a real group now, and a rule divides one rather than ending it –
  otherwise «Abschnitte» would have named only the three ticks above the first rule.

- **The confirm dialog ignored a tap beside it.** Clicking the backdrop did nothing, on the
  reasoning that a destructive confirm should not be dismissable by accident. But the only thing
  a backdrop click can do is resolve *false* – it can never confirm – so the worst it buys is
  pressing the button again, while a modal that does not answer the gesture every other overlay
  answers reads as a frozen app.

- **«Noch offen: Abschluss. Trotzdem abschliessen?»** The step checked the Kurzbericht but was
  named after the section it sits in, so the confirm named the button that had just been pressed.
  A step names the field it wants filled in.

- **The printed roster listed a person once per shift.** Somebody who left and came back appeared
  twice, counted twice by anyone reading down the column – and the sheet answers «who was here»,
  where a name is a person, not a shift. One row now, the stretches stacked in the time column,
  the remark printed once because it belongs to the person. The tick box is a fixed 4 mm square
  whatever the row does, and the two clocks sit in three fixed columns so every dash lands on one
  `x` – as one proportional string they drifted, because Helvetica's underscore is narrower than
  its digits. The blank write-in rows stopped printing phantom `__:__` clocks, and the stubs
  carry a date once any row on the sheet does.

- **The Visum had nowhere to sign, and then two rules at two heights.** The rule was drawn on the
  text baseline, so it underlined the name. Dropping it a writing height below the row fixed that
  and broke the row instead: «Ort, Datum: ____» and «Einsatzleiter: Anna Meier ____» each carried
  a rule at a different `y`, and the lower one sat nearer the NEXT row's label than the name it
  belonged to. The rule is on the row's own line now and starts where the name ends – signing
  happens beside the name, not under it.

- **The printed sheet's columns disagreed with each other.** Headings reserved 26 mm with a
  `CondPageBreak` that could not work – the reserve is measured before the heading is laid out –
  so «Partnerorganisationen» printed as the last thing on page 1 with every one of its rows on
  page 2. Personal and Material each subtracted the whole two-up gutter instead of half, so both
  came out 8.5 pt narrow and were centre-floated against their own section rules. Material's
  write-in rule started wherever its unit began, putting three different edges in one column.
  The Beilagen gutter was subtracted from the widths AND drawn as padding inside them, so two
  photographs measured as touching; plates centre in their box now and three rows fit a page
  instead of two.

- **A plan opened underneath the rails.** A plan and a viewer-only PDF both opened centred in the
  whole viewport, so their left edge started under the NavRail and their head under the top bar –
  which is where a plan keeps its title block and its Zufahrt. Both reserve the chrome now and
  still pan under it once dragged, which was always deliberate; what was wrong was opening that
  way.

- **One breakpoint, at 600px.** The Rapport was the only surface switching to phone insets at 720
  while the NavRail stays a vertical rail down to 600 – so through the whole 601–720px band (iPad
  Split View, a landscape phone) the page ran edge-to-edge UNDER a floating rail that covered its
  own title. Between 601 and 860 the top-bar actions were icon-only AND ~31px, the smallest
  button in the app on the row that logs a Verlauf entry; icon-only and full size go together at
  every width now.

- **`--accent` had leaked into meaning state.** It is the brand red, and it had spread to the
  Combo's «on» row and – worst – the time wheel's selection band: a selection painted alarm-red
  on a surface where red already means *überfällig* is the one confusion the token rule exists to
  prevent. Ticked rows on the Rapport went blue too, so an ordinary rapport lit up with nine blue
  rings for the news that all was normal. Done reads by shape and ink now.

- **Three CSS classes were referenced but never written.** `.ip-hint` is the visible one: the
  Gast dialog's explanatory paragraph fell through to the browser default – 16px in full `--ink`
  with 1em margins, above a 12px `--ink-dim` label – so the hint was larger and louder than the
  heading's own subtitle. `.ip-btn danger` rendered «Schicht entfernen» identical to «Abbrechen»,
  and `btn ghost` rendered three intended-transparent buttons as filled ones.

- **A Rückmeldung can carry a photo.** Up to two, picked by hand in the sheet – "hier war der
  Knopf" is often one picture and no sentences. It is the only thing that leaves this app which
  the sanitiser cannot read, so it is fenced accordingly: the app still captures no screenshot
  of its own, the picture is shown as a thumbnail under *«Das wird mitgeschickt»* before the
  send button, it is downscaled and re-encoded in the browser (which also strips the phone's GPS
  EXIF), and it travels on the direct-send route only – *Kopieren* and *E-Mail* say so rather
  than dropping it quietly. On a deployment with outbound telemetry switched off, attaching is
  not offered at all. See [`PRIVACY.md`](PRIVACY.md).

- **The Einsatzrapport takes Beilagen.** Photos that belong to the REPORT rather than to the
  Verlauf – an ID document, a damage close-up, a handed-over form. They are captured on the
  Rapport surface (or at the Erfassungs-Poster, below), carry a caption, and print at the end
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
  paper ask it identically, on the Rapport surface and at the Erfassungs-Poster.

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
  Rapport could still be changed – and saved. The unlock is «Reaktivieren», once and
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

- **A GPS vehicle can be given a driver.** The feed knows where a vehicle is, never who sits
  in it – and that is exactly what the Einsatzleitung needs in order to reach it. The driver is
  set on the vehicle, picked from the Mannschaft, appears on the label and prints on the Kroki
  like on a hand-placed vehicle. He survives the next GPS poll, which otherwise rebuilds the
  symbol.

- **The live position in Anwesenheit is a marker again, not a reading.**
  «63 m · jetzt» behind every name was a second number column next to the thing the list is
  read for – the names. It stays the symbol, directly left of the clock; the reading lives in
  the tooltip, and a tap still shows the person on the map.

- **The floor sketch came out of the printer half portrait, half landscape.** Each page was shaped
  by the number of storeys that happened to land on it – two gave an upright sheet, one a wide
  one – so a building with an odd number of floors printed in two orientations. Every page keeps
  the same grid now; a page short of a storey leaves its lower band empty, which is what a stack
  with nothing above it looks like.

- **The Kroki preview shows what will be printed.** It drew naked lines – the one screen whose
  entire job is «this is how it comes out» showed less than what came out: the section fork,
  the end label («Leitungsnummer · Inhalt · Stockwerk · Trupp»), the distance and label chips
  were missing, dashed lines appeared solid and every line equally thick. Now the same building
  blocks as on the Lagekarte, under the same labelling setting as the export.

- **The Kroki carries a north arrow.** On screen you know which way you are looking; on paper
  you don't – and a Kroki without a north mark can neither be laid next to a plan nor be read
  against the terrain.

- **The Einsatzjournal starts on a page of its own.** It is a Beilage, not a continuation:
  until now it began wherever the signed part happened to end – the first entries stood in the
  whitespace below the signatures, and the two read as one document.

- **The floor sketch had a box around every storey label.** «2. OG» was drawn as a wide text
  box instead of as a pill: per the contract a missing width means the one-line pill, but the
  code substituted a default width.

- **On the personnel sheet the start is grey too when somebody was there from the beginning** –
  a row that is grey on both ends needs nobody to check it. And the time column adapts to its
  content: with dates, «02.08. 14:41 – 04.06. 11:00» used to wrap onto two lines.

- **The Kroki window is no longer translucent.** The Rapport behind it bled through exactly
  the map this window exists to judge.

- **The date input had no date picker on the desktop.** The picker dialog showed a large empty
  area with only the time in it: the wheels are a finger control, and with a keyboard nothing
  was put in their place. Now day · month · year as select fields next to the time.

- **The demo contradicted itself.** The alarm was 14 minutes ago, but the crew had signed in
  20 minutes ago – six minutes *before* the alarm – and the first Trupp entered the building in
  the same minute the pager went off. Exactly what the new time-plausibility check flags: the
  demo failed its own test.

- **«Einsatz abschliessen» now closes only itself.** The Einsatzrapport was closed along with
  it as a precaution – on the demo, where the action is never actually executed, that cost you
  your place for something that never happened.

- **What is captured via the QR poster now lands in the Verlauf.** Anwesenheit, Material,
  Rapport details and Beilagen could be changed through the poster without a single line being
  written – the same action on the tablet always wrote one. Every line carries «(QR)», because
  the legal document has to show that it did not come from a signed-in person.

- **Logo and title sit on one line.** Stacked, the logo pushed the Einsatz – the thing the
  sheet is about – a third of the page down, and the two read as two blocks instead of one
  head.

- **«Stk» is now «Stk.»** – an abbreviation reads with a dot. The demo also carries the same
  partner organisations as Oberwil, so the block looks there the way a station actually meets
  it.

- **In light mode the partner organisations' boxes were invisible.** They were framed with the
  gloss token – in light mode plain white, so white on a white sheet. An empty box IS the
  control; it has to be visible before anything is in it. The same held for the rings of the
  Abschluss checklist.

- **The partner organisations looked like three different lists.** Ticked rows in black,
  unticked ones in grey, the write-in line empty – three typefaces and three row heights in one
  block whose whole point is comparability. A cross already says «they were there»; the
  typography does not have to say it again more quietly.

- **The Atemschutz attachment no longer prints a status.** «Im Einsatz» on a closed Einsatz
  claims something that had already stopped being true when the sheet left the printer. The
  print table is narrower, too – a time, a word and a number do not need a full page width –
  and «Mitglieder» becomes **AdF**, the term the app uses everywhere else.

- **The Rapport logo can also be set by command.** `admin_branding push reportLogo <datei>`
  – needed for the demo, whose nightly reset reloads the configuration and would have deleted a
  hand-uploaded logo every time. The demo now brings its own logo.

- **On a running Einsatz the sheet only says how many are there.** Without an Einsatzende no
  block can be evaluated – yet «0:00 · gerundet 0:00» was printed anyway, complete with a
  paragraph explaining why both zeros mean nothing. Now the sheet shows the one number that is
  certain. The rounding rule is no longer on the sheet at all: it is the same on every Rapport
  and belongs in the Weisung, not next to the two numbers somebody actually copies over.

- **The Rapport logo did not appear on paper.** It was uploaded, was served, and stood in the
  configuration – but the storage key is a PATH («branding/<uuid>.png»), and the pattern meant
  to recognise it allowed no slashes. It matched nothing, and the logo was silently left out.

- **«Einsatzstunden 0:00» with four people present.** A still-open Anwesenheit block borrows
  the Einsatzende – if that was implausible (say, a mistyped date), every person yielded a
  negative duration, capped to 0. Four people, zero hours, and nothing said why. A block that
  ends before its start is now **not evaluable** instead of «measured, and nothing», and the
  sheet writes down how many people are therefore in neither of the two sums. The numbers also
  sit on a line of their own, the rounding rule as a footnote below – as one sentence this ran
  across the whole page width, with the two numbers anybody actually copies buried in the
  middle.

- **A click into the picture zooms.** The cursor showed a magnifier, but a click did nothing –
  the zoom hid behind double-click, mouse wheel and two-finger gesture, none of which the
  picture advertises. Click in, click out; the other gestures stay.

- **The Rapport has a logo of its own.** The app's mark is read on a screen in passing, the
  Rapport's on paper by a Gemeinde or an insurer – stations rightly want a different mark
  there, and one carrying the full name reads badly in a top bar and right on a letterhead.
  **Admin → Branding → Rapport-Logo**; empty still means the logo above it, nobody has to
  upload twice.

- **An entry tore you away from the map.** After «Erfassen» the Verlauf always opened – even
  when the entry was started from the button at the bottom edge or from a checklist. The
  Verlauf now stays as it was: whoever had it open keeps seeing it, whoever was working on the
  map stays there. The save is confirmed either way.

- **No spaces could be typed in an attachment's caption.** The caption was trimmed on every
  keystroke, so the space just typed was gone before the next letter arrived – «Ausweis Lenker»
  became «AusweisLenker». Cleanup now happens once, on leaving the field.

- **The partner organisations print as a complete list.** Like the Personal: every Ortschaft
  from the station list with its own box – ticked or not – and an empty line at the end for the
  one nobody thought of. A section that shows only the ticked ones cannot say «the police were
  NOT there». The demo now ships a list too.

- **Whoever changes the Atemschutz safety values leaves a trace.** Kontaktintervall and
  Nachfrist decide when a Trupp counts as due and as overdue – whoever moves one of them
  mid-Einsatz moves every clock on the Atemschutz board at once, and until now that left
  nothing behind: the reconstruction could see that a Trupp became overdue, but not that the
  threshold had been moved underneath it. The line carries the **old and new value** –
  «geändert» alone does not say whether the limit got stricter or looser.

- **The Rapport details write a line too.** Einsatzleiter, end time, Gerettete, partner
  organisations, the alarm and vehicle times – the content of the document that gets signed –
  used to change without a trace. One line per save, saying *which* fields it was.

- **An Übungsrapport looked like an Einsatzrapport.** Whether an Einsatz was an **Übung**
  appeared nowhere on the paper – yet it is the one thing that changes *what the document even
  is*, and Übungen do not flow into the statistics. An Übungsrapport that reads like a real
  event contradicts the numbers behind it. It now stands above the title, before everything
  else.

- **The category was called «Stichwort» on the Rapport.** It is the category – the Stichwort
  is the title above it. Now it is called what it is.

- **The address search lost the street as soon as you typed the postal code.** «storchenweg 8,
  410» came back with six hits, none of them a Storchenweg. A PLZ has four digits – a
  half-typed one did not count as one, so the app appended its own locality on top. The query
  carried two localities, and the map service answered by matching the NUMBERS and dropping
  the street name. As soon as somebody writes a locality themselves, the query now stays
  untouched – and **the own Gemeinde sorts first** when a street exists in several villages of
  the region.

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

- **Datum and Zeit are asked as two things, not one string.** The desktop got a bare
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

- **Personen and Tiere didn't line up either.** On the Erfassungs-Poster the two counters were
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

- **Anwesende and Einsatzstunden are on the Rapport.** One line under the roster: how many
  people were there, and how long – `6 Anwesende · Einsatzstunden 14:35 (gerundet 16:00)`. The
  first figure is **raw**, summed to the minute, because that is what actually happened. The
  second is the Sold convention: each person's own time rounded up to the next block, but only
  once a few minutes past the previous one, then summed – **per person, never on the total**,
  which would otherwise make the same Einsatz answer differently depending on how many people
  came. The station sets the block and the grace (`report.hoursRounding`, default 30 / 5 minutes,
  `docs/CONFIGURATION.md` §1b). The rule itself is **not** printed: it is identical on every
  rapport a station produces, so the sheet would repeat one sentence forever – it belongs in the
  Weisung. What makes the rounded figure checkable is the raw one printed beside it. The per-person Stunden columns stay off
  the paper as decided in 2026-07: WinFAP computes those from the recorded von–bis. This is the
  summary for whoever signs the sheet.

- **Beilagen scale now.** Two photos and fifty are different documents. Up to eight print as
  large plates – the reason to photograph a driving licence is to read it off the paper. Beyond
  that they become a numbered contact sheet, three across: fifty pictures are six sheets instead
  of twenty, and what the paper is for at that count is *which pictures exist*. Either way each
  carries its number **B7**, so the Verlauf, a phone call and the paper can name the same
  picture, and every page names its Einsatz in the footer – a rapport gets stapled, unstapled and
  passed around, and a loose sheet that does not say which Einsatz it belongs to cannot be put
  back. Whether the photos print at all stays the Beilagen tick under «Abschnitte»; the
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
  sequence as the Rapport surface on screen, so filling in and checking the paper follow one
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

[Unreleased]: https://github.com/feuerwehr-oberwil/kp-front/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/feuerwehr-oberwil/kp-front/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/feuerwehr-oberwil/kp-front/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/feuerwehr-oberwil/kp-front/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/feuerwehr-oberwil/kp-front/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/feuerwehr-oberwil/kp-front/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/feuerwehr-oberwil/kp-front/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/feuerwehr-oberwil/kp-front/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/feuerwehr-oberwil/kp-front/releases/tag/v0.1.0
