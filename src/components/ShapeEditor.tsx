import type { Entity } from '../types'
import { Icon } from '../lib/icons'
import { SheetGrip, useSheetDrag } from './SheetGrip'
import { appConfig } from '../config/appConfig'
import { ShapeGlyph } from '../lib/shapes'

const COLORS = appConfig.drawing.colors

interface Props {
  // structurally satisfied by a map Entity AND a plan BoardAnno of kind 'shape'
  entity: Pick<Entity, 'shape' | 'color' | 'stop'>
  onColor: (c: string) => void
  /** scale the shape by a factor (>1 bigger, <1 smaller); the parent clamps to its size
   *  space (metres on the map, normalized plan-width on the Plan). The corner drag-handle
   *  stays for tablet/desktop, but on a phone it sits under this sheet — so size lives here.
   *  Scales BOTH axes: the stored size is the width, the height follows via `aspect`. */
  onScale?: (factor: number) => void
  /** toggle the «→|» Stopp-Balken across the arrow tip — the row only shows for the
   *  arrow kind (the other shapes have no tip to stop at) */
  onStop?: (stop: boolean) => void
  /** fly the map to the shape — map-only; a plan shape is already on screen */
  onCenter?: () => void
  onDelete: () => void
  onClose: () => void
}

// Editor for a placed generic shape — colour only. Size and rotation are changed
// directly on the map/plan by dragging the shape's corner / top handles, so
// they're not duplicated here. Reuses the .ctx / .draw-editor look.
export function ShapeEditor({ entity, onColor, onScale, onStop, onCenter, onDelete, onClose }: Props) {
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
  // the header shares the grip's drag (tap stays a tap there — see useSheetDrag)
  const sheetDrag = useSheetDrag({ onClose, tapToggles: false })
  return (
    <div className="ctx draw-editor">
      <SheetGrip onClose={onClose} />
      {/* the whole header drags the sheet too, not just the 44×5px grip above it */}
      <div className="ctx-head" {...sheetDrag}>
        <div className="ph shape-ph" style={{ borderColor: color }}><ShapeGlyph kind={entity.shape ?? 'square'} color={color} stop={entity.stop} /></div>
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
        {onStop && entity.shape === 'arrow' && (
          // the «→|» Stopp-Balken across the arrow tip — arrow-only (Item A2, 29.08.); the
          // line tool's own arrowStop lives in the DrawEditor and stays untouched
          <div className="de-row">
            <span>{appConfig.copy.shapes.stopLabel}</span>
            <button className={`de-toggle ${entity.stop ? 'on' : ''}`} aria-pressed={!!entity.stop} onClick={() => onStop(!entity.stop)}>
              {entity.stop ? appConfig.copy.drawingEditor.on : appConfig.copy.drawingEditor.off}
            </button>
          </div>
        )}
        <div className="de-row de-hint">{appConfig.copy.shapes.rotateHint}</div>
        <div className="ctx-footer-inline">{actions}</div>
      </div>
      {actions}
    </div>
  )
}
