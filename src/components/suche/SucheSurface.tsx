import { useMemo } from 'react'
import { appConfig } from '../../config/appConfig'
import { Icon } from '../../lib/icons'
import { DetentSheet, type Detent } from '../../lib/overlays'
import { storeyBadges, sucheGroups, sucheProgress, sucheSummary, vermisstCount } from '../../lib/suche'
import { SuchePanel, type SuchePanelProps } from './SuchePanel'
import s from './Suche.module.css'

/**
 * The tablet's Suche: a DOCK beside the Gebäude or the Karte (E5, 24.09.2026). Not a sheet —
 * nothing is modal, the plan stays fully usable, and the Gebäude fits itself into the room left
 * beside it (Whiteboard · `dockInset`).
 */
export function SucheDock({ onClose, ...panel }: SuchePanelProps & { onClose: () => void }) {
  const C = appConfig.copy.suche
  return (
    <aside className={s.dock} aria-label={C.title} data-suche-dock>
      <div className={s.dockHead}>
        <h2 className={s.dockTitle}><Icon id="search" />{C.title}</h2>
        <button type="button" className={s.x} onClick={onClose} aria-label={C.close} title={C.close}><Icon id="close" /></button>
      </div>
      <SuchePanel key={panel.focus?.nonce ?? 0} {...panel} />
    </aside>
  )
}

/**
 * The phone's Suche: the plan (Gebäude or Karte) stays underneath and the list is a sheet pulled
 * over it — peek · half · full (lib/overlays · DetentSheet). The floor chips across its top carry
 * each storey's progress and jump the stack there; the one switch at its top changes the surface
 * underneath without touching the sheet's own state.
 * ⚠️ The sheet stands on the nav bar, never over it (15-mobile.css + Suche.module.css · .sheet).
 */
export function SuchePhoneSheet({ onClose, detent, onDetent, surface, onSurface, hasGebaeude, ...panel }: SuchePanelProps & {
  onClose: () => void
  detent: Detent
  onDetent: (d: Detent) => void
  surface: 'gebaeude' | 'karte'
  onSurface: (s: 'gebaeude' | 'karte') => void
  hasGebaeude: boolean
}) {
  const C = appConfig.copy.suche
  const groups = useMemo(() => sucheGroups(panel.doc, { key: panel.stackKey, floors: panel.floors, floorName: panel.floorName }), [panel.doc, panel.stackKey, panel.floors, panel.floorName])
  const badges = storeyBadges(groups)
  const missing = vermisstCount(panel.doc)
  const summary = sucheSummary(missing, sucheProgress(groups))
  const floorChips = surface === 'gebaeude' && panel.floors.length > 0 && (
    <div className={s.floorChips} role="group" aria-label={C.tabBereiche}>
      {[...panel.floors].sort((a, b) => b - a).map((f) => (
        <button key={f} type="button" className={s.floorChip} onClick={() => panel.onFloor?.(f)}
          data-complete={badges[f]?.complete || undefined} data-active={badges[f]?.active || undefined}>
          {panel.floorName(f)}{badges[f] && <b>{badges[f].complete ? '✓' : badges[f].text}</b>}
        </button>
      ))}
    </div>
  )
  const head = detent === 'peek' ? (
    <div className={s.peekRow}>
      <button type="button" className={s.peekText} onClick={() => onDetent('half')} aria-label={`${summary} – ${C.sheetExpand}`}>
        <Icon id="search" />
        <span className={missing > 0 ? s.peekMissing : undefined}>{summary}</span>
        <Icon id="chevron-up" />
      </button>
      <button type="button" className={s.x} onClick={onClose} aria-label={C.close}><Icon id="close" /></button>
    </div>
  ) : (
    <>
      <div className={s.sheetTop}>
        {hasGebaeude ? (
          <div className="useg" role="group" aria-label={C.surfaceSwitch}>
            <button type="button" className={`useg-btn${surface === 'gebaeude' ? ' on' : ''}`} aria-pressed={surface === 'gebaeude'} onClick={() => onSurface('gebaeude')}>{C.surfaceGebaeude}</button>
            <button type="button" className={`useg-btn${surface === 'karte' ? ' on' : ''}`} aria-pressed={surface === 'karte'} onClick={() => onSurface('karte')}>{C.surfaceKarte}</button>
          </div>
        ) : <span className={s.sheetTitle}>{C.title}</span>}
        <span className={s.sheetTitle} />
        <button type="button" className={s.x} onClick={() => onDetent('peek')} aria-label={C.sheetCollapse}><Icon id="chevron-down" /></button>
        <button type="button" className={s.x} onClick={onClose} aria-label={C.close}><Icon id="close" /></button>
      </div>
      {floorChips}
    </>
  )
  return (
    // the floor chips stand at PEEK too (the design's ①): the storey progress is the one thing
    // worth reading while the plan has the screen
    <DetentSheet detent={detent} onDetent={onDetent} ariaLabel={C.title} className={`${s.sheet}${floorChips ? ` ${s.withChips}` : ''}`} head={head} peek={floorChips || undefined}>
      <SuchePanel key={panel.focus?.nonce ?? 0} {...panel} />
    </DetentSheet>
  )
}
