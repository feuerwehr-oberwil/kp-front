import type { Entity } from '../types'
import { Icon } from '../lib/icons'
import { TwinOrigin } from './TwinOrigin'
import { SheetGrip, useSheetDrag } from './SheetGrip'
import { appConfig } from '../config/appConfig'
import { fmtArea, fmtDistance } from '../lib/geo'
import { OnOff, Segmented } from './Segmented'
import { ScaleStepper } from './Stepper'
import { SHAPE_STROKE_DEFAULT, SQUARE_FILL_DEFAULT, ShapeGlyph } from '../lib/shapes'
import { HATCH_PERIOD_PX, HatchDefs, hatchPatternId } from '../lib/draw'
import { DEFAULT_INK } from '../lib/lineStyle'

const COLORS = appConfig.drawing.colors
const WIDTHS = appConfig.drawing.widths
const FILL_OPACITIES = appConfig.drawing.fillOpacities

interface Props {
  // structurally satisfied by a map Entity AND a plan BoardAnno of kind 'shape'
  entity: Pick<Entity, 'shape' | 'color' | 'stop' | 'carrier' | 'sizeM' | 'aspect' | 'strokeW' | 'fillOpacity' | 'hatch' | 'sharpCorners'>
  onColor: (c: string) => void
  /** scale the shape by a factor (>1 bigger, <1 smaller); the parent clamps to its size
   *  space (metres on the map, normalized plan-width on the Plan). The corner drag-handle
   *  stays for tablet/desktop, but on a phone it sits under this sheet — so size lives here.
   *  Scales BOTH axes: the stored size is the width, the height follows via `aspect`. */
  onScale?: (factor: number) => void
  /** Rotation only: how far the shuttle runs. There is no width control and no width handle —
   *  the loop's width follows its length (lib/shapes · rotationBox), so «Länge» is the whole of
   *  a Rotation's size. */
  onScaleLength?: (factor: number) => void
  /** toggle the «→|» Stopp-Balken across the arrow tip — the row only shows for the
   *  arrow kind (the other shapes have no tip to stop at) */
  onStop?: (stop: boolean) => void
  onCarrier?: (carrier: 'heli' | 'tlf' | undefined) => void
  /** Rotation only: turn the circulation sense around (both direction heads mirror in place —
   *  the loop itself never moves), the same «Richtung umkehren» a Linie offers */
  onReverse?: () => void
  /** the outline's weight, in the drawn Fläche's three steps — a Form is a pre-shaped area, so it
   *  is given the area's own control rather than one of its own (lib/shapes · shapeStrokeFactor) */
  onStrokeW?: (w: number) => void
  /** fill, in the Fläche's own two answers: a wash at this opacity (0 = outline only), or the
   *  Schraffur. A Rechteck IS a Fläche that came pre-shaped, so it is asked the same question with
   *  the same control (DrawEditor · the Füllung row). */
  onFill?: (fillOpacity: number, hatch: boolean) => void
  /** Rechteck: square corners instead of the rounded default */
  onCorners?: (sharp: boolean) => void
  /** the shape's ground area / perimeter in m², m — shown the way a Fläche shows its own
   *  (DrawEditor · the Messung block). Map-only: a plan has no metric scale. */
  areaM2?: number | null
  perimeterM?: number | null
  /** the ground box — for a Rechteck this IS its size, not a bounding estimate */
  boxM?: { widthM: number; heightM: number } | null
  /** lock the shape, exactly as a Fläche is locked: the ink goes click-through, the sheet
   *  closes, and the centre LockChip (short hold) is the only way back in */
  onToggleLock?: () => void
  locked?: boolean
  /** fly the map to the shape — map-only; a plan shape is already on screen */
  onCenter?: () => void
  onDelete: () => void
  onClose: () => void
  /** This Form is a Georeferenz twin: the editor is the surface's own, so the ONE thing that
   *  differs — which document persists it — is stated here as the way there (components/TwinOrigin). */
  onOriginal?: () => void
}

// Editor for a placed generic shape — colour only. Size and rotation are changed
// directly on the map/plan by dragging the shape's corner / top handles, so
// they're not duplicated here. Reuses the .ctx / .draw-editor look.
export function ShapeEditor({ entity, onColor, onScale, onScaleLength, onStop, onCarrier, onReverse, onStrokeW, onFill, onCorners, areaM2, boxM, perimeterM, onToggleLock, locked, onCenter, onDelete, onClose, onOriginal }: Props) {
  const color = entity.color ?? DEFAULT_INK
  const name = appConfig.copy.shapes.names[entity.shape ?? 'square'] ?? appConfig.copy.shapes.kindLabel

  // rendered twice: pinned at the sheet bottom on desktop/tablet, and again inside the
  // scrolling body for phones (.ctx-footer-inline) — CSS shows exactly one copy
  const actions = (
    <div className="ctx-actions">
      {onCenter && <button className="btn" onClick={onCenter}><Icon id="cross" />{appConfig.copy.contextPanel.center}</button>}
      {/* the same lock a drawn Fläche has (DrawEditor · onToggleLock): a Rechteck is often the
          Absperrung everything else is drawn on top of, and the thing you must not nudge. */}
      {onToggleLock && (
        <button className="btn" onClick={onToggleLock} title={appConfig.copy.drawingEditor.lockHint} aria-pressed={!!locked}>
          <Icon id="lock" />{appConfig.copy.drawingEditor.lock}
        </button>
      )}
      {onOriginal && <TwinOrigin onOriginal={onOriginal} />}
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
        {/* ⚠️ `fit`, and the shape's OWN aspect (01.09.). Without either, a Rotation's 100×32 loop
            was drawn `preserveAspectRatio="none"` into this square 46px tile — stretched 3× tall,
            so the outline came out three times heavier along the legs than across the ends and the
            direction heads splayed into wedges. That squashed blob was «das hässliche Icon»: the
            artwork was right all along, this one call site just never asked for it to be fitted. */}
        <div className={`ph shape-ph shape-ph-${entity.shape ?? 'square'}`} style={{ borderColor: color }}>
          <ShapeGlyph kind={entity.shape ?? 'square'} color={color} stop={entity.stop}
            aspect={entity.aspect} carrier={entity.carrier} strokeW={entity.strokeW}
            fillOpacity={entity.fillOpacity} hatch={entity.hatch} fit />
        </div>
        <div className="ctx-titlewrap"><h3>{name}</h3><p>{appConfig.copy.shapes.kindLabel}</p></div>
        <button className="ctx-x" onClick={onClose} title={appConfig.copy.closeDialog} aria-label={appConfig.copy.closeDialog}><Icon id="close" /></button>
      </div>
      <div className="ctx-body">
        {/* ⚠️ The rows are GROUPED, the way the Linien-Editor's are (DrawEditor · `.de-group`):
            the hairline falls where the subject changes and nowhere else. Ungrouped, every row
            here ran flush into the Messung block below, so the one rule in the panel appeared
            between «Stopp-Balken» and «Fläche» — where nothing changes — and none appeared
            between the numbers and the Träger row, where everything does. */}
        <div className="de-group">
        {onFill && entity.shape === 'square' && (() => {
          const fillOpacity = entity.fillOpacity ?? SQUARE_FILL_DEFAULT
          return (
            <div className="de-row">
              <span>{appConfig.copy.drawingEditor.fill}</span>
              <span className="dh-swatches">
                {FILL_OPACITIES.map((o) => (
                  <button key={o} className={`dh-color de-fill ${!entity.hatch && Math.abs(fillOpacity - o) < 0.001 ? 'on' : ''}`}
                    title={`${Math.round(o * 100)} %`} aria-label={`${Math.round(o * 100)} %`}
                    style={{ background: o === 0 ? 'transparent' : color, opacity: o === 0 ? 1 : Math.max(0.25, o + 0.2) }}
                    onClick={() => onFill(o, false)}>{o === 0 ? '∅' : ''}</button>
                ))}
                {/* Schraffur is a FILL and shares the row, exactly as it does on a drawn Fläche —
                    «wie ist die Fläche gefüllt» has one answer at a time. */}
                <button className={`dh-color de-fill ${entity.hatch ? 'on' : ''}`}
                  title={appConfig.copy.drawingEditor.fillHatch} aria-label={appConfig.copy.drawingEditor.fillHatch}
                  onClick={() => onFill(fillOpacity, true)}>
                  <svg viewBox={`0 0 ${HATCH_PERIOD_PX * 2} ${HATCH_PERIOD_PX * 2}`} width="100%" height="100%" aria-hidden>
                    <HatchDefs colors={[color]} />
                    <rect width="100%" height="100%" fill={`url(#${hatchPatternId(color)})`} />
                  </svg>
                </button>
              </span>
            </div>
          )
        })()}
        <div className="de-row">
          <span>{appConfig.copy.shapes.color}</span>
          <span className="dh-swatches">
            {COLORS.map((c) => <button key={c} className={`dh-color ${color === c ? 'on' : ''}`} style={{ background: c }} aria-label={c} onClick={() => onColor(c)} />)}
          </span>
        </div>
        {/* ⚠️ The SAME three steps and the same control as a drawn Fläche (DrawEditor · WIDTHS).
            A Form is a pre-shaped area: the operator who has already learnt one line-width picker
            should not meet a second grammar for the same property. */}
        {onStrokeW && (
          <div className="de-row">
            <span>{appConfig.copy.shapes.strokeLabel}</span>
            <span className="dh-widths">
              {WIDTHS.map((w) => (
                <button
                  key={w} className={`dh-width ${(entity.strokeW ?? SHAPE_STROKE_DEFAULT) === w ? 'on' : ''}`}
                  aria-label={`${appConfig.copy.shapes.strokeLabel} ${w}`}
                  onClick={() => onStrokeW(w)}
                ><span style={{ height: w }} /></button>
              ))}
            </span>
          </div>
        )}
        {/* A Rotation has ONE size and it is the run: how far the shuttle goes. Its width follows
            from that (lib/shapes · rotationBox), so it is named «Länge» rather than «Grösse» and
            has no second row. On the canvas the same is true — the two grips are its two ENDS. */}
        {onScale && !(entity.shape === 'rotation' && onScaleLength) && (
          <div className="de-row">
            <span>{appConfig.copy.shapes.size}</span>
            <ScaleStepper onScale={onScale} ariaLabel={appConfig.copy.shapes.size}
              lessLabel={appConfig.copy.shapes.sizeSmaller} moreLabel={appConfig.copy.shapes.sizeBigger} />
          </div>
        )}
        {onScaleLength && entity.shape === 'rotation' && (
          <div className="de-row">
            <span>{appConfig.copy.shapes.lengthLabel}</span>
            <ScaleStepper onScale={onScaleLength} ariaLabel={appConfig.copy.shapes.lengthLabel}
              lessLabel={appConfig.copy.shapes.lengthShorter} moreLabel={appConfig.copy.shapes.lengthLonger} />
          </div>
        )}
        {/* …and the one question only a pre-shaped Fläche has. Segmented, not a toggle: «Rund»
            and «Eckig» are two named answers, neither of which is the absence of the other. */}
        {onCorners && entity.shape === 'square' && (
          <div className="de-row">
            <span>{appConfig.copy.shapes.cornersLabel}</span>
            <Segmented
              value={entity.sharpCorners ? 'sharp' : 'round'}
              onChange={(v) => onCorners(v === 'sharp')}
              options={[
                { value: 'round', label: appConfig.copy.shapes.cornersRound },
                { value: 'sharp', label: appConfig.copy.shapes.cornersSharp },
              ]}
            />
          </div>
        )}
        {onStop && entity.shape === 'arrow' && (
          // the «→|» Stopp-Balken across the arrow tip — arrow-only (Item A2, 29.08.); the
          // line tool's own arrowStop lives in the DrawEditor and stays untouched
          <div className="de-row">
            <span>{appConfig.copy.shapes.stopLabel}</span>
            <OnOff ariaLabel={appConfig.copy.shapes.stopLabel} value={!!entity.stop} onChange={onStop} />
          </div>
        )}
        </div>
        {/* ⚠️ A Rechteck measures itself, exactly as a drawn Fläche does (DrawEditor · the Messung
            block) — same two numbers, same labels, same formatter. Map only: its size is metres on
            the ground there, while on a Plan it is a share of the sheet and has no area to state
            until the plan is scaled. */}
        {areaM2 != null && (
          <div className="de-group">
            <div className="de-conn-title">{appConfig.copy.drawingEditor.measurement}</div>
            <div className="de-row"><span>{appConfig.copy.measure.area}</span>
              <b className="de-measure-v">{fmtArea(areaM2)}</b>
            </div>
            {boxM && (
              <>
                <div className="de-row"><span>{appConfig.copy.measure.boxWidth}</span>
                  <b className="de-measure-v">{fmtDistance(boxM.widthM)}</b>
                </div>
                <div className="de-row"><span>{appConfig.copy.measure.boxHeight}</span>
                  <b className="de-measure-v">{fmtDistance(boxM.heightM)}</b>
                </div>
              </>
            )}
            {perimeterM != null && (
              <div className="de-row"><span>{appConfig.copy.measure.perimeter}</span>
                <b className="de-measure-v">{fmtDistance(perimeterM)}</b>
              </div>
            )}
          </div>
        )}
        {/* what the loop IS, after what it looks like: who runs it, and which way round */}
        {(onCarrier || onReverse) && entity.shape === 'rotation' && <div className="de-group">
        {onCarrier && entity.shape === 'rotation' && (
          // Which vehicle runs the shuttle. The FKS sheet draws the loop WITH its carrier
          // («Rotation-Helikopter», «Rotation TLF», Vegetationsbrand S. 52) — same shape, and the
          // badge in the middle says who. A plain loop stays possible: not every Pendel is one
          // of those two.
          <div className="de-row">
            <span>{appConfig.copy.shapes.carrierLabel}</span>
            <Segmented
              ariaLabel={appConfig.copy.shapes.carrierLabel}
              value={entity.carrier ?? ''}
              onChange={(v) => onCarrier(v === '' ? undefined : (v as 'heli' | 'tlf'))}
              options={[
                { value: '', label: appConfig.copy.shapes.carrierNone },
                { value: 'heli', label: appConfig.copy.shapes.carrierHeli },
                { value: 'tlf', label: appConfig.copy.shapes.carrierTlf },
              ]}
            />
          </div>
        )}
        {onReverse && entity.shape === 'rotation' && (
          // Which way round the shuttle circulates. The same control a Linie offers (DrawEditor ·
          // onReverse), for the same reason: it turns only the direction of travel around — the
          // loop, its two ends and everything beside it stay exactly where they are. An action,
          // so it wears the panel's action row rather than a chip that could look «on».
          <button type="button" className="de-action" onClick={onReverse}>
            <Icon id="swap" />{appConfig.copy.drawingEditor.reverse}
          </button>
        )}
        </div>}
        <div className="ctx-footer-inline">{actions}</div>
      </div>
      {actions}
    </div>
  )
}
