import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { caretToEnd } from '../lib/ui'
import { ApiError } from '../lib/api'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { type DeploymentModule } from '../lib/deploymentConfig'
import { moduleCatalogue, sortPlanModules } from '../lib/planOrder'
import type { ObjectWithPlans, ReferenceDataset } from '../lib/incidents'
import { planSourceLabel, usePlanSources } from './ModulesViewer'
import { fmtDate, SettingRow, SettingsNote, SettingsSheet } from './ui'
import {
  InsecureContextError,
  normaliseObjectKey,
  objectIdForKey,
  saveObject,
  uploadPlan,
  type ObjectInput,
} from './stationDataApi'
import './stationData.css'

// The Einsatzobjekt editor — the object's own fields plus its Modul-PDF slots. It is the BODY
// of two surfaces and owns no frame of its own: the Objektpläne detail page renders it inline
// (the page IS the editor), and `ObjectSheet` is the same body inside a `Sheet`.
//
// Two halves, in the order they are needed: the object itself, then its Modul-PDFs — the
// second half only once the object exists, because a plan is stored under the object's id.
//
// The id is never typed. It is the uuid5 of a short, retypable `key` (see stationDataApi ·
// objectIdForKey), which is the same derivation `admin_objects` uses — so a station that later
// maintains a manifest addresses THIS object with the same key instead of creating a twin.
//
// ⚠️ The two scheduled pulls do NOT find an object the same way, and the editor says which one
// finds this one. The Planspeicher matches on the stored `source_key`, which this form cannot
// write — an object created here is one it skips on every run, for good. SharePoint matches on
// the uuid5 of its folder name, i.e. exactly the derivation above — so an object created here
// IS reachable, the moment a folder carries its key. Two different sentences, and only the ones
// the deployment's configured pulls make true are printed (`usePlanSources`).

/** Human size for a stored plan; null → "—". Exported so the detail page's merged plan rows
 *  say the same thing about the same bytes as the sheet's slot list. */
export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** The in-force module catalogue, in the ONE order every surface lists modules in
 *  (`lib/planOrder`) — exactly what ModulesViewer shows. Only for callers that have no catalogue
 *  of their own; the Objektpläne page passes the one its page already holds. */
export function liveModules(): DeploymentModule[] {
  return sortPlanModules(moduleCatalogue())
}

/** One upload slot: a module id to write under, plus how to label it. */
export interface Slot {
  /** the `module` path segment — `modul3`, or `modul5-wasser` for a family sub-slot */
  id: string
  /** the short form this slot is IDENTIFIED by on every surface — «M3», «M5 PV» */
  short: string
  title: string
  plan: ReferenceDataset | null
  /** true when this slot is not in the catalogue (a plan the CLI or the pull wrote) */
  offCatalogue?: boolean
}

/** A catalogue entry's own short form: its `code`, or the number its id already carries. */
function moduleCode(module: DeploymentModule): string {
  const n = /^modul(\d+)$/.exec(module.id)
  return module.code ?? (n ? `M${n[1]}` : module.id)
}

/** A family sub-slot's suffix as it is READ, not as it is stored: `pv` → «PV», `evak` → «Evak».
 *  Two or three letters are an acronym on paper (PV, BMA, UG); anything longer is a word. */
function subSlotLabel(suffix: string): string {
  const word = suffix.replace(/-/g, ' ').trim()
  if (!word) return ''
  return word.length <= 3 ? word.toLocaleUpperCase() : word.charAt(0).toLocaleUpperCase() + word.slice(1)
}

/**
 * The short form a module is known by on paper — «M1», «M6». A family sub-slot (`modul5-pv`) is
 * no catalogue entry of its own, so it is read off its family plus its suffix: «M5 PV».
 *
 * ⚠️ The ONE derivation: the object table's Pläne column, the Modulpläne rows and the sheet's
 * slot list all say the same thing about the same id — and none of them ever prints a raw
 * `modulN-…` key, which is a storage path, not something a Kommandant reads at 3am. A plan whose
 * module the catalogue dropped still gets one, because its id carries the number anyway.
 */
export function moduleShortForm(modules: DeploymentModule[], moduleId: string | null | undefined): string {
  if (!moduleId) return '—'
  const exact = modules.find((m) => m.id === moduleId)
  if (exact) return moduleCode(exact)
  const family = modules.find((m) => m.family && moduleId.startsWith(`${m.id}-`))
  if (family) return `${moduleCode(family)} ${subSlotLabel(moduleId.slice(family.id.length + 1))}`.trim()
  const parts = /^modul(\d+)(?:-(.+))?$/.exec(moduleId)
  if (parts) return parts[2] ? `M${parts[1]} ${subSlotLabel(parts[2])}`.trim() : `M${parts[1]}`
  return moduleId
}

/** Catalogue modules → upload slots, with every stored plan filed under one. A family module
 *  (Modul 5) contributes one slot per sub-slot it already has; new ones are added by name — the
 *  sub-slot's name lives in its short form («M5 PV»), so its title stays the family's.
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
      // ⚠️ never a sub-slot that is a catalogue entry of its own (`modul5-pv` beside the family
      // `modul5`): it gets its slot from its own turn in this loop, and pushing it here as well
      // put the same module in the table twice, under a duplicate React key.
      const subs = [...byModule.keys()]
        .filter((mod) => mod === m.id || (mod.startsWith(`${m.id}-`) && !modules.some((x) => x.id === mod)))
        .sort()
      for (const sub of subs) {
        slots.push({
          id: sub,
          short: moduleShortForm(modules, sub),
          title: m.title ?? m.id,
          plan: take(sub),
        })
      }
      continue
    }
    slots.push({ id: m.id, short: moduleCode(m), title: m.title ?? m.id, plan: take(m.id) })
  }
  for (const [mod, plan] of byModule) {
    if (!used.has(mod)) {
      // no catalogue entry to take a title from — the stored plan's own is the only name it has
      slots.push({ id: mod, short: moduleShortForm(modules, mod), title: plan.title || mod, plan, offCatalogue: true })
    }
  }
  return slots
}

type Save = { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; detail: string }

/** How long after the last keystroke an existing object writes itself. The same debounce the
 *  rest of the Verwaltung autosaves on (ConfigContext · AUTOSAVE_DELAY_MS) — one rhythm, so a
 *  field feels the same wherever it is edited. */
const AUTOSAVE_DELAY_MS = 700

/** The form's fields as strings, as the server's answer spells them — the baseline the autosave
 *  compares against, so a form nobody changed writes nothing. */
function fieldsOf(obj: ObjectWithPlans | null) {
  return {
    name: obj?.name ?? '',
    address: obj?.address ?? '',
    lat: obj?.lat != null ? String(obj.lat) : '',
    lng: obj?.lng != null ? String(obj.lng) : '',
    note: obj?.source_note ?? '',
  }
}

/**
 * The editor. `object` null = create a new Einsatzobjekt; the plan half appears the moment the
 * first save returns, exactly the sequencing the object's id forces.
 *
 * ⚠️ An EXISTING object's fields commit themselves: a valid change writes itself
 * AUTOSAVE_DELAY_MS after the last keystroke, and at once when the field is left — there is no
 * «Speichern» to forget. CREATE is the one exception, and it keeps its explicit «Objekt
 * erstellen»: the id has to exist before a plan can be stored under it, so the first write is a
 * decision, not a side effect of typing a name.
 *
 * `plans` is how the second half is DRAWN. Left out, it is the plain per-module upload list
 * (what the sheet shows). The Objektpläne detail page passes its own, so that one row per
 * module carries the plan's preparation status and «Vorbereiten» beside the upload control.
 */
export function ObjectEditor({ object, onChanged, plans }: {
  /** null = create a new Einsatzobjekt */
  object: ObjectWithPlans | null
  /** called after every server write, so the list + map behind the editor stay true */
  onChanged: (obj: ObjectWithPlans) => void
  /** how the plan half is drawn once the object exists; default = the plain upload slots */
  plans?: (saved: ObjectWithPlans, onStored: (ds: ReferenceDataset) => void) => ReactNode
}) {
  const C = appConfig.copy.admin.objects
  const sources = usePlanSources()
  // `saved` is the object as the server has it: the prop when editing, and what the first
  // save returned when creating. Plans hang off it, so it also gates the second half.
  const [saved, setSaved] = useState<ObjectWithPlans | null>(object)
  const [key, setKey] = useState('')
  const [derivedId, setDerivedId] = useState<{ key: string; id: string } | null>(null)
  const [fields, setFields] = useState(() => fieldsOf(object))
  const [save, setSave] = useState<Save>({ kind: 'idle' })
  const [keyError, setKeyError] = useState<string | null>(null)
  const [flash, setFlash] = useState(false)

  const { name, address, lat, lng, note } = fields
  const set = <K extends keyof typeof fields>(field: K, value: string) => {
    setFlash(false)
    setFields((prev) => ({ ...prev, [field]: value }))
  }

  const normalisedKey = normaliseObjectKey(key)

  // Derive the id as the key is typed, so the operator sees the handle their key produces
  // before anything is written. Async (WebCrypto) — a stale answer must not overwrite a newer
  // one, hence the token check.
  useEffect(() => {
    if (saved || !normalisedKey) return // nothing to derive; `objectId` below discards the stale one
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
  // Dirty-aware: a form that says nothing new writes nothing. A new object is dirty by
  // definition — there is nothing on the server to be equal to yet.
  const base = fieldsOf(saved)
  const dirty = !saved || (Object.keys(base) as (keyof typeof base)[]).some((k) => fields[k] !== base[k])
  const canSave = name.trim().length > 0 && coords.ok && objectId != null && dirty

  // What is on screen RIGHT NOW, and the current `submit` — both read from OUTSIDE a render (an
  // in-flight write, a debounce timer), which is exactly what a ref is for. Kept in step by the
  // effect below, declared before the autosave effect so it has run by the time that one arms.
  const fieldsRef = useRef(fields)
  const submitRef = useRef<() => Promise<void>>(async () => {})

  const submit = async () => {
    if (!canSave || save.kind === 'busy' || !coords.ok) return
    const sent = fields
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
      // Re-read the fields from what the server stored, so «47,4712» does not stay dirty
      // against the 47.4712 it became. ⚠️ Never over a keystroke that landed WHILE the write
      // was in flight — that is a typed character the autosave would silently eat. The fresh
      // `saved` makes the form dirty again, and the effect below writes the rest.
      if (fieldsRef.current === sent) setFields(fieldsOf(merged))
      setSave({ kind: 'idle' })
      setFlash(true)
      onChanged(merged)
    } catch (e) {
      setSave({ kind: 'error', detail: e instanceof ApiError ? e.detail : C.saveFailed })
    }
  }

  useEffect(() => {
    fieldsRef.current = fields
    submitRef.current = submit
  })
  // Debounced autosave, for an existing object only. A failed write does NOT re-fire on its
  // own (the deps only move when something is typed), so a server that refuses is not hammered
  // — correcting the field is what tries again.
  useEffect(() => {
    if (!saved || !canSave) return
    const timer = window.setTimeout(() => { void submitRef.current() }, AUTOSAVE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [saved, canSave, fields])
  /** Leaving a field commits it at once — the debounce is for typing, not for waiting. */
  const commit = () => { if (saved && canSave) void submitRef.current() }

  // Replace-by-id, never append: a corrected PDF comes back under the SAME dataset id with a
  // bumped version, and a second row here would claim a duplicate the server does not have.
  const onPlanStored = (ds: ReferenceDataset) => {
    if (!saved) return
    const next = {
      ...saved,
      plans: [...saved.plans.filter((p) => p.id !== ds.id), ds].sort((a, b) =>
        (a.module ?? '').localeCompare(b.module ?? ''),
      ),
    }
    setSaved(next)
    onChanged(next)
  }

  return (
    <>
      {/* ── the object ───────────────────────────────────────────────────────── */}
      {/* Name and address ARE the heading of the object's own page — what identifies it, before
          anything it can be asked. The address stays an editable row below: the head reads it,
          the row corrects it. */}
      <SettingsSheet title={saved ? saved.name : C.newTitle} caption={saved?.address ?? undefined}>
        {saved ? (
          <SettingRow label={C.derivedId} tip={saved.source_key ? C.objKeyTip : C.objHandTip}>
            <span className="adm-obj-idline">
              <code>{saved.id}</code>
              {/* The object's own provenance, in the same badge language the plan rows use:
                  a key means a pipeline loaded it, no key means somebody typed it here. */}
              {saved.source_key ? (
                <>
                  <span className="adm-fleet-badge adm-view-badge-muted">{C.objKeyBadge}</span>
                  <code>{saved.source_key}</code>
                </>
              ) : (
                <span className="adm-fleet-badge adm-view-badge-muted">{C.objHandBadge}</span>
              )}
            </span>
          </SettingRow>
        ) : (
          <SettingRow label={C.keyLabel} hint={C.keyHint} tip={C.keyTip}>
            <input
              className="adm-input adm-input-mono"
              value={key}
              autoFocus
              onFocus={caretToEnd}
              onChange={(e) => setKey(e.target.value)}
              placeholder={C.keyPlaceholder}
            />
          </SettingRow>
        )}
        {!saved && objectId && (
          <SettingRow label={C.derivedId}>
            <span className="adm-obj-idline"><code>{objectId}</code></span>
          </SettingRow>
        )}
        {keyError && <SettingsNote><span className="adm-state adm-state-err">{keyError}</span></SettingsNote>}

        {/* Where the rule bites. An object without `source_key` — which is every object this form
            creates — is one the Planspeicher-Abgleich skips on every run, silently and for good;
            SharePoint, matching on the folder name, finds the very same object. Each sentence is
            printed only for a pull this deployment actually runs, so a station with none reads
            nothing here. */}
        {!saved?.source_key && sources?.bucket && <SettingsNote>{C.objHandBucket}</SettingsNote>}
        {!saved?.source_key && sources?.sharepoint && (
          <SettingsNote>
            {saved || !normalisedKey
              ? C.objHandSharepoint
              : fillTemplate(C.objHandSharepointKey, { key: normalisedKey })}
          </SettingsNote>
        )}

        <SettingRow label={C.nameLabel}>
          <input className="adm-input" value={name} onChange={(e) => set('name', e.target.value)} onBlur={commit} />
        </SettingRow>
        <SettingRow label={C.addressLabel} hint={C.addressHint} tip={C.addressTip}>
          <input className="adm-input" value={address} onChange={(e) => set('address', e.target.value)} onBlur={commit} />
        </SettingRow>
        <SettingRow label={C.latLabel} tip={C.coordsTip}>
          <input
            className="adm-input adm-input-mono"
            inputMode="decimal"
            value={lat}
            onChange={(e) => set('lat', e.target.value)}
            onBlur={commit}
            placeholder="47.4712"
          />
        </SettingRow>
        <SettingRow label={C.lngLabel} tip={C.coordsTip}>
          <input
            className="adm-input adm-input-mono"
            inputMode="decimal"
            value={lng}
            onChange={(e) => set('lng', e.target.value)}
            onBlur={commit}
            placeholder="7.5501"
          />
        </SettingRow>
        {!coords.ok && <SettingsNote><span className="adm-state adm-state-err">{coords.error}</span></SettingsNote>}
        <SettingRow label={C.noteLabel} hint={C.noteHint}>
          <input className="adm-input" value={note} onChange={(e) => set('note', e.target.value)} onBlur={commit} />
        </SettingRow>
        {save.kind === 'error' && <SettingsNote><span className="adm-state adm-state-err">{save.detail}</span></SettingsNote>}
        {/* The one sentence the create form owes: why there are no PDF slots yet. */}
        {!saved && <SettingsNote>{C.plansHintNew}</SettingsNote>}
        {/* An existing object says only whether it is written — the write itself is automatic.
            A new one keeps the single commit that mints its id, because a plan cannot be stored
            before there is something to store it under. */}
        {saved ? (
          <SettingsNote>
            <span role="status" className="adm-obj-autosave">
              {save.kind === 'busy' ? C.saving : flash ? <span className="adm-save-ok">{C.savedNote}</span> : null}
            </span>
          </SettingsNote>
        ) : (
          <SettingsNote>
            <div className="adm-actions">
              {/* `.btn primary` is allowed here and nowhere else on this page: this is the one
                  commit that creates the object, not a list of equal actions. */}
              <button
                type="button"
                className="btn primary"
                disabled={!canSave || save.kind === 'busy'}
                onClick={() => void submit()}
              >
                {save.kind === 'busy' ? C.creating : C.create}
              </button>
            </div>
          </SettingsNote>
        )}
      </SettingsSheet>

      {/* ── its Modul-PDFs ───────────────────────────────────────────────────── */}
      {saved && (plans
        ? plans(saved, onPlanStored)
        : (
          <>
            <h3 className="adm-fieldgroup">{C.plansTitle}</h3>
            <PlanSlots object={saved} onStored={onPlanStored} />
          </>
        ))}
    </>
  )
}

/**
 * The per-slot upload state a plan list needs: which slot is busy, which one failed, and the
 * write itself. Shared, because the sheet's plain slot list and the detail page's merged plan
 * rows upload the same way and must fail the same way.
 */
export function usePlanUpload(objectId: string, onStored: (ds: ReferenceDataset) => void) {
  const C = appConfig.copy.admin.objects
  const [busySlot, setBusySlot] = useState<string | null>(null)
  const [err, setErr] = useState<{ slot: string; detail: string } | null>(null)
  const upload = async (slotId: string, file: File) => {
    setBusySlot(slotId)
    setErr(null)
    try {
      onStored(await uploadPlan(objectId, slotId, file))
    } catch (e) {
      setErr({ slot: slotId, detail: e instanceof ApiError ? e.detail : C.uploadFailed })
    } finally {
      setBusySlot(null)
    }
  }
  return { busySlot, err, upload }
}

/** The per-module upload list. Its own component so a plan upload re-renders only this half. */
function PlanSlots({ object, onStored }: { object: ObjectWithPlans; onStored: (ds: ReferenceDataset) => void }) {
  const C = appConfig.copy.admin.objects
  const modules = useMemo(() => liveModules(), [])
  const slots = useMemo(() => planSlots(modules, object.plans), [modules, object.plans])
  const { busySlot, err, upload } = usePlanUpload(object.id, onStored)

  return (
    <>
      <p className="adm-hint">{C.plansHint}</p>
      <ul className="adm-slots">
        {slots.map((s) => (
          <li className="adm-slot" key={s.id}>
            <div className="adm-slot-id">
              <span className="adm-view-code">{s.short}</span>
              <span className="adm-slot-title">{s.title}</span>
              <span className="adm-view-key">{s.id}</span>
              {s.offCatalogue && <span className="adm-view-badge adm-view-badge-warn">{C.offCatalogue}</span>}
            </div>
            <div className="adm-slot-state">
              {s.plan ? (
                <>
                  <a
                    className="adm-link adm-slot-plan"
                    href={`/api/reference/${encodeURIComponent(s.plan.id)}?v=${s.plan.current_version}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Icon id="doc" />
                    {fillTemplate(C.planVersion, { n: s.plan.current_version, date: fmtDate(s.plan.updated_at) })}
                    <span className="adm-ref-note">{fmtBytes(s.plan.size_bytes)}</span>
                  </a>{' '}
                  {/* Which door THIS sheet came through — and, in the tip, that replacing a
                      pulled plan by hand only holds until the next run. */}
                  <PlanSourceBadge sourceType={s.plan.source_type} />
                </>
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
      </ul>
    </>
  )
}

/** A stored plan's provenance badge: hand upload, Planspeicher or SharePoint. Also worn by the
 *  Checklisten rows, which answer the same «woher kommt das» over the same registry. */
export function PlanSourceBadge({ sourceType }: { sourceType: string }) {
  const s = planSourceLabel(sourceType)
  return <span className="adm-fleet-badge adm-view-badge-muted" title={s.tip}>{s.label}</span>
}

/** A file picker that looks like a button. Native `<input type=file>` chrome is unstyleable and
 *  differs per OS; the input stays in the DOM (it is what actually opens the picker) and is
 *  driven by the button, the same pattern ConfigBackup uses for the config import. */
export function PdfButton({ label, busy, busyLabel, disabled, onPick }: {
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
