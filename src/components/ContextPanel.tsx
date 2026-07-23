import { useEffect, useRef, useState } from 'react'
import type { CaptionMode, Spread, SymbolControl, SymbolProps } from '../types'
import { Icon } from '../lib/icons'
import { SheetGrip } from './SheetGrip'
import { appConfig } from '../config/appConfig'
import { lookupUN, decodeKemler, type UnHazardEntry } from '../lib/unHazard'
import { ERG_VERSION, lookupErg } from '../lib/erg'
import { Combo } from './Combo'
import { Stepper } from './Stepper'

// detail-field controls: short fixed lists render as directly-tappable segmented tabs (they
// wrap to multiple rows), longer lists (and the person roster) as a native dropdown; roster
// fields keep a "Name eingeben …" free-text escape. Keep this generous so small doctrine lists
// (e.g. the Offizier Funktion) stay one-tap rather than hiding behind a dropdown.
const OPTION_TABS_MAX = 6
const ROSTER_FIELDS = new Set<string>(appConfig.symbols.rosterFields)
// leadership glyphs whose roster picker gets the officer-first sort + "nur Offiziere" toggle
const OFFICER_ROSTER_SYMBOLS = new Set<string>(appConfig.symbols.officerRosterSymbols)

function FieldControl({ fieldKey, value, options, placeholder, officerFilter, rankOf, onInput, onCommit }: {
  fieldKey: string
  value: string
  options?: string[]
  placeholder: string
  /** roster picker: sort officers first + offer the "nur Offiziere" filter (leadership symbols) */
  officerFilter?: boolean
  rankOf?: (name: string) => string | undefined
  onInput: (v: string) => void   // live edit (no commit) while typing
  onCommit: (v: string) => void  // commit immediately (tab/select/blur)
}) {
  const isRoster = ROSTER_FIELDS.has(fieldKey)
  // no options → a plain free-text field (commits on blur)
  if (!options?.length) {
    return (
      <input className="kv-val" value={value} placeholder={placeholder}
        onChange={(e) => onInput(e.target.value)}
        onBlur={() => onCommit(value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
    )
  }
  // short, non-roster fixed list → segmented tabs
  if (!isRoster && options.length <= OPTION_TABS_MAX) {
    return (
      <div className="kv-tabs">
        {options.map((o) => (
          <button key={o} type="button" className={`kv-tab${value === o ? ' on' : ''}`} onClick={() => onCommit(value === o ? '' : o)}>{o}</button>
        ))}
      </div>
    )
  }
  // long list or roster → custom dropdown (roster adds a "Name eingeben …" free-type escape)
  return (
    <Combo value={value} options={options} placeholder={placeholder}
      allowCustom={isRoster} customLabel="Name eingeben …"
      officerFilter={isRoster && officerFilter} rankOf={rankOf} onChange={onCommit} />
  )
}

// Gefahrentafel UN-Nr → Stoff auto-fill. The detail rows are free key/value pairs, so
// we recognise the source/target rows by their (configurable) key, case-insensitively.
// structural DATA keys (not display labels): read from the copy directly here — they are
// intentionally NOT localized (they match the language-independent preset fields
// ['UN-Nr','Stoff']), so a module-level read of the base value is correct. See config/copy.
const UN_KEY = appConfig.copy.contextPanel.unField.trim().toLowerCase()
const STOFF_KEY = appConfig.copy.contextPanel.stoffField.trim().toLowerCase()
const findVal = (rows: { k: string; v: string }[], key: string) =>
  rows.find((r) => r.k.trim().toLowerCase() === key)?.v ?? ''

/** The surface-agnostic shape this editor reads. Both a map `Entity` and a plan
 *  `BoardAnno` satisfy it (they share `SymbolProps`; `floor`/`photoUrl`/`badge`
 *  are optional and only the map sets the latter two), so ONE editor serves both
 *  surfaces — adding a control here lights up on Lage AND Plan at once. */
export interface SymbolView extends SymbolProps {
  id: string
  floor?: number
  photoUrl?: string
  badge?: string
}

interface Props {
  entity: SymbolView
  svg?: string
  autoFocusTitle?: boolean
  onClose: () => void
  /** recenter the surface on this object — absent where the surface can't (yet) recenter */
  onCenter?: () => void
  /** commit the final label on blur (folds the whole edit into one undo step / audit event) */
  onTitle: (label: string) => void
  /** stream the label on every keystroke so the on-surface glyph/note updates live while
   *  typing; the surface keeps it silent (no per-keystroke undo/audit) and finalises on
   *  onTitle. Absent → legacy commit-only-on-blur behaviour. */
  onTitleLive?: (label: string) => void
  /** replace the whole detail map (rows are added / edited / removed locally) */
  onFields: (fields: Record<string, string>) => void
  /** commit the general free-text notes (absent for read-only entities) */
  onNotes?: (notes: string) => void
  /** set/clear the storey the symbol is on (null clears the badge). Absent for
   *  entities where a floor makes no sense (e.g. live vehicles, plan tiles). */
  onFloor?: (floor: number | null) => void
  /** set/clear the lower / upper storey of a vertical span (stairs, lift). Wired on
   *  both surfaces (the span renders on the glyph everywhere). */
  onFloorFrom?: (floor: number | null) => void
  onFloorTo?: (floor: number | null) => void
  /** set/clear the FKS Entwicklung (spread) arrows (null clears them). Absent where
   *  spread makes no sense (only Feuer/Wasser/Gefahrstoffe wire it). */
  onSpread?: (spread: Spread | null) => void
  /** set/clear the quantity (null or 1 clears the badge). Absent where it makes no sense. */
  onCount?: (count: number | null) => void
  /** set/clear the rotation in degrees (null resets to 0). Absent where rotation
   *  makes no sense (e.g. live vehicles, whose heading comes from the GPS feed). */
  onRotate?: (deg: number | null) => void
  /** secondary rotation (the composite Grosslüfter's fan/airflow). Absent on every other
   *  symbol; when wired AND the symbol's preset lists 'rotation2', the rotation control
   *  splits into a Fahrzeug (body) + Lüfter (fan) pair. */
  onRotate2?: (deg: number | null) => void
  /** set/clear this symbol's on-canvas caption mode override (null = follow the device
   *  default). Absent for non-symbols. See SymbolProps.caption / lib/symbols. */
  onCaption?: (mode: CaptionMode | null) => void
  /** set the Lüfter airflow direction (false = Einblasen, true = Absaugen). Wired only where
   *  the symbol's preset lists 'airflow' (the mobile Lüfter). See SymbolProps.extract. */
  onAirflow?: (extract: boolean) => void
  /** which built-in steppers this symbol declares as meaningful (its preset). A
   *  stepper shows only if BOTH its callback is wired (surface supports it) AND it
   *  is in this set. Absent = show every wired stepper (back-compat / non-symbols). */
  controls?: Set<SymbolControl>
  /** combobox suggestions for the title input (e.g. common vehicle types) */
  titleOptions?: string[]
  /** combobox suggestions per detail field key (person roster, type lists) */
  fieldOptions?: Record<string, string[]>
  /** roster name → rank key, for the officer-first sort + "nur Offiziere" filter on
   *  leadership symbols (FW Offizier / VKF Einsatzleiter). Absent → no rank filtering. */
  rosterRank?: Record<string, string | undefined>
  /** preset-seeded field keys — protected from row deletion (no ✕) so they aren't lost by a stray tap */
  protectedKeys?: Set<string>
  onDelete: () => void
  /** entity is externally sourced (live GPS) — title/fields are not editable and it can't be deleted */
  readOnly?: boolean
  /** true when the vehicle has a manual position/orientation override */
  hasOverride?: boolean
  /** reset a live vehicle's manual position/orientation back to the GPS feed */
  onResetGps?: () => void
  connectedLines?: { id: string; label: string }[]
  onFocusLine?: (id: string) => void
}

// signed storey label for the badge / stepper readout: +2, -1, 0 (EG)
const floorStr = (f: number) => (f > 0 ? `+${f}` : `${f}`)
const FLOOR_MIN = -9
const FLOOR_MAX = 40
const COUNT_MAX = 999
const ROT_STEP = 15   // degrees per tap — same control on both surfaces

type Row = { k: string; v: string }
const toRows = (fields?: Record<string, string>): Row[] => Object.entries(fields ?? {}).map(([k, v]) => ({ k, v }))

// a labelled row wrapping the shared ±Stepper (hold-repeat · tap-to-type · always-visible greyed ✕)
function LabeledStepper({ label, ...rest }: { label: string } & React.ComponentProps<typeof Stepper>) {
  return (
    <div className="field">
      <span>{label}</span>
      <Stepper {...rest} />
    </div>
  )
}

export function ContextPanel({ entity, svg, autoFocusTitle, onClose, onCenter, onTitle, onTitleLive, onFields, onNotes, onFloor, onFloorFrom, onFloorTo, onSpread, onCount, onRotate, onRotate2, onCaption, onAirflow, controls, titleOptions, fieldOptions, rosterRank, protectedKeys, onDelete, readOnly, hasOverride, onResetGps, connectedLines = [], onFocusLine }: Props) {
  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const C = appConfig.copy.contextPanel
  // leadership glyph → its roster picker offers the officer-first sort + "nur Offiziere" filter
  const officerSym = !!entity.symbol && OFFICER_ROSTER_SYMBOLS.has(entity.symbol)
  const rankOf = officerSym && rosterRank ? (n: string) => rosterRank[n] : undefined
  // a stepper is offered only where its callback is wired (the surface supports it)
  // AND the symbol's preset lists it; no preset passed ⇒ show all wired steppers.
  const allow = (c: SymbolControl) => !controls || controls.has(c)

  // merge a spread change, drop a bounded flag whose axis is gone, and clear the
  // whole thing back to null once no arrow remains (keeps the prop tidy / unset).
  const sp = entity.spread ?? {}
  const setSpread = (patch: Partial<Spread>) => {
    const n: Spread = { ...sp, ...patch }
    if (!n.h) n.hBounded = undefined
    if (!n.up && !n.down) n.vBounded = undefined
    const empty = !n.h && !n.up && !n.down
    onSpread?.(empty ? null : {
      h: n.h, hBounded: n.hBounded || undefined,
      up: n.up || undefined, down: n.down || undefined, vBounded: n.vBounded || undefined,
    })
  }
  const [title, setTitle] = useState(entity.label ?? '')
  // Rows come from the stored fields, but ALWAYS surface the symbol's preset fields too —
  // a symbol placed before a preset field existed (e.g. the Offizier «Funktion», added after
  // some officers were already on the map) would otherwise only ever show its stored keys.
  // protectedKeys carries the preset keys in canonical order, so missing ones lead (Funktion
  // before Name), then any extra stored rows. Read-only entities are left untouched (no blanks).
  const [rows, setRows] = useState<Row[]>(() => {
    const base = toRows(entity.fields)
    if (readOnly || !protectedKeys?.size) return base
    const present = new Set(base.map((r) => r.k.trim()))
    const missing = [...protectedKeys].filter((k) => k && !present.has(k)).map((k) => ({ k, v: '' }))
    return [...missing, ...base]
  })
  const [notes, setNotes] = useState(entity.notes ?? '')
  const titleRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (autoFocusTitle) { titleRef.current?.focus(); titleRef.current?.select() } }, [autoFocusTitle])

  // live-title editing: stream each keystroke to onTitleLive (silent surface update) and
  // finalise on blur via onTitle (one undo step + audit). Without onTitleLive we fall back
  // to the legacy "commit only on blur" path.
  const liveEdited = useRef(false)
  const changeTitle = (v: string) => {
    setTitle(v)
    if (onTitleLive) { liveEdited.current = true; onTitleLive(v) }
  }
  const blurTitle = () => {
    if (liveEdited.current) { liveEdited.current = false; onTitle(title) }
    else if (title !== (entity.label ?? '')) onTitle(title)
  }
  const blurNotes = () => { if (notes !== (entity.notes ?? '')) onNotes?.(notes) }
  // Gefahrentafel auto-fill: when a UN-Nr row resolves to an ADR substance and the
  // Stoff row is still empty, seed its German name. Only fills an empty Stoff so a
  // manually-typed substance is never clobbered.
  const fillFromUN = (rs: Row[]): Row[] => {
    const hit = lookupUN(findVal(rs, UN_KEY))
    if (!hit?.name_de) return rs
    return rs.map((r) => (r.k.trim().toLowerCase() === STOFF_KEY && !r.v.trim() ? { ...r, v: hit.name_de! } : r))
  }
  // build the detail map from the editable rows (drop blank keys) and commit it
  const commitRows = (raw: Row[]) => {
    const next = fillFromUN(raw)
    setRows(next)
    const rec: Record<string, string> = {}
    for (const { k, v } of next) { const key = k.trim(); if (key) rec[key] = v }
    onFields(rec)
  }
  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  // set a row's value AND commit (used by the tab/dropdown controls, which have no blur)
  const setRowValue = (i: number, v: string) => commitRows(rows.map((r, j) => (j === i ? { ...r, v } : r)))
  const addRow = () => setRows((rs) => [...rs, { k: '', v: '' }])
  const removeRow = (i: number) => commitRows(rows.filter((_, j) => j !== i))

  const showFloor = onFloor && allow('floor')
  const showFloorRange = (onFloorFrom || onFloorTo) && allow('floorRange')
  const showCount = onCount && allow('count')
  const showRotate = onRotate && allow('rotation')
  const showRotate2 = onRotate2 && allow('rotation2')   // composite Grosslüfter: body + fan
  const showAirflow = onAirflow && allow('airflow')     // mobile Lüfter: Einblasen / Absaugen
  const showSpread = onSpread && allow('spread') && !readOnly
  // live ADR hazard readout — derived from the current UN-Nr row, so it updates as you
  // type. Only present when this symbol carries a UN-Nr field with a value.
  const unValue = findVal(rows, UN_KEY).trim()
  const unHit: UnHazardEntry | null = unValue ? lookupUN(unValue) : null
  const hazRows: { k: string; v: string }[] = unHit
    ? [
        { k: C.unClass, v: unHit.class ?? '' },
        { k: C.unKemler, v: unHit.hazardNumber ?? '' },
        { k: C.unLabels, v: unHit.hazardLabels.join(', ') },
        { k: C.unPacking, v: unHit.packingGroup ?? '' },
      ].filter((r) => r.v)
    : []
  const showUnHazard = unValue.length > 0
  const kemler = decodeKemler(unHit?.hazardNumber)
  const erg = showUnHazard ? lookupErg(unValue) : null
  const unLookupHref = C.unLookupUrl
    .replace('{un}', encodeURIComponent(unValue))
    .replace('{name}', encodeURIComponent(unHit?.name_de ?? ''))
  const showDetails = showFloor || showFloorRange || showCount || showRotate || showSpread || showAirflow || onNotes || rows.length > 0 || showUnHazard || !readOnly

  /* on-canvas caption override for THIS symbol — small + de-emphasised down by the actions
     (the field values matter first; visibility is a rare tweak). Standard follows the device
     default (Einstellungen ▸ Beschriftungen); 'Aus' silences a noisy one, 'Auto'/'Alle' opt a
     single key symbol in even when the device default is off. */
  const caprow = onCaption && !readOnly && (
    <div className="ctx-caprow">
      <span className="ctx-caprow-lbl">{C.caption}</span>
      <div className="ctx-caprow-seg" role="group" aria-label={C.caption}>
        {([
          { v: null, label: C.captionDefault },
          { v: 'off' as const, label: C.captionOff },
          { v: 'auto' as const, label: C.captionAuto },
          { v: 'all' as const, label: C.captionAll },
        ]).map(({ v, label }) => (
          <button key={label} type="button" className={`ctx-caprow-btn${(entity.caption ?? null) === v ? ' on' : ''}`}
            aria-pressed={(entity.caption ?? null) === v} onClick={() => onCaption(v)}>{label}</button>
        ))}
      </div>
    </div>
  )
  // rendered twice: pinned at the sheet bottom on desktop/tablet, and again inside the
  // scrolling body for phones (.ctx-footer-inline) — CSS shows exactly one copy
  const actions = (
    <div className="ctx-actions">
      {onCenter && <button className="btn" onClick={onCenter}><Icon id="cross" />{C.center}</button>}
      {onResetGps
        ? <button className="btn" disabled={!hasOverride} onClick={onResetGps} title={C.resetGpsTitle}><Icon id="compass" />{C.resetGps}</button>
        : !readOnly && <button className="btn warn" onClick={onDelete}><Icon id="close" />{appConfig.copy.delete}</button>}
    </div>
  )

  return (
    <div className="ctx">
      <SheetGrip onClose={onClose} />
      <div className="ctx-head">
        <div className="ph">
          {entity.photoUrl ? <img src={entity.photoUrl} alt="" />
            : svg ? <span dangerouslySetInnerHTML={{ __html: svg }} />
            : (entity.badge ?? <Icon id="type" />)}
        </div>
        <div className="ctx-titlewrap">
          {/* view state renders static text — a readOnly input still takes focus (cursor /
              phone keyboard), which reads as editable when it isn't */}
          {readOnly ? (
            <span className="ctx-title-input ctx-title-ro">{title || C.titlePlaceholder}</span>
          ) : (
          <input
            ref={titleRef}
            className="ctx-title-input"
            autoFocus={autoFocusTitle}
            value={title}
            placeholder={C.titlePlaceholder}
            onChange={(e) => changeTitle(e.target.value)}
            onBlur={blurTitle}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          )}
          {/* type prefill dropdown (e.g. common vehicle types) — keeps the free text input above */}
          {!readOnly && titleOptions?.length ? (
            <div className="ctx-title-pick">
              <Combo value="" options={titleOptions} placeholder={C.titleTypePick} clearable={false}
                onChange={(v) => { if (v) { changeTitle(v); onTitle(v) } }} />
            </div>
          ) : null}
          {entity.subtitle && <p>{entity.subtitle}</p>}
        </div>
        <button className="ctx-x" onClick={onClose} title={appConfig.copy.closeDialog} aria-label={appConfig.copy.closeDialog}><Icon id="close" /></button>
      </div>

      {entity.photoUrl && <div className="ctx-photo"><img src={entity.photoUrl} alt="" /></div>}

      <div className="ctx-body">
        {showDetails && <>
          {/* the glyph-affecting steppers — grouped, only the ones this symbol declares.
              View state: no stepper chrome at all (a disabled ± row still reads as editable);
              set values render as plain fields instead. */}
          {readOnly && (
            <div className="ctx-steps">
              {entity.floor != null && <div className="field"><span>{C.floor}</span><b>{floorStr(entity.floor)}</b></div>}
              {entity.floorFrom != null && <div className="field"><span>{C.floorFrom}</span><b>{floorStr(entity.floorFrom)}</b></div>}
              {entity.floorTo != null && <div className="field"><span>{C.floorTo}</span><b>{floorStr(entity.floorTo)}</b></div>}
              {(entity.count ?? 1) > 1 && <div className="field"><span>{C.count}</span><b>{entity.count}</b></div>}
              {(entity.rotation ?? 0) !== 0 && <div className="field"><span>{showRotate2 ? C.rotationVehicle : C.rotation}</span><b>{entity.rotation}°</b></div>}
              {entity.extract && <div className="field"><span>{C.airflow}</span><b>{C.airflowExtract}</b></div>}
            </div>
          )}
          {!readOnly && (showFloor || showCount || showRotate || showAirflow) && (
            <div className="ctx-steps">
              {showFloor && (
                <LabeledStepper label={C.floor} value={entity.floor ?? null} format={floorStr} placeholder={C.floorNone} seed={0}
                  onChange={(v) => onFloor!(v)} onClear={() => onFloor!(null)} canClear={entity.floor != null}
                  min={FLOOR_MIN} max={FLOOR_MAX} readOnly={readOnly} ariaLabel={C.floor} />
              )}
              {showFloorRange && (
                <>
                  <LabeledStepper label={C.floorFrom} value={entity.floorFrom ?? null} format={floorStr} placeholder={C.floorNone} seed={0}
                    onChange={(v) => onFloorFrom!(v)} onClear={() => onFloorFrom!(null)} canClear={entity.floorFrom != null}
                    min={FLOOR_MIN} max={FLOOR_MAX} readOnly={readOnly} ariaLabel={C.floorFrom} />
                  <LabeledStepper label={C.floorTo} value={entity.floorTo ?? null} format={floorStr} placeholder={C.floorNone} seed={0}
                    onChange={(v) => onFloorTo!(v)} onClear={() => onFloorTo!(null)} canClear={entity.floorTo != null}
                    min={FLOOR_MIN} max={FLOOR_MAX} readOnly={readOnly} ariaLabel={C.floorTo} />
                </>
              )}
              {showCount && (
                <LabeledStepper label={C.count} value={entity.count ?? 1}
                  onChange={(v) => onCount!(v)} onClear={() => onCount!(null)} canClear={(entity.count ?? 1) > 1}
                  min={1} max={COUNT_MAX} readOnly={readOnly} ariaLabel={C.count} />
              )}
              {showRotate && (
                // when a fan rotation is also present (Grosslüfter) the body stepper reads «Fahrzeug»
                <LabeledStepper label={showRotate2 ? C.rotationVehicle : C.rotation} value={entity.rotation ?? 0} step={ROT_STEP} format={(v) => `${v}°`}
                  onChange={(v) => onRotate!(v)} onClear={() => onRotate!(null)} canClear={(entity.rotation ?? 0) !== 0}
                  min={-180} max={180} readOnly={readOnly} ariaLabel={showRotate2 ? C.rotationVehicle : C.rotation} />
              )}
              {showRotate2 && (
                <LabeledStepper label={C.rotationFan} value={entity.rotation2 ?? 0} step={ROT_STEP} format={(v) => `${v}°`}
                  onChange={(v) => onRotate2!(v)} onClear={() => onRotate2!(null)} canClear={(entity.rotation2 ?? 0) !== 0}
                  min={-180} max={180} readOnly={readOnly} ariaLabel={C.rotationFan} />
              )}
              {/* Lüfter airflow direction — Einblasen (arrow away from the fan) vs Absaugen (arrow
                  reversed into the fan). A field row (label + segmented value) so it reads like the
                  steppers above, not a separate widget. */}
              {showAirflow && (
                <div className="field">
                  <span>{C.airflow}</span>
                  <div className="ctx-seg" role="group" aria-label={C.airflow}>
                    {([
                      { v: false, label: C.airflowBlow },
                      { v: true, label: C.airflowExtract },
                    ]).map(({ v, label }) => (
                      <button key={label} type="button" className={`ctx-seg-btn${(entity.extract ?? false) === v ? ' on' : ''}`}
                        aria-pressed={(entity.extract ?? false) === v} onClick={() => onAirflow!(v)}>{label}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* FKS Entwicklung — horizontal (one cardinal) + vertical (↑/↓) spread arrows */}
          {showSpread && (
            <div className="ctx-section">
              <span className="ctx-section-label">{C.spread}</span>
              <div className="spread-row">
                <span className="spread-lbl">{C.spreadH}</span>
                <div className="spread-btns">
                  <button className={`spread-btn ${sp.h === 'W' ? 'on' : ''}`} title={C.spreadLeft}
                    onClick={() => setSpread({ h: sp.h === 'W' ? undefined : 'W' })}>←</button>
                  <button className={`spread-btn ${sp.h === 'E' ? 'on' : ''}`} title={C.spreadRight}
                    onClick={() => setSpread({ h: sp.h === 'E' ? undefined : 'E' })}>→</button>
                  <button className={`spread-btn wide ${sp.hBounded ? 'on' : ''}`} disabled={!sp.h}
                    title={C.spreadBoundedTitle} onClick={() => setSpread({ hBounded: !sp.hBounded })}>{C.spreadBounded}</button>
                </div>
              </div>
              <div className="spread-row">
                <span className="spread-lbl">{C.spreadV}</span>
                <div className="spread-btns">
                  <button className={`spread-btn ${sp.up ? 'on' : ''}`} title={C.spreadUp}
                    onClick={() => setSpread({ up: !sp.up })}>↑</button>
                  <button className={`spread-btn ${sp.down ? 'on' : ''}`} title={C.spreadDown}
                    onClick={() => setSpread({ down: !sp.down })}>↓</button>
                  <button className={`spread-btn wide ${sp.vBounded ? 'on' : ''}`} disabled={!sp.up && !sp.down}
                    title={C.spreadBoundedTitle} onClick={() => setSpread({ vBounded: !sp.vBounded })}>{C.spreadBounded}</button>
                </div>
              </div>
            </div>
          )}

          {/* labelled key/value detail rows (the symbol's preset, freely edited) */}
          {(!readOnly || rows.length > 0) && (
            <div className="ctx-section">
              <span className="ctx-section-label">{C.detailsTitle}</span>
              {rows.filter((r) => !readOnly || r.v.trim()).map((r, i) => (
                <div className="kv-row" key={i}>
                  {readOnly || protectedKeys?.has(r.k.trim())
                    ? <span className="kv-key-ro">{r.k}</span>
                    : <input className="kv-key" value={r.k} placeholder={C.fieldKeyPlaceholder}
                        onChange={(e) => setRow(i, { k: e.target.value })} onBlur={() => commitRows(rows)}
                        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />}
                  {readOnly
                    ? <b className="kv-val kv-val-ro">{r.v}</b>
                    : <FieldControl fieldKey={r.k} value={r.v} options={fieldOptions?.[r.k]} placeholder={C.fieldValuePlaceholder}
                        officerFilter={officerSym} rankOf={rankOf}
                        onInput={(v) => setRow(i, { v })} onCommit={(v) => setRowValue(i, v)} />}
                  {!readOnly && !protectedKeys?.has(r.k.trim()) && (
                    <button className="kv-x" title={C.removeField} aria-label={C.removeField} onClick={() => removeRow(i)}><Icon id="close" /></button>
                  )}
                </div>
              ))}

              {!readOnly && (
                <button className="kv-add" onClick={addRow}><Icon id="plus" />{C.addField}</button>
              )}
            </div>
          )}

          {/* read-only ADR hazard readout from the UN number (Gefahrentafel), auto-derived
              from the ADR table — plus a deep link to a reputable source for full details. */}
          {showUnHazard && (
            <div className="ctx-section un-haz">
              <span className="ctx-section-label">{C.unHazardTitle}</span>
              {/* the tactical hazard read from the Gefahrnummer: water reactivity first
                  (can we extinguish?), then what else is dangerous about it. */}
              {kemler?.reactsWithWater && (
                <p className="un-haz-water"><Icon id="warn" /> {C.unWater}</p>
              )}
              {kemler && kemler.hazards.length > 0 && (
                <ul className="un-haz-list">
                  {kemler.hazards.map((h) => <li key={h}>{h}</li>)}
                </ul>
              )}
              {unHit ? (
                hazRows.map((r) => (
                  <div className="un-haz-row" key={r.k}>
                    <span className="un-haz-k">{r.k}</span>
                    <span className="un-haz-v">{r.v}</span>
                  </div>
                ))
              ) : (
                <p className="un-haz-none">{C.unNoMatch}</p>
              )}

              {/* ERG response block (offline, bundled): guide number, TIH isolation/protective
                  distances, polymerization flag — labelled Planungshilfe with its source. */}
              {erg && (
                <div className="un-erg">
                  {erg.g != null && (
                    <div className="un-haz-row">
                      <span className="un-haz-k">{C.ergGuide}</span>
                      <span className="un-haz-v">{erg.g}{erg.p ? ' P' : ''}</span>
                    </div>
                  )}
                  {erg.p && <p className="un-haz-water"><Icon id="warn" /> {C.ergPolymerization}</p>}
                  {(erg.tih ?? []).map((row, i) => (
                    <div className="un-erg-tih" key={i}>
                      {row.n && <span className="un-erg-n">{row.n}</span>}
                      {row.si && <div className="un-haz-row"><span className="un-haz-k">{C.ergIsolate}</span><span className="un-haz-v">{row.si}</span></div>}
                      {row.pd && <div className="un-haz-row"><span className="un-haz-k">{C.ergProtectDay}</span><span className="un-haz-v">{row.pd}</span></div>}
                      {row.pn && <div className="un-haz-row"><span className="un-haz-k">{C.ergProtectNight}</span><span className="un-haz-v">{row.pn}</span></div>}
                      {row.l === 'T3'
                        ? <div className="un-haz-row"><span className="un-haz-k">{C.ergLarge}</span><span className="un-haz-v">{C.ergTable3}</span></div>
                        : row.l && (
                          <div className="un-haz-row">
                            <span className="un-haz-k">{C.ergLarge}</span>
                            <span className="un-haz-v">{[row.l.li, row.l.ld && `${C.ergDayShort} ${row.l.ld}`, row.l.ln && `${C.ergNightShort} ${row.l.ln}`].filter(Boolean).join(' · ')}</span>
                          </div>
                        )}
                    </div>
                  ))}
                  <p className="un-erg-src">{C.ergSource.replace('{v}', ERG_VERSION)}</p>
                </div>
              )}
              <a className="un-haz-link" href={unLookupHref} target="_blank" rel="noopener noreferrer">
                <Icon id="eye" /> {C.unLookupLabel}
              </a>
              {erg && (
                <a className="un-haz-link" href={`https://cameochemicals.noaa.gov/unna/${encodeURIComponent(unValue.replace(/\D/g, ''))}`} target="_blank" rel="noopener noreferrer">
                  <Icon id="eye" /> {C.ergCameoLabel}
                </a>
              )}
            </div>
          )}

          {/* one general free-text notes field — static text in view state (a readOnly
              textarea still takes focus), and only when there ARE notes */}
          {readOnly ? (notes.trim() && (
            <div className="ctx-section ctx-notes">
              <span className="ctx-section-label">{C.notes}</span>
              <p className="ctx-notes-ro">{notes}</p>
            </div>
          )) : (onNotes || notes) && (
            <div className="ctx-section ctx-notes">
              <span className="ctx-section-label">{C.notes}</span>
              <textarea
                className="ctx-notes-input"
                value={notes}
                placeholder={C.notesPlaceholder}
                onChange={(e) => setNotes(e.target.value)}
                onBlur={blurNotes}
              />
            </div>
          )}
        </>}
        {connectedLines.length > 0 && <div className="ctx-section ctx-connections">
          <span className="ctx-section-label">{appConfig.copy.drawingEditor.connectedLines.replace('{n}', String(connectedLines.length))}</span>
          {connectedLines.map((line) => <button key={line.id} onClick={() => onFocusLine?.(line.id)}><span>{line.label}</span><span className="ctx-conn-go" aria-hidden>›</span></button>)}
        </div>}
        <div className="ctx-footer-inline">{caprow}{actions}</div>
      </div>

      {caprow}
      {actions}
    </div>
  )
}
