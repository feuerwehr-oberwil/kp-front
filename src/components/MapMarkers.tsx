import { useCallback, useEffect, useRef, useState } from 'react'
import { Marker } from 'react-map-gl/maplibre'
import type { CaptionMode, Entity, LngLat, Trupp } from '../types'
import { appConfig } from '../config/appConfig'
import { thumbUrl } from '../lib/mediaUrl'
import { useHoldToDrag } from '../lib/useHoldToDrag'
import { beginSheetPeek, endSheetPeek } from '../lib/sheetPeek'
import { Icon } from '../lib/icons'
import { MenuPick } from './MenuPick'
import { Menu, Popover, PopoverClose } from '../lib/overlays'
import { SHAPE_FREE_ASPECT, ShapeGlyph, shapeAspect } from '../lib/shapes'
import { vehicleSymbolSvg } from '../lib/useVehiclePositions'
import { placardSvgForSymbol } from '../lib/placard'
import { TacticalSymbol, compositeSpec, compositePartGlyph, luefterVariant, isHubretter, HubretterBoom } from '../lib/symbolRender'
import { symbolCaptionText } from '../lib/symbols'
import { softHyphenateText } from '../lib/symbolWrap'
import { fanOffsets, markerZ, pileAt } from '../lib/labelPass'
import { noteScale, noteWPx, clampNoteWPx } from '../lib/notes'
import { pxPerM, symPx, shapePx, isRotatableSym, isVehicleSym, effectiveLayer, TEAM_DOT_PX, TEAM_PILL_CAP_PX } from '../lib/mapView'

// A transform handle (rotate / resize) whose drag is bound with NATIVE pointer listeners that
// stopPropagation, so react-map-gl's marker-drag (a listener on the parent that fires on the same
// pointerdown) never starts alongside it. React's onPointerDown stopPropagation is delegated at
// the document root and runs too late — by then the marker is already dragging. Using the capture
// (setPointerCapture) keeps the move/up events on this element for the whole gesture.
function TransformHandle({ className, icon, title, onStart, onMove, onEnd, style }: {
  className: string; icon: string; title: string
  onStart: (clientX: number, clientY: number, el: HTMLElement) => void
  onMove: (clientX: number, clientY: number) => void
  onEnd: () => void
  style?: React.CSSProperties
}) {
  const ref = useRef<HTMLButtonElement>(null)
  // re-bind each render so the closures see the latest callbacks; it's a single element/listener
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const down = (e: PointerEvent) => {
      e.stopPropagation(); e.preventDefault()
      el.setPointerCapture(e.pointerId)
      onStart(e.clientX, e.clientY, el)
      const move = (ev: PointerEvent) => { ev.stopPropagation(); onMove(ev.clientX, ev.clientY) }
      const end = (ev: PointerEvent) => {
        ev.stopPropagation()
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', end)
        el.removeEventListener('pointercancel', end)
        onEnd()
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', end)
      el.addEventListener('pointercancel', end)
    }
    // MapLibre's Marker starts its drag on mousedown / touchstart (not just pointerdown), so block
    // those at the handle too — otherwise the marker still drags alongside the rotation on touch/stylus
    const block = (ev: Event) => ev.stopPropagation()
    el.addEventListener('pointerdown', down)
    el.addEventListener('mousedown', block)
    el.addEventListener('touchstart', block, { passive: true })
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('mousedown', block)
      el.removeEventListener('touchstart', block)
    }
  })
  return <button ref={ref} className={className} style={style} title={title} aria-label={title} onClick={(e) => e.stopPropagation()}><Icon id={icon} /></button>
}

// once a hold has armed, the finger must still travel this far (screen px) before the symbol
// actually starts following — so a tremble while holding (or holding a beat too long) can't nudge it
const DRAG_DEADZONE_PX = 6

/** Kinds the nearest-centre hit test arbitrates: compact glyphs, centred on their coordinate. */
const PILE_KINDS: Entity['kind'][] = ['symbol', 'vehicle', 'person']

/** Park the caret AFTER the existing text instead of selecting all of it. Re-opening a note is
 *  almost always "add a line", and a full selection means the next keystroke silently wipes
 *  what was already written — the worst possible default with gloves on. */
function caretToEnd(el: HTMLTextAreaElement) {
  const n = el.value.length
  el.setSelectionRange?.(n, n)
}

/** Grow a note's textarea to its content, so the editable box is exactly as tall as the note it
 *  replaces. Height must be reset first — scrollHeight never shrinks while a height is still set.
 *  (Width comes from React: every note carries one.)
 *
 *  The `> 0` guard is load-bearing: at mount the element has not been laid out yet and
 *  scrollHeight reads 0. Writing `height: 0px` collapses the textarea, and a collapsed element
 *  DROPS FOCUS — which showed up as "the note is placed but I can't type into it", with the
 *  keystrokes falling through to the global hotkeys instead. */
function autoGrow(el: HTMLTextAreaElement | null) {
  if (!el) return
  el.style.height = 'auto'
  const h = el.scrollHeight
  if (h > 0) el.style.height = `${h}px`
  else el.style.removeProperty('height')
}

interface Props {
  entities: Entity[]
  byName: Record<string, string>
  isVisible: (id: Entity['layer']) => boolean
  selectedId: string | null
  /** entities in the current marquee multi-selection — shown with a halo (no per-item
   *  handles; the group hub carries the move/delete) */
  groupSelectedIds?: string[]
  /** relationship-network highlight only; never broadens selection or movement */
  networkEntityIds?: string[]
  zoom: number
  /** current map bearing (deg). Placed symbols are pinned to GEOGRAPHIC orientation, so every
   *  glyph/handle CSS rotation is offset by −bearing and a drag stores rotation + bearing. */
  bearing?: number
  /** per-device map symbol-size multiplier (lib/prefs · symbolScales, Einstellungen slider) — scales the symPx band */
  symMul?: number
  /** device default for on-canvas symbol captions; a symbol's own `caption` overrides it.
   *  Whether a caption actually FITS is decided once for the whole map — see suppressedLabels. */
  captionMode?: CaptionMode
  /** Keys the one label pass (MapView · lib/labelPass) decided cannot be drawn without covering
   *  something that outranks them: `cap:<id>` for a symbol caption, `team:<id>` for a Trupp's
   *  name. Their owners paint the 6px ink dot instead. The SELECTED entity is never in here. */
  suppressedLabels?: ReadonlySet<string>
  /** tactical editing is locked (viewer / Führungsansicht / replay): a tap still selects
   *  so the read-only detail panel opens, but no mutating grip is rendered (see MapView).
   *  Not read in here since the note grips row went (29.08.) — the panel handles read-only
   *  itself — but the prop stays declared: MapView passes it, and a future grip needs it. */
  readOnly?: boolean
  draggable: boolean
  /** project lng/lat → container px, through the map's LIVE transform (re-anchors a hold-drag on
   *  every move, so a zoom/resize mid-drag can't teleport the symbol) */
  project: (c: LngLat) => { x: number; y: number } | undefined
  /** unproject container px → lng/lat (turns the dragged pointer position back into a coord) */
  unproject: (p: { x: number; y: number }) => LngLat | undefined
  /** toggle the map's own pan so a hold-drag of a symbol doesn't also pan the map under it */
  setDragPan: (on: boolean) => void
  onSelect: (e: Entity) => void
  onMarkerDragStart: (id: string) => void
  onMarkerMove: (id: string, c: LngLat) => void
  onMarkerDragEnd: (id: string, c: LngLat) => void
  onDelete: (id: string) => void
  onRotate?: (id: string, deg: number) => void
  onShapeTransform?: (id: string, patch: { rotation?: number; rotation2?: number; sizeM?: number; aspect?: number; reachM?: number }, phase: 'start' | 'move' | 'end') => void
  /** which note is in raw inline-text edit mode (mirrors the Plan whiteboard's text notes) */
  editNoteId?: string | null
  /** stream a note's text live as it's typed */
  onNoteText?: (id: string, text: string) => void
  /** commit a note's text on blur */
  onNoteCommit?: (id: string, text: string) => void
  /** enter inline edit on a note (double-click; placement enters edit via editNoteId) */
  onNoteEdit?: (id: string) => void
  /** open a note's detail panel. Since 29.08. this rides on the SELECT tap itself (see
   *  selectEntity) — tap = panel, drag = move, the same grammar as a symbol. */
  onNotePanel?: (id: string) => void
  /** drag the note text box's width (screen px). 'start'/'end' carry no width — they only
   *  bracket the gesture so it folds into one undo step. */
  onNoteWidth?: (id: string, w: number | undefined, phase: 'start' | 'move' | 'end') => void
  // --- kind 'team' (Trupp markers — the map mirror of the plan board's resource chips) ---
  /** monitored Trupps, for the «raus» dim/strike on a linked team marker */
  trupps?: Trupp[]
  /** open the linked Trupp on the Atemschutz surface */
  onShowTrupp?: (truppId: string) => void
  /** join this marker to an Atemschutz-Trupp — `undefined` lets go of the one it has. The mirror
   *  of the line editor's «Gehört zu Trupp …»: a marker put down before anybody was registered
   *  finds its Trupp afterwards, and joining never touches a contact clock (useTruppActions ·
   *  adoptTruppMarker). Absent ⇒ no picker (read-only / tactically locked). */
  onTeamTrupp?: (entityId: string, truppId: string | undefined) => void
  /** stamp the marker's current spot + time into its trail (the ONLY way positions are recorded) */
  onTeamMark?: (id: string) => void
  /** rename an untracked team marker — the map twin of the plan chip's rename pen */
  onTeamRename?: (id: string, name: string) => void
  /** recolour a team marker (null = back to automatic). Takes the ENTITY, because the two cases
   *  write different things: a marker bound to a Trupp recolours the TRUPP (board card and plan
   *  chip follow), a loose one recolours just itself. */
  onTeamColor?: (e: Entity, color: string | null) => void
  /** clear a team marker's recorded trail (unlocks deletion) — reached via the lock button,
   *  behind a confirm; the everyday bar button only TOGGLES visibility */
  onTeamClearTrail?: (id: string) => void
  /** per-team hidden trails (entity ids) — mirrors the plan's hiddenTrails; the eye on a
   *  selected team toggles just that team's lines + breadcrumb dots */
  hiddenTrails?: ReadonlySet<string>
  onToggleTrail?: (id: string) => void
}

/**
 * The placed-entity layer: one Marker per entity (shape / note / photo / symbol /
 * vehicle) plus its selection affordances — delete, rotor (live vehicles), and the
 * shape/symbol transform handles. Owns the rotor/transform pointer-drag refs.
 */
export function MapMarkers({ entities, byName, isVisible, selectedId, groupSelectedIds = [], networkEntityIds = [], zoom, bearing = 0, symMul = 1, captionMode = 'off', suppressedLabels, draggable, project, unproject, setDragPan, onSelect, onMarkerDragStart, onMarkerMove, onMarkerDragEnd, onDelete, onRotate, onShapeTransform, editNoteId = null, onNoteText, onNoteCommit, onNoteEdit, onNotePanel, onNoteWidth, trupps, onShowTrupp, onTeamTrupp, onTeamMark, onTeamRename, onTeamColor, onTeamClearTrail, hiddenTrails, onToggleTrail }: Props) {
  // when the note input mounted — onBlur uses this to tell a real "done editing" click-away
  // (commit) apart from the placement focus-steal (bounce focus back). See onBlur below.
  const noteEditStart = useRef(0)
  // set on Enter so its blur() commits even inside the guard window (an explicit commit, not a steal)
  const noteForceCommit = useRef(false)
  // focus the note input when it mounts. MUST be stable (useCallback) — an inline ref callback
  // re-fires every render, which would re-focus/select on each keystroke (one-key-at-a-time).
  const focusNote = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return
    noteEditStart.current = Date.now()
    // The note input is portaled into the MapLibre Marker element, whose constructor adds a
    // native `mousedown` → preventDefault() ("prevent focusing on click"). On desktop that kills
    // the input's focus-on-click. Stop the mousedown AT the input (a native listener, before it
    // bubbles to the marker element) so the default focus is preserved — pointerdown
    // stopPropagation alone doesn't help because the blocker listens for `mousedown`.
    el.addEventListener('mousedown', (ev) => ev.stopPropagation())
    // Focus synchronously on mount — stays inside the placement tap's gesture context so iPadOS
    // opens the on-screen keyboard (a deferred focus drops the gesture and the keyboard never
    // appears). Focus is then stolen by MapLibre's canvas (and/or a panel mounting on select),
    // but the onBlur guard below re-grabs it instead of letting that steal commit the note.
    el.focus(); caretToEnd(el)
    // …but that call is a SILENT NO-OP when it lands early: react-map-gl builds the Marker's
    // div and only then inserts it into the map container, so at ref time the node can still be
    // detached — and focusing a detached node does nothing at all, with no error. That is why a
    // freshly placed note could not be typed into: focus stayed on the MapLibre canvas and the
    // keystrokes fell through to the global hotkeys. Re-assert on the next frame if it did not
    // take. The synchronous attempt above is kept because when it DOES work it stays inside the
    // tap's gesture context, which is what makes iPadOS open the on-screen keyboard.
    requestAnimationFrame(() => {
      if (document.activeElement !== el) { el.focus(); caretToEnd(el) }
      // size only after layout too — scrollHeight reads 0 before it (see autoGrow)
      autoGrow(el)
    })
  }, [])
  // which team pill is in inline rename. Local, unlike editNoteId: a note enters edit straight
  // from placement (the parent has to drive that), a team is only ever renamed from its own
  // action bar, so nothing outside this component needs to know.
  const [editTeamId, setEditTeamId] = useState<string | null>(null)
  const focusTeam = useCallback((el: HTMLInputElement | null) => {
    if (!el) return
    // same MapLibre marker quirk as the note input: the Marker element preventDefaults
    // mousedown ("prevent focusing on click"), which would kill focus-on-click here too
    el.addEventListener('mousedown', (ev) => ev.stopPropagation())
    el.focus(); el.select()
    requestAnimationFrame(() => { if (document.activeElement !== el) { el.focus(); el.select() } })
  }, [])
  // a rename never survives selecting something else — leaving the pill IS the commit/abort
  useEffect(() => { setEditTeamId((cur) => (cur && cur !== selectedId ? null : cur)) }, [selectedId])
  const rotateRef = useRef<{ id: string; cx: number; cy: number } | null>(null)
  // `rot` = the shape's SCREEN rotation at grab time and `free` = per-axis resize allowed —
  // both captured on pointer-down so the corner drag can be resolved in the shape's own frame
  const shapeRef = useRef<{ id: string; cx: number; cy: number; lat: number; mode: 'rotate' | 'resize' | 'rotate2' | 'cage'; rot: number; free: boolean } | null>(null)
  // Press-and-hold to move a placed symbol. Markers are NOT react-map-gl-draggable (that would
  // claim every pan/zoom that starts on a symbol and drag it instead of the map); instead a still
  // hold past the delay arms a drag — a quick flick to pan/zoom passes straight through to the map.
  // cx/cy = the pointer's start client px (the deadzone's reference); lx/ly = the pointer's client
  // px at the previous move; `last` = the coord this drag put the symbol at, i.e. where it is now.
  const hold = useHoldToDrag()
  const entDrag = useRef<{ id: string; cx: number; cy: number; lx: number; ly: number; moved: boolean; last: LngLat | null } | null>(null)
  // id of the symbol currently being dragged — shows the same selection halo as a real select
  // (dropped on drop). Set only once the drag clears the deadzone, so a hold that never moves
  // shows nothing.
  const [draggingId, setDraggingId] = useState<string | null>(null)

  // ── the pile ────────────────────────────────────────────────────────────────────────────
  // Screen-px offsets for the markers of a fanned pile, keyed by entity id. Computed ONCE, at
  // the tap: they are a transient answer to "which of these did you mean", not a layout — so
  // they ride along with a pan (the pile moves as one) and the next tap ends them either way.
  // The view they were computed for is stored with them: a zoom or a rotation re-lays the whole
  // map out under the spokes, so the answer expires by DERIVATION rather than by an effect that
  // would have to race the re-render.
  // ⚠️ …and so does a member that has MOVED since. A spoke is a promise — the hairline says «this
  // glyph really stands there» — and a live position reporting a new fix (or a symbol another
  // device pushed) broke it: the glyph kept hanging off the old offset while its true point had
  // gone, which reads as the label coming off its dot. Their coordinates are part of the key.
  type FanOffsets = Record<string, { dx: number; dy: number }>
  const fanKey = (offsets: FanOffsets) => `${zoom}|${bearing}|` + Object.keys(offsets).sort()
    .map((id) => { const e = entities.find((x) => x.id === id); return e ? `${id}@${e.coord[0]},${e.coord[1]}` : id })
    .join('|')
  const [fanState, setFan] = useState<{ key: string; offsets: FanOffsets } | null>(null)
  const fan = fanState && fanState.key === fanKey(fanState.offsets) ? fanState.offsets : null
  const openFan = (offsets: FanOffsets) => setFan({ key: fanKey(offsets), offsets })
  // A tap anywhere that is not a fanned glyph closes the fan — including a tap on the map, which
  // this component never sees otherwise. Capture phase, and bound only while a fan is open.
  useEffect(() => {
    if (!fan) return
    const away = (ev: PointerEvent) => {
      if ((ev.target as Element | null)?.closest?.('.marker.fanned')) return
      setFan(null)
    }
    const esc = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setFan(null) }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', esc) }
  }, [fan])

  /**
   * Every marker whose fat-finger pad this tap landed in, nearest centre first.
   *
   * Compact, centre-anchored glyphs only. A note is a wide pill and a shape is metres across,
   * so "distance to my centre" says nothing useful about either — those keep the browser's own
   * hit test, which for a big box is the right answer anyway.
   */
  const pileUnder = (el: EventTarget & Element, clientX: number, clientY: number, self: Entity) => {
    if (!PILE_KINDS.includes(self.kind)) return []
    const r = el.closest('.maplibregl-map')?.getBoundingClientRect()
    if (!r) return []
    const tap = { x: clientX - r.left, y: clientY - r.top }
    return pileAt(tap, entities.flatMap((x) => {
      if (!PILE_KINDS.includes(x.kind) || !Array.isArray(x.coord) || !isVisible(effectiveLayer(x))) return []
      const p = project(x.coord as LngLat)
      // pad diameter mirrors .marker::before in 03-map.css — the hit test has to measure the
      // same slop the operator can see the effect of
      return p ? [{ id: x.id, x: p.x, y: p.y, pad: Math.max(symPx(x.kind, x.coord[1], zoom, symMul) + 20, 44) }] : []
    }))
  }

  // rotate a marker by dragging its handle: angle from the glyph centre to the pointer becomes the
  // glyph rotation (0° = pointing right). NOTE: these run from TransformHandle's NATIVE listeners
  // (see below), which stop propagation before react-map-gl's marker-drag can start — React's
  // delegated stopPropagation fires too late, so the marker would otherwise drag at the same time.
  const rotDown = (clientX: number, clientY: number, el: HTMLElement, id: string) => {
    hold.cancel() // a handle press takes over from any pending/active marker hold
    const marker = el.parentElement
    const glyph = (marker?.querySelector('.ts') ?? marker) as HTMLElement | null
    if (!glyph) return
    const r = glyph.getBoundingClientRect()
    rotateRef.current = { id, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
  }
  const rotMove = (clientX: number, clientY: number) => {
    const st = rotateRef.current; if (!st) return
    const deg = (Math.atan2(clientY - st.cy, clientX - st.cx) * 180) / Math.PI
    // store the GEOGRAPHIC heading (+ bearing) so it renders as −bearing and survives map rotation
    onRotate?.(st.id, Math.round((((deg + bearing) % 360) + 360) % 360))
  }
  const rotUp = () => { rotateRef.current = null }

  // drag-to-transform a shape. Both handles measure from the glyph centre, so the maths is
  // rotation-invariant: rotate = angle centre→pointer (+90° so the top handle leads); resize =
  // pointer distance → ground size in metres. A 'start' / 'end' pair folds the gesture into one undo.
  const shapeDown = (clientX: number, clientY: number, el: HTMLElement, id: string, lat: number, mode: 'rotate' | 'resize' | 'rotate2' | 'cage') => {
    hold.cancel() // a handle press takes over from any pending/active marker hold
    const marker = el.closest('.marker')
    const glyph = marker?.querySelector('.shape-glyph, .ts') as HTMLElement | null
    if (!glyph) return
    const r = glyph.getBoundingClientRect() // rotated/scaled AABB — centre is unchanged
    const ent = entities.find((x) => x.id === id)
    shapeRef.current = {
      id, cx: r.left + r.width / 2, cy: r.top + r.height / 2, lat, mode,
      rot: (ent?.rotation ?? 0) - bearing,
      free: mode === 'resize' && ent?.kind === 'shape' && SHAPE_FREE_ASPECT[ent.shape ?? 'square'],
    }
    onShapeTransform?.(id, {}, 'start')
  }
  const shapeMove = (clientX: number, clientY: number) => {
    const st = shapeRef.current; if (!st) return
    if (st.mode === 'cage') {
      // Hubretter cage tip: one handle sets BOTH the boom bearing (rotation2, geographic) AND the
      // reach (metres from the truck to the cage). No +90/−90 offset — the handle IS the tip, so its
      // angle is the boom direction directly.
      const deg = (Math.atan2(clientY - st.cy, clientX - st.cx) * 180) / Math.PI
      const rotation2 = Math.round((((deg + bearing) % 360) + 360) % 360)
      const dist = Math.hypot(clientX - st.cx, clientY - st.cy)
      const reachM = Math.max(5, Math.min(120, Math.round(dist / pxPerM(st.lat, zoom))))
      onShapeTransform?.(st.id, { rotation2, reachM }, 'move')
    } else if (st.mode === 'rotate' || st.mode === 'rotate2') {
      const deg = (Math.atan2(clientY - st.cy, clientX - st.cx) * 180) / Math.PI
      // the body knob sits at the top (+90 → 0°); the fan knob sits at the BOTTOM (−90), so the two
      // are always on opposite sides of the ring and easy to grab apart. + bearing stores the
      // GEOGRAPHIC angle (renders as −bearing).
      const off = st.mode === 'rotate2' ? -90 : 90
      const val = Math.round((((deg + off + bearing) % 360) + 360) % 360)
      onShapeTransform?.(st.id, st.mode === 'rotate2' ? { rotation2: val } : { rotation: val }, 'move')
    } else if (st.free) {
      // free-aspect corner drag (Rechteck / Rauch): the pointer offset, rotated into the
      // shape's own frame, sets width from |dx| and height from |dy| independently. Same
      // maths as the Plan's resize (Whiteboard · rotMove), so the two surfaces feel identical.
      const rad = (-st.rot * Math.PI) / 180
      const dx = clientX - st.cx, dy = clientY - st.cy
      const lx = dx * Math.cos(rad) - dy * Math.sin(rad)
      const ly = dx * Math.sin(rad) + dy * Math.cos(rad)
      const ppm = pxPerM(st.lat, zoom)
      const sizeM = Math.max(5, Math.min(500, Math.round((2 * Math.abs(lx)) / ppm)))
      const heightM = Math.max(5, Math.min(500, Math.round((2 * Math.abs(ly)) / ppm)))
      const aspect = Math.max(0.2, Math.min(5, Math.round((heightM / sizeM) * 100) / 100))
      onShapeTransform?.(st.id, { sizeM, aspect }, 'move')
    } else {
      const dist = Math.hypot(clientX - st.cx, clientY - st.cy)
      const sizeM = (dist * Math.SQRT2) / pxPerM(st.lat, zoom) // corner handle = half-diagonal
      onShapeTransform?.(st.id, { sizeM: Math.max(5, Math.min(500, Math.round(sizeM))) }, 'move')
    }
  }
  const shapeUp = () => { const st = shapeRef.current; if (!st) return; shapeRef.current = null; onShapeTransform?.(st.id, {}, 'end') }

  // drag the right-edge grip of a note text box. The pill is centred on its coord, so the
  // pointer's distance from the centre is HALF the width. Screen px, not metres: a map note is
  // pinned to a constant screen size, so a ground-scaled width would shrink as you zoom out.
  // A 'start'/'end' pair folds the whole drag into one undo step, like the shape handles.
  const noteWRef = useRef<{ id: string; cx: number } | null>(null)
  const noteWDown = (clientX: number, clientY: number, el: HTMLElement, id: string) => {
    hold.cancel()
    const pill = el.closest('.marker')?.querySelector('.note-pill') as HTMLElement | null
    if (!pill) return
    const r = pill.getBoundingClientRect()
    noteWRef.current = { id, cx: r.left + r.width / 2 }
    onNoteWidth?.(id, undefined, 'start')
  }
  const noteWMove = (clientX: number) => {
    const st = noteWRef.current; if (!st) return
    onNoteWidth?.(st.id, clampNoteWPx(2 * Math.abs(clientX - st.cx)), 'move')
  }
  const noteWUp = () => { const st = noteWRef.current; if (!st) return; noteWRef.current = null; onNoteWidth?.(st.id, undefined, 'end') }

  // ONE select path for every tap that means «this one». A NOTE opens its panel on that same
  // tap (decided 29.08.) — the symbol grammar, unified: tap = panel, drag = move. The panel
  // carries edit + Löschen, and a read-only surface opens it read-only.
  const selectEntity = (ent: Entity) => {
    onSelect(ent)
    if (ent.kind === 'note') onNotePanel?.(ent.id)
  }

  // entity markers — guard against malformed entities (e.g. a server workspace
  // missing a coord) so one bad row can't white-screen the whole map
  return (
    <>
      {entities.filter((e) => isVisible(effectiveLayer(e)) && Array.isArray(e.coord)).map((e) => {
        // the glyph's on-screen pixel size — drives the selection halo + handle ring so
        // they sit a fixed distance OUTSIDE the glyph at any zoom (small glyphs push the
        // handles out to a comfortable minimum via --hbox in CSS, big ones track the edge).
        // a shape's box is width × (width · aspect) — the halo/handle anchor (--gpx → --hbox)
        // takes the LARGER side so the ring always encloses the rectangle
        const shpW = e.kind === 'shape' ? shapePx(e.sizeM, e.coord[1], zoom) : 0
        const shpH = e.kind === 'shape' ? shpW * shapeAspect(e.shape ?? 'square', e.aspect) : 0
        const gpx = e.kind === 'shape' ? Math.max(shpW, shpH)
          : e.kind === 'note' || e.kind === 'photo' || e.kind === 'team' ? 56
          : symPx(e.kind, e.coord[1], zoom, symMul)
        // this marker's offset while its pile is fanned open — and the hairline back to where
        // it actually is, which is why nothing here is a lie the operator has to remember
        const spoke = fan?.[e.id]
        // Selected, multi-selected or mid-drag — the three states that mean «this one, now».
        // They share the halo AND the raised stacking: tapping a symbol that sits under another
        // one has to bring it out, or the panel opens for something the operator cannot see.
        const raised = selectedId === e.id || groupSelectedIds.includes(e.id) || draggingId === e.id
        // ⚠️ A Trupp marker is a STRIP — [dot][gap][name] — and centring the whole strip put half
        // the NAME's width between the dot and the point it states: the dot stood off its own
        // Trupp, and jumped sideways the moment the label pass dropped the name (a symbol dragged
        // past is enough), which read as the label coming off its dot and the dot moving on its
        // own. Anchored by its LEFT edge with half a dot taken back, the dot sits ON the
        // coordinate and the name simply hangs off it — appearing or disappearing moves nothing.
        // The selected pill does the same with its accent cap, so selecting doesn't shift it
        // either. Every other marker is centred on its glyph, as before.
        const teamStrip = e.kind === 'team'
        // Tactical stacking, decided in ONE place (lib/labelPass · MARKER_Z / markerZ). It has to
        // be set HERE, on the marker container: every MapLibre marker is its own stacking context
        // (it carries a transform), so a z-index inside the marker cannot lift it past a sibling.
        const z = markerZ(e.kind, { selected: raised, fanned: !!spoke })
        return (
        <Marker
          key={e.id}
          longitude={e.coord[0]}
          latitude={e.coord[1]}
          anchor={teamStrip ? 'left' : 'center'}
          offset={teamStrip ? [selectedId === e.id ? -TEAM_PILL_CAP_PX : -TEAM_DOT_PX / 2, 0] : undefined}
          style={{ zIndex: z }}
          draggable={false}
          // swallow the synthetic click so it can't reach the map (deselect / placement); selection
          // itself is reported by the hold gesture's onTap, which fires even on a slightly-moved touch
          onClick={(ev) => ev.originalEvent.stopPropagation()}
        >
          <div
            // `dragging` is its own class, not folded into `sel`: the two look the same but mean
            // different things, and only the drag should change the cursor (see .marker.dragging).
            className={`marker${e.kind === 'note' ? ' marker-note' : ''}${networkEntityIds.includes(e.id) ? ' network' : ''}${draggingId === e.id ? ' dragging' : ''}${spoke ? ' fanned' : ''} ${raised ? 'sel' : ''}`}
            style={{ ['--gpx' as string]: `${gpx}px`, ...(spoke ? { ['--fan-dx' as string]: `${spoke.dx}px`, ['--fan-dy' as string]: `${spoke.dy}px` } : null) }}
            // Tap selects; press-and-hold (touch) / press-and-drag (mouse) moves. A quick flick stays
            // a map pan/zoom. Not while editing a note's text (the input owns the pointer).
            // canDrag gates the MOVE only — tap-to-select still works in every tool. See useHoldToDrag.
            onPointerDown={!(e.kind === 'note' && editNoteId === e.id)
              ? (ev) => {
                  const cx = ev.clientX, cy = ev.clientY
                  // Which marker did the finger MEAN? Not "whichever DOM node happened to be on
                  // top" — that is placement order, and it is how a tap on the Wasserbezugsort
                  // handed you the Kleinlöscher. Resolve the whole pile under the pad by nearest
                  // centre; a SELECT then targets that one.
                  // ⚠️ A DRAG does not: it acts on the marker actually pressed. Nearest-centre
                  // only ever differs from it when the pad covers several markers — and there the
                  // tap makes no choice either, it fans the pile out and asks. Letting the drag
                  // guess there moved a neighbour the finger never touched (and, when the neighbour
                  // was a live person position, silently refused to move anything at all).
                  const pile = pileUnder(ev.currentTarget, cx, cy, e)
                  const near = (pile.length ? entities.find((x) => x.id === pile[0].id) : undefined) ?? e
                  const fanned = !!fan
                  // pointerId/isPrimary ride along so the gesture stays bound to THIS finger: the
                  // second finger of a pinch must go to the map, never steer a symbol (useHoldToDrag)
                  hold.begin({ clientX: cx, clientY: cy, pointerId: ev.pointerId, isPrimary: ev.isPrimary }, {
                    onTap: () => {
                      // already fanned: the spokes ARE the choice, so this tap is the answer
                      if (fanned) { setFan(null); selectEntity(e); return }
                      // more than one candidate under the finger → fan them out instead of
                      // guessing. One candidate → select it straight away, exactly as before.
                      if (pile.length > 1) { openFan(fanOffsets(pile)); return }
                      selectEntity(near)
                    },
                    onHoldStart: () => {
                      // a rotor / shape-transform gesture owns the pointer — never also translate
                      if (rotateRef.current || shapeRef.current) { hold.cancel(); return }
                      entDrag.current = { id: e.id, cx, cy, lx: cx, ly: cy, moved: false, last: null }
                      // don't select here: a quick hold-drag to reposition shouldn't open the
                      // ContextPanel. The move targets the symbol by id regardless of selection;
                      // selection (→ panel) is deferred to onDragEnd and only if it never moved.
                      setDragPan(false) // stop the map panning under the held symbol
                    },
                    onDragMove: (mx, my) => {
                      const st = entDrag.current; if (!st || st.id !== e.id) return
                      // deadzone: don't move until the finger clears DRAG_DEADZONE_PX from the grab point
                      if (!st.moved && Math.hypot(mx - st.cx, my - st.cy) < DRAG_DEADZONE_PX) return
                      // Re-anchor on EVERY move: project where the symbol is NOW through the LIVE map
                      // transform and add only the pointer travel since the last move. A screen-px
                      // anchor snapshotted at the grab goes stale the instant the map moves under the
                      // finger (a pinch, a container resize, a programmatic jumpTo) — unprojecting it
                      // through the new transform then teleports the symbol, which is what «bugs out
                      // when the map resizes» looked like. Incrementally, a changed transform costs
                      // nothing: the symbol simply keeps its screen offset to the finger.
                      const base = project((st.last ?? e.coord) as LngLat)
                      if (!base) return
                      const nc = unproject({ x: base.x + (mx - st.lx), y: base.y + (my - st.ly) })
                      if (!nc) return
                      st.lx = mx; st.ly = my
                      // snapshot for undo + show the selection halo on first real move — and on a
                      // phone let the detail sheet peek away, so the drag has the whole surface
                      if (!st.moved) { st.moved = true; onMarkerDragStart(e.id); setDraggingId(e.id); beginSheetPeek() }
                      st.last = nc
                      onMarkerMove(e.id, nc)
                    },
                    onDragEnd: () => {
                      const st = entDrag.current; entDrag.current = null
                      setDragPan(true)
                      setDraggingId(null) // drop the halo once it stops moving
                      endSheetPeek() // …and the sheet comes back to the height it had
                      if (st?.moved && st.last) onMarkerDragEnd(e.id, st.last)
                      // held but never dragged → treat as a select (open the panel). A SELECT
                      // resolves the pile like a tap does — by nearest centre, never by whichever
                      // node is on top — or a slow gloved tap would hand out the wrong marker
                      // while a quick one on the same spot got it right.
                      else if (selectedId !== near.id) selectEntity(near)
                    },
                    // An already-selected symbol (panel open) drags INSTANTLY like a mouse — move
                    // on the first travel, no hold delay. Unselected touch still needs the deliberate
                    // hold so a pan/flick starting on a symbol doesn't grab it.
                    // A self-reported crew position is the one marker nobody may drag. A live
                    // VEHICLE can be nudged — that override is a deliberate feature — but moving
                    // a person's dot would have the operator assert where somebody is, which is
                    // a different and unbacked claim from the one the dot makes.
                    // While a pile is fanned nothing drags: the glyphs are standing off their
                    // real positions, so a drag would write back a coordinate nobody chose.
                  }, { mode: selectedId === e.id || ev.pointerType === 'mouse' ? 'mouse' : 'touch', canDrag: draggable && e.kind !== 'person' && !fanned })
                }
              : undefined}
          >
            {/* the hairline home. Drawn INSIDE the (already offset) marker, so it runs from the
                fanned glyph back to −offset = the true position, with a dot marking it. Purely
                decorative — pointer-events stay off it, or it would eat the tap it exists for. */}
            {spoke && (
              <svg className="fan-spoke" aria-hidden>
                <line x1="0" y1="0" x2={-spoke.dx} y2={-spoke.dy} />
                <circle cx={-spoke.dx} cy={-spoke.dy} r="2.5" />
              </svg>
            )}
            {raised && e.kind !== 'note' && e.kind !== 'team' && <div className="sel-halo" />}
            {networkEntityIds.includes(e.id) && selectedId !== e.id && <div className="network-halo" />}
            {e.kind === 'team' ? (() => {
              // resting: a compact team-coloured dot + name (low map clutter); selected: the
              // full pill (the plan board's resource chip, shared wb-resource CSS) with the
              // timestamp. A Trupp marked «raus» on the Atemschutz board dims here too.
              const isRaus = !!e.truppId && !!trupps?.some((t) => t.id === e.truppId && t.status === 'raus')
              const teamCol = e.color || appConfig.drawing.teamColors[0]
              if (selectedId !== e.id) {
                // the pass could not fit the name without covering something that outranks it:
                // the coloured dot stays (a Trupp is always visible AS a Trupp), and the ink dot
                // says a name is there. One tap on the marker brings it back — a selected object
                // is exempt from suppression.
                const nameHidden = !!e.label && !!suppressedLabels?.has(`team:${e.id}`)
                return (
                  <>
                    <span className={`team-dot ${isRaus ? 'raus' : ''}`} style={{ '--team': teamCol } as React.CSSProperties}>
                      <i />{!nameHidden && <b>{e.label}</b>}
                    </span>
                  </>
                )
              }
              return (
                <span className={`wb-resource-pill ${isRaus ? 'raus' : ''}`} style={{ '--team': teamCol } as React.CSSProperties}>
                  <span className="wb-resource-cap" />
                  <span className="wb-resource-body">
                    <span className="wb-resource-name">
                      {/* identical markup to the plan board's resource chip (Whiteboard.tsx) —
                          same class, same commit-on-blur/Enter, so a rename feels the same on
                          both surfaces */}
                      {editTeamId === e.id
                        ? <input className="wb-resource-input" ref={focusTeam} defaultValue={e.label ?? ''}
                            onPointerDown={(ev) => ev.stopPropagation()}
                            onBlur={(ev) => { onTeamRename?.(e.id, ev.target.value); setEditTeamId(null) }}
                            onKeyDown={(ev) => {
                              if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur()
                              // Esc abandons: blur would commit, so drop the edit first
                              if (ev.key === 'Escape') { ev.stopPropagation(); setEditTeamId(null) }
                            }} />
                        : <b>{e.label}</b>}
                      {isRaus && <span className="wb-resource-raus">{appConfig.copy.atemschutz.status.raus}</span>}
                    </span>
                    {e.t && <i className="wb-resource-time">{e.t}</i>}
                  </span>
                </span>
              )
            })() : e.kind === 'shape' ? (
              <div
                className="shape-glyph"
                style={{ width: shpW, height: shpH, transform: `rotate(${(e.rotation ?? 0) - bearing}deg)` }}
              >
                <ShapeGlyph kind={e.shape ?? 'square'} color={e.color ?? '#1f6feb'} stop={e.stop} />
              </div>
            ) : e.kind === 'note' ? (() => {
              // every note is a wrapping box; a stored note with no width falls back to the
              // default. Font size = the fixed 12px base × the size-slider step.
              // Colour applies in BOTH looks. It used to be `notePlain && color`, so on the
              // default pill the whole colour row was decoration: you picked red, nothing
              // changed, and the swatch stayed selected to prove it had been understood.
              // Plain = coloured ink (there is nothing else to colour); pill = tinted paper,
              // mixed in CSS so it holds up in day and night.
              const tinted = !e.notePlain && !!e.color
              const cls = (base: string) => `${base} box${e.notePlain ? ' plain' : ''}${tinted ? ' tinted' : ''}`
              const nStyle = {
                fontSize: 12 * noteScale(e.noteSize), width: noteWPx(e.noteW),
                ...(e.color ? (e.notePlain ? { color: e.color } : { '--note-tint': e.color }) : null),
              } as React.CSSProperties
              return editNoteId === e.id ? (
                <textarea
                  className={cls('note-pill note-pill-input')}
                  ref={focusNote}
                  rows={1}
                  style={nStyle}
                  value={e.label ?? ''}
                  placeholder={appConfig.copy.whiteboard.textPlaceholder}
                  onPointerDown={(ev) => ev.stopPropagation()}
                  onChange={(ev) => { onNoteText?.(e.id, ev.target.value); autoGrow(ev.currentTarget) }}
                  onBlur={(ev) => {
                    // A blur in the first moment after placement is NOT the user leaving the
                    // field — it's MapLibre focusing its canvas (and/or a select-panel mount)
                    // stealing focus. Committing here would set editNoteId=null and unmount the
                    // input before a key can be pressed ("placed but not focused"). So inside a
                    // short window, bounce focus straight back and skip the commit; a deliberate
                    // click-away always lands well after this (human reaction ≥ ~200ms).
                    const el = ev.currentTarget
                    if (!noteForceCommit.current && Date.now() - noteEditStart.current < 350) { requestAnimationFrame(() => el.focus()); return }
                    noteForceCommit.current = false
                    onNoteCommit?.(e.id, ev.target.value)
                  }}
                  // Enter makes a new line — the ✓, Esc and clicking away are the way out.
                  // `noteForceCommit` tells the blur this is a deliberate commit, so the 350ms
                  // focus-steal guard above lets it through instead of bouncing focus back.
                  onKeyDown={(ev) => {
                    if (ev.key === 'Escape') {
                      ev.preventDefault(); noteForceCommit.current = true; (ev.target as HTMLTextAreaElement).blur()
                    }
                  }}
                />
              ) : (
                <div className={cls('note-pill')} style={nStyle} onDoubleClick={(ev) => { ev.stopPropagation(); onNoteEdit?.(e.id) }}>
                  {e.label || <span className="note-pill-ph">{appConfig.copy.whiteboard.text}</span>}
                </div>
              )
            })() : e.kind === 'photo' ? (
              // 56 px on the map — the small copy, for the same reason as the Verlauf chip
              <div className="ts photo"><img src={thumbUrl(e.photoUrl)} alt="" decoding="async" /></div>
            ) : (() => {
              // the generic vehicle bakes its name + heading into the glyph (text stays
              // upright); every other symbol uses its library/static svg
              // A live GPS vehicle is `kind: 'vehicle'` (not a placed 'symbol'), so isVehicleSym
              // said no and it fell through to the generic branch: the chip rotated the ALREADY
              // rotated glyph, which turned the body twice and tilted the baked-in name with it.
              // It is a vehicle for rendering purposes — same treatment as the placed one.
              const veh = isVehicleSym(e) || (e.kind === 'vehicle' && !!e.symbolSvg)
              const comp = compositeSpec(e.symbol)
              const hub = isHubretter(e.symbol)
              // ONLY directional symbols (a rotation handle, or a vehicle/live unit) stay pinned to
              // the ground via − bearing; plain markers (hydrants, KP, command posts, lifts…) stay
              // UPRIGHT at every bearing ("always north"), so they never look crooked on a turned map.
              // The Hubretter body is rotatable (`rotation`), INDEPENDENT of the boom (`rotation2`).
              // ⚠️ A shared PERSON position is live but has no heading — nobody reports which way
              // they are facing, and the glyph is a disc with their initials in it. It was caught
              // by `e.live` and tilted with the map like a truck, which turns the one thing on it
              // that has to be read at a glance upside down. A person is «always north».
              const directional = (veh || !!e.live || isRotatableSym(e)) && e.kind !== 'person'
              const rot = (e.rotation ?? 0) - (directional ? bearing : 0)
              // rebuilt at the bearing-compensated angle; `directed` so a vehicle that has never
              // moved doesn't gain a heading arrow it never reported
              const svg = veh ? vehicleSymbolSvg(e.label ?? '', rot, e.directed ?? true)
                : comp ? (byName[comp.base] ?? '')
                : hub ? (byName[appConfig.symbols.vehicleName] ?? '')   // plain body; the boom is drawn separately
                : (placardSvgForSymbol(e.symbol, e.fields) ?? e.symbolSvg ?? (e.symbol ? byName[luefterVariant(e.symbol, e.extract)!] ?? byName[e.symbol] ?? '' : ''))
              // a composite stacks its part (Grosslüfter fan / Drehleiter ladder) as a separately-
              // rotatable overlay aimed by rotation2; the Lüfter's extract (Absaugen) swaps to the
              // reversed-arrow fan glyph. Ladder scales 1:1 over the body; the fan reads at 60%.
              const overlay = comp ? { svg: byName[compositePartGlyph(comp, e.extract)] ?? byName[comp.part] ?? '', rotation: (e.rotation2 ?? 0) - bearing, scale: comp.scale, offsetX: comp.offsetX } : undefined
              // Hubretter boom: a variable-reach articulated arm drawn behind the body, ground-scaled in
              // metres (reachM) and aimed by rotation2 (−bearing). The cage tip carries the drag handle.
              const boomPx = hub ? Math.max(24, Math.min(900, (e.reachM ?? 18) * pxPerM(e.coord[1], zoom))) : 0
              // The caption is decided by the ONE label pass, not by a zoom threshold: it is
              // printed whole where it fits and replaced by a dot where it does not. Routed
              // through softHyphenateText because a caption is a FIELD VALUE, not a symbol name
              // — «Salpetersäure, rauchend» has to break at the compound seam, not by syllable.
              const capText = symbolCaptionText(e, captionMode)
              const capHidden = !!capText && !!suppressedLabels?.has(`cap:${e.id}`)
              // the vehicle glyph rotates its body internally, so the chip must NOT also rotate;
              // every other symbol (incl. a composite body) applies its stored rotation to the chip.
              return (
                <>
                  <TacticalSymbol
                    svg={svg}
                    sizePx={symPx(e.kind, e.coord[1], zoom, symMul)}
                    rotation={veh ? 0 : rot}
                    overlay={overlay}
                    floor={e.floor}
                    floorFrom={e.floorFrom}
                    floorTo={e.floorTo}
                    spread={e.spread}
                    count={e.count}
                    // a vehicle's NAME is already in the glyph — symbolCaptionText drops it and
                    // keeps the rest (Fahrer, eigene Felder, Notizen), which only 'Alle' prints
                    caption={capHidden || !capText ? null : softHyphenateText(capText)}
                  />
                  {/* boom AFTER the body → paints on top (mounted on the turntable / roof) */}
                  {hub && <HubretterBoom lengthPx={boomPx} deg={(e.rotation2 ?? 0) - bearing} />}
                </>
              )
            })()}
            {/* ⚠️ The inline ✕ (and the pen/⚙ grips row) is GONE — decided 29.08. The row existed
                because a note's panel only opened from the ⚙, so the ✕ was its everyday delete;
                now the panel opens on the TAP itself (see selectEntity above), same grammar as
                every symbol, and Löschen/edit live in the panel like everywhere else. What a
                selected note keeps is drag-only: the width grip below (the body moves by
                hold-drag, as before). Double-tap stays the desktop shortcut into inline edit. */}
            {selectedId === e.id && !e.live && e.kind === 'note' && (
              <>
                {/* right-edge width grip — a text box only. A one-line note has nothing to drag;
                    its width IS its text. Native listeners (TransformHandle) so the drag beats
                    react-map-gl's marker drag, same as the shape handles. */}
                {onNoteWidth && (
                  <TransformHandle
                    className="note-wgrip"
                    icon="resize"
                    title={appConfig.copy.notes.resizeHint}
                    onStart={(x, y, el) => noteWDown(x, y, el, e.id)}
                    onMove={(x) => noteWMove(x)}
                    onEnd={noteWUp}
                  />
                )}
              </>
            )}
            {/* ✓ Fertig — box mode only, where Enter no longer commits */}
            {e.kind === 'note' && editNoteId === e.id && (
              <button
                className="note-done"
                title={appConfig.copy.notes.done}
                aria-label={appConfig.copy.notes.done}
                // pointerdown, not click: the textarea's blur unmounts this button first
                onPointerDown={(ev) => { ev.preventDefault(); ev.stopPropagation(); noteForceCommit.current = true; onNoteCommit?.(e.id, e.label ?? '') }}
              >
                <Icon id="check" />
              </button>
            )}
            {/* selected team — the same action bar as the plan chip: show on Atemschutz board,
                mark position, show/hide trails, delete (greyed out while a recorded trail exists;
                tapping the greyed trash offers the confirmed trail clear, which frees it). */}
            {selectedId === e.id && e.kind === 'team' && draggable && (
              <div className="wb-pill-acts" onPointerDown={(ev) => ev.stopPropagation()}>
                {/* rename — the touch path (double-tap→dblclick is unreliable on iOS), same as
                    the plan chip. A Trupp-bound marker is named by the Atemschutz board, so it
                    gets no pen: renaming it here would fork the two names apart. */}
                {!e.truppId && onTeamRename && (
                  <button className="wb-pa" title={appConfig.copy.edit} aria-label={appConfig.copy.edit}
                    onClick={() => setEditTeamId(e.id)}><Icon id="pen" /></button>
                )}
                {e.truppId && onShowTrupp && (
                  <button className="wb-pa wb-pa-show" title={appConfig.copy.whiteboard.showTrupp} aria-label={appConfig.copy.whiteboard.showTrupp} onClick={() => onShowTrupp(e.truppId!)}><Icon id="warn" /></button>
                )}
                {/* «Atemschutz-Trupp» — the marker's half of the join, and the exact shape the
                    line editor's «Gehört zu Trupp …» has: the app's own menu, never a native
                    <select>. A Trupp registered AFTER this marker was put down is in the list, so
                    a «Trupp 2» dropped at 03:12 still finds its crew at 03:14. ⚠️ A Trupp that is
                    already out is offered only when it is the one standing here — it is the
                    record of who was, not somebody to send. */}
                {onTeamTrupp && (!!e.truppId || !!trupps?.some((t) => !t.removedAt && t.status !== 'raus')) && (
                  <Menu
                    popupClassName="de-menu-pop"
                    itemClassName={() => 'de-menu-item'}
                    trigger={
                      <button className="wb-pa" title={appConfig.copy.atemschutz.markerLabel} aria-label={appConfig.copy.atemschutz.markerLabel}>
                        <Icon id="people" />
                      </button>
                    }
                    items={[
                      { label: <MenuPick label={appConfig.copy.atemschutz.markerNone} on={!e.truppId} />, onClick: () => onTeamTrupp(e.id, undefined) },
                      ...(trupps ?? []).filter((t) => !t.removedAt && (t.status !== 'raus' || t.id === e.truppId)).map((t) => ({
                        label: <MenuPick label={t.name} on={t.id === e.truppId} />,
                        onClick: () => onTeamTrupp(e.id, t.id),
                      })),
                    ]}
                  />
                )}
                {/* Farbe — for the LOOSE team marker only (placed with the Trupp tool, never
                    registered on the board): it has no other place to be recoloured. A marker
                    bound to a registered Trupp does — the Trupp's own form — and its colour is
                    the Trupp's identity, so a second palette here said the same thing twice.
                    A colour someone else already wears is allowed — «alle Löschtrupps rot». */}
                {onTeamColor && !(e.truppId && trupps?.some((t) => t.id === e.truppId && !t.removedAt)) && (
                  <Popover
                    ariaLabel={appConfig.copy.atemschutz.colorLabel}
                    popupClassName="wb-pa-colors"
                    trigger={
                      <button className="wb-pa" title={appConfig.copy.atemschutz.colorLabel} aria-label={appConfig.copy.atemschutz.colorLabel}>
                        <span className="wb-pa-swatch" style={{ background: e.color || 'transparent' }} />
                      </button>
                    }
                  >
                    <PopoverClose className={`ctx-team-auto${e.color ? '' : ' on'}`} onClick={() => onTeamColor(e, null)}>
                      {appConfig.copy.atemschutz.colorAuto}
                    </PopoverClose>
                    {appConfig.drawing.teamColors.map((c) => (
                      <PopoverClose key={c} className={`dh-color${e.color === c ? ' on' : ''}`} onClick={() => onTeamColor(e, c)}>
                        <span style={{ background: c }} />
                      </PopoverClose>
                    ))}
                  </Popover>
                )}
                {onTeamMark && (
                  <button className="wb-pa wb-pa-mark" title={appConfig.copy.whiteboard.markPosition} aria-label={appConfig.copy.whiteboard.markPosition} onClick={() => onTeamMark(e.id)}><Icon id="flag" /></button>
                )}
                {/* per-team visibility toggle, NOT deletion — the ✕ here silently wiped the record */}
                {(e.trail?.length ?? 0) > 0 && onToggleTrail && (() => {
                  const shown = !hiddenTrails?.has(e.id)
                  return (
                    <button className="wb-pa" title={shown ? appConfig.copy.whiteboard.trailsOff : appConfig.copy.whiteboard.trailsOn}
                      aria-label={appConfig.copy.whiteboard.trails} aria-pressed={shown} onClick={() => onToggleTrail(e.id)}>
                      <Icon id={shown ? 'eye' : 'eyeoff'} />
                    </button>
                  )
                })()}
                {(e.trail?.length ?? 0) > 0
                  ? <button className="wb-pa wb-pa-del-off" title={appConfig.copy.whiteboard.deleteLocked} aria-label={appConfig.copy.whiteboard.deleteLocked}
                      onClick={() => onTeamClearTrail?.(e.id)}><Icon id="trash" /></button>
                  : <button className="wb-pa wb-pa-del" title={appConfig.copy.delete} aria-label={appConfig.copy.delete} onClick={() => onDelete(e.id)}><Icon id="trash" /></button>}
              </div>
            )}
            {/* Rotation is for live VEHICLES (a truck faces somewhere). A person dot carries no
                heading, so a rotate handle on it would invite orienting a fact that has no
                orientation. */}
            {selectedId === e.id && e.live && e.kind !== 'person' && onRotate && (
              <TransformHandle
                className="handle marker-rotate"
                icon="rotate"
                title={appConfig.copy.contextPanel.rotateHint}
                onStart={(x, y, el) => rotDown(x, y, el, e.id)}
                onMove={rotMove}
                onEnd={rotUp}
              />
            )}
            {selectedId === e.id && e.kind === 'shape' && onShapeTransform && (() => {
              // rotor rotates with the shape so the handles stay attached to it: a tethered
              // knob (top) for rotation, a corner grip for resize. The CSS anchors assume a
              // SQUARE --hbox; a stretched shape overrides them inline so the knob rides the
              // real top edge and the grip the real corner (same floors as .marker.sel --hbox).
              const hbW = Math.max(shpW, 56), hbH = Math.max(shpH, 56)
              return (
              <div className="shape-rotor" style={{ transform: `rotate(${(e.rotation ?? 0) - bearing}deg)` }}>
                <span className="shape-stem" style={{ top: `calc(50% - ${hbH / 2 + 18}px)` }} />
                <TransformHandle
                  className="handle shape-rotate"
                  icon="rotate"
                  style={{ top: `calc(50% - ${hbH / 2 + 18}px)` }}
                  title={appConfig.copy.shapes.rotateHint}
                  onStart={(x, y, el) => shapeDown(x, y, el, e.id, e.coord[1], 'rotate')}
                  onMove={shapeMove}
                  onEnd={shapeUp}
                />
                <TransformHandle
                  className="handle shape-resize"
                  icon="resize"
                  style={{ left: `calc(50% + ${hbW / 2 + 3}px)`, top: `calc(50% + ${hbH / 2 + 3}px)` }}
                  title={appConfig.copy.shapes.resizeHint}
                  onStart={(x, y, el) => shapeDown(x, y, el, e.id, e.coord[1], 'resize')}
                  onMove={shapeMove}
                  onEnd={shapeUp}
                />
              </div>
              )
            })()}
            {selectedId === e.id && isRotatableSym(e) && !compositeSpec(e.symbol) && onShapeTransform && (
              // directional symbol: rotate-only handle (no resize — symbols keep their
              // real-world scale). Tethered knob rotates with the symbol.
              <div className="shape-rotor" style={{ transform: `rotate(${(e.rotation ?? 0) - bearing}deg)` }}>
                <span className="shape-stem" />
                <TransformHandle
                  className="handle shape-rotate"
                  icon="rotate"
                  title={appConfig.copy.shapes.rotateHint}
                  onStart={(x, y, el) => shapeDown(x, y, el, e.id, e.coord[1], 'rotate')}
                  onMove={shapeMove}
                  onEnd={shapeUp}
                />
              </div>
            )}
            {selectedId === e.id && !!compositeSpec(e.symbol) && onShapeTransform && (
              // composite (Grosslüfter / Drehleiter / Hubretter): TWO tethered rotors — a short blue
              // knob aims the vehicle body, a longer amber knob aims the part (fan / ladder / boom).
              // Each rotor rotates with its own part (− bearing) so the handles stay attached as the
              // map turns.
              <>
                <div className="shape-rotor" style={{ transform: `rotate(${(e.rotation ?? 0) - bearing}deg)` }}>
                  <span className="shape-stem" />
                  <TransformHandle
                    className="handle shape-rotate"
                    icon="rotate"
                    title={appConfig.copy.contextPanel.rotationVehicle}
                    onStart={(x, y, el) => shapeDown(x, y, el, e.id, e.coord[1], 'rotate')}
                    onMove={shapeMove}
                    onEnd={shapeUp}
                  />
                </div>
                <div className="shape-rotor shape-rotor-fan" style={{ transform: `rotate(${(e.rotation2 ?? 0) - bearing}deg)` }}>
                  <span className="shape-stem" />
                  <TransformHandle
                    className="handle shape-rotate shape-rotate-fan"
                    icon="rotate"
                    title={appConfig.copy.contextPanel[compositeSpec(e.symbol)!.partLabel]}
                    onStart={(x, y, el) => shapeDown(x, y, el, e.id, e.coord[1], 'rotate2')}
                    onMove={shapeMove}
                    onEnd={shapeUp}
                  />
                </div>
              </>
            )}
            {selectedId === e.id && isHubretter(e.symbol) && onShapeTransform && (() => {
              // Hubretter cage tip: ONE handle at the boom end. Dragging it sets both the boom bearing
              // (rotation2) and the reach (reachM). Positioned at the tip = centre + reach·(bearing).
              const rad = (((e.rotation2 ?? 0) - bearing) * Math.PI) / 180
              const len = Math.max(24, Math.min(900, (e.reachM ?? 18) * pxPerM(e.coord[1], zoom)))
              return (
                <div className="cage-handle" style={{ left: `calc(50% + ${(Math.cos(rad) * len).toFixed(1)}px)`, top: `calc(50% + ${(Math.sin(rad) * len).toFixed(1)}px)` }}>
                  <TransformHandle
                    className="handle shape-rotate shape-cage"
                    icon="move"
                    title={appConfig.copy.shapes.moveHint}
                    onStart={(x, y, el) => shapeDown(x, y, el, e.id, e.coord[1], 'cage')}
                    onMove={shapeMove}
                    onEnd={shapeUp}
                  />
                </div>
              )
            })()}
          </div>
        </Marker>
        )
      })}
      {/* team trail breadcrumbs (recorded via «Position markieren») — same dot + timestamp
          look as the plan board; pointer-transparent so they never block a map tap */}
      {entities.filter((e) => e.kind === 'team' && isVisible(effectiveLayer(e)) && Array.isArray(e.coord) && e.trail?.length && !hiddenTrails?.has(e.id)).flatMap((e) =>
        (e.trail ?? []).map((p, i) => (
          // style on the Marker itself: the WRAPPER div must be pointer-transparent too,
          // or a dot lying under the pill (marked without moving) swallows the pill's tap
          <Marker key={`${e.id}-trail-${i}`} longitude={p.coord[0]} latitude={p.coord[1]} anchor="center" draggable={false} style={{ pointerEvents: 'none' }}>
            <div className="map-trail-dot">
              <span className="wb-trail-mark" style={{ background: e.color || appConfig.drawing.teamColors[0] }} />
              <i>{p.t}</i>
            </div>
          </Marker>
        )),
      )}
    </>
  )
}
