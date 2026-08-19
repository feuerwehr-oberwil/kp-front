import { useEffect, useMemo, useRef, useState } from 'react'
import { caretToEnd } from '../lib/ui'
import { ApiError } from '../lib/api'
import { Sheet } from '../lib/overlays'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { DEFAULT_MODULES, getDeploymentConfig, type DeploymentModule } from '../lib/deploymentConfig'
import type { ObjectWithPlans, ReferenceDataset } from '../lib/incidents'
import { Field, fmtDate } from './ui'
import {
  InsecureContextError,
  normaliseObjectKey,
  objectIdForKey,
  saveObject,
  uploadPlan,
  type ObjectInput,
} from './stationDataApi'
import './stationData.css'

// The create/edit sheet behind «Objekt hinzufügen» / «Bearbeiten» on the Objektpläne page.
// Two halves, in the order they are needed: the object itself, then its Modul-PDFs — the
// second half only once the object exists, because a plan is stored under the object's id.
//
// The id is never typed. It is the uuid5 of a short, retypable `key` (see stationDataApi ·
// objectIdForKey), which is the same derivation `admin_objects` uses — so a station that later
// maintains a manifest addresses THIS object with the same key instead of creating a twin.

/** Human size for a stored plan; null → "—". */
function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** The in-force module catalogue: the station's own, or the shipped national defaults when it
 *  has none — exactly what ModulesViewer shows above this sheet. */
function liveModules(): DeploymentModule[] {
  const configured = getDeploymentConfig().modules ?? []
  const mods = configured.length ? configured : DEFAULT_MODULES
  return mods.slice().sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.id.localeCompare(b.id))
}

/** One upload slot: a module id to write under, plus how to label it. */
interface Slot {
  /** the `module` path segment — `modul3`, or `modul5-wasser` for a family sub-slot */
  id: string
  code?: string
  title: string
  plan: ReferenceDataset | null
  /** true when this slot is not in the catalogue (a plan the CLI or the pull wrote) */
  offCatalogue?: boolean
}

/** Catalogue modules → upload slots, with every stored plan filed under one. A family module
 *  (Modul 5) contributes one slot per sub-slot it already has; new ones are added by name.
 *  Whatever is left over — a module the catalogue no longer lists — still gets a slot, because
 *  a plan the page cannot show is a plan the crew opens and nobody can replace. */
export function planSlots(modules: DeploymentModule[], plans: ReferenceDataset[]): Slot[] {
  const byModule = new Map(plans.filter((p) => p.module).map((p) => [p.module as string, p]))
  const used = new Set<string>()
  const take = (id: string) => {
    used.add(id)
    return byModule.get(id) ?? null
  }
  const slots: Slot[] = []
  for (const m of modules) {
    if (m.family) {
      const subs = [...byModule.keys()]
        .filter((mod) => mod === m.id || mod.startsWith(`${m.id}-`))
        .sort()
      for (const sub of subs) {
        slots.push({
          id: sub,
          code: m.code,
          title: sub === m.id ? (m.title ?? m.id) : `${m.title ?? m.id} · ${sub.slice(m.id.length + 1)}`,
          plan: take(sub),
        })
      }
      continue
    }
    slots.push({ id: m.id, code: m.code, title: m.title ?? m.id, plan: take(m.id) })
  }
  for (const [mod, plan] of byModule) {
    if (!used.has(mod)) slots.push({ id: mod, title: mod, plan, offCatalogue: true })
  }
  return slots
}

type Save = { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; detail: string }

export function ObjectSheet({ object, onClose, onChanged }: {
  /** null = create a new Einsatzobjekt */
  object: ObjectWithPlans | null
  onClose: () => void
  /** called after every server write, so the list + map behind the sheet stay true */
  onChanged: (obj: ObjectWithPlans) => void
}) {
  const C = appConfig.copy.admin.objects
  const Cc = appConfig.copy.admin.common2
  // `saved` is the object as the server has it: the prop when editing, and what the first
  // save returned when creating. Plans hang off it, so it also gates the second half.
  const [saved, setSaved] = useState<ObjectWithPlans | null>(object)
  const [key, setKey] = useState('')
  const [derivedId, setDerivedId] = useState<{ key: string; id: string } | null>(null)
  const [name, setName] = useState(object?.name ?? '')
  const [address, setAddress] = useState(object?.address ?? '')
  const [lat, setLat] = useState(object?.lat != null ? String(object.lat) : '')
  const [lng, setLng] = useState(object?.lng != null ? String(object.lng) : '')
  const [note, setNote] = useState(object?.source_note ?? '')
  const [save, setSave] = useState<Save>({ kind: 'idle' })
  const [keyError, setKeyError] = useState<string | null>(null)

  const normalisedKey = normaliseObjectKey(key)

  // Derive the id as the key is typed, so the operator sees the handle their key produces
  // before anything is written. Async (WebCrypto) — a stale answer must not overwrite a newer
  // one, hence the token check.
  useEffect(() => {
    if (saved || !normalisedKey) return // nothing to derive; `idFor` below discards the stale one
    let alive = true
    void objectIdForKey(normalisedKey)
      .then((id) => { if (alive) { setDerivedId({ key: normalisedKey, id }); setKeyError(null) } })
      .catch((e) => {
        if (!alive) return
        setDerivedId(null)
        setKeyError(e instanceof InsecureContextError ? C.keyInsecure : C.keyRequired)
      })
    return () => { alive = false }
  }, [normalisedKey, saved, C.keyInsecure, C.keyRequired])
  // The derived id is only valid for the key it was derived FROM — the async answer for a
  // previous keystroke must never be the id a save writes to.
  const objectId = saved?.id ?? (derivedId?.key === normalisedKey ? derivedId.id : null)

  const coords = useMemo(() => parseCoords(lat, lng, C), [lat, lng, C])
  const canSave = name.trim().length > 0 && coords.ok && objectId != null

  const submit = async () => {
    if (!canSave || save.kind === 'busy' || !coords.ok) return
    setSave({ kind: 'busy' })
    try {
      if (!objectId) throw new Error('no id')
      const body: ObjectInput = {
        name: name.trim(),
        address: address.trim() || null,
        lat: coords.lat,
        lng: coords.lng,
        source_note: note.trim() || null,
      }
      const written = await saveObject(objectId, body)
      // `PUT /api/objects/{id}` answers ObjectOut — no plans — so carry the ones we already know.
      const merged: ObjectWithPlans = { ...written, plans: saved?.plans ?? [], distance_m: null }
      setSaved(merged)
      setSave({ kind: 'idle' })
      onChanged(merged)
    } catch (e) {
      setSave({ kind: 'error', detail: e instanceof ApiError ? e.detail : C.saveFailed })
    }
  }

  // Replace-by-id, never append: a corrected PDF comes back under the SAME dataset id with a
  // bumped version, and a second row here would claim a duplicate the server does not have.
  const onPlanStored = (ds: ReferenceDataset) => {
    if (!saved) return
    const plans = [...saved.plans.filter((p) => p.id !== ds.id), ds].sort((a, b) =>
      (a.module ?? '').localeCompare(b.module ?? ''),
    )
    const next = { ...saved, plans }
    setSaved(next)
    onChanged(next)
  }

  return (
    <Sheet
      open
      onClose={onClose}
      wide
      title={saved ? C.editTitle : C.newTitle}
      sheetClassName="adm-objsheet"
      footer={
        <>
          <button type="button" className="ip-btn" onClick={onClose}>{Cc.cancel}</button>
          <button
            type="button"
            className="ip-btn primary"
            disabled={!canSave || save.kind === 'busy'}
            onClick={() => void submit()}
          >
            {save.kind === 'busy' ? C.saving : C.save}
          </button>
        </>
      }
    >
      {/* ── the object ───────────────────────────────────────────────────────── */}
      {saved ? (
        <p className="adm-hint adm-obj-idline">
          {C.derivedId}: <code>{saved.id}</code>
        </p>
      ) : (
        <Field label={C.keyLabel} hint={C.keyHint} tip={C.keyTip}>
          <input
            className="adm-input adm-input-mono"
            value={key}
            autoFocus
            onFocus={caretToEnd}
            onChange={(e) => setKey(e.target.value)}
            placeholder={C.keyPlaceholder}
          />
        </Field>
      )}
      {!saved && objectId && (
        <p className="adm-hint adm-obj-idline">
          {C.derivedId}: <code>{objectId}</code>
        </p>
      )}
      {keyError && <p className="adm-state adm-state-err">{keyError}</p>}

      <Field label={C.nameLabel}>
        <input className="adm-input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={C.addressLabel} hint={C.addressHint} tip={C.addressTip}>
        <input className="adm-input" value={address} onChange={(e) => setAddress(e.target.value)} />
      </Field>
      <div className="adm-row-2">
        <Field label={C.latLabel} tip={C.coordsTip}>
          <input
            className="adm-input adm-input-mono"
            inputMode="decimal"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            placeholder="47.4712"
          />
        </Field>
        <Field label={C.lngLabel}>
          <input
            className="adm-input adm-input-mono"
            inputMode="decimal"
            value={lng}
            onChange={(e) => setLng(e.target.value)}
            placeholder="7.5501"
          />
        </Field>
      </div>
      {!coords.ok && <p className="adm-state adm-state-err">{coords.error}</p>}
      <Field label={C.noteLabel} hint={C.noteHint}>
        <input className="adm-input" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {save.kind === 'error' && <p className="adm-state adm-state-err">{save.detail}</p>}

      {/* ── its Modul-PDFs ───────────────────────────────────────────────────── */}
      <h3 className="adm-fieldgroup">{C.plansTitle}</h3>
      {saved ? <PlanSlots object={saved} onStored={onPlanStored} /> : <p className="adm-hint">{C.plansHintNew}</p>}
    </Sheet>
  )
}

/** The per-module upload list. Its own component so a plan upload re-renders only this half. */
function PlanSlots({ object, onStored }: { object: ObjectWithPlans; onStored: (ds: ReferenceDataset) => void }) {
  const C = appConfig.copy.admin.objects
  const modules = useMemo(() => liveModules(), [])
  const slots = useMemo(() => planSlots(modules, object.plans), [modules, object.plans])
  const family = useMemo(() => modules.filter((m) => m.family), [modules])
  const [busySlot, setBusySlot] = useState<string | null>(null)
  const [err, setErr] = useState<{ slot: string; detail: string } | null>(null)

  const upload = async (slotId: string, file: File) => {
    setBusySlot(slotId)
    setErr(null)
    try {
      onStored(await uploadPlan(object.id, slotId, file))
    } catch (e) {
      setErr({ slot: slotId, detail: e instanceof ApiError ? e.detail : C.uploadFailed })
    } finally {
      setBusySlot(null)
    }
  }

  return (
    <>
      <p className="adm-hint">{C.plansHint}</p>
      <ul className="adm-slots">
        {slots.map((s) => (
          <li className="adm-slot" key={s.id}>
            <div className="adm-slot-id">
              {s.code && <span className="adm-view-code">{s.code}</span>}
              <span className="adm-slot-title">{s.title}</span>
              <span className="adm-view-key">{s.id}</span>
              {s.offCatalogue && <span className="adm-view-badge adm-view-badge-warn">{C.offCatalogue}</span>}
            </div>
            <div className="adm-slot-state">
              {s.plan ? (
                <a
                  className="adm-link adm-slot-plan"
                  href={`/api/reference/${encodeURIComponent(s.plan.id)}?v=${s.plan.current_version}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Icon id="doc" />
                  {fillTemplate(C.planVersion, { n: s.plan.current_version, date: fmtDate(s.plan.updated_at) })}
                  <span className="adm-ref-note">{fmtBytes(s.plan.size_bytes)}</span>
                </a>
              ) : (
                <span className="adm-fleet-freeval">{C.noPlanYet}</span>
              )}
            </div>
            <PdfButton
              label={s.plan ? C.replacePdf : C.choosePdf}
              busy={busySlot === s.id}
              busyLabel={C.uploading}
              onPick={(f) => void upload(s.id, f)}
            />
            {err?.slot === s.id && <p className="adm-state adm-state-err adm-slot-err">{err.detail}</p>}
          </li>
        ))}
        {family.map((m) => (
          <NewSubSlot
            key={`new-${m.id}`}
            module={m}
            busy={busySlot?.startsWith(m.id) ?? false}
            onPick={(slotId, file) => void upload(slotId, file)}
          />
        ))}
      </ul>
    </>
  )
}

/** A family module's «add a sub-slot» row (Modul 5 – Wasser). The suffix is typed once and the
 *  slot exists the moment a PDF lands in it; there is nothing else to create. */
function NewSubSlot({ module, busy, onPick }: {
  module: DeploymentModule
  busy: boolean
  onPick: (slotId: string, file: File) => void
}) {
  const C = appConfig.copy.admin.objects
  const [suffix, setSuffix] = useState('')
  const slug = suffix.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
  const slotId = slug ? `${module.id}-${slug}` : module.id
  return (
    <li className="adm-slot adm-slot-new">
      <div className="adm-slot-id">
        {module.code && <span className="adm-view-code">{module.code}</span>}
        <span className="adm-slot-title">{fillTemplate(C.subslotAdd, { module: module.title ?? module.id })}</span>
        <span className="adm-view-key">{slotId}</span>
      </div>
      <div className="adm-slot-state">
        <input
          className="adm-input adm-input-mono adm-slot-suffix"
          value={suffix}
          onChange={(e) => setSuffix(e.target.value)}
          placeholder={C.subslotPlaceholder}
          aria-label={C.subslotLabel}
        />
      </div>
      <PdfButton
        label={C.choosePdf}
        busy={busy}
        busyLabel={C.uploading}
        disabled={!slug}
        onPick={(f) => onPick(slotId, f)}
      />
    </li>
  )
}

/** A file picker that looks like a button. Native `<input type=file>` chrome is unstyleable and
 *  differs per OS; the input stays in the DOM (it is what actually opens the picker) and is
 *  driven by the button, the same pattern ConfigBackup uses for the config import. */
function PdfButton({ label, busy, busyLabel, disabled, onPick }: {
  label: string
  busy: boolean
  busyLabel: string
  disabled?: boolean
  onPick: (file: File) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <div className="adm-slot-act">
      <button
        type="button"
        className="btn adm-int-btn"
        disabled={busy || disabled}
        onClick={() => ref.current?.click()}
      >
        {busy ? busyLabel : label}
      </button>
      <input
        ref={ref}
        type="file"
        accept="application/pdf,.pdf"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = '' // so picking the SAME corrected file twice still fires
          if (f) onPick(f)
        }}
      />
    </div>
  )
}

/** Coordinates: both or neither, WGS84 decimal degrees. LV95 metres are the mistake this
 *  catches — `admin_geodata` refuses them at its own door for the same reason, and a projected
 *  pair silently placed on the map is an Einsatzobjekt nobody finds. */
export function parseCoords(
  latRaw: string,
  lngRaw: string,
  msg: { coordsPair: string; coordsInvalid: string; coordsProjected: string },
): { ok: true; lat: number | null; lng: number | null } | { ok: false; error: string } {
  const a = latRaw.trim().replace(',', '.')
  const b = lngRaw.trim().replace(',', '.')
  if (!a && !b) return { ok: true, lat: null, lng: null }
  if (!a || !b) return { ok: false, error: msg.coordsPair }
  const latN = Number(a)
  const lngN = Number(b)
  if (!Number.isFinite(latN) || !Number.isFinite(lngN)) return { ok: false, error: msg.coordsInvalid }
  if (Math.abs(latN) > 180 || Math.abs(lngN) > 180) return { ok: false, error: msg.coordsProjected }
  if (Math.abs(latN) > 90) return { ok: false, error: msg.coordsInvalid }
  return { ok: true, lat: latN, lng: lngN }
}
