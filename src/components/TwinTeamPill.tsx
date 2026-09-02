/** The selected Truppmarker's pill + context bar, for a MIRRORED marker on either surface.
 *
 *  Twin doctrine: a projection carries the same capabilities through the same functions its
 *  original has — rename, Trupp-Join, Farbe, «Position markieren», the Spuren-Auge, the locked
 *  trash — plus the one door a projection alone needs, «zum Original». Both native surfaces draw
 *  that bar inline (MapMarkers · wb-pill-acts, Whiteboard · wb-pill-acts); the two MIRRORS used
 *  to disagree — the Plan carried the whole bar, the Karte a bare dot and a read-only plaque —
 *  so the same Trupp answered differently depending on which picture you were looking at.
 *
 *  It is deliberately free of both surfaces' coordinate systems: the caller supplies the marker's
 *  facts, the writers that land on its ONE source object, and a `hit` shell that owns the
 *  surface's own tap/drag gesture around the pill.
 */
import { useState, type CSSProperties, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { Menu, Popover, PopoverClose } from '../lib/overlays'
import { MenuPick } from './MenuPick'
import { appConfig } from '../config/appConfig'
import type { Trupp } from '../types'

/** Every write the bar makes, each landing on the ONE source object the twin mirrors. */
export interface TwinTeamActions {
  rename: (name: string) => void
  pick: (truppId?: string) => void
  color: (color: string | null) => void
  mark: () => void
  clearTrail: () => void
  remove: () => void
  showTrupp: (truppId: string) => void
  /** pan the OTHER surface to the original — the twin's one extra door */
  toOriginal: () => void
  toggleTrail: () => void
}

export function TwinTeamPill({ name, time, color, colorSet, originalLabel, raus, truppId, trailCount, trailShown, trupps, acts, hit }: {
  name: string
  time?: string
  /** the colour actually painted (the source's own, or the palette's first) */
  color: string
  /** …and the STORED one, so «Automatisch» can say whether it is the state in force */
  colorSet?: string
  /** «Auf Plan zeigen» / «Auf Karte zeigen» — which surface the original lives on */
  originalLabel: string
  raus: boolean
  truppId?: string
  trailCount: number
  trailShown: boolean
  trupps: Trupp[]
  acts: TwinTeamActions
  /** the surface's own hit shell — it owns the press (drag on this surface, tap to keep the
   *  selection) and wraps the pill markup untouched */
  hit: (children: ReactNode) => ReactNode
}) {
  // inline rename on the pill's pen — the same grammar both native chips use
  const [renaming, setRenaming] = useState(false)
  // a marker bound to a LIVE registered Trupp is named and coloured by the Atemschutz board;
  // offering a second name/palette here would fork the two apart
  const boundAlive = !!truppId && trupps.some((t) => t.id === truppId && !t.removedAt)
  return (
    <>
      {hit(
        // ⚠️ the pill span carries the native class untouched: putting it on the hit shell made
        // the button the flex container, and Safari's anonymous button box misplaced the cap.
        <span className={`wb-resource-pill ${raus ? 'raus' : ''}`} style={{ '--team': color } as CSSProperties}>
          <span className="wb-resource-cap" />
          <span className="wb-resource-body">
            <span className="wb-resource-name">
              {renaming
                ? <input className="wb-resource-input" autoFocus defaultValue={name}
                    onPointerDown={(ev) => ev.stopPropagation()}
                    onBlur={(ev) => { acts.rename(ev.target.value); setRenaming(false) }}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur()
                      if (ev.key === 'Escape') { ev.stopPropagation(); setRenaming(false) }
                    }} />
                : <b>{name}</b>}
              {raus && <span className="wb-resource-raus">{appConfig.copy.atemschutz.status.raus}</span>}
            </span>
            {time && <i className="wb-resource-time">{time}</i>}
          </span>
        </span>,
      )}
      <div className="wb-pill-acts" onPointerDown={(ev) => ev.stopPropagation()}>
        {!truppId && (
          <button className="wb-pa" title={appConfig.copy.edit} aria-label={appConfig.copy.edit}
            onClick={() => setRenaming(true)}><Icon id="pen" /></button>
        )}
        {truppId && (
          <button className="wb-pa wb-pa-show" title={appConfig.copy.whiteboard.showTrupp} aria-label={appConfig.copy.whiteboard.showTrupp}
            onClick={() => acts.showTrupp(truppId)}><Icon id="warn" /></button>
        )}
        {/* ⚠️ A Trupp that is already out is offered only when it is the one standing here — it
            is the record of who was, not somebody to send. */}
        {(!!truppId || trupps.some((t) => !t.removedAt && t.status !== 'raus')) && (
          <Menu
            popupClassName="de-menu-pop"
            itemClassName={() => 'de-menu-item'}
            trigger={
              <button className="wb-pa" title={appConfig.copy.atemschutz.markerLabel} aria-label={appConfig.copy.atemschutz.markerLabel}>
                <Icon id="people" />
              </button>
            }
            items={[
              { label: <MenuPick label={appConfig.copy.atemschutz.markerNone} on={!truppId} />, onClick: () => acts.pick(undefined) },
              ...trupps.filter((t) => !t.removedAt && (t.status !== 'raus' || t.id === truppId)).map((t) => ({
                label: <MenuPick label={t.name} on={t.id === truppId} />,
                onClick: () => acts.pick(t.id),
              })),
            ]}
          />
        )}
        {!boundAlive && (
          <Popover
            ariaLabel={appConfig.copy.atemschutz.colorLabel}
            popupClassName="wb-pa-colors"
            trigger={
              <button className="wb-pa" title={appConfig.copy.atemschutz.colorLabel} aria-label={appConfig.copy.atemschutz.colorLabel}>
                <span className="wb-pa-swatch" style={{ background: colorSet || 'transparent' }} />
              </button>
            }
          >
            <PopoverClose className={`ctx-team-auto${colorSet ? '' : ' on'}`} onClick={() => acts.color(null)}>
              {appConfig.copy.atemschutz.colorAuto}
            </PopoverClose>
            {appConfig.drawing.teamColors.map((c) => (
              <PopoverClose key={c} className={`dh-color${colorSet === c ? ' on' : ''}`} onClick={() => acts.color(c)}>
                <span style={{ background: c }} />
              </PopoverClose>
            ))}
          </Popover>
        )}
        <button className="wb-pa wb-pa-mark" title={appConfig.copy.whiteboard.markPosition} aria-label={appConfig.copy.whiteboard.markPosition}
          onClick={() => acts.mark()}><Icon id="flag" /></button>
        {trailCount > 0 && (
          <button className="wb-pa" title={trailShown ? appConfig.copy.whiteboard.trailsOff : appConfig.copy.whiteboard.trailsOn}
            aria-label={appConfig.copy.whiteboard.trails} aria-pressed={trailShown} onClick={() => acts.toggleTrail()}>
            <Icon id={trailShown ? 'eye' : 'eyeoff'} />
          </button>
        )}
        <button className="wb-pa" title={originalLabel} aria-label={originalLabel}
          onClick={() => acts.toOriginal()}><Icon id="external" /></button>
        {/* the record is protected: while a trail exists the trash offers to clear IT, never the
            marker (the same lock both native bars carry) */}
        {trailCount > 0
          ? <button className="wb-pa wb-pa-del-off" title={appConfig.copy.whiteboard.deleteLocked} aria-label={appConfig.copy.whiteboard.deleteLocked}
              onClick={() => acts.clearTrail()}><Icon id="trash" /></button>
          : <button className="wb-pa wb-pa-del" title={appConfig.copy.delete} aria-label={appConfig.copy.delete}
              onClick={() => acts.remove()}><Icon id="trash" /></button>}
      </div>
    </>
  )
}
