import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../lib/icons'
import { LoadingStatus, ShellLoader } from '../ShellLoader'
import { confirmDialog, toast } from '../../lib/ui'
import { locateBlockedText } from '../../lib/permissionPath'
import { ApiError } from '../../lib/api'
import { MapPicker } from '../MapPicker'
import { DateTimeField } from '../TimeField'
import { Combo } from '../Combo'
import { Segmented } from '../Segmented'
import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../../lib/format'
import { fmtDistance, haversineM } from '../../lib/geo'
import { matchesAnyQuery, searchQuery } from '../../lib/search'
import { incidentCategories, isDemoMode, shortAddress } from '../../lib/deploymentConfig'
import {
  createIncident,
  geocodeReverse,
  geocodeSearch,
  getIncident,
  listObjects,
  patchIncident,
  type GeoHit,
  type IncidentCreate,
  type IncidentFull,
  type AlarmUpdateField,
  type IncidentMeta,
  type ObjectWithPlans,
} from '../../lib/incidents'
import { Modal, realCoord } from './_shared'
import { ListGroup, ListRow } from '../ListRow'
import { pointAtField } from '../../lib/pointAtField'
import { objectPicklistSub, sortObjects, splitAddress } from '../../lib/karte/places'
import { useOnline } from '../../lib/useOnline'
import { clearDraft, keepDraft, readDraft } from '../../lib/draftKeep'
import { markNew } from '../../lib/alarmUpdate'
import { Button } from '../Button'
import { MeldungSpans } from '../Meldeleiste'

// --- Einsatz eröffnen / Einsatzdaten korrigieren -------------------------------------
// `ix` (appConfig.copy.intake) is read inside each function below rather than captured at
// module-load, so the locale resolved at boot (config/copy) applies.
//
// Two jobs, one panel: a blank MANUAL create (four location methods, all on the address field —
// ONE list under it for the typed objects and addresses · map-pick · «Hier» GPS), and correcting an
// EXISTING incident in place. There is
// no third «take the alarm» mode any more: an alarm opens its Einsatz on arrival (2026-08-02),
// so this panel is where the expert fixes what the dispatch got wrong — Stichwort, Kategorie,
// Priorität, Ort — with the crew already on the map instead of waiting behind a wizard.

// Single guided panel — see the note above. 3am tenet: nothing hidden, nothing to memorise,
// everything correctable, before or after the incident is born.
/** The subset of `next` that actually differs from `seed`.
 *
 *  `text` is compared too, but only when it is present in `next` — the fetch guard already keeps
 *  it out of the body when the existing Meldungstext could not be read, and an absent key here
 *  has to stay absent rather than becoming "changed to undefined".
 *
 *  Timestamps are compared as INSTANTS, not strings: the field round-trips through a formatter
 *  that drops seconds, so `2026-08-02T14:41:37Z` comes back as `…14:41:00` and a plain !==
 *  would call every save a change to the Alarmzeit — which is the bug this exists to prevent.
 *  Same-minute counts as untouched; a real edit moves the minute.
 */
export function changedOnly(next: Record<string, unknown>, seed: Record<string, unknown> | null): Record<string, unknown> {
  if (!seed) return next
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(next)) {
    if (!(k in seed)) { out[k] = v; continue } // e.g. `text`, which has no seed
    const before = seed[k]
    if (k === 'started_at') {
      const a = typeof v === 'string' ? Date.parse(v) : NaN
      const b = typeof before === 'string' ? Date.parse(before) : NaN
      if (Number.isFinite(a) && Number.isFinite(b) && Math.floor(a / 60_000) === Math.floor(b / 60_000)) continue
    }
    if (v !== before) out[k] = v
  }
  return out
}

/** An instant as ISO, or undefined when there is none to read. */
const asIso = (v: string | undefined): string | undefined => {
  const t = v ? Date.parse(v) : NaN
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined
}

/** What was typed when the sheet closed by anything but «Abbrechen» or a save (lib/draftKeep).
 *  `text` and `alarmiertAt` ride only once the operator set them: the Alarmmeldung of an edit is
 *  fetched and the Alarmzeit of a create is «now» – neither may come back stale. */
type WizardFields = {
  title: string
  address: string
  kategorie: string | null
  coord: [number, number] | null
  isExercise: boolean
  text?: string
  alarmiertAt?: string
}

/** The draft to keep for `now`, or null when nothing differs from what the sheet opened with. */
function wizardDraft(now: WizardFields, opened: WizardFields): WizardFields | null {
  const same = now.title === opened.title && now.address === opened.address
    && now.kategorie === opened.kategorie && now.isExercise === opened.isExercise
    && now.coord?.[0] === opened.coord?.[0] && now.coord?.[1] === opened.coord?.[1]
    && now.text === undefined && now.alarmiertAt === undefined
  return same ? null : now
}

/** «Alarm neu: …» beside a field a pending «Alarm aktualisiert» changes (Banners ·
 *  AlarmUpdateBanner → «Bearbeiten»): one tap puts the alarm's value into the field – saving stays
 *  the operator's. The address hint sits above its input so the suggestions cannot hide it.
 *  Gone once the field holds it. */
function AlarmNew({ field, value, onTake }: { field: AlarmUpdateField | undefined; value: string; onTake: (v: string) => void }) {
  const alarm = field?.alarm
  if (alarm == null || alarm.trim() === value.trim()) return null
  const C = appConfig.copy.intake.alarmUpdate
  return (
    <div className="ip-alarm-new">
      <span>{C.alarmNew} <MeldungSpans text={markNew(field?.current ?? '', alarm)} /></span>
      <Button onClick={() => onTake(alarm)}>{C.take}</Button>
    </div>
  )
}

export function EinsatzWizard({ edit, nearCoord, onClose, onCreated }: {
  /** existing incident to correct in place (PATCH) instead of creating; null = manual create */
  edit?: IncidentMeta | null
  /** current incident coord, used to rank the object library by proximity */
  nearCoord?: [number, number] | null
  onClose: () => void
  onCreated: (inc: IncidentFull) => void
}) {
  const ix = appConfig.copy.intake // read per-render so the resolved locale applies
  // a pending «Alarm aktualisiert» offers the alarm's value beside each field it changes
  const alarmNew = (f: AlarmUpdateField['field']) => edit?.alarm_update?.fields.find((x) => x.field === f)
  // ⚠️ An outside tap, a swipe down, Esc or the ✕ close this sheet, and they used to take the
  // address, Stichwort, Kategorie, Alarmzeit and Alarmmeldung with them (sweep 09.11.2026, UX.5).
  // What differs from what the sheet opened with is kept like the composer's draft and seeds the
  // next open – per Einsatz when correcting. «Abbrechen» and a save are what drop it.
  const draftKey = `einsatz-wizard:${edit?.id ?? 'new'}`
  const [draft] = useState(() => readDraft<WizardFields | null>(draftKey, null))
  const [title, setTitle] = useState(draft?.title ?? edit?.title ?? '')
  const [address, setAddress] = useState(draft?.address ?? edit?.address ?? '')
  // Alarmmeldung (= incident.text). On edit it's fetched from the incident below
  // (IncidentMeta carries no text). `textReady` guards the PATCH so a save before the fetch
  // lands can't blank an existing Meldungstext.
  const [text, setText] = useState(draft?.text ?? '')
  const textTouched = useRef(draft?.text !== undefined)
  const [textReady, setTextReady] = useState(!edit)
  // Alarmierungszeit (= incident.started_at): correctable in edit mode, and settable on
  // MANUAL create so a fully analog incident (no Divera) can be nachgetragen days later
  // with its real alarm time — that timestamp is what a website/statistics feed reads.
  // Defaults to now, so live creation needs no interaction. Held as ISO like every Rapport time
  // (TimeField · DateTimeField); a draft kept before 12.11.2026 holds a datetime-local string,
  // which `asIso` reads as the same local instant.
  const [openedAlarm] = useState(() => edit ? edit.started_at : new Date().toISOString())
  const [alarmiertAt, setAlarmiertAt] = useState(() => asIso(draft?.alarmiertAt) ?? openedAlarm)
  // category defaults to the first VKF type (Brandbekämpfung) so the dropdown is never empty;
  // the list is the server's (`categoryLabels`), the option text translated per locale
  const kategorien = incidentCategories()
  const kategorieText = (k: string) => ix.kategorienLabels[k] ?? k
  const openedKategorie = edit?.type ?? kategorien[0] ?? null
  const [kategorie, setKategorie] = useState<string | null>(draft ? draft.kategorie : openedKategorie)
  // Priorität has NO control any more (18.09.2026): it is inferred from the alarm keywords and
  // nobody was correcting it here — a field on the intake form that only ever repeated a guess.
  // The value itself is untouched: an existing incident keeps whatever it carries (so the diff
  // below never reports a change), and a manual create sends none, which the backend derives.
  const priority = edit ? (edit.priority === 'HIGH' ? 'HIGH' : 'LOW') : null
  // [lng, lat] resolved location (object / address hit / map-pick / the alarm's own coord)
  const [coord, setCoord] = useState<[number, number] | null>(draft ? draft.coord : realCoord(edit?.lng, edit?.lat))
  // Übung — stats-excluded + deletable. A Probealarm that opened itself gets retro-tagged here.
  const [isExercise, setIsExercise] = useState(draft?.isExercise ?? !!edit?.is_exercise)
  const [busy, setBusy] = useState(false)
  /** what the sheet opened with – frozen like `seed`: the draft is «what the operator changed» */
  const [opened] = useState<WizardFields>(() => ({
    title: edit?.title ?? '', address: edit?.address ?? '', kategorie: openedKategorie,
    coord: realCoord(edit?.lng, edit?.lat), isExercise: !!edit?.is_exercise,
  }))
  useEffect(() => {
    const kept = wizardDraft({
      title, address, kategorie, coord, isExercise,
      text: textTouched.current ? text : undefined,
      alarmiertAt: alarmiertAt !== openedAlarm ? alarmiertAt : undefined,
    }, opened)
    if (kept) keepDraft(draftKey, kept)
    else clearDraft(draftKey)
  }, [title, address, kategorie, coord, isExercise, text, alarmiertAt, opened, openedAlarm, draftKey])
  /** «Abbrechen»: the deliberate way out, so the draft goes too */
  const cancel = () => { clearDraft(draftKey); onClose() }
  // the Alarmmeldung fetch FAILED — the textarea is disabled and says so, and `text` stays out of
  // the PATCH body, so a save cannot blank what could not be read (see the fetch below)
  const [textFailed, setTextFailed] = useState(false)

  /** What the incident looked like when this panel opened — the baseline the save diffs against
   *  (see submit). Frozen on mount on purpose: it is «what the operator started from», so a
   *  background sync landing mid-edit must not quietly widen or narrow what the save writes. */
  const seed = useRef(edit ? {
    title: edit.title ?? '',
    type: edit.type ?? null,
    priority: edit.priority === 'HIGH' ? 'HIGH' : 'LOW',
    address: edit.address ?? null,
    started_at: edit.started_at ?? null,
    is_exercise: !!edit.is_exercise,
    lng: realCoord(edit.lng, edit.lat)?.[0] ?? null,
    lat: realCoord(edit.lng, edit.lat)?.[1] ?? null,
  } as Record<string, unknown> : null).current

  // THE list under the address field (owner 15.11.2026, round 2: «objekt oder adresse suchen
  // should just be in-line with the normal search bar»): typing shows the matching Feuerwehrpläne
  // objects AND the geocoder's addresses in one menu, objects first – the Karte & Objekte search
  // is the model (karte/KarteSearch). The object picker's own search field and fold are gone, and
  // so is the «Aus Plänen» button (owner, 15.11.2026: «the map and current location are enough») –
  // an object is found by typing its name or address, like everywhere else.
  const [menu, setMenu] = useState<'closed' | 'typing'>('closed')
  const [hits, setHits] = useState<GeoHit[]>([])
  const [addrLoading, setAddrLoading] = useState(false)
  // the lookup FAILED (an answer that was not a list) – said apart from «no address» (LISTS.1)
  const [addrFailed, setAddrFailed] = useState(false)
  const online = useOnline()
  const addrOpen = menu !== 'closed'
  const closeMenu = () => setMenu('closed')
  const addrSeq = useRef(0)
  // ⚠️ The menu has to CLOSE on an outside tap, the way Combo does. Nothing but picking a hit
  // ever closed it, so in edit mode — where the field is prefilled — merely tapping in to fix a
  // typo opened a 220px list over the Stichwort field below it.
  // The next tap anywhere in that band landed on an address row and silently rewrote the address
  // AND the coordinate. Esc closes the menu before the sheet, so the way out is not «discard
  // every edit».
  const addrRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!addrOpen) return
    const onDown = (e: PointerEvent) => {
      if (!addrRef.current?.contains(e.target as Node)) closeMenu()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()   // the sheet's own Esc must not fire and throw the edits away
      closeMenu()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [addrOpen])

  // the object library, loaded while the menu is open (null = not here yet)
  const [objects, setObjects] = useState<ObjectWithPlans[] | null>(null)

  // map picker (self-contained — works with no active incident yet)
  const [mapOpen, setMapOpen] = useState(false)

  // «Hier» — the PRIMARY location method: the EL usually stands at (or near) the Einsatzort,
  // so one tap takes a GPS fix; object library / map pick are the fallbacks for elsewhere
  const [locating, setLocating] = useState(false)
  // «Hier» found no position: said in the form's warning slot under the address (toast diet,
  // 17.11.2026 – a refusal inside an open form is said at the field), for as long as the
  // coordinate it failed to replace still stands. Any new coordinate (address hit, map, object)
  // or the next «Hier» press ends it.
  const [hereFailed, setHereFailed] = useState<{ at: [number, number] | null; blocked?: boolean } | null>(null)
  // ⚠️ On an EXISTING Einsatz «Hier» always asks first. It is the largest button in the panel
  // and it moves the Einsatzort to wherever the device is standing — and the panel is most often
  // opened from the Magazin, hours later, to fix an address. One mis-tap moved the incident to
  // the station and took the map, the Kroki framing, the offline tile box and the nearest-object
  // plan surfacing with it, silently. Creating is untouched: there is nothing to move yet.
  const confirmMove = async (c: [number, number]): Promise<boolean> => {
    const from = realCoord(edit?.lng, edit?.lat)
    if (!edit || !from) return true
    return confirmDialog({
      title: ix.moveConfirmTitle,
      message: fillTemplate(ix.moveConfirmMsg, { d: fmtDistance(haversineM(from, c)) }),
      confirmLabel: ix.moveConfirmBtn,
    })
  }
  const useHere = () => {
    if (locating) return
    // blocked says where to allow it (lib/permissionPath, rare-user round F9)
    const failed = (err?: GeolocationPositionError) => setHereFailed({ at: coord, blocked: err?.code === 1 })
    if (!navigator.geolocation) { failed(); return }
    setHereFailed(null)
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLocating(false)
        const c: [number, number] = [p.coords.longitude, p.coords.latitude]
        void confirmMove(c).then((ok) => { if (ok) applyPicked(c) })
      },
      (err) => { setLocating(false); failed(err) },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    )
  }

  // a coordinate from the map picker → set it and reverse-geocode the address (so a
  // map-click fills the nearest registered address, not just bare coords)
  const applyPicked = (c: [number, number]) => {
    setCoord(c); setMapOpen(false); closeMenu()
    // ⚠️ Fills a BLANK address only — the same rule the Rapport uses for the Kroki-seeded
    // Einsatzleiter. A nudge of the map pin used to overwrite an address somebody had just
    // typed by hand, and a typed address is a statement; a reverse-geocode is a guess.
    geocodeReverse(c[1], c[0])
      .then((hit) => { if (hit?.label) setAddress((a) => (a.trim() ? a : hit.label)) })
      .catch(() => {})
  }

  // debounced swisstopo autocomplete on the address field (skip while a hit is locked in)
  useEffect(() => {
    const q = address.trim()
    if (!addrOpen || q.length < 3) { setHits([]); setAddrLoading(false); setAddrFailed(false); return }
    const seq = ++addrSeq.current
    setAddrLoading(true)
    const t = setTimeout(() => {
      geocodeSearch(q).then((r) => { if (addrSeq.current === seq) { setHits(r); setAddrFailed(false); setAddrLoading(false) } })
        .catch(() => { if (addrSeq.current === seq) { setHits([]); setAddrFailed(true); setAddrLoading(false) } })
    }, 300)
    return () => clearTimeout(t)
  }, [address, addrOpen])

  // load the object library while the menu is open, ranked by the being-set / incident coord.
  // (No device GPS here: tapping in to type must not throw the browser's location dialog.)
  //
  // The whole library comes down once and the typing is filtered HERE, exactly as the
  // Planauswahl does it (components/PlanPicker): the list is ~150 objects, so filtering is
  // instant, and it is the only way the search covers the ADDRESS as well as the name. The
  // server's `q` matches one field at a time and forgives nothing — «grenzweg» found nothing
  // while the object sitting at Grenzweg 1 was two rows down, and a typo emptied the list.
  useEffect(() => {
    if (!addrOpen) return
    const ref = coord ?? nearCoord
    const near = ref ? `${ref[0]},${ref[1]}` : undefined
    listObjects(undefined, near).then(setObjects).catch(() => setObjects([]))
  }, [addrOpen, coord, nearCoord])

  // …the same tolerance every other picker has (lib/search): umlauts in either spelling and one
  // typo from four characters up. Name OR address — «BLT» and «Grenzweg» must both find the
  // Tramdepot, because an alarm names whichever of the two the caller knows. Objects match from
  // TWO characters (they are on the device, «BLT» is three); the geocoder keeps its three.
  const typed = address.trim()
  const shownObjects = useMemo(() => {
    if (!objects) return []
    if (!typed) return objects
    const needle = searchQuery(typed)
    return needle && typed.length >= 2 ? objects.filter((o) => matchesAnyQuery(needle, o.name, o.address)) : []
  }, [objects, typed])

  // Edit mode: pull the incident's Meldungstext (Alarmmeldung) — it isn't in IncidentMeta.
  useEffect(() => {
    if (!edit) return
    let alive = true
    getIncident(edit.id)
      .then((full) => { if (alive) { setText((t) => (t.trim() ? t : full.text ?? '')); setTextReady(true) } })
      // ⚠️ NOT setTextReady(true). The guard exists so a save before the fetch lands cannot
      // blank an existing Meldungstext — and the failure path is exactly when that matters:
      // on a bad connection `text` is still '' and the PATCH would write null over the
      // dispatch message the Rapport prints as «Alarmmeldung». Left false, the field stays
      // out of the body entirely and the textarea says why.
      .catch(() => { if (alive) setTextFailed(true) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit?.id])

  const pickHit = (h: GeoHit) => {
    setAddress(h.label); setCoord([h.lng, h.lat]); closeMenu(); setHits([])
  }
  const pickObject = (o: ObjectWithPlans) => {
    if (!title.trim()) setTitle(o.name)
    if (o.address) setAddress(o.address)
    if (o.lng != null && o.lat != null) setCoord([o.lng, o.lat])
    closeMenu()
  }

  // «Eröffnen» must never be a dead-end: after the primary «Hier»/GPS path the title is often
  // blank, which used to leave the button disabled with no hint. Fall back to the address
  // short-form, then the category label (set once the config has loaded) — a sensible incident name.
  // ⚠️ CREATE only. On an existing Einsatz the fallback is a silent rename: select-all in the
  // Stichwort field and, before a character is typed, the panel has already resolved a title —
  // save and «Gebäudebrand Schulhaus» becomes «Schulstrasse 4». Correcting is not creating; a
  // blank field there means «I am mid-edit», so the save waits instead of inventing a name.
  const effectiveTitle = edit
    ? title.trim()
    : title.trim() ||
      (address.trim() ? shortAddress(address.trim()) ?? '' : '') ||
      (kategorie ? kategorieText(kategorie) : '')
  // Demo: a visitor may explore the whole wizard, but actually opening a new Einsatz is blocked
  // (it would write to the shared backend). Editing the demo incident stays fully open.
  const demoBlocked = isDemoMode() && !edit
  const titleRef = useRef<HTMLLabelElement>(null)
  const demoRef = useRef<HTMLParagraphElement>(null)
  const submit = async () => {
    if (busy) return
    // Blocked — the Stichwort (an edit with it emptied) or the demo: the button stays tappable
    // and points at what holds it back (lib/pointAtField); a grey «Speichern» with a «*» somewhere
    // above it said nothing. `busy` stays a native disabled: that press is in flight.
    if (!effectiveTitle) { pointAtField(titleRef.current, { focus: titleRef.current?.querySelector('input') }); return }
    if (demoBlocked) { pointAtField(demoRef.current); return }
    setBusy(true)
    // Meldungstext/Alarmmeldung is sent on create, and on edit once the existing text has
    // been fetched (textReady) so a quick save can't blank it.
    const full = {
      title: effectiveTitle,
      type: kategorie,
      ...(priority ? { priority } : {}),
      address: address.trim() || null,
      ...(textReady ? { text: text.trim() || null } : {}),
      ...(asIso(alarmiertAt) ? { started_at: asIso(alarmiertAt) } : {}),
      is_exercise: isExercise,
      // the form can set or move the location, never clear it: the ✕ «Standort entfernen» went
      // with the «Koordinaten» fold (owner pick 1A, 15.11.2026), so no coordinate = nothing to send
      ...(coord ? { lng: coord[0], lat: coord[1] } : {}),
    } satisfies IncidentCreate
    // ⚠️ On EDIT, send only what actually changed. The full body re-wrote eight fields every
    // time, including three the operator may never have looked at — and `started_at` is the
    // expensive one: it is seeded through a formatter that drops seconds, and the backend stamps
    // `started_at_source = "manual"` whenever it arrives. So fixing a typo in the address rounded
    // a 03:14:37 alarm to 03:14:00 and told the statistics consumer a human had asserted the
    // time. A null `type`/`priority` was likewise invented into a value the backend deliberately
    // derives itself. Diffing also shrinks the last-write-wins window to the touched fields.
    const patch = edit ? changedOnly(full, seed) : null
    // nothing was touched — closing is the honest outcome, and it skips a write that would
    // otherwise re-stamp the record for no reason
    if (patch && !Object.keys(patch).length) { cancel(); return }
    try {
      const inc = edit && patch ? await patchIncident(edit.id, patch) : await createIncident(full)
      // no «Einsatz erstellt» toast (toast diet, 17.11.2026): the Einsatz opening IS the answer
      clearDraft(draftKey) // saved – the next open starts from the record
      onCreated(inc)
    } catch (e) {
      toast(e instanceof ApiError ? e.detail : edit ? ix.errorUpdate : ix.errorCreate, { icon: 'warn', tone: 'warn' })
      setBusy(false)
    }
  }

  // THE object order (lib/karte/places · sortObjects, LISTS.7): a name hit first, then nearest
  const orderedObjects = sortObjects(shownObjects, searchQuery(typed))
  // the Karte search's rows (karte/KarteSearch): glyph · name · address · distance. No chevron –
  // a pick fills the form, it opens nothing
  const objRow = (o: ObjectWithPlans) => (
    <ListRow key={o.id} onClick={() => pickObject(o)} chevron={false} lead={<Icon id="footprint" />} title={o.name}
      sub={objectPicklistSub(o, o.plans.length ? ix.objectPlans(o.plans.length) : ix.objectNoPlans)}
      end={o.distance_m != null ? fmtDistance(o.distance_m) : undefined} />
  )
  const menuBody = !!typed && (typed.length >= 3 || shownObjects.length > 0) && (
    <>
      {shownObjects.length > 0 && <ListGroup label={ix.objectsGroup}>{orderedObjects.map(objRow)}</ListGroup>}
      {/* the address search's four states (LISTS.1, the Karte search's): offline is not «no
          address», a failed lookup is not either – the objects above still work without both */}
      {typed.length >= 3 && (
        !online || addrFailed || addrLoading || !hits.length ? (
          <ListGroup label={ix.addressGroup} bare>
            {!online ? <div className="ip-ac-note"><Icon id="cloud-off" /> {ix.addressOffline}</div>
              : addrFailed ? <div className="form-warn form-warn-amber form-warn-compact"><Icon id="warn" /><span className="form-warn-text">{ix.addressFailed}</span></div>
              : addrLoading ? <div className="ip-ac-note"><LoadingStatus>{ix.addressSearching}</LoadingStatus></div>
              : <p className="no-hits">{fillTemplate(appConfig.copy.noHits, { q: typed })}</p>}
          </ListGroup>
        ) : (
          <ListGroup label={ix.addressGroup}>
            {hits.map((h, i) => {
              const [street, place] = splitAddress(h.label)
              return <ListRow key={`${h.label}:${i}`} onClick={() => pickHit(h)} chevron={false} lead={<Icon id="pin" />} title={street} sub={place} />
            })}
          </ListGroup>
        )
      )}
    </>
  )
  const menuShown = addrOpen && !!menuBody

  return (
    <>
    {mapOpen && <MapPicker initial={coord} onCancel={() => setMapOpen(false)} onConfirm={applyPicked} />}
    <Modal title={edit ? ix.editTitle : isExercise ? ix.titleNewExercise : ix.titleNew} onClose={onClose} footer={<>
      {/* «Abbrechen» in both modes (29.09.2026): the wizard is ONE step, and closing it goes back
          to the landing without opening anything — a cancel, not a «Zurück» to a previous step */}
      <button className="ip-btn" onClick={cancel}>{ix.cancel}</button>
      <button className="ip-btn primary" disabled={busy} aria-disabled={!effectiveTitle || demoBlocked} onClick={submit}>
        {/* one verb, title and button alike: «eröffnen» – and «Übung» once the kind says so */}
        {busy ? <><ShellLoader /> {edit ? ix.saving : ix.opening}</> : edit ? ix.save : isExercise ? ix.openExercise : ix.open}
      </button>
    </>}>
      {/* «Ernstfall | Übung» is the FIRST question (owner pick C7 = B, 17.11.2026): the kind used
          to be an «Übung? Nein | Ja» switch under Kategorie, missed on a drill evening – a real
          Einsatz then stays undeletable from the list for good. Both kinds are named, «Ernstfall»
          preselected; the consequence stays with «Übung», under its half. Same control when
          editing. Stored field and API unchanged (`is_exercise`). */}
      <div className="ip-kind">
        <Segmented ariaLabel={ix.kindLabel} value={isExercise} onChange={setIsExercise}
          options={[{ value: false, label: ix.kindReal }, { value: true, label: ix.exerciseLabel }]} />
        <small>{ix.exerciseSub}</small>
      </div>
      {/* ONE flat list of fields, no section eyebrows (owner review 10.11.2026: «only like 5
          things to put in») – each field's own label says what it is. --- Standort --- */}
      <div className="ip-field" ref={addrRef}>
        <span>{ix.addressLabel}</span>
        <AlarmNew field={alarmNew('address')} value={address} onTake={(v) => {
          setAddress(v); closeMenu()
          // the pin comes along: the alarm's own coordinate, else the first hit for the address
          const u = edit?.alarm_update
          const c = realCoord(u?.lng, u?.lat)
          if (c) setCoord(c)
          else geocodeSearch(v).then((h) => { if (h[0]) setCoord([h[0].lng, h[0].lat]) }).catch(() => {})
        }} />
        {/* The location methods ride the field's own right edge (owner pick 1A, 15.11.2026):
            «Auf Karte» | «Hier». They used to be a row of two buttons under the field plus «Hier»
            in it, and a «Koordinaten» fold under those – three rows for one question. «Aus Plänen»
            went too (round 2): typing finds the Feuerwehrpläne objects in the field's one menu.
            «Hier» (GPS) stays last, after the divider: the EL usually stands at (or near) the
            Einsatzort, so it is the primary method and has to be reachable the moment the field is
            in view. Icon-only, so each carries its word as `aria-label` and `title`. */}
        <div className="ip-ac-input-wrap">
          <input
            value={address}
            placeholder={ix.addressPlaceholder}
            onChange={(e) => { setAddress(e.target.value); setMenu((m) => (m === 'closed' ? 'typing' : m)) }}
            onFocus={() => setMenu((m) => (m === 'closed' ? 'typing' : m))}
          />
          <div className="ip-ac-tools">
            <button type="button" className="ip-ac-tool" aria-label={ix.mapPickButton} title={ix.mapPickButton} onClick={() => { closeMenu(); setMapOpen(true) }}>
              <Icon id="map" />
            </button>
            <span className="ip-ac-sep" aria-hidden="true" />
            <button type="button" className="ip-ac-tool ip-ac-locate" disabled={locating} onClick={useHere}
              aria-label={ix.hereButton} title={ix.hereButton}>
              {locating ? <ShellLoader /> : <Icon id="locate" />}
            </button>
          </div>
          {/* inside the wrap so it hangs from the INPUT, not from the warning line under it */}
          {menuShown && <div className="ip-ac-menu">{menuBody}</div>}
        </div>
        {/* ⚠️ The ONLY trace of the coordinate left on the form (owner pick 1A, 15.11.2026). The
            literal coordinate and its ✕ «Standort entfernen» went with the «Koordinaten» fold –
            five decimals nobody read. What stays is the one fact that matters: this Einsatz has NO
            location yet (no address hit, object, map pick or GPS fix), which an address typed by
            hand does not give it. A warning, so it is never behind anything; nothing when set. */}
        {hereFailed?.at === coord ? (
          <p className="form-warn form-warn-amber form-warn-compact" role="status">
            <Icon id="warn" /><span className="form-warn-text">{hereFailed.blocked ? locateBlockedText() : ix.hereFailed}</span>
          </p>
        ) : !coord && (
          <p className="form-warn form-warn-amber form-warn-compact" role="status">
            <Icon id="warn" /><span className="form-warn-text">{ix.coordMissing}</span>
          </p>
        )}
      </div>

      {/* --- Stichwort & Kategorie --- */}
      <label ref={titleRef} className="ip-field"><span>{ix.titleLabel} *</span>
        {/* no autofocus — the EL usually sets the location (address / object / map) first, so
            opening with the keyboard up over the Stichwort field would be in the way */}
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={ix.titlePlaceholder} />
      </label>
      <AlarmNew field={alarmNew('title')} value={title} onTake={setTitle} />
      <div className="ip-field"><span>{ix.categoryLabel}</span>
        {/* themed Combo instead of the OS select; options are display labels, the stored
            value stays the (German) kategorie key — mapped back on change */}
        <Combo
          value={kategorie ? kategorieText(kategorie) : ''}
          options={kategorien.map(kategorieText)}
          placeholder={ix.categoryLabel}
          clearable={false}
          onChange={(label) => {
            const key = kategorien.find((k) => kategorieText(k) === label) ?? label
            setKategorie(key)
          }}
        />
      </div>
      {/* --- Alarmierung — the dispatch facts, everything before we arrived: when we were alarmed
          + the alarm message. The Rapportangaben hold the rest. ONE section in both modes
          (29.09.2026): the wizard asked «Meldungstext (optional)» then «Alarmzeit» with no
          eyebrow, the edit sheet «Alarmzeit» then «Alarmmeldung» under «Alarmierung» — one field,
          two names, two places, and the Rapport says «Alarmmeldung». The eyebrow went with the
          other two on 10.11.2026; order and names stay.
          Creating, the time is prefilled with now — leave it for a live incident, set it back to
          enter an analog one afterwards (the paper report keeps the bookkeeping; this row is what
          puts the right date into the catalogue). --- */}
      <label className="ip-field"><span>{ix.alarmTime}</span>
        <DateTimeField ariaLabel={ix.alarmTime} value={alarmiertAt}
          onCommit={(iso) => setAlarmiertAt(iso ?? '')} />
      </label>
      <label className="ip-field"><span>{ix.alarmMessage}</span>
        {/* editing: disabled while the existing Meldungstext could not be read — editing it
            would mean typing over something invisible, and saving would blank it */}
        <textarea className="ip-textarea" rows={edit ? 3 : 2} value={text} disabled={!textReady}
          onChange={(e) => { textTouched.current = true; setText(e.target.value) }}
          placeholder={textFailed ? ix.alarmTextUnavailable : ix.detailsPlaceholder} />
      </label>
      {textReady && <AlarmNew field={alarmNew('text')} value={text} onTake={(v) => { textTouched.current = true; setText(v) }} />}

      {demoBlocked && <p ref={demoRef} className="ip-demo-block"><Icon id="info" /> {ix.demoBlocked}</p>}
    </Modal>
    </>
  )
}
