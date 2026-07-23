import { Fragment } from 'react'
import { Icon } from '../lib/icons'
import { SheetGrip } from './SheetGrip'
import { appConfig } from '../config/appConfig'
import { LineStylePicker } from '../lib/draw'
import { fmtDistance } from '../lib/geo'
import { CONTENT_LABELS } from '../lib/lineDecor'
import { floorBadge } from '../lib/symbolRender'
import { Stepper } from './Stepper'
import { Segmented } from './Segmented'
import type { LineAttachment, LineEndpoint, LineRoutingMode } from '../types'

// small glyph for the line-ending picker: plain · arrow · FKS Teilstück "E"-fork
function EndingGlyph({ kind }: { kind: 'none' | 'arrow' | 'teilstueck' }) {
  return (
    <svg width="36" height="14" viewBox="0 0 36 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="2" y1="7" x2={kind === 'none' ? 34 : 24} y2="7" />
      {kind === 'arrow' && <path d="M25 2 L33 7 L25 12" />}
      {kind === 'teilstueck' && (
        <>
          <line x1="25" y1="2" x2="25" y2="12" />
          <line x1="25" y1="2" x2="33" y2="2" />
          <line x1="25" y1="7" x2="33" y2="7" />
          <line x1="25" y1="12" x2="33" y2="12" />
        </>
      )}
    </svg>
  )
}

const COLORS = appConfig.drawing.colors
const WIDTHS = appConfig.drawing.widths

/** The style fields a line/area/circle exposes — model-agnostic so a Lage `Drawing` and a Plan
 *  `BoardAnno` can both drive the SAME editor (callers map their object → these primitives). */
export interface DrawStyle {
  kind: 'line' | 'area' | 'circle' | 'draw'
  color?: string
  width?: number
  dashed?: boolean
  label?: string
  marker?: string
  arrow?: boolean
  showDistance?: boolean
  fillOpacity?: number
  radiusM?: number
  // FKS hose-line annotations
  teilstueck?: boolean
  content?: 'S' | 'W' | 'H' | 'P'
  lineNo?: number
  floorTag?: number
  startAttachment?: LineAttachment
  endAttachment?: LineAttachment
}

interface Props {
  drawing: DrawStyle
  /** how many vertices the shape has, for the header subtitle (circle uses its radius instead) */
  pointCount: number
  /** offer the geodesic distance toggle — Lage only (a Plan has no metric scale) */
  supportsDistance?: boolean
  onPreset: (presetId: string) => void
  onColor: (c: string) => void
  onWidth: (w: number) => void
  onDashed: (dashed: boolean) => void
  onLabel: (label: string) => void
  onMarker: (marker: string) => void
  onArrow: (arrow: boolean) => void
  /** line end: 'none' | 'arrow' | 'teilstueck' (mutually exclusive). Absent ⇒ only the legacy arrow toggle. */
  onEnding?: (ending: 'none' | 'arrow' | 'teilstueck') => void
  /** FKS device letter at the end (S/W/H/P) or undefined for plain Wasser */
  onContent?: (content: 'S' | 'W' | 'H' | 'P' | undefined) => void
  /** Druckleitung number + storey badge on the line (undefined clears) */
  onLineNo?: (lineNo: number | undefined) => void
  onFloorTag?: (floor: number | undefined) => void
  onShowDistance: (showDistance: boolean) => void
  onRadius: (radiusM: number) => void
  onFillOpacity: (fillOpacity: number) => void
  /** lock the shape against accidental moves (it goes click-through; unlock via the centre
   *  lock chip). Absent → the lock control is hidden (e.g. surfaces without locking). */
  onToggleLock?: () => void
  locked?: boolean
  onDelete: () => void
  onClose: () => void
  attachmentLabels?: Partial<Record<LineEndpoint, string>>
  onRouting?: (endpoint: LineEndpoint, mode: LineRoutingMode) => void
  onDetach?: (endpoint: LineEndpoint) => void
  onFocusAttachment?: (endpoint: LineEndpoint) => void
  attachmentHidden?: Partial<Record<LineEndpoint, boolean>>
  onRevealAttachment?: (endpoint: LineEndpoint) => void
}

const FILL_OPACITIES = appConfig.drawing.fillOpacities

export function DrawEditor({ drawing, pointCount, supportsDistance = false, onColor, onWidth, onDashed, onLabel, onMarker, onArrow, onEnding, onContent, onLineNo, onFloorTag, onShowDistance, onRadius, onFillOpacity, onToggleLock, locked, onDelete, onClose, attachmentLabels, onRouting, onDetach, onFocusAttachment, attachmentHidden, onRevealAttachment }: Props) {
  const color = drawing.color ?? '#1f6feb'
  const width = drawing.width ?? 4
  const dashed = !!drawing.dashed
  const isCircle = drawing.kind === 'circle'
  const isArea = drawing.kind === 'area'
  // a freehand stroke (kind 'draw') and a node line (kind 'line') style identically
  const isLine = drawing.kind === 'line' || drawing.kind === 'draw'
  const fillOpacity = drawing.fillOpacity ?? (isCircle ? appConfig.drawing.circleFillOpacity : 0.14)
  const headIcon = isCircle ? 'circle' : isArea ? 'area' : 'pen'
  const headTitle = isCircle ? appConfig.copy.drawingEditor.circle : isArea ? appConfig.copy.drawingEditor.area : appConfig.copy.drawingEditor.drawing
  const headSub = isCircle ? fmtDistance(drawing.radiusM ?? 0) : `${pointCount} ${appConfig.copy.drawingEditor.points}`
  const radiusM = drawing.radiusM ?? 0
  const radStep = appConfig.drawing.circleRadiusStepM
  const radMin = appConfig.drawing.circleMinRadiusM
  // rendered twice: pinned at the sheet bottom on desktop/tablet, and again inside the
  // scrolling body for phones (.ctx-footer-inline) — CSS shows exactly one copy
  const actions = (
    <div className="ctx-actions">
      {onToggleLock && (
        <button className="btn" onClick={onToggleLock} title={appConfig.copy.drawingEditor.lockHint} aria-pressed={!!locked}>
          <Icon id="lock" />{appConfig.copy.drawingEditor.lock}
        </button>
      )}
      <button className="btn warn" onClick={onDelete}><Icon id="close" />{appConfig.copy.delete}</button>
    </div>
  )
  return (
    <div className="ctx draw-editor">
      <SheetGrip onClose={onClose} />
      <div className="ctx-head">
        <div className="ph" style={{ borderColor: color, color }}><Icon id={headIcon} /></div>
        <div className="ctx-titlewrap"><h3>{headTitle}</h3><p>{headSub}</p></div>
        <button className="ctx-x" onClick={onClose} title={appConfig.copy.closeDialog} aria-label={appConfig.copy.closeDialog}><Icon id="close" /></button>
      </div>
      <div className="ctx-body">
        {/* shape group — radius (circle) + fill (circle/area) */}
        {(isCircle || isArea) && (
          <div className="de-group">
            {isCircle && (
              <div className="de-row"><span>{appConfig.copy.drawingEditor.radius}</span>
                <Stepper value={radiusM} min={radMin} max={100000} step={radStep} format={fmtDistance}
                  onChange={onRadius} ariaLabel={appConfig.copy.drawingEditor.radius} />
              </div>
            )}
            <div className="de-row"><span>{appConfig.copy.drawingEditor.fill}</span>
              <span className="dh-swatches">
                {FILL_OPACITIES.map((o) => (
                  <button key={o} className={`dh-color de-fill ${Math.abs(fillOpacity - o) < 0.001 ? 'on' : ''}`}
                    title={`${Math.round(o * 100)} %`} aria-label={`${Math.round(o * 100)} %`}
                    style={{ background: o === 0 ? 'transparent' : color, opacity: o === 0 ? 1 : Math.max(0.25, o + 0.2) }}
                    onClick={() => onFillOpacity(o)}>{o === 0 ? '∅' : ''}</button>
                ))}
              </span>
            </div>
          </div>
        )}

        {/* style group — Farbe · Stärke · Linie */}
        <div className="de-group">
          <div className="de-row"><span>{appConfig.copy.drawingEditor.color}</span>
            <span className="dh-swatches">
              {COLORS.map((c) => <button key={c} className={`dh-color ${color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => onColor(c)} />)}
            </span>
          </div>
          <div className="de-row"><span>{appConfig.copy.drawingEditor.width}</span>
            <span className="dh-widths">
              {WIDTHS.map((w) => <button key={w} className={`dh-width ${width === w ? 'on' : ''}`} onClick={() => onWidth(w)}><span style={{ height: w }} /></button>)}
            </span>
          </div>
          {isLine && (
            <div className="de-row"><span>{appConfig.copy.drawingEditor.lineStyle}</span>
              <span className="dh-widths">
                <LineStylePicker dashed={dashed} onChange={onDashed} />
              </span>
            </div>
          )}
        </div>

        {/* text group — Text · Marker */}
        {(isLine || isArea) && (
          <div className="de-group">
            <div className="de-row"><span>{appConfig.copy.drawingEditor.label}</span>
              <input className="de-input" value={drawing.label ?? ''} placeholder={isArea ? appConfig.copy.drawingEditor.areaLabelPlaceholder : appConfig.copy.drawingEditor.labelPlaceholder} onChange={(e) => onLabel(e.target.value)} />
            </div>
            {isLine && (
              <div className="de-row"><span>{appConfig.copy.drawingEditor.marker}</span>
                <input className="de-input de-input-short" value={drawing.marker ?? ''} placeholder={appConfig.copy.drawingEditor.markerPlaceholder} maxLength={3} onChange={(e) => onMarker(e.target.value)} />
              </div>
            )}
          </div>
        )}

        {/* FKS line group — Abschluss · Inhalt · Leitung-Nr · Stockwerk · Länge */}
        {isLine && (
          <div className="de-group">
            {onEnding ? (
              <div className="de-row"><span>{appConfig.copy.drawingEditor.ending}</span>
                <Segmented
                  ariaLabel={appConfig.copy.drawingEditor.ending}
                  value={drawing.teilstueck ? 'teilstueck' : drawing.arrow ? 'arrow' : 'none'}
                  onChange={onEnding}
                  options={[
                    { value: 'none', label: <EndingGlyph kind="none" />, title: appConfig.copy.drawingEditor.endingNone },
                    { value: 'arrow', label: <EndingGlyph kind="arrow" />, title: appConfig.copy.drawingEditor.endingArrow },
                    { value: 'teilstueck', label: <EndingGlyph kind="teilstueck" />, title: appConfig.copy.drawingEditor.endingTeilstueck },
                  ]}
                />
              </div>
            ) : (
              <div className="de-row"><span>{appConfig.copy.drawingEditor.arrow}</span>
                <span className="dh-widths">
                  <button className={`de-toggle ${drawing.arrow ? 'on' : ''}`} aria-pressed={!!drawing.arrow} onClick={() => onArrow(!drawing.arrow)}>{drawing.arrow ? appConfig.copy.drawingEditor.on : appConfig.copy.drawingEditor.off}</button>
                </span>
              </div>
            )}
            {onContent && (
              <div className="de-row"><span>{appConfig.copy.drawingEditor.content}</span>
                <span className="de-presets">
                  <button className={`de-preset ${!drawing.content ? 'on' : ''}`} title={appConfig.copy.drawingEditor.contentPlain} onClick={() => onContent(undefined)}>{appConfig.copy.drawingEditor.contentPlain}</button>
                  {(['S', 'W', 'H', 'P'] as const).map((c) => (
                    <button key={c} className={`de-preset ${drawing.content === c ? 'on' : ''}`} title={CONTENT_LABELS[c]} onClick={() => onContent(c)}>{c}</button>
                  ))}
                </span>
              </div>
            )}
            {onLineNo && (
              <div className="de-row"><span>{appConfig.copy.drawingEditor.lineNo}</span>
                <Stepper value={drawing.lineNo ?? null} min={1} max={99} placeholder="–"
                  onChange={(v) => onLineNo(v)} onClear={() => onLineNo(undefined)} canClear={drawing.lineNo != null}
                  ariaLabel={appConfig.copy.drawingEditor.lineNo} />
              </div>
            )}
            {onFloorTag && (
              <div className="de-row"><span>{appConfig.copy.drawingEditor.floorTag}</span>
                <Stepper value={drawing.floorTag ?? null} min={-9} max={40} seed={0} format={floorBadge} placeholder="–"
                  onChange={(v) => onFloorTag(v)} onClear={() => onFloorTag(undefined)} canClear={drawing.floorTag != null}
                  ariaLabel={appConfig.copy.drawingEditor.floorTag} />
              </div>
            )}
            {supportsDistance && (
              <div className="de-row"><span>{appConfig.copy.drawingEditor.distance}</span>
                <span className="dh-widths">
                  <button className={`de-toggle ${drawing.showDistance ? 'on' : ''}`} aria-pressed={!!drawing.showDistance} onClick={() => onShowDistance(!drawing.showDistance)}>{drawing.showDistance ? appConfig.copy.drawingEditor.on : appConfig.copy.drawingEditor.off}</button>
                </span>
              </div>
            )}
          </div>
        )}
        {isLine && (drawing.startAttachment || drawing.endAttachment) && (
          <div className="de-group de-connections">
            <div className="de-conn-title">{appConfig.copy.drawingEditor.connections}</div>
            {(['start', 'end'] as const).map((endpoint) => {
              const a = endpoint === 'start' ? drawing.startAttachment : drawing.endAttachment
              if (!a) return null
              const gps = a.gps?.state, hidden = !!attachmentHidden?.[endpoint]
              const name = attachmentLabels?.[endpoint] ?? a.target.id
              const note = gps === 'continuous' ? appConfig.copy.drawingEditor.gpsFollowing
                : gps === 'paused' ? appConfig.copy.drawingEditor.gpsMovingAway
                : hidden ? appConfig.copy.drawingEditor.hiddenTarget : null
              return <Fragment key={endpoint}>
                {/* endpoint → target: same de-row as the FKS rows above; the value taps to fly there */}
                <div className="de-row"><span>{endpoint === 'start' ? appConfig.copy.drawingEditor.connectedStart : appConfig.copy.drawingEditor.connectedEnd}</span>
                  <button type="button" className="de-conn-name" onClick={onFocusAttachment ? () => onFocusAttachment(endpoint) : undefined} disabled={!onFocusAttachment}>
                    <span>{name}</span>{onFocusAttachment && <span className="de-conn-go" aria-hidden>›</span>}
                  </button>
                </div>
                {note && <div className={`de-conn-note${gps === 'paused' ? ' warn' : ''}`}>
                  <span>{note}</span>
                  {hidden && onRevealAttachment && <button type="button" className="de-conn-reveal" onClick={() => onRevealAttachment(endpoint)}>{appConfig.copy.drawingEditor.revealTarget}</button>}
                </div>}
                {onRouting && (
                  <div className="de-row"><span>{appConfig.copy.drawingEditor.route}</span>
                    <span className="de-presets">
                      {gps === 'paused'
                        ? <button className="de-preset" onClick={() => onRouting(endpoint, 'trace')}>{appConfig.copy.drawingEditor.gpsContinue}</button>
                        : gps === 'continuous'
                        ? <button className="de-preset on" onClick={() => onRouting(endpoint, 'direct')}>{appConfig.copy.drawingEditor.gpsPause}</button>
                        : <>
                            <button className={`de-preset ${a.routing === 'direct' ? 'on' : ''}`} onClick={() => onRouting(endpoint, 'direct')}>{appConfig.copy.drawingEditor.routeDirect}</button>
                            <button className={`de-preset ${a.routing === 'trace' ? 'on' : ''}`} onClick={() => onRouting(endpoint, 'trace')}>{appConfig.copy.drawingEditor.routeTrace}</button>
                          </>}
                    </span>
                  </div>
                )}
                {onDetach && <button type="button" className="de-conn-detach" onClick={() => onDetach(endpoint)}>{gps === 'paused' ? appConfig.copy.drawingEditor.gpsDetachHere : appConfig.copy.drawingEditor.detachConnection}</button>}
              </Fragment>
            })}
          </div>
        )}
        <div className="ctx-footer-inline">{actions}</div>
      </div>
      {actions}
    </div>
  )
}
