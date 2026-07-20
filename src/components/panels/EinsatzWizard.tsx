import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../lib/icons'
import { toast } from '../../lib/ui'
import { ApiError } from '../../lib/api'
import { useGeoPosition } from '../../lib/useGeoPosition'
import { MapPicker } from '../MapPicker'
import { DateTimeField } from '../TimeField'
import { Combo } from '../Combo'
import { appConfig } from '../../config/appConfig'
import { isDemoMode, shortAddress } from '../../lib/deploymentConfig'
import {
  createIncident,
  geocodeReverse,
  geocodeSearch,
  getIncident,
  listObjects,
  patchIncident,
  takeDiveraAlarm,
  type DiveraAlarm,
  type GeoHit,
  type IncidentFull,
  type IncidentMeta,
  type ObjectWithPlans,
} from '../../lib/incidents'
import { Modal, realCoord } from './_shared'

// --- Einsatz eröffnen (intake wizard, Phase 4) --------------------------------------
// `ix` (appConfig.copy.intake) is read inside each function below rather than captured at
// module-load, so the locale resolved at boot (config/copy) applies.

/** Pre-select a VKF category from a Divera Stichwort (first keyword hit wins). */
function guessKategorie(title: string): string | null {
  const up = (title || '').toUpperCase()
  // kategorieGuess is NOT localized (it mirrors the backend's German keyword map), so the
  // value is the same in any locale — but read through the getter for consistency.
  for (const [kw, label] of appConfig.copy.intake.kategorieGuess) if (up.includes(kw)) return label
  return null
}

/** ISO ⇄ <input type="datetime-local"> string (local time, minute precision). */
function dtLocalValue(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function dtIso(local: string): string | undefined {
  if (!local) return undefined
  const d = new Date(local)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

// Single guided panel used for both intake paths: a Divera alarm pre-fills every field
// (EL reviews/corrects), or a blank manual create with three location methods (object
// library · address autocomplete · map-pick). 3am tenet: nothing hidden, nothing to
// memorise, everything correctable before the incident is born.
export function EinsatzWizard({ seed, edit, nearCoord, onClose, onCreated }: {
  /** Divera alarm to review/override; null = manual create */
  seed: DiveraAlarm | null
  /** existing incident to correct in place (PATCH) instead of creating; null = create/take */
  edit?: IncidentMeta | null
  /** current incident coord, used to rank the object library by proximity */
  nearCoord?: [number, number] | null
  onClose: () => void
  onCreated: (inc: IncidentFull) => void
}) {
  const ix = appConfig.copy.intake // read per-render so the resolved locale applies
  const [title, setTitle] = useState(seed?.title ?? edit?.title ?? '')
  const [address, setAddress] = useState(seed?.address ?? edit?.address ?? '')
  // Alarmmeldung (= incident.text). On create/take it comes from the alarm; on edit it's
  // fetched from the incident below (IncidentMeta carries no text). `textReady` guards the
  // PATCH so a save before the fetch lands can't blank an existing Meldungstext.
  const [text, setText] = useState(seed?.text ?? '')
  const [textReady, setTextReady] = useState(!edit)
  // Alarmierungszeit (= incident.started_at): correctable in edit mode, and settable on
  // MANUAL create so a fully analog incident (no Divera) can be nachgetragen days later
  // with its real alarm time — that timestamp is what a website/statistics feed reads.
  // Defaults to now, so live creation needs no interaction. Divera take keeps the alarm's
  // own time (field hidden, nothing sent).
  const [alarmiertAt, setAlarmiertAt] = useState(
    dtLocalValue(edit ? edit.started_at : seed ? null : new Date().toISOString()),
  )
  // category defaults to the first VKF type (Brandbekämpfung) so the dropdown is never empty
  const [kategorie, setKategorie] = useState<string | null>(
    seed ? (guessKategorie(seed.title) ?? ix.kategorien[0]) : (edit?.type ?? ix.kategorien[0]),
  )
  // [lng, lat] resolved location (Divera coord / object / address hit / map-pick)
  const [coord, setCoord] = useState<[number, number] | null>(
    realCoord(seed?.lng, seed?.lat) ?? realCoord(edit?.lng, edit?.lat),
  )
  // Übung — stats-excluded + deletable. Manual create & edit only; a Divera take is a real
  // alarm (a taken Probealarm gets retro-tagged via the Einsatzdaten editor).
  const [isExercise, setIsExercise] = useState(!!edit?.is_exercise)
  const [busy, setBusy] = useState(false)

  // address autocomplete
  const [hits, setHits] = useState<GeoHit[]>([])
  const [addrLoading, setAddrLoading] = useState(false)
  const [addrOpen, setAddrOpen] = useState(false)
  const addrSeq = useRef(0)

  // object library picker
  const [objOpen, setObjOpen] = useState(false)
  const [objQuery, setObjQuery] = useState('')
  const [objects, setObjects] = useState<ObjectWithPlans[]>([])

  // map picker (self-contained — works with no active incident yet)
  const [mapOpen, setMapOpen] = useState(false)

  // «Hier» — the PRIMARY location method: the EL usually stands at (or near) the Einsatzort,
  // so one tap takes a GPS fix; object library / map pick are the fallbacks for elsewhere
  const [locating, setLocating] = useState(false)
  const useHere = () => {
    if (locating) return
    if (!navigator.geolocation) { toast(ix.hereFailed, { icon: 'warn', tone: 'warn' }); return }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (p) => { setLocating(false); applyPicked([p.coords.longitude, p.coords.latitude]) },
      () => { setLocating(false); toast(ix.hereFailed, { icon: 'warn', tone: 'warn' }) },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    )
  }

  // device GPS (watched only while the object picker is open) so "Objekt aus
  // Feuerwehrplänen" ranks by where the responder actually stands, not the incident coord
  const myPos = useGeoPosition(objOpen)

  // a coordinate from the map picker → set it and reverse-geocode the address (so a
  // map-click fills the nearest registered address, not just bare coords)
  const applyPicked = (c: [number, number]) => {
    setCoord(c); setMapOpen(false); setAddrOpen(false)
    geocodeReverse(c[1], c[0]).then((hit) => { if (hit?.label) setAddress(hit.label) }).catch(() => {})
  }

  // debounced swisstopo autocomplete on the address field (skip while a hit is locked in)
  useEffect(() => {
    const q = address.trim()
    if (!addrOpen || q.length < 3) { setHits([]); setAddrLoading(false); return }
    const seq = ++addrSeq.current
    setAddrLoading(true)
    const t = setTimeout(() => {
      geocodeSearch(q).then((r) => { if (addrSeq.current === seq) { setHits(r); setAddrLoading(false) } })
        .catch(() => { if (addrSeq.current === seq) { setHits([]); setAddrLoading(false) } })
    }, 300)
    return () => clearTimeout(t)
  }, [address, addrOpen])

  // load / filter the object library when its picker is open. Rank by the responder's own
  // GPS first (where they stand), falling back to the being-set / incident coord if denied.
  useEffect(() => {
    if (!objOpen) return
    const ref = myPos ?? coord ?? nearCoord
    const near = ref ? `${ref[0]},${ref[1]}` : undefined
    const t = setTimeout(() => {
      listObjects(objQuery.trim() || undefined, near).then(setObjects).catch(() => setObjects([]))
    }, 250)
    return () => clearTimeout(t)
  }, [objOpen, objQuery, myPos, coord, nearCoord])

  // Edit mode: pull the incident's Meldungstext (Alarmmeldung) — it isn't in IncidentMeta.
  useEffect(() => {
    if (!edit) return
    let alive = true
    getIncident(edit.id)
      .then((full) => { if (alive) { setText((t) => (t.trim() ? t : full.text ?? '')); setTextReady(true) } })
      .catch(() => { if (alive) setTextReady(true) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit?.id])

  const pickHit = (h: GeoHit) => {
    setAddress(h.label); setCoord([h.lng, h.lat]); setAddrOpen(false); setHits([])
  }
  const pickObject = (o: ObjectWithPlans) => {
    if (!title.trim()) setTitle(o.name)
    if (o.address) setAddress(o.address)
    if (o.lng != null && o.lat != null) setCoord([o.lng, o.lat])
    setObjOpen(false); setAddrOpen(false)
  }

  // «Eröffnen» must never be a dead-end: after the primary «Hier»/GPS path the title is often
  // blank, which used to leave the button disabled with no hint. Fall back to the address
  // short-form, then the category label (always set) — there's always a sensible incident name.
  const effectiveTitle =
    title.trim() ||
    (address.trim() ? shortAddress(address.trim()) ?? '' : '') ||
    (ix.kategorienLabels[kategorie ?? ix.kategorien[0]] ?? kategorie ?? ix.kategorien[0])
  // Demo: a visitor may explore the whole wizard, but actually opening a new Einsatz is blocked
  // (it would write to the shared backend). Edit / Divera-take stay allowed; only manual create.
  const demoBlocked = isDemoMode() && !edit && !seed
  const submit = async () => {
    if (!effectiveTitle || busy || demoBlocked) return
    setBusy(true)
    // Meldungstext/Alarmmeldung is sent on create/take, and on edit once the existing text
    // has been fetched (textReady) so a quick save can't blank it. Alarmierungszeit
    // (started_at) goes with edit and manual create (nachtragen); a Divera take keeps the
    // alarm's own time.
    const body = {
      title: effectiveTitle,
      type: kategorie,
      address: address.trim() || null,
      ...(textReady ? { text: text.trim() || null } : {}),
      ...(!seed && dtIso(alarmiertAt) ? { started_at: dtIso(alarmiertAt) } : {}),
      ...(!seed ? { is_exercise: isExercise } : {}),
      ...(coord ? { lng: coord[0], lat: coord[1] } : {}),
    }
    try {
      const inc = edit
        ? await patchIncident(edit.id, body)
        : seed
        ? await takeDiveraAlarm(seed.divera_id, body)
        : await createIncident(body)
      toast(edit ? ix.updated : seed ? ix.taken : ix.created, { icon: 'check', tone: 'success' })
      onCreated(inc)
    } catch (e) {
      const fallback = edit ? ix.errorUpdate : seed ? ix.errorTake : ix.errorCreate
      toast(e instanceof ApiError ? e.detail : fallback, { icon: 'warn', tone: 'warn' })
      setBusy(false)
    }
  }

  // near objects float to the top of the picker when we have a coordinate
  const near = objects.filter((o) => o.distance_m != null && o.distance_m <= 1000)
                       .sort((a, b) => (a.distance_m ?? 0) - (b.distance_m ?? 0))
  const nearIds = new Set(near.map((o) => o.id))
  const rest = objects.filter((o) => !nearIds.has(o.id)).sort((a, b) => a.name.localeCompare(b.name))
  const ObjRow = (o: ObjectWithPlans) => (
    <button key={o.id} type="button" className="ip-objrow" onClick={() => pickObject(o)}>
      <span className="ip-objrow-main">
        <span className="ip-objrow-name">{o.name}{o.distance_m != null ? <span className="ip-objrow-dist"> · {Math.round(o.distance_m)} m</span> : null}</span>
        <span className="ip-objrow-sub">{o.address ?? '—'} · {o.plans.length ? ix.objectPlans(o.plans.length) : ix.objectNoPlans}</span>
      </span>
    </button>
  )

  return (
    <>
    {mapOpen && <MapPicker initial={coord} onCancel={() => setMapOpen(false)} onConfirm={applyPicked} />}
    <Modal title={edit ? ix.editTitle : seed ? ix.titleDivera : ix.titleNew} onClose={onClose}>
      {seed && <div className="ip-divera-hint"><Icon id="truck" /> {ix.diveraHint}</div>}

      {/* --- Standort --- */}
      <div className="ip-ix-head">{ix.locationHead}</div>
      <div className="ip-field ip-ac">
        <span>{ix.addressLabel}</span>
        <input
          value={address}
          placeholder={ix.addressPlaceholder}
          onChange={(e) => { setAddress(e.target.value); setAddrOpen(true) }}
          onFocus={() => setAddrOpen(true)}
        />
        {addrOpen && (addrLoading || hits.length > 0 || address.trim().length >= 3) && (
          <div className="ip-ac-menu">
            {addrLoading && <div className="ip-ac-note">{ix.addressSearching}</div>}
            {!addrLoading && hits.length === 0 && <div className="ip-ac-note">{ix.addressNoHits}</div>}
            {hits.map((h, i) => (
              <button key={i} type="button" className="ip-ac-row" onClick={() => pickHit(h)}>
                <Icon id="flag" /> <span>{h.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="ip-ix-methods">
        <button type="button" className="ip-btn primary" disabled={locating} onClick={useHere}>
          <Icon id={locating ? 'rotate' : 'locate'} className={locating ? 'spin' : undefined} /> {ix.hereButton}
        </button>
        <button type="button" className={`ip-btn${objOpen ? ' on' : ''}`} onClick={() => setObjOpen((v) => !v)}>
          <Icon id="doc" /> {ix.objectButton}
        </button>
        <button type="button" className="ip-btn" onClick={() => setMapOpen(true)}>
          <Icon id="map" /> {ix.mapPickButton}
        </button>
      </div>

      {objOpen && (
        <div className="ip-objpick">
          <input className="ip-search" value={objQuery} placeholder={ix.objectSearchPlaceholder} onChange={(e) => setObjQuery(e.target.value)} />
          <div className="ip-objlist">
            {objects.length === 0 && <div className="ip-ac-note">{ix.objectNoHits}</div>}
            {near.length > 0 && <div className="ip-objgroup">{ix.objectNear}</div>}
            {near.map(ObjRow)}
            {rest.map(ObjRow)}
          </div>
        </div>
      )}

      <div className={`ip-loc${coord ? ' set' : ''}`}>
        <Icon id={coord ? 'flag' : 'warn'} />
        {coord ? (
          <>
            <span className="ip-loc-txt">{ix.coordSet} · {coord[1].toFixed(5)}, {coord[0].toFixed(5)}</span>
            <button type="button" className="ip-loc-clear" onClick={() => setCoord(null)} aria-label={ix.coordClear}><Icon id="close" /></button>
          </>
        ) : (
          <span className="ip-loc-txt">{ix.coordNone}</span>
        )}
      </div>

      {/* --- Stichwort & Kategorie --- */}
      <div className="ip-ix-head">{ix.keywordHead}</div>
      <label className="ip-field"><span>{ix.titleLabel} *</span>
        {/* no autofocus — the EL usually sets the location (address / object / map) first, so
            opening with the keyboard up over the Stichwort field would be in the way */}
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={ix.titlePlaceholder} />
      </label>
      <div className="ip-field"><span>{ix.categoryLabel}</span>
        {/* themed Combo instead of the OS select; options are display labels, the stored
            value stays the (German) kategorie key — mapped back on change */}
        <Combo
          value={ix.kategorienLabels[kategorie ?? ix.kategorien[0]] ?? kategorie ?? ix.kategorien[0]}
          options={ix.kategorien.map((k) => ix.kategorienLabels[k] ?? k)}
          placeholder={ix.categoryLabel}
          clearable={false}
          onChange={(label) => {
            const key = ix.kategorien.find((k) => (ix.kategorienLabels[k] ?? k) === label) ?? label
            setKategorie(key)
          }}
        />
      </div>
      {!seed && (
        <label className="ip-check">
          <input type="checkbox" checked={isExercise} onChange={(e) => setIsExercise(e.target.checked)} />
          <span>{ix.exerciseToggle}</span>
        </label>
      )}
      {/* create/take: free-text Meldungstext stays under the keyword section */}
      {!edit && (
        <label className="ip-field"><span>{ix.detailsLabel}</span>
          <textarea className="ip-textarea" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={ix.detailsPlaceholder} />
        </label>
      )}
      {/* manual create: Alarmierungszeit, prefilled with now — leave it for a live incident,
          set it back to nachtragen an analog one (paper report keeps the bookkeeping; this
          row is what puts the right date into the catalogue). Divera take: alarm's time. */}
      {!edit && !seed && (
        <label className="ip-field"><span>{ix.alarmTime}</span>
          <DateTimeField ariaLabel={ix.alarmTime} value={dtIso(alarmiertAt)}
            onCommit={(iso) => setAlarmiertAt(dtLocalValue(iso))} />
        </label>
      )}

      {/* --- Alarmierung (edit only) — the dispatch facts, everything before we arrived:
          when we were alarmed + the alarm message. The Rapportangaben hold the rest. --- */}
      {edit && (
        <>
          <div className="ip-ix-head">{ix.alarmierungHead}</div>
          <label className="ip-field"><span>{ix.alarmTime}</span>
            <DateTimeField ariaLabel={ix.alarmTime} value={dtIso(alarmiertAt)}
              onCommit={(iso) => setAlarmiertAt(dtLocalValue(iso))} />
          </label>
          <label className="ip-field"><span>{ix.alarmMessage}</span>
            <textarea className="ip-textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={ix.detailsPlaceholder} />
          </label>
        </>
      )}

      {demoBlocked && <p className="ip-demo-block"><Icon id="info" /> {ix.demoBlocked}</p>}
      <div className="ip-actions">
        {/* manual create is reached from the intake pool — "Zurück" signals it returns there */}
        <button className="ip-btn" onClick={onClose}>{!seed && !edit ? ix.back : ix.cancel}</button>
        <button className="ip-btn primary" disabled={!effectiveTitle || busy || demoBlocked} onClick={submit}>
          {busy ? <><Icon id="rotate" className="spin" /> {edit ? ix.saving : ix.opening}</> : edit ? ix.save : ix.open}
        </button>
      </div>
    </Modal>
    </>
  )
}
