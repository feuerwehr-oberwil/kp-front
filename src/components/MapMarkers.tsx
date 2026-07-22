import { useCallback, useEffect, useRef, useState } from 'react'
import { Marker } from 'react-map-gl/maplibre'
import type { CaptionMode, Entity, LngLat, Trupp } from '../types'
import { appConfig } from '../config/appConfig'
import { useHoldToDrag } from '../lib/useHoldToDrag'
import { Icon } from '../lib/icons'
import { ShapeGlyph } from '../lib/shapes'
import { vehicleSymbolSvg } from '../lib/useVehiclePositions'
import { placardSvgForSymbol } from '../lib/placard'
import { TacticalSymbol, GROSSLUEFTER_BODY, GROSSLUEFTER_FAN, FAN_OVERLAY_SCALE, luefterVariant } from '../lib/symbolRender'
import { symbolCaptionText } from '../lib/symbols'
import { pxPerM, symPx, shapePx, isRotatableSym, isVehicleSym, isGrossluefter } from '../lib/mapView'

// A transform handle (rotate / resize) whose drag is bound with NATIVE pointer listeners that
// stopPropagation, so react-map-gl's marker-drag (a listener on the parent that fires on the same
// pointerdown) never starts alongside it. React's onPointerDown stopPropagation is delegated at
// the document root and runs too late — by then the marker is already dragging. Using the capture
// (setPointerCapture) keeps the move/up events on this element for the whole gesture.
function TransformHandle({ className, icon, title, onStart, onMove, onEnd }: {
  className: string; icon: string; title: string
  onStart: (clientX: number, clientY: number, el: HTMLElement) => void
  onMove: (clientX: number, clientY: number) => void
  onEnd: () => void
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
  return <button ref={ref} className={className} title={title} aria-label={title} onClick={(e) => e.stopPropagation()}><Icon id={icon} /></button>
}

// once a hold has armed, the finger must still travel this far (screen px) before the symbol
// actually starts following — so a tremble while holding (or holding a beat too long) can't nudge it
const DRAG_DEADZONE_PX = 6

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
  /** global S/M/L symbol-size multiplier (lib/prefs · symbolMul) — scales the symPx band */
  symMul?: number
  /** device default for on-canvas symbol captions; a symbol's own `caption` overrides it.
   *  Captions are additionally hidden below appConfig.symbols.captionMinZoom (declutter). */
  captionMode?: CaptionMode
  draggable: boolean
  /** project lng/lat → container px (snapshots a symbol's start position for a hold-drag) */
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
  onShapeTransform?: (id: string, patch: { rotation?: number; rotation2?: number; sizeM?: number }, phase: 'start' | 'move' | 'end') => void
  /** which note is in raw inline-text edit mode (mirrors the Plan whiteboard's text notes) */
  editNoteId?: string | null
  /** stream a note's text live as it's typed */
  onNoteText?: (id: string, text: string) => void
  /** commit a note's text on blur */
  onNoteCommit?: (id: string, text: string) => void
  /** enter inline edit on a note (double-click; placement enters edit via editNoteId) */
  onNoteEdit?: (id: string) => void
  // --- kind 'team' (Trupp markers — the map mirror of the plan board's resource chips) ---
  /** monitored Trupps, for the «raus» dim/strike on a linked team marker */
  trupps?: Trupp[]
  /** open the linked Trupp on the Atemschutz surface */
  onShowTrupp?: (truppId: string) => void
  /** stamp the marker's current spot + time into its trail (the ONLY way positions are recorded) */
  onTeamMark?: (id: string) => void
  /** clear a team marker's recorded trail (unlocks deletion) — reached via the lock button,
   *  behind a confirm; the everyday bar button only TOGGLES visibility */
  onTeamClearTrail?: (id: string) => void
  /** global trail visibility (lines + breadcrumb dots) — mirrors the plan's showTrails */
  trailsVisible?: boolean
  onToggleTrails?: () => void
}

/**
 * The placed-entity layer: one Marker per entity (shape / note / photo / symbol /
 * vehicle) plus its selection affordances — delete, rotor (live vehicles), and the
 * shape/symbol transform handles. Owns the rotor/transform pointer-drag refs.
 */
export function MapMarkers({ entities, byName, isVisible, selectedId, groupSelectedIds = [], networkEntityIds = [], zoom, bearing = 0, symMul = 1, captionMode = 'off', draggable, project, unproject, setDragPan, onSelect, onMarkerDragStart, onMarkerMove, onMarkerDragEnd, onDelete, onRotate, onShapeTransform, editNoteId = null, onNoteText, onNoteCommit, onNoteEdit, trupps, onShowTrupp, onTeamMark, onTeamClearTrail, trailsVisible = true, onToggleTrails }: Props) {
  // captions declutter out below a zoom threshold (glyphs are tiny there); the Plan has no zoom
  const captionsVisible = zoom >= appConfig.symbols.captionMinZoom
  // when the note input mounted — onBlur uses this to tell a real "done editing" click-away
  // (commit) apart from the placement focus-steal (bounce focus back). See onBlur below.
  const noteEditStart = useRef(0)
  // set on Enter so its blur() commits even inside the guard window (an explicit commit, not a steal)
  const noteForceCommit = useRef(false)
  // focus the note input when it mounts. MUST be stable (useCallback) — an inline ref callback
  // re-fires every render, which would re-focus/select on each keystroke (one-key-at-a-time).
  const focusNote = useCallback((el: HTMLInputElement | null) => {
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
    el.focus(); el.select?.()
  }, [])
  const rotateRef = useRef<{ id: string; cx: number; cy: number } | null>(null)
  const shapeRef = useRef<{ id: string; cx: number; cy: number; lat: number; mode: 'rotate' | 'resize' | 'rotate2' } | null>(null)
  // Press-and-hold to move a placed symbol. Markers are NOT react-map-gl-draggable (that would
  // claim every pan/zoom that starts on a symbol and drag it instead of the map); instead a still
  // hold past the delay arms a drag — a quick flick to pan/zoom passes straight through to the map.
  // sx/sy = the symbol's start position in container px; cx/cy = the pointer's start client px.
  const hold = useHoldToDrag()
  const entDrag = useRef<{ id: string; sx: number; sy: number; cx: number; cy: number; moved: boolean; last: LngLat | null } | null>(null)
  // id of the symbol currently being dragged — shows the same selection halo as a real select
  // (dropped on drop). Set only once the drag clears the deadzone, so a hold that never moves
  // shows nothing.
  const [draggingId, setDraggingId] = useState<string | null>(null)

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
  const shapeDown = (clientX: number, clientY: number, el: HTMLElement, id: string, lat: number, mode: 'rotate' | 'resize' | 'rotate2') => {
    hold.cancel() // a handle press takes over from any pending/active marker hold
    const marker = el.closest('.marker')
    const glyph = marker?.querySelector('.shape-glyph, .ts') as HTMLElement | null
    if (!glyph) return
    const r = glyph.getBoundingClientRect() // rotated/scaled AABB — centre is unchanged
    shapeRef.current = { id, cx: r.left + r.width / 2, cy: r.top + r.height / 2, lat, mode }
    onShapeTransform?.(id, {}, 'start')
  }
  const shapeMove = (clientX: number, clientY: number) => {
    const st = shapeRef.current; if (!st) return
    if (st.mode === 'rotate' || st.mode === 'rotate2') {
      const deg = (Math.atan2(clientY - st.cy, clientX - st.cx) * 180) / Math.PI
      // the body knob sits at the top (+90 → 0°); the fan knob sits at the BOTTOM (−90), so the two
      // are always on opposite sides of the ring and easy to grab apart. + bearing stores the
      // GEOGRAPHIC angle (renders as −bearing).
      const off = st.mode === 'rotate2' ? -90 : 90
      const val = Math.round((((deg + off + bearing) % 360) + 360) % 360)
      onShapeTransform?.(st.id, st.mode === 'rotate2' ? { rotation2: val } : { rotation: val }, 'move')
    } else {
      const dist = Math.hypot(clientX - st.cx, clientY - st.cy)
      const sizeM = (dist * Math.SQRT2) / pxPerM(st.lat, zoom) // corner handle = half-diagonal
      onShapeTransform?.(st.id, { sizeM: Math.max(5, Math.min(500, Math.round(sizeM))) }, 'move')
    }
  }
  const shapeUp = () => { const st = shapeRef.current; if (!st) return; shapeRef.current = null; onShapeTransform?.(st.id, {}, 'end') }

  // entity markers — guard against malformed entities (e.g. a server workspace
  // missing a coord) so one bad row can't white-screen the whole map
  return (
    <>
      {entities.filter((e) => isVisible(e.layer) && Array.isArray(e.coord)).map((e) => {
        // the glyph's on-screen pixel size — drives the selection halo + handle ring so
        // they sit a fixed distance OUTSIDE the glyph at any zoom (small glyphs push the
        // handles out to a comfortable minimum via --hbox in CSS, big ones track the edge).
        const gpx = e.kind === 'shape' ? shapePx(e.sizeM, e.coord[1], zoom)
          : e.kind === 'note' || e.kind === 'photo' || e.kind === 'team' ? 56
          : symPx(e.kind, e.coord[1], zoom, symMul)
        return (
        <Marker
          key={e.id}
          longitude={e.coord[0]}
          latitude={e.coord[1]}
          anchor="center"
          draggable={false}
          // swallow the synthetic click so it can't reach the map (deselect / placement); selection
          // itself is reported by the hold gesture's onTap, which fires even on a slightly-moved touch
          onClick={(ev) => ev.originalEvent.stopPropagation()}
        >
          <div
            className={`marker${e.kind === 'note' ? ' marker-note' : ''}${networkEntityIds.includes(e.id) ? ' network' : ''} ${selectedId === e.id || groupSelectedIds.includes(e.id) || draggingId === e.id ? 'sel' : ''}`}
            style={{ ['--gpx' as string]: `${gpx}px` }}
            // Tap selects; press-and-hold (touch) / press-and-drag (mouse) moves. A quick flick stays
            // a map pan/zoom. Not while editing a note's text (the input owns the pointer).
            // canDrag gates the MOVE only — tap-to-select still works in every tool. See useHoldToDrag.
            onPointerDown={!(e.kind === 'note' && editNoteId === e.id)
              ? (ev) => {
                  const cx = ev.clientX, cy = ev.clientY
                  hold.begin({ clientX: cx, clientY: cy }, {
                    onTap: () => onSelect(e),
                    onHoldStart: () => {
                      // a rotor / shape-transform gesture owns the pointer — never also translate
                      if (rotateRef.current || shapeRef.current) { hold.cancel(); return }
                      const p = project(e.coord as LngLat)
                      entDrag.current = { id: e.id, sx: p?.x ?? 0, sy: p?.y ?? 0, cx, cy, moved: false, last: null }
                      // don't select here: a quick hold-drag to reposition shouldn't open the
                      // ContextPanel. The move targets the symbol by id regardless of selection;
                      // selection (→ panel) is deferred to onDragEnd and only if it never moved.
                      setDragPan(false) // stop the map panning under the held symbol
                    },
                    onDragMove: (mx, my) => {
                      const st = entDrag.current; if (!st || st.id !== e.id) return
                      // deadzone: don't move until the finger clears DRAG_DEADZONE_PX from the grab point
                      if (!st.moved && Math.hypot(mx - st.cx, my - st.cy) < DRAG_DEADZONE_PX) return
                      const nc = unproject({ x: st.sx + (mx - st.cx), y: st.sy + (my - st.cy) })
                      if (!nc) return
                      if (!st.moved) { st.moved = true; onMarkerDragStart(e.id); setDraggingId(e.id) } // snapshot for undo + show the selection halo on first real move
                      st.last = nc
                      onMarkerMove(e.id, nc)
                    },
                    onDragEnd: () => {
                      const st = entDrag.current; entDrag.current = null
                      setDragPan(true)
                      setDraggingId(null) // drop the halo once it stops moving
                      if (st?.moved && st.last) onMarkerDragEnd(e.id, st.last)
                      else if (selectedId !== e.id) onSelect(e) // held but never dragged → treat as a select (open the panel)
                    },
                    // An already-selected symbol (panel open) drags INSTANTLY like a mouse — move
                    // on the first travel, no hold delay. Unselected touch still needs the deliberate
                    // hold so a pan/flick starting on a symbol doesn't grab it.
                  }, { mode: selectedId === e.id || ev.pointerType === 'mouse' ? 'mouse' : 'touch', canDrag: draggable })
                }
              : undefined}
          >
            {(selectedId === e.id || groupSelectedIds.includes(e.id) || draggingId === e.id) && e.kind !== 'note' && e.kind !== 'team' && <div className="sel-halo" />}
            {networkEntityIds.includes(e.id) && selectedId !== e.id && <div className="network-halo" />}
            {e.kind === 'team' ? (() => {
              // resting: a compact team-coloured dot + name (low map clutter); selected: the
              // full pill (the plan board's resource chip, shared wb-resource CSS) with the
              // timestamp. A Trupp marked «raus» on the Atemschutz board dims here too.
              const isRaus = !!e.truppId && !!trupps?.some((t) => t.id === e.truppId && t.status === 'raus')
              const teamCol = e.color || appConfig.drawing.teamColors[0]
              if (selectedId !== e.id) {
                return (
                  <span className={`team-dot ${isRaus ? 'raus' : ''}`} style={{ '--team': teamCol } as React.CSSProperties}>
                    <i /><b>{e.label}</b>
                  </span>
                )
              }
              return (
                <span className={`wb-resource-pill ${isRaus ? 'raus' : ''}`} style={{ '--team': teamCol } as React.CSSProperties}>
                  <span className="wb-resource-cap" />
                  <span className="wb-resource-body">
                    <span className="wb-resource-name">
                      <b>{e.label}</b>
                      {isRaus && <span className="wb-resource-raus">{appConfig.copy.atemschutz.status.raus}</span>}
                    </span>
                    {e.t && <i className="wb-resource-time">{e.t}</i>}
                  </span>
                </span>
              )
            })() : e.kind === 'shape' ? (
              <div
                className="shape-glyph"
                style={{ width: shapePx(e.sizeM, e.coord[1], zoom), height: shapePx(e.sizeM, e.coord[1], zoom), transform: `rotate(${(e.rotation ?? 0) - bearing}deg)` }}
              >
                <ShapeGlyph kind={e.shape ?? 'square'} color={e.color ?? '#1f6feb'} />
              </div>
            ) : e.kind === 'note' ? (
              editNoteId === e.id ? (
                <input
                  className="note-pill note-pill-input"
                  ref={focusNote}
                  value={e.label ?? ''}
                  placeholder={appConfig.copy.whiteboard.textPlaceholder}
                  onPointerDown={(ev) => ev.stopPropagation()}
                  onChange={(ev) => onNoteText?.(e.id, ev.target.value)}
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
                  onKeyDown={(ev) => { if (ev.key === 'Enter') { noteForceCommit.current = true; (ev.target as HTMLInputElement).blur() } }}
                />
              ) : (
                <div className="note-pill" onDoubleClick={(ev) => { ev.stopPropagation(); onNoteEdit?.(e.id) }}>
                  {e.label || <span className="note-pill-ph">{appConfig.copy.whiteboard.text}</span>}
                </div>
              )
            ) : e.kind === 'photo' ? (
              <div className="ts photo"><img src={e.photoUrl} alt="" /></div>
            ) : (() => {
              // the generic vehicle bakes its name + heading into the glyph (text stays
              // upright); every other symbol uses its library/static svg
              const veh = isVehicleSym(e)
              const gross = isGrossluefter(e)
              // ONLY directional symbols (a rotation handle, or a vehicle/live unit) stay pinned to
              // the ground via − bearing; plain markers (hydrants, KP, command posts, lifts…) stay
              // UPRIGHT at every bearing ("always north"), so they never look crooked on a turned map.
              const directional = veh || !!e.live || isRotatableSym(e)
              const rot = (e.rotation ?? 0) - (directional ? bearing : 0)
              const svg = veh ? vehicleSymbolSvg(e.label ?? '', rot)
                : gross ? (byName[GROSSLUEFTER_BODY] ?? '')
                : (placardSvgForSymbol(e.symbol, e.fields) ?? e.symbolSvg ?? (e.symbol ? byName[luefterVariant(e.symbol, e.extract)!] ?? byName[e.symbol] ?? '' : ''))
              // the Grosslüfter stacks the fan as a separately-rotatable overlay (airflow direction)
              const overlay = gross ? { svg: byName[GROSSLUEFTER_FAN] ?? '', rotation: (e.rotation2 ?? 0) - bearing, scale: FAN_OVERLAY_SCALE } : undefined
              // the vehicle glyph rotates its body internally, so the chip must NOT also rotate;
              // every other symbol (incl. the Grosslüfter body) applies its stored rotation to the chip.
              return (
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
                  // vehicles bake their name into the glyph already, so they get no caption
                  caption={captionsVisible && !veh ? symbolCaptionText(e, captionMode) : null}
                />
              )
            })()}
            {/* Inline delete is kept ONLY for notes — they have no ContextPanel ("dashboard") to
                delete from, and a note with text already asks before deleting (no accidental loss).
                Symbols / shapes / photos drop the field ✕ (too many accidental deletes) and are
                deleted from their dashboard panel instead. */}
            {selectedId === e.id && !e.live && e.kind === 'note' && (
              <>
                {/* double-tap is unreliable on iOS, so a selected note also gets an explicit
                    edit handle — dblclick stays as the desktop shortcut */}
                {editNoteId !== e.id && (
                  <button
                    className="handle marker-edit"
                    title={appConfig.copy.edit}
                    aria-label={appConfig.copy.edit}
                    onPointerDown={(ev) => ev.stopPropagation()}
                    onClick={(ev) => { ev.stopPropagation(); onNoteEdit?.(e.id) }}
                  >
                    <Icon id="pen" />
                  </button>
                )}
                <button
                  className="handle marker-del"
                  title={appConfig.copy.delete}
                  aria-label={appConfig.copy.delete}
                  onPointerDown={(ev) => ev.stopPropagation()}
                  onClick={(ev) => { ev.stopPropagation(); onDelete(e.id) }}
                >
                  <Icon id="close" />
                </button>
              </>
            )}
            {/* selected team — the same action bar as the plan chip: show on Atemschutz board,
                mark position, show/hide trails, delete (locked while a recorded trail exists;
                tapping the lock offers the confirmed trail clear, which unlocks). */}
            {selectedId === e.id && e.kind === 'team' && draggable && (
              <div className="wb-pill-acts" onPointerDown={(ev) => ev.stopPropagation()}>
                {e.truppId && onShowTrupp && (
                  <button className="wb-pa wb-pa-show" title={appConfig.copy.whiteboard.showTrupp} aria-label={appConfig.copy.whiteboard.showTrupp} onClick={() => onShowTrupp(e.truppId!)}><Icon id="warn" /></button>
                )}
                {onTeamMark && (
                  <button className="wb-pa wb-pa-mark" title={appConfig.copy.whiteboard.markPosition} aria-label={appConfig.copy.whiteboard.markPosition} onClick={() => onTeamMark(e.id)}><Icon id="flag" /></button>
                )}
                {/* visibility toggle, NOT deletion — the ✕ here silently wiped the record */}
                {(e.trail?.length ?? 0) > 0 && onToggleTrails && (
                  <button className="wb-pa" title={trailsVisible ? appConfig.copy.whiteboard.trailsOff : appConfig.copy.whiteboard.trailsOn}
                    aria-label={appConfig.copy.whiteboard.trails} aria-pressed={trailsVisible} onClick={onToggleTrails}>
                    <Icon id={trailsVisible ? 'eye' : 'eyeoff'} />
                  </button>
                )}
                {(e.trail?.length ?? 0) > 0
                  ? <button className="wb-pa wb-pa-lock" title={appConfig.copy.whiteboard.deleteLocked} aria-label={appConfig.copy.whiteboard.deleteLocked}
                      onClick={() => onTeamClearTrail?.(e.id)}><Icon id="lock" /></button>
                  : <button className="wb-pa wb-pa-del" title={appConfig.copy.delete} aria-label={appConfig.copy.delete} onClick={() => onDelete(e.id)}><Icon id="trash" /></button>}
              </div>
            )}
            {selectedId === e.id && e.live && onRotate && (
              <TransformHandle
                className="handle marker-rotate"
                icon="rotate"
                title={appConfig.copy.contextPanel.rotateHint}
                onStart={(x, y, el) => rotDown(x, y, el, e.id)}
                onMove={rotMove}
                onEnd={rotUp}
              />
            )}
            {selectedId === e.id && e.kind === 'shape' && onShapeTransform && (
              // rotor rotates with the shape so the handles stay attached to it:
              // a tethered knob (top) for rotation, a corner grip for resize
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
                <TransformHandle
                  className="handle shape-resize"
                  icon="resize"
                  title={appConfig.copy.shapes.resizeHint}
                  onStart={(x, y, el) => shapeDown(x, y, el, e.id, e.coord[1], 'resize')}
                  onMove={shapeMove}
                  onEnd={shapeUp}
                />
              </div>
            )}
            {selectedId === e.id && isRotatableSym(e) && !isGrossluefter(e) && onShapeTransform && (
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
            {selectedId === e.id && isGrossluefter(e) && onShapeTransform && (
              // composite Grosslüfter: TWO tethered rotors — a short blue knob aims the vehicle
              // body, a longer amber knob aims the fan/airflow. Each rotor rotates with its own
              // part (− bearing) so the handles stay attached as the map turns.
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
                    title={appConfig.copy.contextPanel.rotationFan}
                    onStart={(x, y, el) => shapeDown(x, y, el, e.id, e.coord[1], 'rotate2')}
                    onMove={shapeMove}
                    onEnd={shapeUp}
                  />
                </div>
              </>
            )}
          </div>
        </Marker>
        )
      })}
      {/* team trail breadcrumbs (recorded via «Position markieren») — same dot + timestamp
          look as the plan board; pointer-transparent so they never block a map tap */}
      {trailsVisible && entities.filter((e) => e.kind === 'team' && isVisible(e.layer) && Array.isArray(e.coord) && e.trail?.length).flatMap((e) =>
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
