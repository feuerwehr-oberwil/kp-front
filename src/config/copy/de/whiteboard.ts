// German copy · the Plan whiteboard, notes and entities.
// One slice of the canonical `de` catalogue, assembled in ../de.ts — read the rules at the
// top of that file before adding or renaming a key here.

export const whiteboardCopy = {
  // data-layer messages (lib/incidents): generated incident title + client-side GeoJSON checks
  incidents: {
    migratedTitle: 'Migrierter Arbeitsstand',
    geojsonNotJson: 'Keine gültige JSON-Datei.',
    geojsonNotFc: 'Kein GeoJSON FeatureCollection.',
    geojsonNotWgs84: 'Koordinaten wirken wie LV95, nicht WGS84 [lng, lat]. Vorher nach EPSG:4326 umprojizieren.',
  },
  entities: {
    noteSubtitle: 'Notiz',
    fallbackObjectName: 'Objekt',
  },
  notes: {
    deleteTitle: 'Notiz entfernen',
    deleteMsg: 'Diese Notiz enthält Text. Wirklich entfernen?',
    // note styling — shared by the Karte map and the Plan whiteboard (same controls in the
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
    done: 'Fertig',
  },
  whiteboard: {
    fit: 'Fit',
    pan: 'Auswahl',
    team: 'Trupp',
    draw: 'Zeichnen',
    text: 'Notiz',
    symbol: 'Symbol',
    line: 'Linie',
    area: 'Fläche',
    dockHints: {
      draw: 'Auf den Plan ziehen, um frei zu zeichnen. Farbe, Breite und Stil danach im Editor.',
      line: 'Eckpunkte antippen. Doppeltippen oder «Fertig» schliesst die Linie ab. Farbe, Breite und Stil danach im Editor.',
      lineFreeShort: 'Mit dem Finger über den Plan ziehen',
      lineNodesShort: 'Punkte tippen – ✓ schliesst die Linie ab',
      areaFreeShort: 'Den Umriss mit dem Finger ziehen',
      areaNodesShort: 'Mind. 3 Eckpunkte tippen – ✓ schliesst ab',
      area: 'Ziehen zeichnet den Umriss frei. Oder Eckpunkte antippen (mind. 3) – Doppeltippen oder «Fertig» schliesst die Fläche ab.',
      circle: 'Von der Mitte zum Rand ziehen setzt den Radius. Radius, Farbe und Füllung danach im Editor anpassen – in echten Metern, sobald der Massstab kalibriert ist.',
      text: 'Auf den Plan tippen, um eine Notiz zu setzen – sie öffnet sich direkt zum Tippen. Grösse, Farbe und Klartext danach im Panel der Notiz.',
      resource: 'Auf den Plan tippen, um einen Trupp zu setzen. Zum Verschieben ziehen.',
      scale: 'Die zwei Endpunkte des gedruckten Massstabs antippen, dann die reale Länge eingeben. Danach zeigen Linien mit «Länge» echte Meter.',
      measure: 'Punkte auf den Plan tippen. «Strecke» zeigt die Distanz, «Fläche» den Inhalt + Umfang – in echten Metern, sobald der Massstab kalibriert ist. Punkte ziehen zum Verschieben, einen Punkt gedrückt halten entfernt ihn.',
    },
    // Plan-Massstab (calibrate against a printed scale bar so plan lines read in metres)
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
      chipAuto: 'Ref. auto',
      chipAutoHint: 'Ref. automatisch – Massstab aus der Kartenverknüpfung',
      // the Gebäude floor-stack (A7): the scale comes from the footprint's ground size, not a fit
      chipAutoStackHint: 'Ref. automatisch – Massstab aus dem Gebäudegrundriss',
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
      /** ⚠️ Der Massstab landet im STATIONS-Dokument, nicht im Einsatz — das kann scheitern
       *  (kein Empfang, oder jemand anders hat das Dokument inzwischen geändert). Die beiden
       *  Zeilen darüber wurden früher gemeldet, bevor überhaupt jemand geantwortet hatte. */
      saveFailed: 'Massstab speichern fehlgeschlagen',
      needsCalibration: 'Massstab festlegen: die zwei Enden des Massstabs antippen',
      needsCalibrationViewer: 'Messen erst möglich, wenn der Massstab kalibriert ist',
    },
    // «Karte verknüpfen» – die Paarung markanter Punkte, die den Plan auf die Karte legt
    // (lib/georef · fitSimilarity, lib/georefMode). Zwei Punkte genügen; erst der dritte misst.
    georef: {
      chipUnlinked: 'Karte verknüpfen',
      // ⚠️ Der Chip sagt EIN Wort: dass dieses Blatt an der Karte hängt. Die Güte stand früher
      // daneben («Verknüpft · ⌀ 10.8 m») – ein Satz in einer Reihe von Dreiwort-Pillen, und eine
      // Zahl ohne «aus wie vielen Paaren» sagt nichts. Der Farbton trägt weiterhin, ob die
      // Passung gemessen ist; die Zahl steht einen Tipp entfernt in der Passung.
      chipLinked: 'Verknüpft',
      // die Güte selbst – in der Passung und in den Ebenen-Zeilen der Zwillinge: «aus 2 Punkten»
      // heisst exakt gelöst und damit UNGEMESSEN, eine Zahl gibt es erst ab dem dritten Punkt
      // (georef · residualClaim).
      chipTwoPoints: 'aus 2 Punkten',
      chipResidual: '⌀ {m} m',
      linkTitle: 'Plan mit der Karte verknüpfen',
      openQuality: 'Referenz prüfen und korrigieren',
      // ⚠️ Die Naht trägt KEINE Beschriftung mehr – weder «KARTE VERKNÜPFEN» noch «Karte
      // geliehen». Beides war Erklärung des Layouts statt Anweisung; die Leiste am Fuss sagt,
      // welcher Modus läuft und was als Nächstes zu tippen ist. Die gestrichelte Linie genügt.
      // Die eine Anweisung des minimalen Panels – ein Satz, sonst nichts.
      // ⚠️ Beispiele und «Reihenfolge egal» standen bis 15.09. hier mit auf der Zeile: drei
      // Aussagen in einer Anweisung, die man mitten im Tippen liest. Sie stehen jetzt im (i)
      // darunter (`freeOrderTip`), wo man sie beim ersten Mal sucht und danach nie wieder.
      freeOrderTap: 'Dieselbe Stelle auf Modul und Karte antippen',
      // hinter dem (i), auf beiden Formfaktoren: woran man eine gute Stelle erkennt
      freeOrderTip: 'Gut sind eindeutige Punkte – Hausecke, Hydrant, Wegkreuzung. Die Reihenfolge ist egal, gesetzte Hälften suchen sich ihr Gegenstück selber.',
      // die Kurzform unter «Punkt setzen» auf dem Telefon: wohin die Taste wirkt
      freeOrderPlace: 'Wirkt auf der sichtbaren Fläche – Karte oder Modul, Reihenfolge egal',
      // «Verschieben» ist bewaffnet: der nächste Tipp auf dieser Fläche setzt genau diese Hälfte
      moveMap: 'Punkt {n} verschieben – neue Stelle auf der Karte antippen, der alte verschwindet.',
      movePlan: 'Punkt {n} verschieben – neue Stelle auf dem Modul antippen, der alte verschwindet.',
      title: 'Karte verknüpfen',
      // offene Hälften: gesetzt, aber noch ohne Gegenstück auf der anderen Fläche
      barOpen: '{n} offen',
      // Zähler je Fläche – die Statuszeile «Karte 3 · Modul 2».
      // ⚠️ Steht NUR, wenn die beiden Zahlen auseinanderlaufen (15.09.): «Karte 3 · Modul 3» war
      // eine Zeile, die nie etwas meldete. Ungleich heisst «eine Hälfte hängt» – und genau dann
      // ist der Zähler die Warnung, als die er gedacht war (GeorefMode · georefStatus).
      sideProgress: 'Karte {map} · Modul {plan}',
      // Statuszeile, zweite Hälfte: WO die offene Hälfte fehlt. Das bernsteinfarbene Kreuz, das
      // dasselbe sagt, steht unter Umständen auf der Fläche, die das Telefon gerade nicht zeigt.
      statusOpenMap: 'Punkt {n} fehlt noch auf der Karte.',
      statusOpenPlan: 'Punkt {n} fehlt noch auf dem Modul.',
      statusOpenMapMany: '{k} Punkte fehlen noch auf der Karte.',
      statusOpenPlanMany: '{k} Punkte fehlen noch auf dem Modul.',
      statusOpenBoth: 'Offene Punkte auf Karte und Modul – gleiche Stellen finden sich automatisch.',
      statusSelected: 'Punkt {n} ausgewählt – daneben tippen wählt ab.',
      // ⚠️ `cancel` gehört noch der Rückfrage vor «Alle Punkte zurücksetzen» – dort bricht es
      // wirklich etwas ab. Der Ausstieg aus dem Modus heisst `closeMode`: er verwirft nichts.
      cancel: 'Abbrechen',
      // Der Weg hinaus, solange noch keine brauchbare Verknüpfung steht. ⚠️ NICHT «Abbrechen»:
      // gesetzte Punkte werden laufend gespeichert, der Ausstieg nimmt nichts zurück. Wer den
      // Knopf drückte, um eine schiefe Ausrichtung loszuwerden, fand den Plan danach trotzdem
      // verknüpft. Zum Wegwerfen gibt es «Alle Punkte zurücksetzen», mit Rückfrage.
      closeMode: 'Schliessen',
      done: 'Fertig',
      // ⚠️ OHNE Nummer. Die Taste wirkt auf der sichtbaren Fläche, und welche Nummer der Tipp
      // bekommt, entscheidet die Zuordnung – die Zahl stünde also gelegentlich falsch da.
      placePoint: 'Punkt setzen',
      targetOutside: 'Fadenkreuz zuerst auf die sichtbare Fläche bewegen',
      // Sichtprüfung nach dem Ausrichten: der Blattumriss liegt auf der Karte, man sieht sofort,
      // ob die Ecken zusammenfallen. Einmalig – kein Dauer-Layer.
      checkFit: 'Deckung prüfen',
      checkOpacity: 'Sichtbarkeit der Modul-Deckung',
      checkMap: 'Karte',
      checkPlan: 'Modul',
      // ── «Automatisch ausrichten» – der CV-Vorschlag (lib/georefSuggest · app/georef_suggest) ──
      // Der Einstieg auf einem unverknüpften Blatt bietet zwei Wege: den automatischen Vorschlag
      // und den bestehenden Punkte-Ablauf. Der Vorschlag erscheint als Deckung («Deckung prüfen»
      // mit dem Blatt auf der Karte), wird geprüft/nachgeführt und erst mit «Übernehmen»
      // gespeichert – als 2 Punkte, also ehrlich «exakt, aber ungeprüft» (amber).
      autoStart: 'Automatisch ausrichten',
      autoStartSub: 'Vorschlag auf der Karte prüfen, dann übernehmen',
      autoManual: 'Punkte selbst setzen',
      autoManualSub: 'Dieselbe Stelle auf Modul und Karte antippen – Reihenfolge egal',
      autoBusy: 'Automatische Ausrichtung läuft…',
      // die echten Phasen des Endpunkts (NDJSON-Fortschritt) – keine erfundene Prozentzahl
      autoStepRender: 'Plan rendern',
      autoStepOsm: 'Gebäudedaten laden',
      autoStepMatch: 'Gebäude vergleichen',
      // «kein Vorschlag» ist ein normales Ergebnis, kein Fehler – der Satz führt zum Ausweg
      autoNone: 'Kein sicherer Vorschlag gefunden – Punkte selbst setzen',
      // ohne bekannten Massstab läuft der Matcher gar nicht erst: ein fixierter falscher
      // Massstab liefert überzeugend aussehende, falsche Posen (Messung Gymnasium 08.09.)
      autoNoScale: 'Massstab des Plans nicht erkannt – zuerst kalibrieren oder Punkte selbst setzen',
      autoFailed: 'Automatische Ausrichtung fehlgeschlagen',
      autoUnavailable: 'Automatische Ausrichtung ist auf diesem Server nicht eingerichtet',
      // die Review-Leiste über der Deckung
      proposalHead: 'Automatisch ausgerichtet',
      proposalSub: 'Gebäudekanten vergleichen, dann übernehmen',
      // die unsichere Bandbreite des Matchers (score zwischen Cutoff und Ceiling):
      // Anweisung zuerst, Grund nach dem Gedankenstrich (Regel von warnCollinear)
      proposalCheckHead: 'Deckung nachprüfen',
      proposalCheckSub: 'Gebäude stimmen nur teilweise überein – genau vergleichen, bei Bedarf anpassen',
      proposalAdjustHead: 'Plan anpassen',
      proposalAdjustSub: 'Verschieben oder drehen, bis die Gebäudekanten passen.',
      adjust: 'Anpassen',
      accept: 'Übernehmen',
      discard: 'Verwerfen',
      restore: 'Vorschlag wiederherstellen',
      planSize: 'Plangrösse',
      sizeSmaller: 'Plan um 1 Prozent verkleinern',
      sizeBigger: 'Plan um 1 Prozent vergrössern',
      undoNudge: 'Letzte Anpassung rückgängig',
      rotateGrip: 'Drehen',
      hintMove: 'Ziehen verschiebt den Plan',
      hintRotate: 'Ziehen dreht den Plan um den Mittelpunkt',
      acceptedToast: 'Ausrichtung übernommen',
      crossTitle: 'Punkt {n} – ziehen verschiebt, antippen zeigt Optionen',
      pendingCrossTitle: 'Punkt {n} offen – ziehen verschiebt, antippen zeigt Optionen',
      // das kleine Popover eines angetippten Kreuzes – ersetzt den unsichtbaren Aufnehm-Zustand,
      // dessen einzige Ausgänge Esc (auf Touch unsichtbar), Löschen oder Neu-Setzen waren
      pointN: 'Punkt {n}',
      popMove: 'Verschieben',
      popKeep: 'Behalten',
      popResidual: 'Rest {m} m',
      popOpen: 'offen',
      // steht im Popover einer OFFENEN Hälfte: so entsteht ein Paar von Hand (bleibt fix)
      popPairHint: 'Zum Zuordnen den offenen Punkt auf der anderen Fläche antippen',
      detailsTitle: 'Details zur Passung',
      saveFailed: 'Verknüpfung speichern fehlgeschlagen',
      // Passungs-Anzeige. ⚠️ EINE Zeile zur Güte, mehr nicht: Blattbreite, Drehung und die
      // Restfehler je Punkt standen hier, weil sie sich rechnen liessen – gelesen hat sie
      // niemand mitten im Einsatz. Was zählt, ist «wie viele Paare» und «wie weit daneben».
      qualityTitle: 'Passung',
      pairs: 'Paare',
      // aus 3 Paaren gemessen; bei 2 Paaren steht stattdessen chipTwoPoints (georef · residualClaim)
      qualityDeviation: 'Abweichung ⌀ {m} m',
      // ⚠️ Anweisungen, keine Vorhaltungen (29.08.): zuerst, was zu TUN ist – fett auf der
      // Karte –, nach dem Gedankenstrich der Grund. «kleine Tippfehler wirken über den ganzen
      // Plan» war die Folge ohne den Ausweg.
      warnTwoPoints: 'Zwei Paare lösen exakt – erst ein dritter Punkt zeigt, wie gut die Passung wirklich ist.',
      warnCollinear: 'Den nächsten Punkt abseits der Linie setzen – die bisherigen liegen fast auf einer Linie, quer dazu ist die Lage unbestimmt.',
      warnBaseline: 'Den nächsten Punkt weiter weg setzen – die Punkte liegen erst {m} m auseinander, grössere Abstände machen die Passung stabiler.',
      // ── Ampel (lib/georefMode · georefLamp) ────────────────────────────────────────────────
      // ⚠️ Sie steht die ganze Zeit im Balken, nicht erst in der Passung. Der Balken zählte
      // bisher Paare («2 Paare») – eine Zahl, zu der niemand eine Meinung haben kann. Was fehlt,
      // ist der Satz, der sagt, ob das reicht und was der nächste Punkt daran ändert. Genau den
      // liest niemand, der ihn in einem Panel einen Tipp weiter suchen müsste.
      lampNoneHead: 'Noch keine Verknüpfung',
      lampNoneBody: 'Zwei Punkte legen den Plan auf die Karte.',
      lampOneHead: '1 Punkt gesetzt',
      lampOneBody: 'Der zweite legt den Plan auf die Karte.',
      lampTwoHead: '2 Punkte – exakt, aber ungeprüft',
      lampGoodHead: '{n} Punkte · ⌀ {m} m',
      // Die Zahl bekommt ihren Satz. «⌀ 1.4 m» allein sagt nicht, ob man weitermachen soll.
      lampGoodBody: 'Genau genug, um Symbole zwischen Plan und Karte zu spiegeln.',
      addThird: 'Dritten Punkt setzen',
      // ── übernommene automatische Ausrichtung (georef · isAutoGeoref) ──────────────────────
      // Die zwei Blattecken-Paare sind synthetisch: die Flächen sprechen die HERKUNFT aus,
      // statt Punkte zu zählen, die niemand gesetzt hat («2 Paare» wirkte wie erfunden).
      lampAutoHead: 'Automatisch ausgerichtet',
      // die Station hat den automatischen Vorschlag geprüft und freigegeben (Admin › Objektpläne)
      lampApprovedHead: 'Von der Station freigegeben',
      // …und eine freigegebene Passung gilt als VERKNÜPFT (18.09.2026): kein «ungemessen»,
      // kein Warnton. Ein ⌀ steht trotzdem nicht da – aus zwei synthetischen Paaren gibt es
      // keinen zu berechnen; der Satz sagt stattdessen, wer für die Passung geradesteht.
      lampApprovedBody: 'Die Station hat die Deckung geprüft und diese Passung freigegeben.',
      chipAuto: 'ungemessen',
      warnAuto: 'Referenzpunkte setzen, um die Passung zu messen – bisher gilt die Sichtprüfung der Deckung.',
      autoAddPoints: 'Referenzpunkte setzen',
      // genau EIN eigener Punkt neben der Automatik (zwei ersetzen sie – settleSlots)
      autoOneHead: 'Automatisch ausgerichtet · 1 Punkt',
      autoOneBody: 'Ein zweiter Punkt ersetzt die Automatik durch echte Referenzpunkte.',
      autoOnePoint: '1 Punkt',
      // «Fertig»/«Schliessen» mit offenen Hälften: sagen, was wegfiel, statt still zu schlucken
      openDroppedOne: 'Offener Punkt verworfen – ein Referenzpunkt braucht beide Flächen',
      openDroppedMany: '{k} offene Punkte verworfen – ein Referenzpunkt braucht beide Flächen',
      // ab dem dritten Paar: es gibt keinen «vierten Punkt» zu lehren, nur noch einen weiteren
      addMore: 'Punkte hinzufügen',
      transfer: 'Übertragen',
      transferTitle: 'Passung übertragen',
      transferBody: 'Die Referenzpunkte von {source} werden kopiert. Danach kann jedes Modul separat angepasst werden.',
      transferLinked: 'bereits verknüpft',
      transferCompleted: 'übertragen',
      transferReplaceTitle: 'Passung von {target} ersetzen?',
      transferReplaceBody: 'Die vorhandenen Referenzpunkte von {target} werden durch die Passung von {source} ersetzt.',
      transferDone: 'Passung auf {target} übertragen – Deckung dort prüfen',
      reset: 'Zurücksetzen',
      resetTitle: 'Referenz zurücksetzen?',
      resetBody: 'Die Verknüpfung zwischen diesem Plan und der Karte wird gelöscht. Die Punkte müssen danach neu gesetzt werden.',
      resetDone: 'Referenz zurückgesetzt',
      // In der Leiste des laufenden Modus: alle Paare weg, der Modus bleibt an – man setzt ja
      // sofort neu. «Abbrechen» daneben behält, was steht.
      clearPoints: 'Zurücksetzen',
      clearTitle: 'Alle Punkte zurücksetzen?',
      clearBody: 'Die gesetzten Punkte werden gelöscht, die Verknüpfung des Plans mit der Karte fällt damit weg. Das Setzen beginnt von vorn.',
      // ein aufgenommener Punkt: entweder neu setzen (antippen) oder ganz weg
      removePoint: 'Punkt löschen',
      // In den Ebenen bekommt jedes verknüpfte Blatt seine eigene Zeile (lib/georefTwins ·
      // planRasterRows): das Blatt selbst als Bild unter der Tinte der Karte. Der Plan-Code steht
      // drin, damit «welches Blatt liegt hier?» keine Rückfrage ist. Die Objekte darauf brauchen
      // keine Zeile mehr – sie sind gewöhnliche Objekte und gehören zu ihrer eigenen Ebene.
      layerGroupPlans: 'Pläne',
      layerPlanImage: 'Plan ({plan})',
      // ⚠️ Das EINZIGE, was einem Blatt noch geliehen statt gehört: der Live-Feed (Fahrzeuge und
      // geteilte Standorte, lib/planProjection · liveOverlay). Kein Datensatz, darum auch kein
      // Objekt – der Titel sagt, woher er kommt und dass Ziehen die Karte mitnimmt.
      twinFromMap: '{name} – gespiegelt von der Karte. Antippen zeigt die Angaben, Ziehen verschiebt das Original.',
      // Rückfallname eines Symbols ohne Beschriftung: das Wort steht im Etikett, damit die
      // Plakette nie leer bleibt (lib/entityGlyph, lib/georefTwins · contentTwinName).
      twinUnnamed: 'Symbol',
    },
    finishShape: 'Fertig',
    cancelShape: 'Abbrechen',
    insertVertex: 'Punkt einfügen',
    dragVertex: 'Eckpunkt ziehen · gedrückt halten zum Löschen',
    dragRadius: 'Radius ziehen',
    groupDeleteTitle: 'Auswahl entfernen',
    groupDeleted: 'Auswahl entfernt',
    groupDeletedN: '{n} Objekte vom Plan entfernt',
    placeText: 'Notiz auf Plan gesetzt',
    placeSymbol: 'Symbol «{name}» auf Plan gesetzt',
    placeLine: 'Linie auf Plan gezeichnet',
    placeArea: 'Fläche auf Plan gezeichnet',
    placeCircle: 'Absperrkreis auf Plan gezeichnet',
    placeTeam: '{name} auf Plan gesetzt',
    selectTrupp: 'Welcher Trupp?',
    newTeam: 'Neuer Trupp',
    // A Trupp stands in exactly ONE place. Tapping it again in this list MOVES it — what was
    // meant was almost always a second Trupp. Hence greyed out instead of selectable.
    truppPlacedHere: 'schon hier',
    showTrupp: 'Bei den Trupps zeigen',
    markPosition: 'Position markieren',
    positionMarked: '{name}: Position markiert',
    // The trash on a Trupp marker that carries a Spur asks WHICH of the two goes (18.09.2026,
    // the app's own Menu): the marker alone leaves the searched area behind as a Geister-Spur,
    // and the record is only destroyed where the operator said so. Both löschen rows are danger
    // rows, and both confirm first.
    removeMarker: 'Marker entfernen',
    removeMarkerTrail: 'Marker und Spur entfernen',
    clearTrail: 'Spur entfernen',
    clearTrailConfirm: 'Alle {n} markierten Positionen von {name} entfernen? Die Spur verschwindet von Karte und Plan.',
    trailCleared: '{name}: Spur entfernt',
    trails: 'Spuren',
    trailsOn: 'Spuren einblenden',
    trailsOff: 'Spuren ausblenden',
    // The ghost a removed Truppmarker left behind (lib/truppTrails): grey, read-only, and
    // labelled with the Trupp's number, because that is the name that stays true.
    ghostTrail: 'Spur {name}',
    ghostTrailHint: 'Spur von {name} – der Truppmarker wurde entfernt',
    ghostTrailTitle: 'Spur von {name}',
    ghostTrailAsk: 'Der Truppmarker wurde entfernt, seine Spur ist geblieben. Den Trupp am Ende der Spur wieder platzieren – oder die Spur entfernen?',
    ghostTrailRestore: 'Trupp wieder platzieren',
    ghostTrailRestored: '{name} wieder platziert – Spur übernommen',
    // Umbenennen eines losen Trupp-Markers auf eine Nummer, die schon vergeben ist (ein Trupp,
    // ein anderer Marker oder eine Spur trägt sie) – abgelehnt, der alte Name bleibt
    teamNameTaken: '{name} ist schon vergeben – der Name bleibt',
    textPlaceholder: 'Notiz …',
    blankHint: 'Leeres Blatt – mit Linie, Fläche, Notiz, Symbol oder Trupp beschriften',
    osmLoading: 'Gebäudeumrisse werden geladen …',
    osmError: 'Gebäudeumrisse (OSM) nicht erreichbar',
    osmEmpty: 'Keine Gebäude in diesem Bereich',
    osmRetry: 'Erneut versuchen',
    osmPickHint: 'Gebäude antippen, dann übernehmen',
    // ⚠️ Nur noch für ein Gebäude OHNE Georeferenz (vor 23.08. gewählt): dessen Umriss lässt
    // sich nicht wiederfinden, die Auswahl fängt also wirklich bei null an. Mit Georeferenz ist
    // der bestehende Umriss vorgewählt – siehe osmPickHintAmend.
    osmPickHintReplace: 'Gebäude antippen, dann übernehmen – ersetzt das bestehende Gebäude',
    // Steht über der Leiste, sobald das bestehende Gebäude wiedergefunden und vorgewählt ist:
    // «Anderes Gebäude wählen» heisst fast immer ergänzen, nicht von vorn anfangen.
    osmPickHintAmend: 'Das bestehende Gebäude ist markiert – weitere antippen zum Ergänzen, dann übernehmen',
    // Steht über der Leiste, wenn noch kein Gebäude gewählt ist und die App den Umriss am
    // Einsatzort vorgewählt hat (lib/footprintPick): ein Vorschlag, den man prüft – nie übernommen,
    // bevor jemand «Übernehmen» tippt.
    osmPickHintHere: 'Gebäude am Einsatzort ist markiert – prüfen, dann übernehmen.',
    // ⚠️ Zahl in Klammern, damit ein Umriss wie mehrere passt. Das ist ein Verlust, kein Hinweis:
    // was hier fehlt (offline, Kartenausschnitt verschoben, in OSM geändert), fällt beim
    // Übernehmen weg – lieber laut gesagt als stillschweigend aus der Auswahl genommen.
    osmPickMissing: 'Umrisse des bestehenden Gebäudes fehlen hier ({n}) – sie fallen beim Übernehmen weg.',
    osmTransfer: 'Übernehmen ({n})',
    osmClear: 'Auswahl leeren',
    addFloorUp: 'Obergeschoss hinzufügen',
    noFloorPlan: 'Kein Geschossplan',
    stairTo: 'Weiter zu {floor}',
    stairFrom: 'Von {floor}',
    climbUp: 'Ein Geschoss höher weiter',
    climbDown: 'Ein Geschoss tiefer weiter',
    climbBack: 'Zurück auf {floor}',
    addFloorDown: 'Untergeschoss hinzufügen',
    // the toast and ↶ of «+ OG / + UG», naming the storey (its Verlauf row comes with #226)
    floorAddedToast: '{floor} hinzugefügt',
    floorHide: 'Geschoss ausblenden',
    // the storey label's menu (29.09.2026, sweep K5): «Ausblenden · Geschoss entfernen»
    floorHideShort: 'Ausblenden',
    floorMenu: '{name}: ausblenden oder entfernen',
    floorShow: 'einblenden',
    floorHidden: 'ausgeblendet',
    removeFloor: 'Geschoss entfernen',
    removeFloorConfirm: '{floor}: {n} Markierungen dieses Geschosses werden entfernt oder gekürzt. Geschoss trotzdem entfernen?',
    removeFloorConfirmOne: '{floor}: 1 Markierung dieses Geschosses wird entfernt oder gekürzt. Geschoss trotzdem entfernen?',
    floorRemoved: 'Geschoss entfernt',
    /** the Verlauf row for the act itself (25.09.2026) — it used to write only its ↶ row */
    floorRemovedLog: 'Geschoss {floor} entfernt',
    floorRemovedLogMarks: 'Geschoss {floor} entfernt – {n} Markierungen entfernt oder gekürzt',
    floorRestoredLog: 'Geschoss {floor} wiederhergestellt',
    floorAddedLog: 'Geschoss {floor} hinzugefügt',
    floorAdded: 'Geschoss hinzugefügt',
    buildingReplaced: 'Gebäude ersetzt',
    buildingReplacedMarks: 'Gebäude ersetzt – {n} Markierungen entfernt',
    buildingReplacedKept: 'Gebäude gewechselt – Geschosse behalten',
    buildingReplacedCarried: 'Gebäude gewechselt – {n} Markierungen übertragen',
    buildingReplacedCarriedDropped: 'Gebäude gewechselt – {n} übertragen, {d} weggefallen',
    /** Ein Gebäude zum ersten Mal übernommen (noch kein Stapel da) — der ↶-Schritt dafür. */
    buildingTaken: 'Gebäude übernommen',
    replaceBuilding: 'Anderes Gebäude wählen',
    replaceBuildingConfirm: 'Der bisherige Geschoss-Stapel wird verworfen und durch den neuen Umriss ersetzt.',
    // ⚠️ Der LEGACY-Fall: ein Gebäude ohne Georeferenz lässt sich nicht auf dem Boden verorten,
    // also gibt es nichts, woran die Markierungen hängen könnten. Sie liegen im Koordinaten-
    // system des ALTEN Umrisses und würden auf einem anderen stillschweigend woanders bedeuten.
    // Sie gehen weg – aber nie ungefragt und nie ohne Rückweg.
    replaceBuildingConfirmMarks: 'Auf den Geschossen stehen {n} Markierungen. Sie hängen am bisherigen Umriss und lassen sich nicht auf einen anderen übertragen – sie werden entfernt. «Rückgängig» im Hinweis holt sie zurück.',
    // Trägt das bestehende Gebäude eine Georeferenz, wird umgerechnet statt verworfen: jede
    // Markierung geht über den BODEN in den neuen Umriss, behält also den Ort, den sie meint,
    // statt den Platz, den sie im alten Rechteck hatte. Die Geschosse kommen mit.
    replaceBuildingConfirmKeep: 'Der neue Umriss tritt an die Stelle des bisherigen. Die Geschosse bleiben erhalten.',
    replaceBuildingConfirmCarry: 'Der neue Umriss tritt an die Stelle des bisherigen. Die Geschosse bleiben, und {n} Markierungen werden mit übertragen – sie behalten ihren Ort am Boden.',
    // ⚠️ Was nicht mehr auf dem neuen Umriss liegt, wird weggelassen und nicht an den Rand
    // geschoben: eine an eine falsche Wand geheftete Markierung liest sich wie Wissen.
    replaceBuildingConfirmCarryDrop: '{n} Markierungen werden auf den neuen Umriss übertragen und behalten ihren Ort am Boden. {d} liegen nicht mehr darauf und fallen weg. «Rückgängig» im Hinweis holt alles zurück.',
    // ⚠️ Der Weg zurück zur Auswahl. «Umrisse» und «Gebäude» sind EINE Kachel in der Leiste
    // (23.08.) – wer ein anderes Gebäude will, tippt hier, nicht auf eine zweite Kachel.
    backToBuilding: 'Zurück zum Gebäude',
    // Beschriftung dieser einen Kachel. Sie nennt das Ziel («Gebäude»), nicht das Mittel
    // («Umrisse») – ob schon ein Stockwerkstapel existiert, sagt das GLYPH (Footprint vs.
    // Stockwerke), nicht das Wort: «Kein Gebäude» las sich in einer Leiste aus Substantiven
    // schräg (entfernt 25.08.).
    railBuilding: 'Gebäude',
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
    // The auto-surfaced object is only the NEAREST one with plans, not the Einsatzadresse: the
    // chip turns amber and carries the distance; the full sentence is what a screen reader gets.
    objectNearby: '{name} · {distance} entfernt',
    objectNearbyLabel: 'Nächstes Objekt in {distance} – nicht die Einsatzadresse',
    // …and a banner over the sheet, once per Einsatz and object (Whiteboard · nearbyBanner): both
    // addresses side by side, a door to the picker. After ✕ only the chip keeps saying it.
    nearbyBannerTitle: 'Nächstes Objekt, nicht die Einsatzadresse.',
    nearbyBannerBody: 'Einsatz: {incident} · Plan: {object} ({distance}).',
    nearbyBannerNoAddress: 'ohne Adresse',
    objectActive: 'Pläne von «{name}»',
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
    orientAsDrawn: 'Wie gezeichnet',
    northUnknownTitle: 'Norden unbekannt – Plan nicht mit der Karte verknüpft',
    orientNorthUp: 'Norden oben',
    orientLongAxis: 'Auf Längsachse drehen',
    // the rotation popover both compass doors open (30.08. – replaces the hidden dial drag)
    orientMenuTitle: 'Gebäude drehen',
    orientSliderLabel: 'Drehung',
  },
  // Die leere Tafel (08.10.2026): «Womit beginnen?» – Startkarten, solange das Blatt leer ist –
  // und die Vorlage «Erstes Plakat (FKS)» (Erste Führung, A3-Plakat als echte Felder).
  tafel: {
    startTitle: 'Womit beginnen?',
    startSub: '{title} · {address}',
    suggestion: 'Vorschlag',
    objectTitle: 'Objekt wählen',
    objectBody: 'Objektpläne aus der Objektdatenbank.',
    objectNone: 'In der Nähe ist kein Objekt erfasst.',
    objectSearch: 'Objektdatenbank öffnen',
    objectPick: '{name} übernehmen',
    buildingTitle: 'Gebäude am Einsatzort',
    buildingBody: 'Umriss aus der Karte – Geschosse stapeln und darauf skizzieren.',
    buildingAction: 'Gebäude wählen',
    templateTitle: 'Vorlage',
    plakatName: 'Erstes Plakat (FKS)',
    sketch: 'oder einfach losskizzieren – Werkzeuge rechts',
    sketchPhone: 'oder einfach losskizzieren',
    buildingRowSub: 'Umriss aus der Karte',
    objectRowNone: 'Objektdatenbank durchsuchen',
    plakat: {
      heading: 'Erste Führung',
      prefilled: 'aus dem Einsatz vorausgefüllt',
      title: 'Einsatz',
      address: 'Adresse',
      alarm: 'Alarm',
      el: 'Einsatzleiter',
      problems: 'Problemerfassung',
      front: 'Front',
      ordnung: 'Ordnung',
      sanitaet: 'Sanität',
      spezial: 'Spezialprobleme',
      massnahmen: 'Massnahmen',
      mittel: 'Mittel',
      verbindungen: 'Verbindungen',
      absprachen: 'Absprachepunkte',
      was: 'Was / Wo',
      wer: 'Wer',
      wann: 'Wann',
      formation: 'Formation',
      pers: 'Pers.',
      wo: 'Wo',
      funktion: 'Funktion / Standort',
      kanal: 'Kanal',
      ruf: 'Rufname / Tel.',
      newProblem: 'Problem …',
      newRow: 'Neue Zeile …',
      note: 'Stichwort',
      trendNone: 'Trend offen',
      trendUp: 'wird schlimmer',
      trendSame: 'gleich',
      trendDown: 'entspannt sich',
      trendTitle: 'Trend: {trend} – tippen zum Wechseln',
      done: 'Erledigt',
      weatherTag: 'Wetter',
      wind: 'Wind {dir} {speed} km/h',
      // die FKS-Absprachepunkte der Ersten Führung, als offene Häkchen vorgelegt
      absprachenDefaults: ['Standort Einsatzleitung', 'Zufahrt / Rettungsachse', 'Warteraum', 'Patientensammelstelle', 'Wasserbezug', 'Absperrung'],
      inserted: 'Erstes Plakat eingefügt',
      edited: 'Plakat geändert',
      remove: 'Plakat entfernen',
      removeTitle: 'Plakat entfernen?',
      removeMsg: 'Alles, was auf dem Plakat steht, geht mit. Rückgängig holt es zurück.',
      removed: 'Plakat entfernt',
      // Rapport: eigener Abschnitt, wenn auf der Tafel ein Plakat steht
      reportTitle: 'Erste Führung (Plakat)',
    },
  },
} as const
