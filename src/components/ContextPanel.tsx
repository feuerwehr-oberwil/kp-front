import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { leaveOnEscape, ONE_LINE } from '../lib/fieldKeys'
import type { CaptionMode, NoteSize, Spread, SymbolControl, SymbolProps } from '../types'
import { thumbUrl } from '../lib/mediaUrl'
import { Icon } from '../lib/icons'
import { colorName } from '../lib/drawNames'
import { boundedKey, normalizeSpread, tidySpread, type SpreadDir } from '../lib/spread'
import { openPhoto } from '../lib/ui'
import { fillTemplate, formatSymbolName, stripUnprintable } from '../lib/format'
import { softHyphenateText } from '../lib/symbolWrap'
import { takenClock } from '../lib/photoGeo'
import { CtxShell, SheetGrip, useSheetDrag } from './SheetGrip'
import { appConfig } from '../config/appConfig'
import { allStoffNames, lookupUN, lookupUNByName } from '../lib/unHazard'
import { useHazardData } from '../lib/useHazardData'
import { DEFAULT_ERG_RING_MODE } from '../lib/ergRings'
import { UnHazardSection } from './UnHazardSection'
import { useCommitDraftOnUnmount } from '../lib/useCommitDraftOnUnmount'
import { Combo } from './Combo'
import { Stepper } from './Stepper'
import { Segmented } from './Segmented'
import { Button, IconButton } from './Button'
import { compositeSpec } from '../lib/symbolRender'
import { bareBlack } from '../lib/glyphTile'
import { UN_CAPABLE, countFieldValue, isMeasuredSymbol, symbolFieldKind } from '../lib/symbols'
import { MeasuredField, ReadingAgain, ReadingHistory, ReadingInfo, ReadingOverHead } from './ReadingParts'
import { sanitizeSvg } from '../lib/sanitizeSvg'
import { bearing360 } from '../lib/planProjection'
import { doneStatusText, isFireFamily } from '../lib/objectDone'
import { smartHyphens } from '../lib/smartHyphens'

// note ink colours = the drawing palette, so a red warning note matches a red line
const NOTE_COLORS = appConfig.drawing.colors
const ROSTER_FIELDS = new Set<string>(appConfig.symbols.rosterFields)
// leadership glyphs whose roster picker gets the officer-first sort + "nur Offiziere" toggle
const OFFICER_ROSTER_SYMBOLS = new Set<string>(appConfig.symbols.officerRosterSymbols)
// The Einsatzleiter glyph's two roster rows, in the order the preset lists them. They are a PAIR
// — the two halves of one job — which is what the labels and the ⇄ below are about. The KP Front
// carries the same pair (14.09.), so both glyphs get the labels and the handover.
const EL_SYMBOLS = new Set<string>(appConfig.symbols.einsatzleiterSymbols)
const EL_NAME = 'Name'
const EL_STV = 'Stv.'
// a vehicle's «Herkunft» (appConfig.symbols.originField) – a station-list field like any other
// (FieldControl: the list with free typing); the key is named here for the live vehicle's own row
const ORIGIN_FIELD = appConfig.symbols.originField

function FieldControl({ fieldKey, value, kind, options, placeholder, officerFilter, rankOf, statusOf, onInput, onCommit }: {
  fieldKey: string
  value: string
  /** a number field (lib/symbols · symbolFieldKind): the ± stepper, or a measured gas's keypad */
  kind?: 'count' | 'measured'
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
  // a count field («Anzahl Tiere», sweep 27.10.2026 #14) → the ± stepper the person count beside
  // it wears, each tap one commit. Empty reads «–»; ✕ empties it. A value typed as free text
  // before it was a stepper («2 Katzen») is NOT a number: it keeps the text field below, so what
  // somebody wrote is never hidden — emptying it hands the row to the stepper.
  const count = kind === 'count' ? countFieldValue(value) : undefined
  if (kind === 'count' && count !== undefined) {
    return (
      <Stepper value={count} min={1} max={COUNT_MAX} placeholder="–"
        onChange={(v) => onCommit(String(v))} onClear={() => onCommit('')} canClear={count != null}
        ariaLabel={fieldKey} />
    )
  }
  // no options → a plain free-text field (commits on blur). A measured gas (the Messpunkt's CO, Ex,
  // O₂, H₂S) never comes here: its row is ReadingParts · MeasuredField.
  if (!options?.length) {
    return (
      <input className="kv-val" value={value} placeholder={placeholder}
        onChange={(e) => onInput(e.target.value)}
        onBlur={() => onCommit(value)}
        {...ONE_LINE} />
    )
  }
  // any list, short or long, roster or station list → the dropdown with free typing: the search
  // row doubles as the entry, and the «‹X› verwenden» row under the matches takes what is typed.
  // A station list (fleet.attributeLists) is the fast path, never a cage (docs/CONFIGURATION.md ·
  // fleet). Until 05.11.2026 a list of ≤6 was Segmented tabs, with no way to type an Einheit the
  // station had not listed (owner pick: one control for every list).
  return (
    <Combo value={value} options={options} placeholder={placeholder}
      allowCustom
      officerFilter={isRoster && officerFilter} rankOf={rankOf}
      // …a hand-typed name commits ONCE, from the «‹X› verwenden» row: a roster field records
      // whoever is named on it as present (a Gast, if the roster has never heard of them).
      statusOf={isRoster ? statusOf : undefined} onChange={onCommit} />
  )
}

// Gefahrentafel UN-Nr. → Stoff auto-fill. The detail rows are free key/value pairs, so
// we recognise the source/target rows by their (configurable) key, case-insensitively.
// structural DATA keys (not display labels): read from the copy directly here — they are
// intentionally NOT localized (they match the language-independent preset fields
// ['UN-Nr.','Stoff']), so a module-level read of the base value is correct. See config/copy.
// A trailing abbreviation dot never discriminates keys: symbols saved before 'UN-Nr'
// became 'UN-Nr.' must keep matching, so normKey strips it on both sides.
const normKey = (k: string) => k.trim().toLowerCase().replace(/\.$/, '')
const UN_KEY = normKey(appConfig.copy.contextPanel.unField)
const STOFF_KEY = normKey(appConfig.copy.contextPanel.stoffField)
const findVal = (rows: { k: string; v: string }[], key: string) =>
  rows.find((r) => normKey(r.k) === key)?.v ?? ''

/** The surface-agnostic shape this editor reads. Both a map `Entity` and a plan
 *  `BoardAnno` satisfy it (they share `SymbolProps`; `floor`/`photoUrl`/`badge`
 *  are optional and only the map sets the latter two), so ONE editor serves both
 *  surfaces — adding a control here lights up on Lage AND Plan at once. */
export interface SymbolView extends SymbolProps {
  id: string
  floor?: number
  photoUrl?: string
  badge?: string
  /** a photo marker placed from the Verlauf (lib/photoGeo) — map only */
  photoOf?: { row: string; i: number }
  takenAt?: string
}

/** The fields this panel writes, in its own vocabulary (`SymbolView` – the Plan maps `floor` to
 *  its `storey`, a note's `label` to its `text`). ONE door for every edit: a field the panel
 *  offers reaches both surfaces' commits by construction, where 31 callbacks mapped by hand on
 *  each surface had let one drift (the Anwesenheit filing of #762). Values arrive normalised –
 *  an empty or default value is `undefined`, so the record stores it as absent on both surfaces. */
export type SymbolPatch = Partial<Pick<SymbolView,
  | 'label' | 'fields' | 'notes' | 'floor' | 'floorFrom' | 'floorTo' | 'spread' | 'count' | 'rotation'
  | 'rotation2' | 'caption' | 'extract' | 'ergRings' | 'noteSize' | 'notePlain' | 'color'>>

/** `typing` – a keystroke in the name, shown on the surface but not yet a step; `commit` – the
 *  edit is done (a blur, a pick, a tap): the surface's ONE ↶ step for it. */
export type PatchPhase = 'typing' | 'commit'

/** What the panel is open on, which decides the fields it offers – the surface says it once:
 *  - `symbol` – a placed tactical symbol: name, details, Notizen and every glyph control its
 *    preset lists (`controls`); the Schutzabstand rings where the surface passes `erg`
 *  - `object` – a placed object that is no symbol (a photo marker): name, details, Notizen
 *  - `live` – a feed-sourced object (a GPS vehicle, a person's own dot): its details, read out
 *  - `note` – a Notiz: its text and the Notiz row (size, look, ink) */
export type PanelSubject = 'symbol' | 'object' | 'live' | 'note'

export interface ContextPanelProps {
  entity: SymbolView
  subject: PanelSubject
  /** every field edit (see SymbolPatch); the surface commits it and lays its own ↶ step */
  onPatch: (patch: SymbolPatch, phase: PatchPhase) => void
  svg?: string
  onClose: () => void
  /** recenter the surface on this object — absent where the surface can't (yet) recenter */
  onCenter?: () => void
  /** «Zum Original» — an explicit jump to this object on the other surface. Absent on a surface
   *  that has nowhere to send it. (It is the SAME object either way now; what the row offers is a
   *  different view of it, not a different copy.) */
  onOriginal?: () => void
  originalLabel?: string
  // (no «Auf {plan} zeigen» / «Auf Karte zeigen» any more, 31.10.2026: every object is drawn on
  // the Karte and on its linked plans alike, so a door to «the same thing over there» said nothing)
  /** The ERG Schutzabstand around a Gefahrentafel (SymbolProps.ergRings, lib/ergRings) – Karte
   *  only, because the Plan has no metric scale. `coord` is where the rings stand ([lng, lat]):
   *  the sun there decides the day or the night distance (lib/ergRings · ergDayNote); absent →
   *  the national fallback coordinate. The Aus / Klein / Gross control renders on a `symbol`
   *  whose UN number resolves to TIH distances. `onAdopt` («Übernehmen», Feldtest 07.09.) turns
   *  a distance into a REAL Absperrkreis around the symbol; `adopted` are the radii already
   *  adopted (lib/ergAdopt) – their row shows ✓ instead. */
  erg?: { coord?: [number, number]; adopted?: readonly number[]; onAdopt?: (radiusM: number) => void }
  /** the device-wide caption default, shown as active when this symbol has no explicit override
   *  (so the picker never needs a separate "Standard/inherit" option). Defaults to 'auto'.
   *  See SymbolProps.caption / lib/symbols. */
  captionDefault?: CaptionMode
  /** which built-in steppers this symbol declares as meaningful (its preset). A `symbol` shows a
   *  stepper only if it is in this set. Absent = every stepper. */
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
  /** «Gelöscht / erledigt» (lib/objectDone, review item 21b): `true` declares the matter over —
   *  the symbol stays, greyed, with the time – `false` (the pressed «Erledigt» tapped again) takes
   *  it back. Wired by both surfaces for a placed symbol on an editable surface; absent everywhere
   *  else. Where it is wired, the footer's delete reads «Entfernen»: next to a «gelöschtes» Feuer,
   *  «Löschen» would say the opposite of what the button does. */
  onDone?: (done: boolean) => void
  /** «Gleich gemessen» on a measured symbol (the Messpunkt, lib/readingLog · readingAct with
   *  `again`): the surface appends a reading of the values as they stand, as one undoable step
   *  with its Verlauf row. Wired by both surfaces; absent = no button. */
  onReadingAgain?: () => void
  /** Clear a crew member's self-reported position (Selbstauskunft) from the command post.
   *  Editor-only, and offered ONLY on a live `person` dot: somebody drives home with sharing
   *  still on, or a phone dies holding its last fix, and the dot then claims a crew is
   *  somewhere they are not. Removing it takes data away and shows nothing new. */
  onStopSharing?: () => void
  /** nothing on the panel is editable (a locked session, a feed-sourced object) */
  readOnly?: boolean
  /** Löschen stays available on a panel that is otherwise read-only. The one caller is a
   *  Georeferenz twin whose kind has no editor on THIS surface: «read-only» there means «no
   *  fields to edit here», not «this object is protected», and the same object's own panel on
   *  the other surface offers Löschen (D-06). A genuinely locked surface passes neither. */
  allowDelete?: boolean
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
   *  it is the one thing about a live vehicle only a human can say. Without `onChange` (a
   *  locked session) the row is a read-out. */
  driver?: { value: string; options?: string[]; onChange?: (v: string) => void }
  /** …and its «Herkunft» (05.11.2026), the row under the Fahrer: same reason, same override map,
   *  `options` = the station's `fleet.origins`. Without `onChange` a read-out. */
  origin?: { value: string; options?: string[]; onChange?: (v: string) => void }
  /** A vehicle's Einsatz clocks («Ausgerückt 13:40», «Vor Ort 13:48») – automatic, read-only rows
   *  from the Rapport's vehicle times (lib/vehicleTimes, owner 25.11.2026: «Sheet only»), shown
   *  after the editable rows, below «Herkunft» (owner sign-off note, 25.11.2026). */
  vehicleTimes?: { label: string; value: string }[]
  /** A placed Fahrzeug named like a GPS vehicle beside it (lib/gpsTwin, owner picks UX journeys
   *  B3·33/34): the hint under «Bezeichnung», and `onHold` – the symbol goes, the GPS vehicle is
   *  held at its spot. `onKeep` («Sind zwei», owner sign-off note, 25.11.2026): it is a second
   *  vehicle, and the hint goes for this symbol. Without either (a locked session) the hint alone. */
  gpsTwin?: { name: string; distM: number; onHold?: () => void; onKeep?: () => void }
  connectedLines?: { id: string; label: string }[]
  /** Angedockte Gefahrentafel (SymbolProps.dockedTo, lib/docking): the host's display name.
   *  Rendered with a «Lösen» action when `onUndock` is wired — the panel is the one place the
   *  bond is VISIBLE, since the drop gesture that makes it draws nothing. */
  dockedToLabel?: string
  onUndock?: () => void
  /** …and the SAME bond read from the host's side (15.09.2026): the Trupp markers docked ONTO
   *  this symbol, one row each, already worded as «Trupp 4 · bei «Hydrant»» (copy · atemschutz ·
   *  dockLabel) so the row names both sides before its «Lösen» separates them. The map shows the
   *  bond as a glyph on the tile; this is the one place it is in words with a door out. */
  dockedTeams?: { id: string; label: string; onRelease?: () => void }[]
  onFocusLine?: (id: string) => void
  /** the note was just PLACED: open with the caret in its text field, so putting a Notiz down
   *  and writing it are one act. Read once, on mount — the panel is keyed by the note's id. */
  autoFocusNote?: boolean
}

// signed storey label for the badge / stepper readout: +2, -1, 0 (EG). The Von/Bis steppers keep
// the signed number, the fire service's own word for a storey (owner, 25.11.2026: «Use ‹+1› /
// ‹-1›, which is the normal fire-service term» – the «1. OG» read-out of UX pick B3·43 was undone).
const floorStr = (f: number) => (f > 0 ? `+${f}` : `${f}`)
const FLOOR_MIN = -9
const FLOOR_MAX = 40
const COUNT_MAX = 999
const ROT_STEP = 15   // degrees per tap — same control on both surfaces
/** ⚠️ A bearing is STORED in [0, 360) (lib/planProjection · bearing360, 24.09.2026) but STEPPED in
 *  (−180, 180], the stepper's own range: read raw, a stored 270° pinned it at its max and the
 *  first − jumped to 180°. What the stepper hands back is stored in [0, 360) again. */
const signedDeg = (d: number) => { const b = bearing360(d); return b > 180 ? b - 360 : b }
/** the stepper's read-out: WHOLE degrees, as every angle the app shows (SelectionTurn, the Kurs).
 *  A turn by hand (the two-finger twist, the selection dial) stores whatever the fingers said —
 *  «−46.50917745051447°» stood in the panel (owner, staging 30.09.2026: «fix this»). Only the
 *  display rounds; the stored bearing is untouched until a ± or a typed value replaces it. */
const fmtDeg = (v: number) => `${Math.round(v)}°`

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

/** A door to the object's original («Zum Original») – the foot's link tone. Its label may not
 *  outgrow its tile (30.09.2026, owner: a door's label ran out of its frame into «Zentrieren»): it
 *  is cut at its end, and the whole label is the title. */
function LinkBtn({ onClick, text }: { onClick: () => void; text: string }) {
  return (
    <Button className="link" icon={<Icon id="external" />} onClick={onClick} title={text} aria-label={text}>
      <span className="btn-t" aria-hidden><span className="btn-t-cut">{text}</span></span>
    </Button>
  )
}

export function ContextPanel({ entity, subject, onPatch, svg, onClose, onCenter, onOriginal, originalLabel, onReadingAgain, erg, captionDefault = 'auto', controls, titleOptions, fieldOptions, rosterRank, protectedKeys, onDelete, onDone, onStopSharing, readOnly, allowDelete = false, hasOverride, onPinGps, onResetGps, driver, origin, vehicleTimes = [], gpsTwin, personStatus, fieldHints, connectedLines = [], onFocusLine, dockedToLabel, onUndock, dockedTeams = [], autoFocusNote = false }: ContextPanelProps) {
  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const C = appConfig.copy.contextPanel
  const N = appConfig.copy.notes
  // a UN-speaking symbol's panel (lib/symbols · UN_CAPABLE) has the UN field and the Stoff search:
  // both tables load as it opens, not on the first key, and the readout repaints when they land
  const unPanel = !!entity.symbol && UN_CAPABLE.has(entity.symbol)
  const hazVersion = useHazardData({ un: unPanel, erg: unPanel })
  // leadership glyph → its roster picker offers the officer-first sort + "nur Offiziere" filter
  const officerSym = !!entity.symbol && OFFICER_ROSTER_SYMBOLS.has(entity.symbol)
  const rankOf = officerSym && rosterRank ? (n: string) => rosterRank[n] : undefined
  // ⚠️ The Einsatzleiter glyph's (and the KP Front's) rows are labelled «EL» / «Stv.», not «Name» / «Stv.». The
  // STORED keys are unchanged (Name/Stv. — the Kroki, the caption and the Anwesenheits-Bemerkung
  // all key off them); this is what the row SAYS. «Name» beside «Stv.» named the value on one row
  // and the job on the other, so the two never read as the two halves of one job — which is what
  // they are, and what makes the ⇄ below obvious.
  // ⚠️ Two things, deliberately separated. What the rows are CALLED is a fact about the symbol and
  // holds for everybody — a viewer, a locked board, the Einsatzleiter's own tablet — so the label
  // hangs off the symbol alone. Only the ⇄ swap below is an edit and keeps the readOnly guard.
  // (They were one flag, so a read-only panel said «Stv.» while every other surface and the paper
  // said «Stv. EL».)
  const isElSym = !!entity.symbol && EL_SYMBOLS.has(entity.symbol)
  const elSym = !readOnly && isElSym
  const rowLabel = (k: string) => {
    if (!isElSym) return k
    if (k === EL_NAME) return appConfig.copy.anwesenheit.roleEinsatzleiterShort
    if (k === EL_STV) return appConfig.copy.anwesenheit.roleEinsatzleiterStvShort
    return k
  }
  // what an empty box says (27.09.2026 — it said «Wert» everywhere): a person field asks for a
  // name, any other field repeats its own label with an ellipsis, a field still without a label
  // shows only the ellipsis; a field that needs a unit keeps its own line (fieldPlaceholders).
  const valuePlaceholder = (key: string) => {
    const k = key.trim()
    if (C.fieldPlaceholders[k]) return C.fieldPlaceholders[k]
    if (ROSTER_FIELDS.has(k)) return C.fieldNamePlaceholder
    return k ? fillTemplate(C.fieldValuePlaceholder, { label: rowLabel(k) }) : '…'
  }
// Drawn glyphs (sprite, lib/icons), not 12.5-px text arrows (sweep G.10). The Entwicklungsgrenze
// is the bar ACROSS the arrow tip, so it stands perpendicular to its own arrow: upright beside
// ← →, lying flat at the tip's height beside ↑ ↓. Same stroke the symbol prints.
const SPREAD_GLYPH = { left: 'spread-left', right: 'spread-right', up: 'spread-up', down: 'spread-down' } satisfies Record<SpreadDir, string>
const GRENZE_GLYPH = { left: 'grenze-v', right: 'grenze-v', up: 'grenze-up', down: 'grenze-down' } satisfies Record<SpreadDir, string>

  // What the subject offers (PanelSubject): the glyph controls are a symbol's, each one only where
  // its preset lists it (no preset passed ⇒ all of them); the Notizen a placed object's.
  const isSymbol = subject === 'symbol'
  const isNote = subject === 'note'
  const offersNotes = isSymbol || subject === 'object'
  const allow = (c: SymbolControl) => isSymbol && (!controls || controls.has(c))
  const commit = (patch: SymbolPatch) => onPatch(patch, 'commit')

  // ⚠️ normalized, not raw: a symbol placed before 2026-08 carries the old exclusive
  // `h`/`hBounded`/`vBounded` shape (lib/spread.ts). Reading it raw would show no arrows and
  // then SAVE that emptiness over a spread somebody had set.
  const sp = normalizeSpread(entity.spread)
  const setSpread = (patch: Partial<Spread>) => commit({ spread: tidySpread({ ...sp, ...patch }) ?? undefined })
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
  // A live vehicle's Fahrer and Herkunft ride in its fields too (lib/useVehicleLayer – for the
  // caption and the Kroki), but here they have their own rows above: not a second time read-only.
  const ownRows = new Set([driver && 'Fahrer', origin && ORIGIN_FIELD].filter(Boolean))
  // the live row's text while it is typed (no station list → FieldControl's free-text field)
  const [originDraft, setOriginDraft] = useState(origin?.value ?? '')
  const seedRows = (fields: Record<string, string> | undefined): Row[] => {
    const base = toRows(fields).filter((r) => !ownRows.has(r.k))
    if (!protectedKeys?.size) return base
    // normKey absorbs rows stored under a preset key's pre-dot spelling ('UN-Nr' →
    // 'UN-Nr.'): the value survives under the canonical key, and the next commit
    // writes it back renamed — a lazy per-symbol migration.
    const byKey = new Map(base.map((r) => [normKey(r.k), r]))
    const presetNorm = new Set([...protectedKeys].map(normKey))
    const preset = [...protectedKeys].filter(Boolean).map((k) => ({ k, v: byKey.get(normKey(k))?.v ?? '' }))
    const extra = base.filter((r) => !presetNorm.has(normKey(r.k)))
    return [...preset, ...extra]
  }
  const [rows, setRows] = useState<Row[]>(() => seedRows(entity.fields))
  /** the fields block, so the sync below can tell «somebody is typing in here» from «nobody is» */
  const fieldsRef = useRef<HTMLDivElement>(null)
  /** What this panel last WROTE — or what it opened on. The yardstick for the effect below. */
  const writtenRef = useRef(JSON.stringify(entity.fields ?? {}))
  // a row typed into but not committed yet (fields commit on blur – see the unmount commit below)
  const rowsDirty = useRef(false)
  // ⚠️ Follow the entity when the fields change from OUTSIDE — the same rule the title below
  // follows, for a worse failure. `rows` is this panel's own copy, taken once when it opened, and
  // `commitRows` writes the WHOLE record back: a value another device (or the same object's panel on the
  // other surface) filled in while this panel stood open was invisible here, and the next commit
  // wrote the stale copy over it. That clears the field, the merge brings it back from the other
  // device — and the Verlauf ends up with the same «Stv.: Eichenberger Bastian» line twice for
  // something somebody set once (03.09., 08:01 and 08:10).
  // Skipped while the caret is in one of these rows: a re-seed there would clobber live typing,
  // and whoever is typing is about to commit their own record anyway.
  // ⚠️ «one of these rows» includes the Combo search menu, which is PORTALLED to document.body —
  // `fieldsRef.contains(activeElement)` alone never saw it, so a sync echo mid-search re-seeded
  // the rows, remounted the Combo and closed the menu under the operator's thumb (Feldtest
  // 08.09., «Da verschwindet das Fenster plötzlich»).
  useEffect(() => {
    const stored = JSON.stringify(entity.fields ?? {})
    if (stored === writtenRef.current) return
    const active = document.activeElement
    if (fieldsRef.current?.contains(active)) return
    if (active instanceof Element && active.closest('.combo-menu-portal')) return
    writtenRef.current = stored
    rowsDirty.current = false
    setRows(seedRows(entity.fields))
    // seedRows reads protectedKeys — the symbol's own preset, which cannot change while one panel
    // stays mounted (the caller keys the panel by entity id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity.fields])
  const [notes, setNotes] = useState(entity.notes ?? '')
  // a note edits its content in a textarea; every other symbol's header is read-only now
  const noteTextRef = useRef<HTMLTextAreaElement>(null)
  // Follow the label when it changes OUTSIDE this panel. A note is the case that needs it: its
  // panel opens the moment it is placed and the operator then types on the canvas, so without
  // this the panel keeps showing an empty text — and the next edit here would wipe what they
  // wrote. Skipped while the note's own textarea has focus, so it can never clobber live typing.
  useEffect(() => {
    if (document.activeElement !== noteTextRef.current) setTitle(entity.label ?? '')
  }, [entity.label])
  /* A just-placed Notiz opens with the caret already in its text field (05.09.): placing one and
   * writing it are one act, and the operator was left looking at an empty box with no obvious
   * place to type. Mount-only — the panel is keyed by the note's id, so a later reopen of the
   * same note is an ordinary read and must not grab the focus (or, on a phone, the keyboard).
   * `preventScroll`: the sheet is a fixed flex column and the browser's own scroll-into-view
   * jumps it.
   * ⚠️ And on a phone the sheet is opened FULL first (05.09.): at its 46dvh default the focused
   * textarea sits in the bottom half of the screen, which is precisely where the iOS keyboard
   * then comes up — so the field this effect exists to put the caret in was the one thing not on
   * screen. Same class the grip's own tap sets (SheetGrip · useSheetDrag), so the operator drags
   * it back down exactly as usual; inert on every wider surface, where `.sheet-full` is not a
   * state the panel has. */
  useEffect(() => {
    if (!autoFocusNote) return
    const el = noteTextRef.current
    if (!el) return
    el.closest('.ctx')?.classList.add('sheet-full')
    el.focus({ preventScroll: true })
    const n = el.value.length
    try { el.setSelectionRange(n, n) } catch { /* nothing selectable yet */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // live-title editing: every keystroke goes out as `typing` (the surface shows it, silently) and
  // the blur finalises it as ONE `commit` (one undo step + audit).
  const liveEdited = useRef(false)
  const changeTitle = (raw: string) => {
    // ⚠️ Emoji are stripped where text ENTERS, not where it prints: this label rides onto the
    // Kroki and into the rapport, both set in Helvetica, which draws a black box for one
    // (lib/format · stripUnprintable). Same guard on the detail fields and the notes below.
    const v = stripUnprintable(raw)
    setTitle(v)
    liveEdited.current = true
    onPatch({ label: v }, 'typing')
    return v
  }
  /** Ends a live title edit that is still open. Only a Notiz's text stays open between
   *  keystrokes (a symbol's name commits with each pick), and its typing holds an open undo step
   *  on the surface: the panel leaving without a blur – ✕, a swipe, another selection – closes it
   *  here, so the edit is its own ↶ step and never folds into the next act. «Entfernen» closes it
   *  BEFORE the removal, so the removal stays the later step – the order a blur would have given. */
  const endLiveTitle = () => { if (liveEdited.current) { liveEdited.current = false; commit({ label: title }) } }
  useCommitDraftOnUnmount(endLiveTitle)
  const blurTitle = () => {
    if (liveEdited.current) endLiveTitle()
    else if (title !== (entity.label ?? '')) commit({ label: title })
  }
  // Committed against a ref, not `entity.notes`: the unmount commit below re-runs blurNotes
  // after a normal blur→close, when the entity prop may not have caught up yet — the ref keeps
  // that second call a no-op instead of a duplicate undo step + audit emit.
  const notesCommitted = useRef(entity.notes ?? '')
  const blurNotes = () => {
    if (notes === notesCommitted.current || notes === (entity.notes ?? '')) return
    notesCommitted.current = notes
    commit({ notes: notes || undefined })
  }
  // A swipe-dismiss / slot swap unmounts the focused textarea without a blur — commit the draft
  // then, or the typed Notiz dies with the sheet (Feldtest 07.09.).
  useCommitDraftOnUnmount(blurNotes)
  // Gefahrentafel auto-fill: when a UN-Nr row resolves to an ADR substance and the
  // Stoff row is still empty, seed its German name. Only fills an empty Stoff so a
  // manually-typed substance is never clobbered.
  //
  // Swap repair (07.09.2026): operators transcribe the physical orange plate top-to-bottom —
  // Gefahrnummer first, UN second — so the Kemler lands in UN-Nr. and the UN in Stoff. When
  // the UN-Nr. value is no UN but the Stoff value IS a known UN whose ADR Kemler equals the
  // typed digits, the entry is unambiguously that swap: move the UN into its field and fill
  // Stoff with the substance name (the Kemler is auto-derived, it lives nowhere as data).
  // UN-speaking symbols (Tafel, Gas, Chemie — lib/symbols · UN_CAPABLE): the Stoff row turns
  // into a substance search over the station's common list plus the full ADR table, and a
  // committed Stoff resolves its UN number the same way a committed UN resolves its Stoff.
  const unCapable = unPanel
  const commons = (unCapable && appConfig.symbols.unCommons[entity.symbol!]) || []
  const stoffOptions = useMemo(() => {
    if (!unCapable) return []
    // commons lead (the one-tap answers), the official names follow — minus the officials a
    // common label already covers («Propan» vs the dataset's «PROPAN»)
    const covered = new Set(commons.map((c) => c.label.toLowerCase()))
    return [...commons.map((c) => c.label), ...allStoffNames().filter((n) => !covered.has(n.toLowerCase()))]
    // eslint-disable-next-line react-hooks/exhaustive-deps -- commons is derived from the symbol
  }, [unCapable, entity.symbol, hazVersion])

  const fillFromUN = (rs: Row[]): Row[] => {
    const un = findVal(rs, UN_KEY).trim()
    const stoff = findVal(rs, STOFF_KEY).trim()
    // «Changed» is measured against the STORED record: whichever of the pair this commit
    // touched pulls the other one along. Fill-only-if-empty left the plate lying twice over
    // (Feldtest 08.09.): a new UN-Nr. kept the previous Stoff standing, a newly picked Stoff
    // kept the previous UN-Nr. — and the readout/rings follow the UN, so the mismatch was live.
    const storedVal = (key: string) =>
      (Object.entries(entity.fields ?? {}).find(([k]) => normKey(k) === key)?.[1] ?? '').trim()
    const unChanged = un !== storedVal(UN_KEY)
    const stoffChanged = stoff !== storedVal(STOFF_KEY)
    // The swap check runs BEFORE lookupUN(un): lookupUN zero-pads, so a transcribed
    // Kemler like «30» would otherwise resolve to the class-1 UN 0030 (detonators) and
    // mask the far likelier reading of the pair.
    const swapHit = /^x?\d{2,3}$/i.test(un) && /^\d{4}$/.test(stoff) ? lookupUN(stoff) : null
    if (swapHit?.hazardNumber?.toUpperCase() === un.toUpperCase()) {
      return rs.map((r) =>
        normKey(r.k) === UN_KEY ? { ...r, v: stoff }
        : normKey(r.k) === STOFF_KEY ? { ...r, v: swapHit.name_de ?? '' }
        : r)
    }
    // The substance was just picked/typed and the UN-Nr. was not: the Stoff wins. Resolve it
    // (commons first, then the exact official ADR name — never a fuzzy guess) and REPLACE the
    // standing UN-Nr.; an unresolvable substance clears it, because a UN-Nr. left over from the
    // previous substance is wrong ERG distances on the map, not a leftover.
    if (stoff && stoffChanged && !unChanged) {
      const target = commons.find((c) => c.label.toLowerCase() === stoff.toLowerCase())?.un
        ?? lookupUNByName(stoff)?.un
      if ((target ?? '') !== un) return rs.map((r) => (normKey(r.k) === UN_KEY ? { ...r, v: target ?? '' } : r))
      return rs
    }
    const hit = lookupUN(un)
    if (hit?.name_de) {
      // A just-changed UN-Nr. replaces the substance name; an untouched one only fills a blank.
      // Overwriting demands a PROPER 4-digit UN: lookupUN zero-pads, so a Kemler-like «44» would
      // resolve to 0044 and clobber a Stoff over what is most likely a transcription slip.
      const write = unChanged && /^\d{4}$/.test(un) ? stoff !== hit.name_de : !stoff
      return write ? rs.map((r) => (normKey(r.k) === STOFF_KEY ? { ...r, v: hit.name_de! } : r)) : rs
    }
    // The reverse door (Feldtest Manuel, 07.09.): the operator knows the SUBSTANCE. A committed
    // Stoff with an empty UN-Nr. resolves the same way and fills the UN row.
    if (!un && stoff) {
      const target = commons.find((c) => c.label.toLowerCase() === stoff.toLowerCase())?.un
        ?? lookupUNByName(stoff)?.un
      if (target) return rs.map((r) => (normKey(r.k) === UN_KEY ? { ...r, v: target } : r))
    }
    return rs
  }
  // build the detail map from the editable rows (drop blank keys) and commit it
  const commitRows = (raw: Row[]) => {
    const next = fillFromUN(raw)
    setRows(next)
    const rec: Record<string, string> = {}
    for (const { k, v } of next) { const key = stripUnprintable(k).trim(); if (key) rec[key] = stripUnprintable(v) }
    // …this is now what the entity says, as far as this panel is concerned (see the sync effect)
    writtenRef.current = JSON.stringify(rec)
    rowsDirty.current = false
    commit({ fields: rec })
  }
  const setRow = (i: number, patch: Partial<Row>) => {
    rowsDirty.current = true
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  }
  // A tap on the Karte deselects and unmounts this panel while the caret still sits in a field –
  // a removed node gets no blur, so the typed value (a Messpunkt reading, 27.10.) died with the
  // panel. Same door the Notizen use.
  useCommitDraftOnUnmount(() => { if (rowsDirty.current) commitRows(rows) })
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
  // the handover is offered on the Einsatzleiter glyph once there is something to swap
  const elPair = elSym && rows.some((r) => r.k.trim() === EL_NAME) && rows.some((r) => r.k.trim() === EL_STV)
    && rows.some((r) => (r.k.trim() === EL_NAME || r.k.trim() === EL_STV) && r.v.trim())
  // a removal goes at once, no toast (the delete rule, lib/removal): the ↶ brings the row back
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

  // ONE storey vocabulary on both surfaces (Bastian, 15.09.2026): «Von / Bis Geschoss» for every
  // symbol that knows storeys at all – a single storey is Von = Bis. The old single «Geschoss»
  // stepper is gone; on the Gebäude the tile seeds both ends (Whiteboard), on the Karte they
  // start empty. The `floor`/`storey` fields stay readable for what older records carry.
  const showFloorRange = allow('floorRange') || allow('floor')
  const showCount = allow('count')
  const showRotate = allow('rotation')
  const showRotate2 = allow('rotation2')   // composite Grosslüfter: body + fan
  const showAirflow = allow('airflow')     // mobile Lüfter: Einblasen / Absaugen
  const showSpread = allow('spread')
  /** one end of the Von/Bis span: the other end keeps what the panel shows, and the old single
   *  `floor` goes (the span replaces it) */
  const setFloor = (end: 'from' | 'to', f: number | null) => commit({
    floor: undefined,
    floorFrom: end === 'from' ? f ?? undefined : entity.floorFrom ?? entity.floor,
    floorTo: end === 'to' ? f ?? undefined : entity.floorTo ?? entity.floor,
  })
  /** a bearing from a stepper (null = ✕), stored in [0, 360) and 0 as absent */
  const turn = (v: number | null) => (v == null ? undefined : bearing360(v))
  // live ADR hazard readout — derived from the current UN-Nr row, so it updates as you
  // type. Only present when this symbol carries a UN-Nr field with a value. The block itself is
  // UnHazardSection, shared with the Gefahrgut lookup of «Karte & Objekte».
  const unValue = findVal(rows, UN_KEY).trim()
  const showUnHazard = unValue.length > 0
  // A note reuses this panel (`isNote`), but none of the symbol chrome applies to it: it has no
  // glyph to rotate, no preset fields, and its own text already IS the free-text field — a second
  // "Notizen" box inside a note would be a riddle. So the details block is suppressed outright
  // and the Notiz section below is all a note gets.
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
  // a live vehicle's Fahrer / Herkunft count as details too – a read-only sheet with no other row hid them
  const showDetails = !isNote && (showFloorRange || showCount || showRotate || showSpread || showAirflow || offersNotes || rows.length > 0 || showUnHazard || !readOnly || !!driver || !!origin || vehicleTimes.length > 0)

  /* on-canvas caption override for THIS symbol — small + de-emphasised down by the actions
     (the field values matter first; visibility is a rare tweak). Standard follows the device
     default (Einstellungen ▸ Beschriftungen); 'Aus' silences a noisy one, 'Auto'/'Alle' opt a
     single key symbol in even when the device default is off. */
  // Just Aus / Auto / Alle — the operator never has to reason about "follow the device default"
  // (the old "Standard" option): an untouched symbol simply shows the effective default as active,
  // and picking any button pins that mode on this symbol.
  const capMode = entity.caption ?? captionDefault
  const capWord = { off: C.captionOff, auto: C.captionAuto, all: C.captionAll } as const
  // a locked panel STATES the mode (RBAC audit 22.10.2026): a read-out, not three faded buttons
  const caprow = isSymbol && (
    <div className="ctx-caprow">
      <span className="ctx-caprow-lbl">{C.caption}</span>
      {readOnly ? <b className="kv-val-ro">{capWord[capMode]}</b> : (
        <Segmented ariaLabel={C.caption} value={capMode}
          options={(['off', 'auto', 'all'] as const).map((value) => ({ value, label: capWord[value] }))}
          onChange={(v) => commit({ caption: v })} />
      )}
    </div>
  )
  /* ── «Zustand» (lib/objectDone, review item 21b 24.09.2026) ── a row like «Beschriftung»:
     «Zustand [Brennt | Gelöscht]» on a Feuer, «[Aktiv | Erledigt]» on the other damage and hazard
     symbols (owner pick UX journeys M·6, 25.11.2026). It replaces the foot's «Erledigt» tile
     (31.10.2026, SHEETS.9 of 17.11.2026: [Zentrieren · toggle · Entfernen] on every card) for
     symbols: a walker left a burnt-out Feuer standing because the tile read like «close the
     panel». Read as a STATE, not an action; the foot is [Zentrieren · Entfernen]. The second half
     keeps its hold sentence («bleibt grau auf Karte und Rapport», `data-holdexplain`). WHEN it was
     set is the header's subtitle («Schadenlage · gelöscht 20:40», doneAt), so a read-only panel,
     which has no row, still states it. */
  const doneAt = !isNote ? doneStatusText(entity) : null
  const O = appConfig.copy.objectDone
  const family = isFireFamily(entity.symbol) ? 'fire' : 'other'
  const stateRow = onDone && !readOnly && !isNote ? (
    <div className="ctx-caprow">
      <span className="ctx-caprow-lbl">{O.stateLabel}</span>
      <Segmented ariaLabel={O.stateLabel} value={!!doneAt} explain
        options={[
          { value: false, label: O.stateActive[family], title: O.stateActive[family] },
          { value: true, label: O.word[family].title, title: fillTemplate(O.stateDoneHint, { word: O.word[family].title }) },
        ]}
        onChange={(v) => { if (v !== !!doneAt) onDone(v) }} />
    </div>
  ) : null
  // rendered twice: pinned at the sheet bottom on desktop/tablet, and again inside the
  // scrolling body for phones (.ctx-footer-inline) — CSS shows exactly one copy
  const actions = (
    <div className="ctx-actions">
      {/* first, and in the link tone: on a read-only panel it is the only thing that DOES anything,
          and what it does is leave for the real object. */}
      {onOriginal && <LinkBtn onClick={onOriginal} text={originalLabel ?? C.toOriginal} />}
      {onCenter && <Button icon={<Icon id="cross" />} onClick={onCenter}>{C.center}</Button>}
      {/* «GPS» (reset a vehicle's manual override) and «Löschen» are alternatives, and a live
          entity gets neither — `readOnly` is already true for anything externally sourced.
          A self-reported crew position is the exception: it is somebody's own row, and the
          command post can clear it (see onStopSharing). */}
      {/* neutral, not the delete red: it stops a share, the person can share again (ELEM.11) */}
      {onStopSharing && (
        <Button icon={<Icon id="close" />} onClick={onStopSharing} data-holdexplain aria-label={C.stopSharingTitle}>{C.stopSharing}</Button>
      )}
      {/* «Festhalten» and «GPS» are the two directions of one thing, so they sit together:
          hold this vehicle where it stands, or give it back to the feed. Only ONE is ever
          live — a pinned vehicle has nothing to pin, a following one has nothing to reset.
          Their sentences are the HOLD's (`data-holdexplain`, button sweep audit A5/A6/A11): a
          `title` was the mouse's alone. */}
      {onPinGps && <Button icon={<Icon id="coords" />} onClick={onPinGps} data-holdexplain aria-label={C.pinGpsTitle}>{C.pinGps}</Button>}
      {onResetGps
        ? <Button icon={<Icon id="compass" />} disabled={!hasOverride} onClick={onResetGps} data-holdexplain aria-label={C.resetGpsTitle}>{C.resetGps}</Button>
        // «Entfernen», the one word for taking a tactical object off the picture (25.09.2026) —
        // «gelöscht» is what a Feuer becomes (objectDone), so it can no longer name this press.
        // Bin + word, like every other card's remove (owner, button sweep SHEETS.1, 17.11.2026 – the
        // bin SQUARE of 27.09.2026 was the one remove you could not read without guessing); on a
        // symbol with a «Zustand» its HOLD says what it is for (`data-holdexplain`, audit A1).
        : (!readOnly || allowDelete) && !onStopSharing && (
          <Button variant="danger" icon={<Icon id="trash" />} onClick={() => { endLiveTitle(); onDelete() }}
            {...(onDone ? { 'data-holdexplain': true, 'aria-label': `${appConfig.copy.remove} – ${O.removeHint}` } : {})}>
            {appConfig.copy.remove}
          </Button>
        )}
    </div>
  )

  // the header shares the grip's drag (tap stays a tap there — see useSheetDrag)
  const sheetDrag = useSheetDrag({ onClose, tapToggles: false })
  // the first measured gas (the Messpunkt) – the tick column's caption stands above it
  const firstMeasured = rows.findIndex((r) => symbolFieldKind(entity.symbol, r.k) === 'measured')
  return (
    <CtxShell onClose={onClose}>
      <SheetGrip onClose={onClose} />
      {/* the whole header drags the sheet too, not just the 44×5px grip above it */}
      <div className="ctx-head" {...sheetDrag}>
        <div className="ph">
          {/* header chip: the small copy. The full-size preview below (.ctx-photo) is the
              point of a photo marker's panel and keeps the real picture. */}
          {/* ⚠️ SEC-01 — sanitise AT THIS SINK. `svg` is the selected entity's editor-supplied
              `symbolSvg`, free workspace data that round-trips through the PUT/GET. The finding
              reopened four times because a sink like this one rendered it raw while only
              TacticalSymbol was covered; the sink sanitiser is the authoritative gate, so EVERY
              `dangerouslySetInnerHTML` that takes an SVG string must wrap it, never trust the prop. */}
          {entity.photoUrl ? <img src={thumbUrl(entity.photoUrl)} alt="" decoding="async" />
            : svg ? <span className={bareBlack(svg) ? 'glyph-tile' : undefined} dangerouslySetInnerHTML={{ __html: sanitizeSvg(svg) }} />
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
              phone (components/SheetGrip · useSheetDrag).
              ⚠️ …and its header says the TYPE too («Fahrzeug», or the pack's name), like every
              other symbol (29.09.2026, sweep K12). It showed «TLF» as an underlined button that
              jumped to the field: one value in two places, and the underline read as a second
              field. The name lives in «Bezeichnung» only. */}
          {/* soft hyphens at a compound's seams (lib/symbolWrap): «Unverletzten-sammelstelle»
              breaks where the eye completes it, never under the ✕ (design pass D5, 18.11.2026) */}
          <span className="ctx-title-input ctx-title-ro">
            {isNote ? N.section : entity.photoUrl ? appConfig.copy.photoViewer.title : softHyphenateText(symbolName || title || C.titlePlaceholder)}
          </span>
          {/* a note's subtitle IS «Notiz», which the title above already says – one word is enough.
              A symbol declared over says when, beside its type: «Schadenlage · erledigt 20:40» –
              on a read-only panel too, where the Führungsansicht wants to know that the fire was
              declared out, and when (see stateRow). */}
          {!isNote && (entity.subtitle || doneAt) && (
            <p>{entity.subtitle}{entity.subtitle && doneAt && ' · '}{doneAt && <span className="ctx-done-at">{doneAt}</span>}</p>
          )}
          {/* a photo placed from the Verlauf says where it came from, and when it was taken */}
          {entity.photoOf && !entity.subtitle && (
            <p>{takenClock(entity.takenAt) ? fillTemplate(appConfig.copy.photoGeo.markerTaken, { t: takenClock(entity.takenAt)! }) : appConfig.copy.photoGeo.marker}</p>
          )}
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
                // …same marker, same reason as the Notizen field further down
                data-entity-edit=""
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
            <div className="field">
              <span>{N.size}</span>
              <Segmented
                ariaLabel={N.size}
                options={[{ value: 's', label: N.sizeS }, { value: 'm', label: N.sizeM }, { value: 'l', label: N.sizeL }]}
                value={entity.noteSize ?? 'm'}
                onChange={(v) => commit({ noteSize: v as NoteSize })}
              />
            </div>
            <div className="field">
              <span>{N.look}</span>
              <Segmented
                ariaLabel={N.look}
                // «Klartext» said nothing on its own: the hold says both (audit A10, 17.11.2026)
                explain
                options={[{ value: false, label: N.lookPill, title: N.lookPillWhat }, { value: true, label: N.lookPlain, title: N.lookPlainWhat }]}
                value={!!entity.notePlain}
                onChange={(v) => commit({ notePlain: v || undefined })}
              />
            </div>
            <div className="field">
              <span>{N.color}</span>
              {/* the drawing palette, plus a "default note ink" swatch first — same colours as
                  every other coloured thing on the surface, so there is no second palette */}
              <div className="ctx-note-colors">
                <button className={`dh-color note-ink${entity.color ? '' : ' on'}`} title={N.color} aria-label={N.color}
                  aria-pressed={!entity.color} onClick={() => commit({ color: undefined })} />
                {NOTE_COLORS.map((c) => (
                  <button key={c} className={`dh-color${entity.color === c ? ' on' : ''}`} style={{ background: c }}
                    aria-pressed={entity.color === c} aria-label={colorName(c)} onClick={() => commit({ color: c })} />
                ))}
              </div>
            </div>
          </div>
        )}
        {showDetails && <>
          {/* The glyph-affecting steppers — grouped, only the ones this symbol declares. View
              state keeps the literal same row/chrome and disables it: removing unset controls
              made the mirrored object's sidebar a different, mostly empty object. */}
          {driver && !driver.onChange && (
            // the locked session's read-out: the same row, the value as every read-only field shows it
            <div className="field"><span className="kv-key-ro" ref={smartHyphens}>{C.driverLabel}</span><b className="kv-val-ro">{driver.value || '–'}</b></div>
          )}
          {driver?.onChange && (
            // The SAME row as the placed vehicle's preset «Fahrer» (label left, picker right —
            // .field): it used to be its own full-width block, so the one field a live vehicle
            // offers looked like a different kind of thing than the identical field next door.
            // A <label>, so tapping the word opens the picker.
            <label className="field">
              <span className="kv-key-ro" ref={smartHyphens}>{C.driverLabel}</span>
              {/* ⚠️ The SAME picker as every other roster field (sweep, 10.08.). This one had no
                  Dienstgrad, no «unter AS / Magazin / nicht anwesend» and no rank ordering — on
                  the one field where naming somebody who is already under Atemschutz is the
                  conflict the app warns about, and it warned only AFTER the pick. Now the row
                  says so while the finger is still over it. */}
              <Combo
                value={driver.value}
                options={driver.options ?? []}
                allowCustom
                placeholder={C.driverPlaceholder}
                rankOf={rankOf ?? (rosterRank ? (n: string) => rosterRank[n] : undefined)}
                statusOf={personStatus}
                onChange={driver.onChange}
              />
            </label>
          )}
          {origin && !origin.onChange && (
            <div className="field"><span className="kv-key-ro" ref={smartHyphens}>{ORIGIN_FIELD}</span><b className="kv-val-ro">{origin.value || '–'}</b></div>
          )}
          {origin?.onChange && (
            // the SAME control as a placed vehicle's preset «Herkunft» row below (FieldControl)
            <label className="field">
              <span className="kv-key-ro" ref={smartHyphens}>{ORIGIN_FIELD}</span>
              <FieldControl fieldKey={ORIGIN_FIELD} value={originDraft} options={origin.options}
                placeholder={valuePlaceholder(ORIGIN_FIELD)}
                onInput={setOriginDraft} onCommit={(v) => { setOriginDraft(v); if (v !== origin.value) origin.onChange?.(v) }} />
            </label>
          )}
          {/* ⚠️ `showFloorRange` belongs in this gate — it was the one stepper left out, so a
              symbol whose preset lists ONLY 'floorRange' (the Lift) rendered the row of
              steppers not at all and its von/bis storeys were unreachable on both surfaces. */}
          {(showFloorRange || showCount || showRotate || showAirflow) && (
            <div className="ctx-steps">
              {/* Untergeschosse are as easy as Obergeschosse: `seedOnDec` makes the FIRST tap on
                  either − or + land on EG (0), so a Kellerbrand is one further tap on − instead of
                  an unreachable stepper. Typing works the same way — the readout is an input and
                  takes «-1» directly. Both ends of the von/bis span step independently. */}
              {showFloorRange && (
                <>
                  <LabeledStepper label={C.floorFrom} value={entity.floorFrom ?? entity.floor ?? null} format={floorStr} placeholder={C.floorNone} seed={0} seedOnDec
                    onChange={(v) => setFloor('from', v)} onClear={() => setFloor('from', null)} canClear={entity.floorFrom != null || entity.floor != null}
                    min={FLOOR_MIN} max={FLOOR_MAX} readOnly={readOnly} ariaLabel={C.floorFrom} />
                  <LabeledStepper label={C.floorTo} value={entity.floorTo ?? entity.floor ?? null} format={floorStr} placeholder={C.floorNone} seed={0} seedOnDec
                    onChange={(v) => setFloor('to', v)} onClear={() => setFloor('to', null)} canClear={entity.floorTo != null || entity.floor != null}
                    min={FLOOR_MIN} max={FLOOR_MAX} readOnly={readOnly} ariaLabel={C.floorTo} />
                </>
              )}
              {showCount && (
                <LabeledStepper label={countLabel} value={entity.count ?? 1}
                  onChange={(v) => commit({ count: v > 1 ? v : undefined })} onClear={() => commit({ count: undefined })} canClear={(entity.count ?? 1) > 1}
                  min={1} max={COUNT_MAX} readOnly={readOnly} ariaLabel={countLabel} />
              )}
              {showRotate && (
                // when a fan rotation is also present (Grosslüfter) the body stepper reads «Fahrzeug»
                <LabeledStepper label={showRotate2 ? C.rotationVehicle : C.rotation} value={signedDeg(entity.rotation ?? 0)} step={ROT_STEP} snap format={fmtDeg}
                  onChange={(v) => commit({ rotation: turn(v) })} onClear={() => commit({ rotation: turn(null) })} canClear={(entity.rotation ?? 0) !== 0}
                  min={-180} max={180} readOnly={readOnly} ariaLabel={showRotate2 ? C.rotationVehicle : C.rotation} />
              )}
              {showRotate2 && (() => {
                // the part stepper reads «Lüfter», «Leiter» … per the composite (fan vs ladder/boom)
                const partLabel = C[compositeSpec(entity.symbol)?.partLabel ?? 'rotationFan']
                return (
                  <LabeledStepper label={partLabel} value={signedDeg(entity.rotation2 ?? 0)} step={ROT_STEP} snap format={fmtDeg}
                    onChange={(v) => commit({ rotation2: turn(v) })} onClear={() => commit({ rotation2: turn(null) })} canClear={(entity.rotation2 ?? 0) !== 0}
                    min={-180} max={180} readOnly={readOnly} ariaLabel={partLabel} />
                )
              })()}
              {/* Lüfter airflow direction — Einblasen (arrow away from the fan) vs Absaugen (arrow
                  reversed into the fan). A field row (label + segmented value) so it reads like the
                  steppers above, not a separate widget. */}
              {showAirflow && (
                <div className="field">
                  <span>{C.airflow}</span>
                  {/* a locked panel states the direction (the Beschriftung's read-out recipe) */}
                  {readOnly ? <b className="kv-val-ro">{entity.extract ? C.airflowExtract : C.airflowBlow}</b> : (
                    <Segmented ariaLabel={C.airflow} value={entity.extract ?? false}
                      options={[{ value: false, label: C.airflowBlow }, { value: true, label: C.airflowExtract }]}
                      onChange={(v) => commit({ extract: v || undefined })} />
                  )}
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
                  {/* a locked session READS the spread: the lit arrows (and their Grenze) as plain
                      glyphs, «–» for none – never faded buttons (duck sweep FEEDBACK.5) */}
                  {readOnly ? (
                    <span className="kv-val-ro spread-ro">
                      {dirs.some((d) => sp[d]) ? dirs.filter((d) => sp[d]).map((d) => (
                        <span className="spread-unit" key={d} role="img" aria-label={sp[boundedKey(d)] ? `${C.spreadDirTitles[d]} · ${C.spreadBounded}` : C.spreadDirTitles[d]}>
                          {d === 'left' && sp[boundedKey(d)] && <Icon id={GRENZE_GLYPH[d]} />}
                          <Icon id={SPREAD_GLYPH[d]} />
                          {d !== 'left' && sp[boundedKey(d)] && <Icon id={GRENZE_GLYPH[d]} />}
                        </span>
                      )) : '–'}
                    </span>
                  ) : (
                  <div className="spread-btns">
                    {dirs.map((d) => {
                      const dir = (
                        <button className={`spread-btn dir ${sp[d] ? 'on' : ''}`} title={C.spreadDirTitles[d]}
                          aria-label={C.spreadDirTitles[d]} onClick={() => toggleDir(d)}>
                          <Icon id={SPREAD_GLYPH[d]} />
                        </button>
                      )
                      // the bar itself, not the word: on paper the Grenze IS the stroke across
                      // the arrow tip (→|), so the button shows what it draws — and it is
                      // perpendicular to its own arrow, like the printed symbol
                      const grenze = (
                        // ONE name, the hold's: «Grenze nach links – Ausbreitung hier gestoppt» (audit
                        // B18, 17.11.2026) – the meaning sat in a `title` the hold never reads
                        <button className={`spread-btn grenze ${sp[boundedKey(d)] ? 'on' : ''}`}
                          aria-label={`${C.spreadBounded} ${C.spreadDirTitles[d]} – ${C.spreadBoundedWhat}`}
                          onClick={() => toggleBounded(d)}>
                          <Icon id={GRENZE_GLYPH[d]} />
                        </button>
                      )
                      // one capsule per direction, the bar on the arrow's tip side: «|←» and «→|»
                      return <span className="spread-unit" key={d}>{d === 'left' ? <>{grenze}{dir}</> : <>{dir}{grenze}</>}</span>
                    })}
                  </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* The generic Fahrzeug's own name. It used to be the header input; here it reads like
              every other field, keeps its type list, and leaves the header free to be dragged. */}
          {labelled && (readOnly ? (
            <div className="field"><span>{C.labelField}</span><b className="kv-val-ro">{title || '–'}</b></div>
          ) : (
            <label className="field">
              <span>{C.labelField}</span>
              <Combo
                value={title} options={titleOptions ?? []} placeholder={C.titlePlaceholder}
                allowCustom
                onChange={(raw) => { const v = changeTitle(raw); liveEdited.current = false; commit({ label: v }) }}
              />
            </label>
          ))}
          {/* …and the double it makes beside the GPS vehicle of that name: THE amber form warning,
              its two ways out (lib/gpsTwin) – hold the GPS one here instead, or «Sind zwei», which
              silences it for this symbol (owner sign-off note, 25.11.2026: «two TLFs can really be
              there»). Under the name it is about, on every device. */}
          {labelled && gpsTwin && (
            <div className="form-warn form-warn-amber ctx-gps-twin" role="note">
              <Icon id="warn" />
              <span className="form-warn-text"><b>{gpsTwin.name}</b> {fillTemplate(C.gpsTwinHint, { m: Math.max(1, Math.round(gpsTwin.distM)) })}</span>
              {gpsTwin.onHold && (
                <button type="button" className="form-warn-act" onClick={gpsTwin.onHold}>{fillTemplate(C.gpsTwinHold, { name: gpsTwin.name })}</button>
              )}
              {gpsTwin.onKeep && (
                <button type="button" className="form-warn-act" onClick={gpsTwin.onKeep}>{C.gpsTwinKeep}</button>
              )}
            </div>
          )}

          {/* labelled key/value detail rows: the symbol's preset, plus any free row an older record
              carries. No new free rows (31.10.2026, «+ Feld» is gone) – what is worth saying about
              one symbol beyond its preset goes into Notizen. */}
          {/* ⚠️ NO section title. A «Fahrer» row is a label and a value selector — exactly what the
              Drehung and the Bezeichnung above it are — so a heading over it only claimed that a
              different KIND of thing started here. Of 81 symbols, 30 carry no such row at all, 27
              carry one and exactly one carries four, so the whole run is glanceable without being
              announced. Titles are kept for the blocks that are genuinely something else: the
              Ausbreitung (two sub-rows), the Mittel-Erfassung, die UN-Gefahr, Notizen, Farbe and
              the Leitungen.
              ⚠️ `data-entity-edit` marks the whole block: every field control in it is free text
              somebody may still be typing — see the Notizen field below. */}
          {rows.length > 0 && (
            <div className="ctx-rows" ref={fieldsRef} data-entity-edit="">
              {rows.map((r, i) => {
                const fixed = readOnly || !!protectedKeys?.has(r.k.trim())
                // The Stoff row of a UN-speaking symbol is a substance search, not a plain
                // field: the common list one tap away, the full ADR table behind the search
                // row, free text through the Gast door — and the commit resolves the UN-Nr.
                // (fillFromUN's reverse branch), which lights the readout and the rings.
                const stoffSearch = unCapable && normKey(r.k) === STOFF_KEY
                const control = (
                  <FieldControl fieldKey={r.k} value={r.v} kind={symbolFieldKind(entity.symbol, r.k)} options={fieldOptions?.[r.k]}
                    placeholder={valuePlaceholder(r.k)}
                    officerFilter={officerSym} rankOf={rankOf} statusOf={personStatus}
                    onInput={(v) => setRow(i, { v })} onCommit={(v) => setRowValue(i, v)} />
                )
                const field = (
                  <>
                    {stoffSearch ? (
                      <Combo value={r.v} options={stoffOptions} allowCustom limit={40}
                        placeholder={valuePlaceholder(r.k)}
                        searchPlaceholder={C.stoffSearch}
                        onChange={(v) => setRowValue(i, v)} />
                    ) : symbolFieldKind(entity.symbol, r.k) === 'measured' ? (
                      // a measured gas (the Messpunkt): the number box, its bare «über Messbereich» tick
                      // and the calm/amber/red bar under them, following the value as it is typed
                      <MeasuredField symbol={entity.symbol} fieldKey={r.k.trim()} value={r.v} placeholder={valuePlaceholder(r.k)}
                        onInput={(v) => setRow(i, { v })} onCommit={(v) => setRowValue(i, v)} />
                    ) : control}
                    {/* the contradiction stays put, under the field it is about */}
                    {fieldHints?.[r.k.trim()] && (
                      <p className="kv-hint"><Icon id="warn" />{fieldHints[r.k.trim()]}</p>
                    )}
                  </>
                )
                // a preset / read-only field reads like the Darstellung rows above — a plain label and
                // the control, no editable-key box, no delete — so a «Typ» sits identically to a
                // «Luftrichtung». A free row from an older record keeps its editable key + delete
                // (nothing new is added since 31.10.2026, but what was written stays editable).
                // the caption of the tick column, once, above the first measured gas (ReadingParts)
                const overHead = !readOnly && i === firstMeasured && <ReadingOverHead />
                return fixed ? (
                  <Fragment key={i}>
                    {overHead}
                    <div className="field">
                      <span className="kv-key-ro" ref={smartHyphens}>{rowLabel(r.k)}</span>
                      {readOnly ? <b className="kv-val-ro">{r.v || '–'}</b> : field}
                    </div>
                  </Fragment>
                ) : (
                  <Fragment key={i}>
                    {overHead}
                    <div className={`kv-row${dupRow[i] ? ' dup' : ''}`}>
                      <input className="kv-key" value={r.k} placeholder={C.fieldKeyPlaceholder}
                        aria-invalid={dupRow[i] || undefined}
                        onChange={(e) => setRow(i, { k: e.target.value })} onBlur={() => commitRows(rows)}
                        {...ONE_LINE} />
                      {field}
                      <IconButton label={C.removeField} onClick={() => removeRow(i)}><Icon id="close" /></IconButton>
                    </div>
                    {dupRow[i] && (
                      <p className="kv-dup-hint" role="alert">
                        <Icon id="warn" />{C.duplicateField.replace('{key}', r.k.trim())}
                      </p>
                    )}
                  </Fragment>
                )
              })}
              {/* …and the Einsatzleiter pair gets «Führung übergeben»: the handover is a swap, and a
                  swap is one gesture. One quiet worded button on its own line under the two names
                  (rare-user r2 F17, 17.11.2026 – as a tile at the end of the EL row it squeezed the
                  names to «W.» / «Nam…», and the names are what this panel is read for). */}
              {elPair && (
                <Button variant="quiet" className="kv-swap" icon={<Icon id="swap" />} onClick={swapEl}>
                  {C.swapEl}
                </Button>
              )}
            </div>
          )}
          {/* the vehicle's Einsatz clocks (lib/vehicleTimes): automatic, so a read-out on every
              session – and LAST, under every row one can edit, below «Herkunft» (owner sign-off
              note, 25.11.2026; it opened the sheet before: «is it vor Ort?» is the radio's
              question, but the inputs come first). */}
          {vehicleTimes.map((t) => (
            <div key={t.label} className="field"><span className="kv-key-ro" ref={smartHyphens}>{t.label}</span><b className="kv-val-ro">{t.value}</b></div>
          ))}

          {/* a Messpunkt's «Gleich gemessen», its limits behind an ⓘ, then its readings, one row per
              radio report (ReadingParts). A value still in a box is committed first: the button's
              tap blurs it, and a reading must never be of what the box no longer says. */}
          {isMeasuredSymbol(entity) && !readOnly && onReadingAgain && <ReadingAgain entity={entity} onAgain={onReadingAgain} />}
          {isMeasuredSymbol(entity) && <ReadingInfo symbol={entity.symbol} />}
          {isMeasuredSymbol(entity) && <ReadingHistory entity={entity} />}

          {/* read-only ADR hazard readout from the UN number (Gefahrentafel), auto-derived
              from the ADR table — plus a deep link to a reputable source for full details. */}
          {showUnHazard && (
            <UnHazardSection
              un={unValue}
              ringMode={isSymbol && erg ? (entity.ergRings ?? DEFAULT_ERG_RING_MODE) : undefined}
              // a locked panel reads the Schutzabstand, it does not switch it (UnHazardSection).
              // 'small' is the default and is stored as absent, so a fresh placard syncs the same
              // in both directions.
              onRingMode={readOnly || !isSymbol || !erg ? undefined : (mode) => commit({ ergRings: mode === 'small' ? undefined : mode })}
              ergCoord={erg?.coord}
              onAdoptRadius={erg?.onAdopt}
              adoptedRadii={erg?.adopted}
            />
          )}

          {/* one general free-text notes field — static text in view state (a readOnly
              textarea still takes focus), and only when there ARE notes */}
          {readOnly ? ((offersNotes || notes.trim()) && (
            <div className="ctx-section ctx-notes">
              <span className="ctx-section-label">{C.notes}</span>
              <p className="ctx-notes-ro">{notes || '–'}</p>
            </div>
          )) : (offersNotes || notes) && (
            <div className="ctx-section ctx-notes">
              <span className="ctx-section-label">{C.notes}</span>
              <textarea
                className="ctx-notes-input"
                // ⚠️ the marker the Verlauf's settle window reads (IncidentWorkspace ·
                // isTypingSymbolField). This field commits on BLUR, and on a tablet a sentence
                // gets blurred and picked up again — so the 03.09. Rapport carried «Notiz «1
                // Roller in en»», «…in ennen» and «…innen» as three rows of one sentence being
                // written. While the caret is back in here, the row waits.
                data-entity-edit=""
                value={notes}
                placeholder={C.notesPlaceholder}
                onChange={(e) => setNotes(stripUnprintable(e.target.value))}
                onBlur={blurNotes}
                // Esc keeps the text and leaves the field (lib/fieldKeys); Return is a new line
                onKeyDown={leaveOnEscape}
              />
            </div>
          )}
        </>}
        {/* ⚠️ NO Truppfarbe in this PANEL any more (04.09.). The colour is automatic — one per
            Trupp, from the station's Auftrag colours or the next free one (Trupp.color) — and it
            is no longer asked in the Trupp form, on the plan chip or on either mirror. It was a
            decision nobody was making and four surfaces had to offer.
            Changing one is still possible in exactly ONE place: the marker's own bar on the Karte
            (components/TwinTeamPill · acts.color, wired in IncidentWorkspace). That is the
            surface where a colour is actually read, so it is the surface that may set it — and
            the panel does not repeat the offer. */}
        {dockedToLabel && <div className="ctx-section ctx-connections">
          <span className="ctx-section-label">{C.dockedTo.replace('{name}', dockedToLabel)}</span>
          {/* «Lösen» is the neutral framed unlink button (button sweep SHEETS.3, 17.11.2026): a detach
              can be taken back, so no red, and never an ✕, which only closes */}
          {onUndock && <Button className="ctx-conn-act" icon={<Icon id="unlink" />} onClick={onUndock}>{C.dockedRelease}</Button>}
        </div>}
        {/* Angedockte Trupps (lib/docking): one row per crew standing on this symbol. It mirrors
            the «Leitung 2 · Trupp 4 — Lösen» slot on the marker's own bar (components/TwinTeamPill)
            — same grammar, other end of the same bond. A row with no writer is a statement only,
            which is what a read-only or tactically locked surface shows. */}
        {dockedTeams.length > 0 && <div className="ctx-section ctx-connections">
          <span className="ctx-section-label">{appConfig.copy.atemschutz.dockedTeams}</span>
          {dockedTeams.map((t) => (t.onRelease
            ? <div key={t.id} className="ctx-conn-row"><span>{t.label}</span>
              <Button icon={<Icon id="unlink" />} onClick={t.onRelease} aria-label={`${C.dockedRelease}: ${t.label}`}>{C.dockedRelease}</Button></div>
            : <button key={t.id} disabled><span>{t.label}</span></button>))}
        </div>}
        {connectedLines.length > 0 && <div className="ctx-section ctx-connections">
          <span className="ctx-section-label">{appConfig.copy.drawingEditor.connectedLines.replace('{n}', String(connectedLines.length))}</span>
          {connectedLines.map((line) => <button key={line.id} onClick={() => onFocusLine?.(line.id)}><span>{line.label}</span><Icon id="chevron" className="ctx-conn-go" /></button>)}
        </div>}
        <div className="ctx-footer-inline">{caprow}{stateRow}{actions}</div>
      </div>

      {caprow}
      {stateRow}
      {actions}
    </CtxShell>
  )
}
