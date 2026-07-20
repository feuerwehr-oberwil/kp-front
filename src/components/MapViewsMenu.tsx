import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { CameraView, LngLat } from '../types'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'
import { DockInfo } from './DockInfo'
import s from './MapViewsMenu.module.css'

/** Everything the saved-views control needs from App — the synced list plus the camera ops. */
export interface ViewsApi {
  list: CameraView[]
  current: { bearing: number; center: LngLat; zoom: number }
  onGo: (v: CameraView) => void
  onSave: () => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  onResetNorth: () => void
  /** fit the incident + all placed/drawn content into view (the old scope/locate button) */
  onFit: () => void
  /** take a single GPS fix and fly to it (the on-demand «Mein Standort» blue dot) */
  onLocate: () => void
}

// Is the live camera (roughly) sitting on a saved view? Lets us highlight the one we're on so
// the operator recognises where they are. Loose tolerances — flyTo lands close, not exact, and
// a hand-nudge of a few metres shouldn't drop the highlight.
function isOnView(v: CameraView, c: { bearing: number; center: LngLat; zoom: number }): boolean {
  const dLng = Math.abs(v.center[0] - c.center[0])
  const dLat = Math.abs(v.center[1] - c.center[1])
  const dBear = Math.abs(((v.bearing - c.bearing + 540) % 360) - 180) // shortest angular gap
  return dLng < 1e-4 && dLat < 1e-4 && Math.abs(v.zoom - c.zoom) < 0.15 && dBear < 2
}

function ViewsPopover({ api, readOnly, coordsOn, onToggleCoords, onClose }: {
  api: ViewsApi
  readOnly: boolean
  coordsOn?: boolean
  onToggleCoords?: () => void
  onClose: () => void
}) {
  const cp = appConfig.copy.mapViews
  const [editingId, setEditingId] = useState<string | null>(null)
  const commitRename = (id: string, name: string) => { api.onRename(id, name.trim()); setEditingId(null) }

  // No backdrop scrim — exactly like the measure/draw ToolDock: the dock just sits over the map,
  // the map stays fully draggable + clickable underneath, and it closes by tapping the compass
  // again, the ✕, or activating another tool. (A scrim would swallow map drags/clicks.)
  return createPortal(
    <>
      {/* same dark dock as the measure/draw ToolDock, in the same spot: centred just left of
          the right tool rail, ✕ on top, ⓘ at the bottom (see .wb-dock / .wb-dock-map). */}
      <div className={cx(s.pop, s.dock)} role="dialog" aria-label={cp.title}>
        <div className={s.head}>
          <button className={s.close} aria-label={appConfig.copy.closeDialog} onClick={onClose}><Icon id="close" /></button>
        </div>
        <button className={cx(s.row, s.north)} onClick={() => { api.onResetNorth(); onClose() }}>
          <span className={s.ico}><Icon id="compass" /></span>
          <span className={s.name}>{cp.north}</span>
        </button>
        <button className={cx(s.row, s.north)} onClick={() => { api.onFit(); onClose() }}>
          <span className={s.ico}><Icon id="cross" /></span>
          <span className={s.name}>{cp.fit}</span>
        </button>
        <button className={cx(s.row, s.north)} onClick={() => { api.onLocate(); onClose() }}>
          <span className={s.ico}><Icon id="locate" /></span>
          <span className={s.name}>{cp.locate}</span>
        </button>
        {/* coordinate readout toggle — lives here instead of as its own rail-footer button
            (rarely used; freed the slot for Ebenen). Stays open so the state flip is visible. */}
        {onToggleCoords && (
          <button className={cx(s.row, s.north, coordsOn && s.on)} aria-pressed={coordsOn} onClick={onToggleCoords}>
            <span className={s.ico}><Icon id="coords" /></span>
            <span className={s.name}>{appConfig.copy.nav.coords}</span>
          </button>
        )}
        <div className={s.sep} />
        {api.list.length === 0 && <div className={s.empty}>{cp.empty}</div>}
        {api.list.map((v) => editingId === v.id ? (
          <div key={v.id} className={cx(s.row, s.editing)}>
            <span className={s.ico} style={{ transform: `rotate(${-v.bearing}deg)` }}><Icon id="compass" /></span>
            <input
              className={s.input} autoFocus defaultValue={v.name} aria-label={cp.rename}
              onKeyDown={(e) => { if (e.key === 'Enter') commitRename(v.id, e.currentTarget.value); else if (e.key === 'Escape') setEditingId(null) }}
              onBlur={(e) => commitRename(v.id, e.currentTarget.value)}
            />
          </div>
        ) : (
          <div key={v.id} className={cx(s.row, isOnView(v, api.current) && s.on)}>
            <button className={s.go} onClick={() => { api.onGo(v); onClose() }}>
              <span className={s.ico} style={{ transform: `rotate(${-v.bearing}deg)` }}><Icon id="compass" /></span>
              <span className={s.name}>{v.name}</span>
            </button>
            {!readOnly && (
              <>
                <button className={s.mini} aria-label={cp.rename} title={cp.rename} onClick={() => setEditingId(v.id)}><Icon id="pen" /></button>
                <button className={s.mini} aria-label={cp.delete} title={cp.delete} onClick={() => api.onDelete(v.id)}><Icon id="trash" /></button>
              </>
            )}
          </div>
        ))}
        {!readOnly && (
          <>
            <div className={s.sep} />
            <button className={cx(s.row, s.save)} onClick={() => api.onSave()}>
              <span className={s.ico}><Icon id="plus" /></span>
              <span className={s.name}>{cp.save}</span>
            </button>
          </>
        )}
        <div className={s.sep} />
        <div className={s.foot}><DockInfo text={cp.hint} inline /></div>
      </div>
    </>,
    document.body,
  )
}

/**
 * The multi-purpose compass: always visible (it rotates to the live bearing as an indicator),
 * and tapping it opens the saved-views popover — `Nach Norden`, the team's saved framings, and
 * `Aktuelle Ansicht speichern`. The trigger styling is supplied by the caller so it sits
 * natively in either the right tool-rail footer (`rail`) or the top-right map HUD (`util`).
 */
export function MapViewsButton({ api, bearing, readOnly, variant, btnClassName, activeClassName, glyphClassName, label, open, onOpenChange, coordsOn, onToggleCoords }: {
  api: ViewsApi
  bearing: number
  readOnly: boolean
  variant: 'rail' | 'util'
  btnClassName: string
  /** applied when open, so the compass lights up like any other active tool button */
  activeClassName?: string
  glyphClassName: string
  /** shown next to the glyph in the rail variant (the HUD variant is icon-only) */
  label?: string
  /** controlled by App so the popover is mutually exclusive with the drawing/measure tool docks */
  open: boolean
  onOpenChange: (open: boolean) => void
  /** coordinate-readout toggle row in the popover (replaces the old rail-footer button) */
  coordsOn?: boolean
  onToggleCoords?: () => void
}) {
  const cp = appConfig.copy.mapViews
  const glyph = <span className={glyphClassName} style={{ transform: `rotate(${-bearing}deg)` }}><Icon id="compass" /></span>
  return (
    <>
      <button className={cx(btnClassName, open && activeClassName)} title={cp.title} aria-label={cp.title} aria-pressed={open} aria-expanded={open} aria-haspopup="dialog" onClick={() => onOpenChange(!open)}>
        {variant === 'rail'
          ? <><span className="vrail-glyph">{glyph}</span><span className="vrail-label">{label ?? cp.title}</span></>
          : glyph}
      </button>
      {open && <ViewsPopover api={api} readOnly={readOnly} coordsOn={coordsOn} onToggleCoords={onToggleCoords} onClose={() => onOpenChange(false)} />}
    </>
  )
}
