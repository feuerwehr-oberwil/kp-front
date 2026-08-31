import { Fragment, useEffect, useRef, useState } from 'react'
import type { CaptionMode, NoteSize, Spread, SymbolControl, SymbolProps } from '../types'
import { thumbUrl } from '../lib/mediaUrl'
import { Icon } from '../lib/icons'
import { boundedKey, normalizeSpread, tidySpread, type SpreadDir } from '../lib/spread'
import { openPhoto } from '../lib/ui'
import { formatSymbolName, stripUnprintable } from '../lib/format'
import { SheetGrip, useSheetDrag } from './SheetGrip'
import { appConfig } from '../config/appConfig'
import { lookupUN, decodeKemler, type UnHazardEntry } from '../lib/unHazard'
import { ERG_VERSION, lookupErg } from '../lib/erg'
import { Combo } from './Combo'
import { Stepper } from './Stepper'
import { Segmented } from './Segmented'
import { getDeploymentConfig, type DeploymentMittelItem } from '../lib/deploymentConfig'
import { compositeSpec } from '../lib/symbolRender'

// detail-field controls: short fixed lists render as directly-tappable segmented tabs (they
// wrap to multiple rows), longer lists (and the person roster) as a native dropdown; roster
// fields keep a "Name eingeben …" free-text escape. Keep this generous so small doctrine lists
// (e.g. the Offizier Funktion) stay one-tap rather than hiding behind a dropdown.
const OPTION_TABS_MAX = 6
// note ink colours = the drawing palette, so a red warning note matches a red line
const NOTE_COLORS = appConfig.drawing.colors
const ROSTER_FIELDS = new Set<string>(appConfig.symbols.rosterFields)
// leadership glyphs whose roster picker gets the officer-first sort + "nur Offiziere" toggle
const OFFICER_ROSTER_SYMBOLS = new Set<string>(appConfig.symbols.officerRosterSymbols)
// The Einsatzleiter glyph's two roster rows, in the order the preset lists them. They are a PAIR
// — the two halves of one job — which is what the labels and the ⇄ below are about.
const EL_NAME = 'Name'
const EL_STV = 'Stv.'

function FieldControl({ fieldKey, value, options, placeholder, officerFilter, rankOf, statusOf, onInput, onCommit }: {
  fieldKey: string
  value: string
  options?: string[]
  placeholder: string
  /** roster picker: sort officers first + offer the "nur Offiziere" filter (leadership symbols) */
  officerFilter?: boolean
  rankOf?: (name: string) => string | undefined
  /** what is already known about a person — «unter AS», «Magazin», «gegangen» (roster fields) */
  statusOf?: (name: string) => { label: string; tone?: 'warn' | 'muted' | 'info' } | undefined
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
  // short, non-roster fixed list → the shared segmented control (re-tap the active one to clear)
  if (!isRoster && options.length <= OPTION_TABS_MAX) {
    return (
      <Segmented options={options.map((o) => ({ value: o, label: o }))} value={value}
        onChange={(v) => onCommit(v === value ? '' : v)} ariaLabel={fieldKey} />
    )
  }
  // long list or roster → custom dropdown (roster adds a "Name eingeben …" free-type escape)
  return (
    <Combo value={value} options={options} placeholder={placeholder}
      allowCustom={isRoster} customLabel="Name eingeben …"
      officerFilter={isRoster && officerFilter} rankOf={rankOf}
      // …and a hand-typed name commits when the field is LEFT, like the plain text field above:
      // a roster field records whoever is named on it as present (a Gast, if the roster has
      // never heard of them), and a commit per keystroke would record every prefix of the name.
      statusOf={isRoster ? statusOf : undefined} onInput={onInput} onChange={onCommit} />
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

export interface ContextPanelProps {
  entity: SymbolView
  svg?: string
  onClose: () => void
  /** recenter the surface on this object — absent where the surface can't (yet) recenter */
  onCenter?: () => void
  /** «Zum Original» — this panel MIRRORS an object that lives on the OTHER surface (a
   *  Georeferenz twin, see components/GeorefTwinPanel). Editing may write through to that one
   *  source in place; this optional row remains the explicit way to inspect it on its own surface. */
  onOriginal?: () => void
  originalLabel?: string
  /** Move ownership of a projected object onto the surface currently being viewed. */
  onTransferHere?: () => void
  /** The inverse of «Zum Original»: show this source object on its linked surface. */
  onProjection?: () => void
  projectionLabel?: string
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
  /** set this symbol's on-canvas caption mode (Aus / Auto / Alle). Absent for non-symbols.
   *  See SymbolProps.caption / lib/symbols. */
  onCaption?: (mode: CaptionMode) => void
  /** the device-wide caption default, shown as active when this symbol has no explicit override
   *  (so the picker never needs a separate "Standard/inherit" option). Defaults to 'auto'. */
  captionDefault?: CaptionMode
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
  /** what is already known about a roster name — shown ON the dropdown entry */
  personStatus?: (name: string) => { label: string; tone?: 'warn' | 'muted' | 'info' } | undefined
  /** ⚠️ The contradiction a filled roster field carries, by field key, shown UNDER the field
   *  and permanently. It used to be a toast: «Brunner Thomas ist unter AS» appeared three
   *  seconds after the pick and then went away, so the one place it mattered — the field it is
   *  about — never said anything at all. */
  fieldHints?: Record<string, string | undefined>
  /** preset-seeded field keys — protected from row deletion (no ✕) so they aren't lost by a stray tap */
  protectedKeys?: Set<string>
  onDelete: () => void
  /** Clear a crew member's self-reported position (Selbstauskunft) from the command post.
   *  Editor-only, and offered ONLY on a live `person` dot: somebody drives home with sharing
   *  still on, or a phone dies holding its last fix, and the dot then claims a crew is
   *  somewhere they are not. Removing it takes data away and shows nothing new. */
  onStopSharing?: () => void
  /** entity is externally sourced (live GPS) — title/fields are not editable and it can't be deleted */
  readOnly?: boolean
  /** true when the vehicle has a manual position/orientation override */
  hasOverride?: boolean
  /** Hold a live vehicle where it stands: writes its current position as an override so the
   *  symbol stays put once the vehicle drives off. Absent for one that is already held (there
   *  is nothing to pin) and for anything that is not a GPS vehicle. */
  onPinGps?: () => void
  /** reset a live vehicle's manual position/orientation back to the GPS feed */
  onResetGps?: () => void
  /** Fahrer of a LIVE (GPS-sourced) vehicle. The feed knows where the vehicle is, never who is
   *  driving it — and the entity is rebuilt on every poll, so this rides the operator override
   *  instead of the entity's own fields. Offered even though the panel is otherwise read-only:
   *  it is the one thing about a live vehicle only a human can say. */
  driver?: { value: string; options: string[]; onChange: (v: string) => void }
  connectedLines?: { id: string; label: string }[]
  onFocusLine?: (id: string) => void
  // --- free-text note (Lage 'note' / Plan 'text') -------------------------------------------
  // Wiring ANY of these turns the panel into a note editor: the Notiz section appears and the
  // symbol-only chrome (steppers, hazard readout) stays hidden. The width is what makes a note
  // a wrapping box, but its UNIT differs per surface (plan fraction vs. screen px), so the
  // caller passes it through opaquely and only the surface interprets it.
  /** marks this entity as a note (the width itself lives on the surface, which owns the grip). */
  onNoteWidth?: (w: number | null) => void
  onNoteSize?: (size: NoteSize) => void
  onNotePlain?: (plain: boolean) => void
  /** note ink colour ('' clears back to the default note ink). */
  onColor?: (color: string) => void
  /** recolour a placed Atemschutz-Trupp (null = back to automatic). Present only for a team
   *  marker that is bound to a Trupp — it writes the TRUPP's colour, not just this marker. */
  onTeamColor?: (color: string | null) => void
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

export function ContextPanel({ entity, svg, onClose, onCenter, onOriginal, originalLabel, onTransferHere, onProjection, projectionLabel, onTitle, onTitleLive, onFields, onNotes, onFloor, onFloorFrom, onFloorTo, onSpread, onCount, onRotate, onRotate2, onCaption, captionDefault = 'auto', onAirflow, controls, titleOptions, fieldOptions, rosterRank, protectedKeys, onDelete, onStopSharing, readOnly, hasOverride, onPinGps, onResetGps, driver, personStatus, fieldHints, connectedLines = [], onFocusLine, onNoteWidth, onNoteSize, onNotePlain, onColor, onTeamColor }: ContextPanelProps) {
  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const C = appConfig.copy.contextPanel
  const N = appConfig.copy.notes
  // leadership glyph → its roster picker offers the officer-first sort + "nur Offiziere" filter
  const officerSym = !!entity.symbol && OFFICER_ROSTER_SYMBOLS.has(entity.symbol)
  const rankOf = officerSym && rosterRank ? (n: string) => rosterRank[n] : undefined
  // ⚠️ The Einsatzleiter glyph's rows are labelled «EL» / «Stv.», not «Name» / «Stv.». The
  // STORED keys are unchanged (Name/Stv. — the Kroki, the caption and the Anwesenheits-Bemerkung
  // all key off them); this is what the row SAYS. «Name» beside «Stv.» named the value on one row
  // and the job on the other, so the two never read as the two halves of one job — which is what
  // they are, and what makes the ⇄ below obvious.
  // ⚠️ Two things, deliberately separated. What the rows are CALLED is a fact about the symbol and
  // holds for everybody — a viewer, a locked board, the Einsatzleiter's own tablet — so the label
  // hangs off the symbol alone. Only the ⇄ swap below is an edit and keeps the readOnly guard.
  // (They were one flag, so a read-only panel said «Stv.» while every other surface and the paper
  // said «Stv. EL».)
  const isElSym = entity.symbol === appConfig.symbols.einsatzleiterName
  const elSym = !readOnly && isElSym
  const rowLabel = (k: string) => {
    if (!isElSym) return k
    if (k === EL_NAME) return appConfig.copy.anwesenheit.roleEinsatzleiterShort
    if (k === EL_STV) return appConfig.copy.anwesenheit.roleEinsatzleiterStvShort
    return k
  }
const SPREAD_GLYPH: Record<SpreadDir, string> = { left: '←', right: '→', up: '↑', down: '↓' }
// The Entwicklungsgrenze is the bar ACROSS the arrow tip, so it stands perpendicular to its own
// arrow: upright beside ← →, lying flat beside ↑ ↓. Same stroke the symbol prints.
const GRENZE_GLYPH: Record<SpreadDir, string> = { left: '│', right: '│', up: '─', down: '─' }

  // a stepper is offered only where its callback is wired (the surface supports it)
  // AND the symbol's preset lists it; no preset passed ⇒ show all wired steppers.
  const allow = (c: SymbolControl) => !controls || controls.has(c)

  // ⚠️ normalized, not raw: a symbol placed before 2026-08 carries the old exclusive
  // `h`/`hBounded`/`vBounded` shape (lib/spread.ts). Reading it raw would show no arrows and
  // then SAVE that emptiness over a spread somebody had set.
  const sp = normalizeSpread(entity.spread)
  const setSpread = (patch: Partial<Spread>) => onSpread?.(tidySpread({ ...sp, ...patch }))
  /** Turning an arrow off takes its own Grenze with it — a bar without its arrow cannot print. */
  const toggleDir = (d: SpreadDir) =>
    setSpread(sp[d] ? { [d]: false, [boundedKey(d)]: false } : { [d]: true })
  /** «Grenze» is never disabled. On an arrow that is off it means «dorthin, und dort gestoppt»
   *  and switches the direction on with it — the commonest case must not cost two taps. */
  const toggleBounded = (d: SpreadDir) =>
    setSpread(sp[d] ? { [boundedKey(d)]: !sp[boundedKey(d)] } : { [d]: true, [boundedKey(d)]: true })
  const [title, setTitle] = useState(entity.label ?? '')
  // Rows come from the stored fields, but ALWAYS surface the symbol's preset fields too —
  // a symbol placed before a preset field existed (e.g. the Offizier «Funktion» or the
  // Einsatzleiter «Stv.», added after some symbols were already on the map) would otherwise
  // only ever show its stored keys. protectedKeys carries the preset keys in canonical order:
  // we render the preset fields FIRST in that order (missing ones seeded empty, stored ones
  // carrying their value), then any extra custom stored rows. Ordering by the preset — not by
  // "missing leads" — keeps a trailing preset field trailing (Einsatzleiter: Name before Stv.,
  // not Stv. hoisted above Name just because it was blank). Read-only uses the same rows: an
  // empty Fahrer field is still part of the literal source object's sidebar, shown as «–».
  const [rows, setRows] = useState<Row[]>(() => {
    const base = toRows(entity.fields)
    if (!protectedKeys?.size) return base
    const byKey = new Map(base.map((r) => [r.k.trim(), r]))
    const preset = [...protectedKeys].filter(Boolean).map((k) => byKey.get(k) ?? { k, v: '' })
    const extra = base.filter((r) => !protectedKeys.has(r.k.trim()))
    return [...preset, ...extra]
  })
  const [notes, setNotes] = useState(entity.notes ?? '')
  // A hand-typed Fahrer while it is being typed. The committed value lives on the surface (the
  // vehicle override), and naming one puts that person on the Anwesenheit — so the draft stays
  // here until the field is left and exactly one name is committed. null = nothing being typed.
  const [driverDraft, setDriverDraft] = useState<string | null>(null)
  // A tap on the header title of a labelled Fahrzeug falls through to its «Bezeichnung» field:
  // the header is where the name SHOWS, so it is where people tap to change it — and whoever
  // does not spot the field further down was stuck. The tap brings the field into view and
  // pops its menu (Combo · openTick).
  const bezRef = useRef<HTMLLabelElement>(null)
  const [bezTick, setBezTick] = useState(0)
  const openBezeichnung = () => {
    bezRef.current?.scrollIntoView?.({ block: 'center' })
    setBezTick((t) => t + 1)
  }
  // a note edits its content in a textarea; every other symbol's header is read-only now
  const noteTextRef = useRef<HTMLTextAreaElement>(null)
  // Follow the label when it changes OUTSIDE this panel. A note is the case that needs it: its
  // panel opens the moment it is placed and the operator then types on the canvas, so without
  // this the panel keeps showing an empty text — and the next edit here would wipe what they
  // wrote. Skipped while the note's own textarea has focus, so it can never clobber live typing.
  useEffect(() => {
    if (document.activeElement !== noteTextRef.current) setTitle(entity.label ?? '')
  }, [entity.label])

  // live-title editing: stream each keystroke to onTitleLive (silent surface update) and
  // finalise on blur via onTitle (one undo step + audit). Without onTitleLive we fall back
  // to the legacy "commit only on blur" path.
  const liveEdited = useRef(false)
  const changeTitle = (raw: string) => {
    // ⚠️ Emoji are stripped where text ENTERS, not where it prints: this label rides onto the
    // Kroki and into the rapport, both set in Helvetica, which draws a black box for one
    // (lib/format · stripUnprintable). Same guard on the detail fields and the notes below.
    const v = stripUnprintable(raw)
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
    for (const { k, v } of next) { const key = stripUnprintable(k).trim(); if (key) rec[key] = stripUnprintable(v) }
    onFields(rec)
  }
  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  // set a row's value AND commit (used by the tab/dropdown controls, which have no blur)
  const setRowValue = (i: number, v: string) => commitRows(rows.map((r, j) => (j === i ? { ...r, v } : r)))
  /**
   * Hand the Einsatz over: EL ⇄ Stv., in one commit.
   *
   * The two used to be re-typed — clear both dropdowns, find both names again — at the one
   * moment nobody has thirty seconds, and the Anwesenheit only learned about it if you got both
   * halves right. ONE commit re-files both fields, so `linkRosterFields` re-files both people
   * (and lib/roleAssignment · mergeRoleNote makes the new Bemerkung REPLACE the old one, rather
   * than leaving whoever stepped back reading «Einsatzleiter, Stv. Einsatzleiter»).
   */
  const swapEl = () => commitRows(rows.map((r) => {
    const k = r.k.trim()
    if (k === EL_NAME) return { ...r, v: rows.find((x) => x.k.trim() === EL_STV)?.v ?? '' }
    if (k === EL_STV) return { ...r, v: rows.find((x) => x.k.trim() === EL_NAME)?.v ?? '' }
    return r
  }))
  const addRow = () => setRows((rs) => [...rs, { k: '', v: '' }])
  const removeRow = (i: number) => commitRows(rows.filter((_, j) => j !== i))

  // Details are stored as a key→value MAP, so two rows sharing a Bezeichnung silently collapse
  // into one — the last row wins and the earlier value is gone at the next reload. We neither
  // block nor auto-rename (the operator may be mid-word); the later row simply says so, in red,
  // so nothing is ever lost without being told. Flags every occurrence after the first.
  const dupRow = (() => {
    const seen = new Set<string>()
    return rows.map((r) => {
      const k = r.k.trim()
      if (!k) return false
      if (seen.has(k)) return true
      seen.add(k)
      return false
    })
  })()

  const showFloor = onFloor && allow('floor')
  const showFloorRange = (onFloorFrom || onFloorTo) && allow('floorRange')
  const showCount = onCount && allow('count')
  const showRotate = onRotate && allow('rotation')
  const showRotate2 = onRotate2 && allow('rotation2')   // composite Grosslüfter: body + fan
  const showAirflow = onAirflow && allow('airflow')     // mobile Lüfter: Einblasen / Absaugen
  const showSpread = onSpread && allow('spread')
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
  // A note reuses this panel, but none of the symbol chrome applies to it: it has no glyph to
  // rotate, no preset fields, and its own text already IS the free-text field — a second
  // "Notizen" box inside a note would be a riddle. So the details block is suppressed outright
  // and the Notiz section below is all a note gets.
  const isNote = !!(onNoteWidth || onNoteSize || onNotePlain)
  /** A symbol whose LABEL is its identity — today exactly the generic Fahrzeug, recognised by the
   *  fact that the station configured a title list for it. Those keep an editable name (as a
   *  «Bezeichnung» field below); every other symbol's header is its own name and read-only. */
  const labelled = !isNote && !!titleOptions?.length
  /** «Anzahl Verwundete», not «Anzahl». On the symbols where the number IS the message, the bare
   *  word makes a reader ask what is being counted — and the Kroki prints the label, so the paper
   *  inherits the question. Falls back to the plain word for everything else. */
  const countLabel = (entity.symbol && C.countBySymbol[entity.symbol]) || C.count
  /** the symbol's own name, for the header of everything that is NOT user-labelled */
  const symbolName = entity.symbol ? formatSymbolName(entity.symbol) : ''
  const showDetails = !isNote && (showFloor || showFloorRange || showCount || showRotate || showSpread || showAirflow || onNotes || rows.length > 0 || showUnHazard || !readOnly)

  /* on-canvas caption override for THIS symbol — small + de-emphasised down by the actions
     (the field values matter first; visibility is a rare tweak). Standard follows the device
     default (Einstellungen ▸ Beschriftungen); 'Aus' silences a noisy one, 'Auto'/'Alle' opt a
     single key symbol in even when the device default is off. */
  // Just Aus / Auto / Alle — the operator never has to reason about "follow the device default"
  // (the old "Standard" option): an untouched symbol simply shows the effective default as active,
  // and picking any button pins that mode on this symbol.
  const capMode = entity.caption ?? captionDefault
  const caprow = onCaption && (
    <div className="ctx-caprow">
      <span className="ctx-caprow-lbl">{C.caption}</span>
      <Segmented ariaLabel={C.caption} value={capMode}
        options={[
          { value: 'off' as const, label: C.captionOff, disabled: readOnly },
          { value: 'auto' as const, label: C.captionAuto, disabled: readOnly },
          { value: 'all' as const, label: C.captionAll, disabled: readOnly },
        ]}
        onChange={(v) => onCaption(v)} />
    </div>
  )
  // rendered twice: pinned at the sheet bottom on desktop/tablet, and again inside the
  // scrolling body for phones (.ctx-footer-inline) — CSS shows exactly one copy
  const actions = (
    <div className="ctx-actions">
      {/* first, and in the link tone: on a twin's panel it is the only thing that DOES anything,
          and what it does is leave for the real object. */}
      {onOriginal && <button className="btn link" onClick={onOriginal}><Icon id="external" />{originalLabel ?? C.toOriginal}</button>}
      {onTransferHere && <button className="btn" onClick={onTransferHere}><Icon id="move" />{C.transferHere}</button>}
      {onProjection && <button className="btn link" onClick={onProjection}><Icon id="external" />{projectionLabel ?? C.toProjection}</button>}
      {onCenter && <button className="btn" onClick={onCenter}><Icon id="cross" />{C.center}</button>}
      {/* «GPS» (reset a vehicle's manual override) and «Löschen» are alternatives, and a live
          entity gets neither — `readOnly` is already true for anything externally sourced.
          A self-reported crew position is the exception: it is somebody's own row, and the
          command post can clear it (see onStopSharing). */}
      {onStopSharing && (
        <button className="btn warn" onClick={onStopSharing} title={C.stopSharingTitle}>
          <Icon id="close" />{C.stopSharing}
        </button>
      )}
      {/* «Festhalten» and «GPS» are the two directions of one thing, so they sit together:
          hold this vehicle where it stands, or give it back to the feed. Only ONE is ever
          live — a pinned vehicle has nothing to pin, a following one has nothing to reset. */}
      {onPinGps && <button className="btn" onClick={onPinGps} title={C.pinGpsTitle}><Icon id="coords" />{C.pinGps}</button>}
      {onResetGps
        ? <button className="btn" disabled={!hasOverride} onClick={onResetGps} title={C.resetGpsTitle}><Icon id="compass" />{C.resetGps}</button>
        : !readOnly && !onStopSharing && <button className="btn warn" onClick={onDelete}><Icon id="close" />{appConfig.copy.delete}</button>}
    </div>
  )

  // the header shares the grip's drag (tap stays a tap there — see useSheetDrag)
  const sheetDrag = useSheetDrag({ onClose, tapToggles: false })
  return (
    <div className="ctx">
      <SheetGrip onClose={onClose} />
      {/* the whole header drags the sheet too, not just the 44×5px grip above it */}
      <div className="ctx-head" {...sheetDrag}>
        <div className="ph">
          {/* header chip: the small copy. The full-size preview below (.ctx-photo) is the
              point of a photo marker's panel and keeps the real picture. */}
          {entity.photoUrl ? <img src={thumbUrl(entity.photoUrl)} alt="" decoding="async" />
            : svg ? <span dangerouslySetInnerHTML={{ __html: svg }} />
            : (entity.badge ?? <Icon id="type" />)}
        </div>
        <div className="ctx-titlewrap">
          {/* A note has no NAME — its text IS its content, and a sentence does not belong in a
              one-line title field. So the header just says «Notiz» and the text lives in the
              textarea below, where it can breathe. */}
          {/* ⚠️ THE HEADER IS A NAME, NOT A FIELD (11.08.). It carries the symbol's own name — a
              default that says WHAT this is — and renaming a Rauch to «Küche» made the panel
              lie about which symbol was selected. Where something genuinely needs saying about
              one symbol, that is what Notizen is for. The one real exception is the generic
              Fahrzeug, whose label IS its identity; that moved to a «Bezeichnung» field below,
              where it reads like every other field and does not fight the header's drag on a
              phone (components/SheetGrip · useSheetDrag). Its header title stays a BUTTON that
              falls through to that field (openBezeichnung) — the header is where the name
              shows, so it is where people tap to change it. */}
          {labelled && !readOnly ? (
            <button type="button" className="ctx-title-input ctx-title-btn" title={C.labelField}
              onClick={openBezeichnung}>
              {title || C.titlePlaceholder}
            </button>
          ) : (
            <span className="ctx-title-input ctx-title-ro">
              {isNote ? N.section : labelled ? (title || C.titlePlaceholder) : (symbolName || title || C.titlePlaceholder)}
            </span>
          )}
          {/* a note's subtitle IS «Notiz», which the title above already says — one word is enough */}
          {entity.subtitle && !isNote && <p>{entity.subtitle}</p>}
        </div>
        <button className="ctx-x" onClick={onClose} title={appConfig.copy.closeDialog} aria-label={appConfig.copy.closeDialog}><Icon id="close" /></button>
      </div>

      {/* tap to see it full-size, in the app (lib/ui · openPhoto) — a photo marker's whole point
          is the picture, and the panel can only show a thumbnail of it */}
      {entity.photoUrl && (
        <button type="button" className="ctx-photo" title={appConfig.copy.photoViewer.title}
          onClick={() => openPhoto(entity.photoUrl!, { caption: entity.label, filename: 'foto.jpg' })}>
          <img src={entity.photoUrl} alt="" />
        </button>
      )}

      <div className="ctx-body">
        {/* ── Notiz ── the same three settings the armed-tool dock offers while writing, plus the
            one that changes the note's state: Form. Deliberately short — every extra control here
            is one more thing to reason about at 3am, and each would have to be carried through
            both print paths as well. */}
        {isNote && !readOnly && (
          <div className="ctx-note">
            {/* the note's actual content — a real textarea, because a Notiz is a sentence or
                three, not a label. Editing straight on the surface (double-tap / the ✎ handle)
                stays the fast path; this is for when you want room. */}
            <div className="ctx-note-text">
              <span className="ctx-section-label">{N.content}</span>
              <textarea
                ref={noteTextRef}
                className="ctx-note-input"
                rows={3}
                value={title}
                placeholder={appConfig.copy.whiteboard.textPlaceholder}
                // «Einzeilig» means one line, full stop: a break pasted or typed in here is
                // flattened to a space rather than quietly stored and rendered differently on
                // the surface than in this field. Room for paragraphs is what «Textfeld» is.
                onChange={(e) => changeTitle(e.target.value)}
                onBlur={blurTitle}
                // Enter makes a paragraph — this field has room. Esc is the deliberate way out
                // (a blur on Enter also closed the whole panel, so finishing a word made the
                // settings vanish).
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur() } }}
              />
            </div>
            {onNoteSize && (
              <div className="field">
                <span>{N.size}</span>
                <Segmented
                  ariaLabel={N.size}
                  options={[{ value: 's', label: N.sizeS }, { value: 'm', label: N.sizeM }, { value: 'l', label: N.sizeL }]}
                  value={entity.noteSize ?? 'm'}
                  onChange={(v) => onNoteSize(v as NoteSize)}
                />
              </div>
            )}
            {onNotePlain && (
              <div className="field">
                <span>{N.look}</span>
                <Segmented
                  ariaLabel={N.look}
                  options={[{ value: false, label: N.lookPill }, { value: true, label: N.lookPlain }]}
                  value={!!entity.notePlain}
                  onChange={(v) => onNotePlain(v)}
                />
              </div>
            )}
            {onColor && (
              <div className="field">
                <span>{N.color}</span>
                {/* the drawing palette, plus a "default note ink" swatch first — same colours as
                    every other coloured thing on the surface, so there is no second palette */}
                <div className="ctx-note-colors">
                  <button className={`dh-color note-ink${entity.color ? '' : ' on'}`} title={N.color} aria-label={N.color}
                    aria-pressed={!entity.color} onClick={() => onColor('')} />
                  {NOTE_COLORS.map((c) => (
                    <button key={c} className={`dh-color${entity.color === c ? ' on' : ''}`} style={{ background: c }}
                      aria-pressed={entity.color === c} aria-label={c} onClick={() => onColor(c)} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        {showDetails && <>
          {/* The glyph-affecting steppers — grouped, only the ones this symbol declares. View
              state keeps the literal same row/chrome and disables it: removing unset controls
              made the mirrored object's sidebar a different, mostly empty object. */}
          {driver && (
            // The SAME row as the placed vehicle's preset «Fahrer» (label left, picker right —
            // .field): it used to be its own full-width block, so the one field a live vehicle
            // offers looked like a different kind of thing than the identical field next door.
            // A <label>, so tapping the word opens the picker.
            <label className="field">
              <span className="kv-key-ro">{C.driverLabel}</span>
              {/* ⚠️ The SAME picker as every other roster field (sweep, 10.08.). This one had no
                  Dienstgrad, no «unter AS / Magazin / nicht anwesend» and no rank ordering — on
                  the one field where naming somebody who is already under Atemschutz is the
                  conflict the app warns about, and it warned only AFTER the pick. Now the row
                  says so while the finger is still over it. */}
              <Combo
                value={driverDraft ?? driver.value}
                options={driver.options}
                allowCustom
                placeholder={C.driverPlaceholder}
                rankOf={rankOf ?? (rosterRank ? (n: string) => rosterRank[n] : undefined)}
                statusOf={personStatus}
                onInput={setDriverDraft}
                onChange={(v) => { setDriverDraft(null); driver.onChange(v) }}
              />
            </label>
          )}
          {/* ⚠️ `showFloorRange` belongs in this gate — it was the one stepper left out, so a
              symbol whose preset lists ONLY 'floorRange' (the Lift) rendered the row of
              steppers not at all and its von/bis storeys were unreachable on both surfaces. */}
          {(showFloor || showFloorRange || showCount || showRotate || showAirflow) && (
            <div className="ctx-steps">
              {/* Untergeschosse are as easy as Obergeschosse: `seedOnDec` makes the FIRST tap on
                  either − or + land on EG (0), so a Kellerbrand is one further tap on − instead of
                  an unreachable stepper. Typing works the same way — the readout is an input and
                  takes «-1» directly. Both ends of the von/bis span step independently. */}
              {showFloor && (
                <LabeledStepper label={C.floor} value={entity.floor ?? null} format={floorStr} placeholder={C.floorNone} seed={0} seedOnDec
                  onChange={(v) => onFloor!(v)} onClear={() => onFloor!(null)} canClear={entity.floor != null}
                  min={FLOOR_MIN} max={FLOOR_MAX} readOnly={readOnly} ariaLabel={C.floor} />
              )}
              {showFloorRange && (
                <>
                  <LabeledStepper label={C.floorFrom} value={entity.floorFrom ?? null} format={floorStr} placeholder={C.floorNone} seed={0} seedOnDec
                    onChange={(v) => onFloorFrom!(v)} onClear={() => onFloorFrom!(null)} canClear={entity.floorFrom != null}
                    min={FLOOR_MIN} max={FLOOR_MAX} readOnly={readOnly} ariaLabel={C.floorFrom} />
                  <LabeledStepper label={C.floorTo} value={entity.floorTo ?? null} format={floorStr} placeholder={C.floorNone} seed={0} seedOnDec
                    onChange={(v) => onFloorTo!(v)} onClear={() => onFloorTo!(null)} canClear={entity.floorTo != null}
                    min={FLOOR_MIN} max={FLOOR_MAX} readOnly={readOnly} ariaLabel={C.floorTo} />
                </>
              )}
              {showCount && (
                <LabeledStepper label={countLabel} value={entity.count ?? 1}
                  onChange={(v) => onCount!(v)} onClear={() => onCount!(null)} canClear={(entity.count ?? 1) > 1}
                  min={1} max={COUNT_MAX} readOnly={readOnly} ariaLabel={countLabel} />
              )}
              {showRotate && (
                // when a fan rotation is also present (Grosslüfter) the body stepper reads «Fahrzeug»
                <LabeledStepper label={showRotate2 ? C.rotationVehicle : C.rotation} value={entity.rotation ?? 0} step={ROT_STEP} format={(v) => `${v}°`}
                  onChange={(v) => onRotate!(v)} onClear={() => onRotate!(null)} canClear={(entity.rotation ?? 0) !== 0}
                  min={-180} max={180} readOnly={readOnly} ariaLabel={showRotate2 ? C.rotationVehicle : C.rotation} />
              )}
              {showRotate2 && (() => {
                // the part stepper reads «Lüfter», «Leiter» … per the composite (fan vs ladder/boom)
                const partLabel = C[compositeSpec(entity.symbol)?.partLabel ?? 'rotationFan']
                return (
                  <LabeledStepper label={partLabel} value={entity.rotation2 ?? 0} step={ROT_STEP} format={(v) => `${v}°`}
                    onChange={(v) => onRotate2!(v)} onClear={() => onRotate2!(null)} canClear={(entity.rotation2 ?? 0) !== 0}
                    min={-180} max={180} readOnly={readOnly} ariaLabel={partLabel} />
                )
              })()}
              {/* Lüfter airflow direction — Einblasen (arrow away from the fan) vs Absaugen (arrow
                  reversed into the fan). A field row (label + segmented value) so it reads like the
                  steppers above, not a separate widget. */}
              {showAirflow && (
                <div className="field">
                  <span>{C.airflow}</span>
                  <Segmented ariaLabel={C.airflow} value={entity.extract ?? false}
                    options={[{ value: false, label: C.airflowBlow, disabled: readOnly }, { value: true, label: C.airflowExtract, disabled: readOnly }]}
                    onChange={(v) => onAirflow!(v)} />
                </div>
              )}
            </div>
          )}

          {/* («Als Material erfassen» left this card 28.08. — the Material surface itself now
              shows the «Gesetzt, aber nicht erfasst» strip; see MittelView.) */}

          {/* FKS Entwicklung — horizontal (one cardinal) + vertical (↑/↓) spread arrows */}
          {showSpread && (
            <div className="ctx-section">
              <span className="ctx-section-label">{C.spread}</span>
              {/* Each arrow carries its OWN Grenze, glued to it — a fire running both ways
                  along a Fassade and stopped at a Brandmauer on one side only is one symbol.
                  The old row had a single «Grenze» per axis and left/right were exclusive. */}
              {([[C.spreadH, ['left', 'right']], [C.spreadV, ['up', 'down']]] as const).map(([label, dirs]) => (
                <div className="spread-row" key={label}>
                  <span className="spread-lbl">{label}</span>
                  <div className="spread-btns">
                    {dirs.map((d) => (
                      <span className="spread-unit" key={d}>
                        <button className={`spread-btn dir ${sp[d] ? 'on' : ''}`} title={C.spreadDirTitles[d]}
                          disabled={readOnly} onClick={() => toggleDir(d)}>{SPREAD_GLYPH[d]}</button>
                        {/* the bar itself, not the word: on paper the Grenze IS the stroke across
                            the arrow tip (→|), so the button shows what it draws — and it is
                            perpendicular to its own arrow, like the printed symbol */}
                        <button className={`spread-btn grenze ${sp[boundedKey(d)] ? 'on' : ''}`}
                          title={C.spreadBoundedTitle} aria-label={`${C.spreadBounded} ${C.spreadDirTitles[d]}`}
                          disabled={readOnly} onClick={() => toggleBounded(d)}>{GRENZE_GLYPH[d]}</button>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* The generic Fahrzeug's own name. It used to be the header input; here it reads like
              every other field, keeps its type list, and leaves the header free to be dragged. */}
          {labelled && (readOnly ? (
            <div className="field"><span>{C.labelField}</span><b className="kv-val-ro">{title || '–'}</b></div>
          ) : (
            <label className="field" ref={bezRef}>
              <span>{C.labelField}</span>
              <Combo
                value={title} options={titleOptions ?? []} placeholder={C.titlePlaceholder}
                allowCustom customLabel={C.labelCustom}
                openTick={bezTick}
                onChange={(v) => { changeTitle(v); onTitle(v) }}
              />
            </label>
          ))}

          {/* labelled key/value detail rows (the symbol's preset, freely edited) */}
          {/* ⚠️ NO section title. A «Fahrer» row is a label and a value selector — exactly what the
              Drehung and the Bezeichnung above it are — so a heading over it only claimed that a
              different KIND of thing started here. Of 81 symbols, 30 carry no such row at all, 27
              carry one and exactly one carries four, so the whole run is glanceable without being
              announced. Titles are kept for the blocks that are genuinely something else: the
              Ausbreitung (two sub-rows), the Mittel-Erfassung, die UN-Gefahr, Notizen, Farbe and
              the Leitungen. */}
          {(!readOnly || rows.length > 0) && (
            <div className="ctx-rows">
              {rows.map((r, i) => {
                const fixed = readOnly || !!protectedKeys?.has(r.k.trim())
                const field = (
                  <>
                    <FieldControl fieldKey={r.k} value={r.v} options={fieldOptions?.[r.k]}
                      placeholder={C.fieldPlaceholders[r.k.trim()] ?? C.fieldValuePlaceholder}
                      officerFilter={officerSym} rankOf={rankOf} statusOf={personStatus}
                      onInput={(v) => setRow(i, { v })} onCommit={(v) => setRowValue(i, v)} />
                    {/* the contradiction stays put, under the field it is about */}
                    {fieldHints?.[r.k.trim()] && (
                      <p className="kv-hint"><Icon id="warn" />{fieldHints[r.k.trim()]}</p>
                    )}
                  </>
                )
                // a preset / read-only field reads like the Darstellung rows above — a plain label and
                // the control, no editable-key box, no delete — so a «Typ» sits identically to a
                // «Luftrichtung». A user-added custom field keeps its editable key + delete.
                // …and the Einsatzleiter pair gets the ⇄ between its two rows: the handover is a
                // swap, and a swap is one gesture. Offered only once there is something to swap.
                const swap = elSym && r.k.trim() === EL_NAME
                  && rows.some((x) => x.k.trim() === EL_STV)
                  && rows.some((x) => (x.k.trim() === EL_NAME || x.k.trim() === EL_STV) && x.v.trim())
                return fixed ? (
                  <Fragment key={i}>
                    <div className="field">
                      <span className="kv-key-ro">{rowLabel(r.k)}</span>
                      {readOnly ? <b className="kv-val-ro">{r.v || '–'}</b> : field}
                    </div>
                    {swap && (
                      <button type="button" className="kv-swap" onClick={swapEl}
                        title={C.swapEl} aria-label={C.swapEl}>
                        <Icon id="swap" /><span>{C.swapEl}</span>
                      </button>
                    )}
                  </Fragment>
                ) : (
                  <Fragment key={i}>
                    <div className={`kv-row${dupRow[i] ? ' dup' : ''}`}>
                      <input className="kv-key" value={r.k} placeholder={C.fieldKeyPlaceholder}
                        aria-invalid={dupRow[i] || undefined}
                        onChange={(e) => setRow(i, { k: e.target.value })} onBlur={() => commitRows(rows)}
                        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
                      {field}
                      <button className="kv-x" title={C.removeField} aria-label={C.removeField} onClick={() => removeRow(i)}><Icon id="close" /></button>
                    </div>
                    {dupRow[i] && (
                      <p className="kv-dup-hint" role="alert">
                        <Icon id="warn" />{C.duplicateField.replace('{key}', r.k.trim())}
                      </p>
                    )}
                  </Fragment>
                )
              })}

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
          {readOnly ? ((onNotes || notes.trim()) && (
            <div className="ctx-section ctx-notes">
              <span className="ctx-section-label">{C.notes}</span>
              <p className="ctx-notes-ro">{notes || '–'}</p>
            </div>
          )) : (onNotes || notes) && (
            <div className="ctx-section ctx-notes">
              <span className="ctx-section-label">{C.notes}</span>
              <textarea
                className="ctx-notes-input"
                value={notes}
                placeholder={C.notesPlaceholder}
                onChange={(e) => setNotes(stripUnprintable(e.target.value))}
                onBlur={blurNotes}
              />
            </div>
          )}
        </>}
        {/* Truppfarbe — a placed Atemschutz-Trupp is recoloured where the operator is looking, and
            the pick lands on the TRUPP (board card, plan chip and this marker all wear it). Same
            palette + «Automatisch» as the Trupp form; a colour two Trupps share is allowed, because
            «alle Löschtrupps rot» is a legitimate way to read a Lage. */}
        {onTeamColor && !readOnly && (
          <div className="ctx-section">
            <span className="ctx-section-label">{appConfig.copy.atemschutz.colorLabel}</span>
            <div className="ctx-note-colors">
              <button className={`ctx-team-auto${entity.color ? '' : ' on'}`} aria-pressed={!entity.color}
                title={appConfig.copy.atemschutz.colorAutoHint} onClick={() => onTeamColor(null)}>
                {appConfig.copy.atemschutz.colorAuto}
              </button>
              {appConfig.drawing.teamColors.map((c) => (
                <button key={c} className={`dh-color${entity.color === c ? ' on' : ''}`} style={{ background: c }}
                  aria-pressed={entity.color === c} aria-label={c} onClick={() => onTeamColor(c)} />
              ))}
            </div>
          </div>
        )}
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
