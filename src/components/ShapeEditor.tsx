import type { Entity } from '../types'
import { Icon } from '../lib/icons'
import { SheetGrip } from './SheetGrip'
import { appConfig } from '../config/appConfig'
import { ShapeGlyph } from '../lib/shapes'

const COLORS = appConfig.drawing.colors

interface Props {
  // structurally satisfied by a map Entity AND a plan BoardAnno of kind 'shape'
  entity: Pick<Entity, 'shape' | 'color'>
  onColor: (c: string) => void
  /** scale the shape by a factor (>1 bigger, <1 smaller); the parent clamps to its size
   *  space (metres on the map, normalized plan-width on the Plan). The corner drag-handle
   *  stays for tablet/desktop, but on a phone it sits under this sheet — so size lives here. */
  onScale?: (factor: number) => void
  /** fly the map to the shape — map-only; a plan shape is already on screen */
  onCenter?: () => void
  onDelete: () => void
  onClose: () => void
}

// Editor for a placed generic shape — colour only. Size and rotation are changed
// directly on the map/plan by dragging the shape's corner / top handles, so
// they're not duplicated here. Reuses the .ctx / .draw-editor look.
export function ShapeEditor({ entity, onColor, onScale, onCenter, onDelete, onClose }: Props) {
  const color = entity.color ?? '#1f6feb'
  const name = appConfig.copy.shapes.names[entity.shape ?? 'square'] ?? appConfig.copy.shapes.kindLabel

  // rendered twice: pinned at the sheet bottom on desktop/tablet, and again inside the
  // scrolling body for phones (.ctx-footer-inline) — CSS shows exactly one copy
  const actions = (
    <div className="ctx-actions">
      {onCenter && <button className="btn" onClick={onCenter}><Icon id="cross" />{appConfig.copy.contextPanel.center}</button>}
      <button className="btn warn" onClick={onDelete}><Icon id="close" />{appConfig.copy.delete}</button>
    </div>
  )
  return (
    <div className="ctx draw-editor">
      <SheetGrip onClose={onClose} />
      <div className="ctx-head">
        <div className="ph shape-ph" style={{ borderColor: color }}><ShapeGlyph kind={entity.shape ?? 'square'} color={color} /></div>
        <div className="ctx-titlewrap"><h3>{name}</h3><p>{appConfig.copy.shapes.kindLabel}</p></div>
        <button className="ctx-x" onClick={onClose} title={appConfig.copy.closeDialog} aria-label={appConfig.copy.closeDialog}><Icon id="close" /></button>
      </div>
      <div className="ctx-body">
        <div className="de-row">
          <span>{appConfig.copy.shapes.color}</span>
          <span className="dh-swatches">
            {COLORS.map((c) => <button key={c} className={`dh-color ${color === c ? 'on' : ''}`} style={{ background: c }} aria-label={c} onClick={() => onColor(c)} />)}
          </span>
        </div>
        {onScale && (
          <div className="de-row">
            <span>{appConfig.copy.shapes.size}</span>
            <span className="shape-size-steps">
              <button className="btn shape-size-btn" onClick={() => onScale(1 / 1.25)} title={appConfig.copy.shapes.sizeSmaller} aria-label={appConfig.copy.shapes.sizeSmaller}><Icon id="minus" /></button>
              <button className="btn shape-size-btn" onClick={() => onScale(1.25)} title={appConfig.copy.shapes.sizeBigger} aria-label={appConfig.copy.shapes.sizeBigger}><Icon id="plus" /></button>
            </span>
          </div>
        )}
        <div className="de-row de-hint">{appConfig.copy.shapes.rotateHint}</div>
        <div className="ctx-footer-inline">{actions}</div>
      </div>
      {actions}
    </div>
  )
}
