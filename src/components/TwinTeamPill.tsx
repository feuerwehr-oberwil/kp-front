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
import { Menu } from '../lib/overlays'
import { MenuPick } from './MenuPick'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import type { TeamLineBadge } from '../lib/truppLines'
import type { Trupp } from '../types'

/**
 * The join sheet — «welcher Trupp ist dieser Marker?» — of a selected Trupp marker (Karte) or
 * chip (Plan): the marker's half of the join, in the exact shape the line editor's «Gehört zu
 * Trupp …» has (the app's own menu, never a native <select>). ONE list for both surfaces:
 * «Kein Trupp», then every registered Trupp that is not out — an out one only when it is the one
 * standing here (it is the record of who WAS, not somebody to send). A Trupp registered AFTER
 * the marker was put down is in the list, so a «Trupp 2» dropped at 03:12 still finds its crew
 * at 03:14. Takeover of somebody else's chip asks first, in the ONE place that ask lives
 * (useTruppActions · adoptTruppMarker).
 *
 * ⚠️ Always drawn wherever the surface offers `pick` (14.09.). It used to be withheld while no
 * Trupp was joinable yet, which in the field read as «the join option is sometimes missing» —
 * the button is the door, whether or not anyone is behind it right now.
 *
 * «Neuer Trupp» (14.09.) is the LAST row, wherever the surface offers `create`: it opens the
 * normal Anmeldung, and saving it joins the new Trupp to THIS marker in the same go — the picture
 * was there first, the record comes second, and nobody has to find the chip again from the card.
 * Cancel leaves the loose chip as it was. Both surfaces render this one function, so the row
 * exists here and nowhere else.
 */
export function TruppJoinMenu({ truppId, trupps, pick, create, onNone }: {
  truppId?: string; trupps: Trupp[]; pick: (truppId?: string) => void; create?: () => void
  /** «Kein Trupp» exists only on a marker that hangs on a hose (15.09., Bastian): it takes the
   *  marker off the Leitung – hose unlinked and uncoupled, marker a step away, still this Trupp's.
   *  A marker on nothing has no such entry; leaving the picture is the trash can. */
  onNone?: () => void
}) {
  return (
    <Menu
      popupClassName="de-menu-pop"
      itemClassName={() => 'de-menu-item'}
      trigger={
        <button className="wb-pa" title={appConfig.copy.atemschutz.markerLabel} aria-label={appConfig.copy.atemschutz.markerLabel}>
          <Icon id="people" />
        </button>
      }
      items={[
        ...(onNone ? [{ label: <MenuPick label={appConfig.copy.atemschutz.markerNone} on={false} />, onClick: onNone }] : []),
        ...trupps.filter((t) => !t.removedAt && (t.status !== 'raus' || t.id === truppId)).map((t) => ({
          label: <MenuPick label={t.name} on={t.id === truppId} />,
          onClick: () => pick(t.id),
        })),
        // the plus sits in the tick's slot, so the row lines up with the picks above it
        ...(create ? [{
          label: <><span className="de-menu-tick on" aria-hidden><Icon id="plus" /></span><span>{appConfig.copy.whiteboard.newTeam}</span></>,
          onClick: create,
        }] : []),
      ]}
    />
  )
}

/** Every write the bar makes, each landing on the ONE source object the twin mirrors.
 *  An OPTIONAL writer is a door this surface does not offer — its button is not drawn. */
export interface TwinTeamActions {
  rename?: (name: string) => void
  pick?: (truppId?: string) => void
  /** «Neuer Trupp» on the join sheet — register a Trupp that adopts this marker on save */
  newTrupp?: () => void
  mark?: () => void
  clearTrail: () => void
  remove: () => void
  showTrupp?: (truppId: string) => void
  /** pan the OTHER surface to the original — the MIRROR's one extra door, absent on a native */
  toOriginal?: () => void
  toggleTrail?: () => void
  /** «Lösen» on a joined marker (Karte, 15.09.): let go of the Leitung this Trupp is on. Offered
   *  only where a `line` badge is also drawn — a surface that does not show the join does not
   *  offer to break it. */
  unlink?: () => void
  /** let go of the symbol the marker is docked to (lib/docking) – the same «Lösen» glyph */
  undock?: () => void
}

export function TwinTeamPill({ name, time, color, originalLabel, raus, truppId, trailCount, trailShown, trupps, line, acts, hit, renameRef, renaming: renamingProp, onRenaming }: {
  name: string
  time?: string
  /** the colour actually painted (the source's own, or the palette's first) */
  color: string
  /** «Auf Plan zeigen» / «Auf Karte zeigen» — which surface the original lives on. Mirrors
   *  only: on a native surface the marker IS the original, so there is nowhere to send you. */
  originalLabel?: string
  raus: boolean
  truppId?: string
  trailCount: number
  trailShown: boolean
  trupps: Trupp[]
  /** The Leitung this Trupp works, merged INTO the marker — «Ein Etikett» (Karte only, 15.09.):
   *  the number field in the hose's own ink, plus a coupling stub where the hose actually ends
   *  here, and the hose then draws no separate end tag. ⚠️ OPTIONAL on purpose: the Plan and
   *  both mirrors pass nothing and render exactly as they did, so the merge cannot leak onto a
   *  sheet whose printed twin must not change (lib/truppLines · teamLineBadges). */
  line?: TeamLineBadge
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
  const rename = acts?.rename
  const pick = acts?.pick
  const newTrupp = acts?.newTrupp
  const showTrupp = acts?.showTrupp
  const mark = acts?.mark
  const toOriginal = acts?.toOriginal
  const toggleTrail = acts?.toggleTrail
  const unlink = acts?.unlink
  const undock = acts?.undock
  // ⚠️ the pill span carries the native class untouched: putting it on the hit shell made
  // the button the flex container, and Safari's anonymous button box misplaced the cap.
  const pill = (
    <span className={`wb-resource-pill ${raus ? 'raus' : ''}${line ? ' joined' : ''}`}
      style={{ '--team': color, ...(line ? { '--line': line.color } : null) } as CSSProperties}>
      {/* The coupling, in the hose's ink, at the pill's LEFT edge — the same edge the marker is
          anchored by, so the stub sits exactly where the line ends. Absolutely positioned: it
          must not push the cap (and with it the coordinate the pill states) sideways. */}
      <span className="wb-resource-cap" />
      {/* ⚠️ AFTER the cap, where the mock has it before the dot. The cap/dot IS the coordinate
          (lib/mapView · TEAM_PILL_CAP_PX): anything in front of it moves the point the marker
          states, which is the bug the left-edge anchoring exists to prevent. The order is still
          constant — cap · Leitung · Name · #N — so nothing has to be re-found at 3am. */}
      {line?.lineNo != null && (
        <span className="team-ltg" title={fillTemplate(appConfig.copy.drawingEditor.lineLabelNo, { n: line.lineNo })}>
          {line.lineNo}
        </span>
      )}
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
          {/* no «#N» badge here either (14.09.) — on the picture the name alone is the label, the
              number lives on the Atemschutz card (docs/trupp-naming.md §2) */}
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
          {/* «Lösen» (15.09.): the one explicit way to part the marker from what it hangs on – its
              Leitung, the symbol it is docked to, or both at once. A glyph, first in the bar: the
              pill's own «1» chip already says which Leitung, and the words «Leitung 1 · Trupp 3»
              said nothing the picture did not. */}
          {((line && unlink && truppId) || undock) && (
            <button className="wb-pa wb-pa-unlink" title={appConfig.copy.contextPanel.dockedRelease} aria-label={appConfig.copy.contextPanel.dockedRelease}
              onClick={() => { if (line && truppId) unlink?.(); undock?.() }}><Icon id="unlink" /></button>
          )}
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
          {/* «Atemschutz-Trupp» — the join sheet (TruppJoinMenu above), whenever this surface
              offers the door at all */}
          {pick && <TruppJoinMenu truppId={truppId} trupps={trupps} pick={pick} create={newTrupp} onNone={line && unlink && truppId ? unlink : undefined} />}
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
