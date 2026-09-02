/** The selected Truppmarker's pill + context bar — the ONE copy, for all four places it shows.
 *
 *  Twin doctrine: a projection carries the same capabilities through the same functions its
 *  original has — rename, Trupp-Join, Farbe, «Position markieren», the Spuren-Auge, the locked
 *  trash — plus the one door a projection alone needs, «zum Original». That bar used to be
 *  written out four times: twice for the mirrors and once inside each NATIVE surface
 *  (MapMarkers' Trupp marker, Whiteboard's resource chip). The mirrors had already drifted once
 *  — the Plan carried the whole bar, the Karte a bare dot and a read-only plaque — so the same
 *  Trupp answered differently depending on which picture you were looking at. Since 03.09. all
 *  four render THIS component, so there is nothing left to drift.
 *
 *  It is deliberately free of every surface's coordinate system: the caller supplies the
 *  marker's facts, the writers that land on its ONE source object, and a `hit` shell that owns
 *  the surface's own tap/drag gesture around the pill.
 *
 *  What a surface says by LEAVING A WRITER OUT is «this door is not mine to open»: an action
 *  that is absent draws no button. That is how the plan board keeps its chip colour in the
 *  SelectionBar (no swatch here), and how a read-only Karte shows the pill with no bar at all.
 */
import { useState, type CSSProperties, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { Menu, Popover, PopoverClose } from '../lib/overlays'
import { MenuPick } from './MenuPick'
import { appConfig } from '../config/appConfig'
import type { Trupp } from '../types'

/** Every write the bar makes, each landing on the ONE source object the twin mirrors.
 *  An OPTIONAL writer is a door this surface does not offer — its button is not drawn. */
export interface TwinTeamActions {
  rename?: (name: string) => void
  pick?: (truppId?: string) => void
  /** absent on the plan board: a chip's colour is written from the SelectionBar there */
  color?: (color: string | null) => void
  mark?: () => void
  clearTrail: () => void
  remove: () => void
  showTrupp?: (truppId: string) => void
  /** pan the OTHER surface to the original — the MIRROR's one extra door, absent on a native */
  toOriginal?: () => void
  toggleTrail?: () => void
}

export function TwinTeamPill({ name, time, color, colorSet, originalLabel, raus, truppId, trailCount, trailShown, trupps, acts, hit, renameRef, renaming: renamingProp, onRenaming }: {
  name: string
  time?: string
  /** the colour actually painted (the source's own, or the palette's first) */
  color: string
  /** …and the STORED one, so «Automatisch» can say whether it is the state in force */
  colorSet?: string
  /** «Auf Plan zeigen» / «Auf Karte zeigen» — which surface the original lives on. Mirrors
   *  only: on a native surface the marker IS the original, so there is nowhere to send you. */
  originalLabel?: string
  raus: boolean
  truppId?: string
  trailCount: number
  trailShown: boolean
  trupps: Trupp[]
  /** absent = pill only, no bar — a surface that may look but not write (read-only Karte,
   *  a plan board in a drawing tool) still shows the selected pill exactly as before */
  acts?: TwinTeamActions
  /** the surface's own hit shell — it owns the press (drag on this surface, tap to keep the
   *  selection) and wraps the pill markup untouched. A surface whose own container already
   *  carries the gesture (both natives) leaves it out and the pill is rendered bare. */
  hit?: (children: ReactNode) => ReactNode
  /** the surface's focus recipe for the rename input, where a plain autoFocus is not enough —
   *  ⚠️ MapLibre's Marker preventDefaults mousedown ("prevent focusing on click"), so the Karte
   *  has to stop that event on the input itself or the field never takes focus. */
  renameRef?: (el: HTMLInputElement | null) => void
  /** a surface that can open the rename from OUTSIDE this bar drives the flag itself — the plan
   *  board's double-click on a chip is the one such door. Leave both out (the Karte, both
   *  mirrors: pen only) and the pill keeps the flag, since leaving the pill IS the commit. */
  renaming?: boolean
  onRenaming?: (on: boolean) => void
}) {
  // inline rename on the pill's pen — the same grammar every surface uses
  const [selfRenaming, setSelfRenaming] = useState(false)
  const renaming = renamingProp ?? selfRenaming
  const setRenaming = onRenaming ?? setSelfRenaming
  // a marker bound to a LIVE registered Trupp is named and coloured by the Atemschutz board;
  // offering a second name/palette here would fork the two apart
  const boundAlive = !!truppId && trupps.some((t) => t.id === truppId && !t.removedAt)
  const rename = acts?.rename
  const pick = acts?.pick
  const setColor = acts?.color
  const showTrupp = acts?.showTrupp
  const mark = acts?.mark
  const toOriginal = acts?.toOriginal
  const toggleTrail = acts?.toggleTrail
  // ⚠️ the pill span carries the native class untouched: putting it on the hit shell made
  // the button the flex container, and Safari's anonymous button box misplaced the cap.
  const pill = (
    <span className={`wb-resource-pill ${raus ? 'raus' : ''}`} style={{ '--team': color } as CSSProperties}>
      <span className="wb-resource-cap" />
      <span className="wb-resource-body">
        <span className="wb-resource-name">
          {renaming && rename
            ? <input className="wb-resource-input" autoFocus={!renameRef} ref={renameRef} defaultValue={name}
                onPointerDown={(ev) => ev.stopPropagation()}
                onBlur={(ev) => { rename(ev.target.value); setRenaming(false) }}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur()
                  // Esc abandons: blur would commit, so drop the edit first
                  if (ev.key === 'Escape') { ev.stopPropagation(); setRenaming(false) }
                }} />
            : <b>{name}</b>}
          {raus && <span className="wb-resource-raus">{appConfig.copy.atemschutz.status.raus}</span>}
        </span>
        {time && <i className="wb-resource-time">{time}</i>}
      </span>
    </span>
  )
  return (
    <>
      {hit ? hit(pill) : pill}
      {acts && (
        <div className="wb-pill-acts" onPointerDown={(ev) => ev.stopPropagation()}>
          {/* rename — the touch path (double-tap→dblclick is unreliable on iOS). A Trupp-bound
              marker is named by the Atemschutz board, so it gets no pen: renaming it here would
              fork the two names apart. */}
          {!truppId && rename && (
            <button className="wb-pa" title={appConfig.copy.edit} aria-label={appConfig.copy.edit}
              onClick={() => setRenaming(true)}><Icon id="pen" /></button>
          )}
          {truppId && showTrupp && (
            <button className="wb-pa wb-pa-show" title={appConfig.copy.whiteboard.showTrupp} aria-label={appConfig.copy.whiteboard.showTrupp}
              onClick={() => showTrupp(truppId)}><Icon id="warn" /></button>
          )}
          {/* «Atemschutz-Trupp» — the marker's half of the join, and the exact shape the line
              editor's «Gehört zu Trupp …» has: the app's own menu, never a native <select>. A
              Trupp registered AFTER this marker was put down is in the list, so a «Trupp 2»
              dropped at 03:12 still finds its crew at 03:14. Takeover of somebody else's chip
              asks first, in the ONE place that ask lives (useTruppActions · adoptTruppMarker).
              ⚠️ A Trupp that is already out is offered only when it is the one standing here —
              it is the record of who was, not somebody to send. */}
          {pick && (!!truppId || trupps.some((t) => !t.removedAt && t.status !== 'raus')) && (
            <Menu
              popupClassName="de-menu-pop"
              itemClassName={() => 'de-menu-item'}
              trigger={
                <button className="wb-pa" title={appConfig.copy.atemschutz.markerLabel} aria-label={appConfig.copy.atemschutz.markerLabel}>
                  <Icon id="people" />
                </button>
              }
              items={[
                { label: <MenuPick label={appConfig.copy.atemschutz.markerNone} on={!truppId} />, onClick: () => pick(undefined) },
                ...trupps.filter((t) => !t.removedAt && (t.status !== 'raus' || t.id === truppId)).map((t) => ({
                  label: <MenuPick label={t.name} on={t.id === truppId} />,
                  onClick: () => pick(t.id),
                })),
              ]}
            />
          )}
          {/* Farbe — for the LOOSE team marker only (placed with the Trupp tool, never registered
              on the board): it has no other place to be recoloured. A marker bound to a registered
              Trupp does — the Trupp's own form — and its colour is the Trupp's identity, so a
              second palette here said the same thing twice. A colour someone else already wears
              is allowed — «alle Löschtrupps rot». */}
          {setColor && !boundAlive && (
            <Popover
              ariaLabel={appConfig.copy.atemschutz.colorLabel}
              popupClassName="wb-pa-colors"
              trigger={
                <button className="wb-pa" title={appConfig.copy.atemschutz.colorLabel} aria-label={appConfig.copy.atemschutz.colorLabel}>
                  <span className="wb-pa-swatch" style={{ background: colorSet || 'transparent' }} />
                </button>
              }
            >
              <PopoverClose className={`ctx-team-auto${colorSet ? '' : ' on'}`} onClick={() => setColor(null)}>
                {appConfig.copy.atemschutz.colorAuto}
              </PopoverClose>
              {appConfig.drawing.teamColors.map((c) => (
                <PopoverClose key={c} className={`dh-color${colorSet === c ? ' on' : ''}`} onClick={() => setColor(c)}>
                  <span style={{ background: c }} />
                </PopoverClose>
              ))}
            </Popover>
          )}
          {mark && (
            <button className="wb-pa wb-pa-mark" title={appConfig.copy.whiteboard.markPosition} aria-label={appConfig.copy.whiteboard.markPosition}
              onClick={() => mark()}><Icon id="flag" /></button>
          )}
          {/* per-team visibility toggle, NOT deletion — the ✕ here silently wiped the record */}
          {trailCount > 0 && toggleTrail && (
            <button className="wb-pa" title={trailShown ? appConfig.copy.whiteboard.trailsOff : appConfig.copy.whiteboard.trailsOn}
              aria-label={appConfig.copy.whiteboard.trails} aria-pressed={trailShown} onClick={() => toggleTrail()}>
              <Icon id={trailShown ? 'eye' : 'eyeoff'} />
            </button>
          )}
          {toOriginal && originalLabel && (
            <button className="wb-pa" title={originalLabel} aria-label={originalLabel}
              onClick={() => toOriginal()}><Icon id="external" /></button>
          )}
          {/* the record is protected: while a trail exists the trash offers to clear IT, never the
              marker (the same lock every surface carries) */}
          {trailCount > 0
            ? <button className="wb-pa wb-pa-del-off" title={appConfig.copy.whiteboard.deleteLocked} aria-label={appConfig.copy.whiteboard.deleteLocked}
                onClick={() => acts.clearTrail()}><Icon id="trash" /></button>
            : <button className="wb-pa wb-pa-del" title={appConfig.copy.delete} aria-label={appConfig.copy.delete}
                onClick={() => acts.remove()}><Icon id="trash" /></button>}
        </div>
      )}
    </>
  )
}
