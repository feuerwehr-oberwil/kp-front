import { Fragment, useState } from 'react'
import { Icon } from '../lib/icons'
import { TwinOrigin } from './TwinOrigin'
import { SheetGrip, useSheetDrag } from './SheetGrip'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { HATCH_CHIP_VB, HatchDefs, LineStylePicker, hatchPatternId } from '../lib/draw'
import { DEFAULT_INK, markerGlyph } from '../lib/lineStyle'
import { fmtDistance, fmtArea, hoseCount } from '../lib/geo'
import { CONTENT_LABELS } from '../lib/lineDecor'
import { floorBadge } from '../lib/symbolRender'
import { useLineProfile } from '../lib/useLineProfile'
import { ProfileChart, ProfileStats } from './ProfileChart'
import { Stepper } from './Stepper'
import { MenuPick } from './MenuPick'
import { Menu } from '../lib/overlays'
import { OnOff, Segmented } from './Segmented'
import type { LineAttachment, LineContent, LineEndpoint, LngLat, LineRoutingMode } from '../types'

// small glyph for the line-ending picker: plain · arrow · arrow with Entwicklungsgrenze · FKS
// Teilstück "E"-fork.
// ⚠️ Both arrows are the MAP's own arrowhead (MapView · the `draw-arrow` / `draw-arrow-stop` SDF
// sprite) scaled into this box: a FILLED, notched head and a SOLID bar just past the tip, in the
// sprite's proportions — the bar is ~1/7 of the head's length thick and spans ~9/10 of its width.
// Sketched as an outlined chevron with a hairline tick, the preview promised something far
// lighter than the Lage actually draws; a picker has to show the picture it will make.
function EndingGlyph({ kind }: { kind: 'none' | 'arrow' | 'arrowStop' | 'teilstueck' }) {
  // ⚠️ 24px wide, not 36 (01.09.). The shaft is not the subject — the END is, and four long lines
  // side by side made the Abschluss row twice as wide as anything else in the panel while saying
  // nothing extra. The stub is just enough to show WHICH end the decoration is on.
  const tip = kind === 'arrowStop' ? 19.4 : 23
  const base = tip - 13     // head length — unchanged, it is the thing being chosen
  const notch = tip - 10.1  // the concave tail
  const shaftEnd = kind === 'none' ? 22 : kind === 'teilstueck' ? 12 : base + 1
  return (
    <svg width="24" height="14" viewBox="0 0 24 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="2" y1="7" x2={shaftEnd} y2="7" />
      {(kind === 'arrow' || kind === 'arrowStop') && (
        <path d={`M${tip},7 L${base},0.5 L${notch},7 L${base},13.5 Z`} fill="currentColor" stroke="none" />
      )}
      {kind === 'arrowStop' && <rect x="21.2" y="1.2" width="1.8" height="11.6" fill="currentColor" stroke="none" />}
      {kind === 'teilstueck' && (
        <>
          <line x1="13" y1="2" x2="13" y2="12" />
          <line x1="13" y1="2" x2="21" y2="2" />
          <line x1="13" y1="7" x2="21" y2="7" />
          <line x1="13" y1="12" x2="21" y2="12" />
        </>
      )}
    </svg>
  )
}

const COLORS = appConfig.drawing.colors
const WIDTHS = appConfig.drawing.widths
const LINE_PRESETS = appConfig.drawing.linePresets

/** Which preset a line currently wears. The bundles differ only in the arrowhead and the
 *  repeated marker letter (Freihand: neither · Pfeil: arrow · Rettungsachse: arrow + «R»), so
 *  those two fields identify one unambiguously. A hand-tuned line matches none — then no chip
 *  lights, which is honest: the line is not «a Rettungsachse», it is its own thing. */
function matchLinePreset(arrow?: boolean, marker?: string) {
  return LINE_PRESETS.find((p) => !!p.defaults.arrow === !!arrow && (p.defaults.marker ?? '') === (marker ?? ''))?.id
}

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
  arrowStop?: boolean
  showDistance?: boolean
  fillOpacity?: number
  hatch?: boolean
  radiusM?: number
  // FKS hose-line annotations
  teilstueck?: boolean
  content?: LineContent
  lineNo?: number
  floorTag?: number
  /** the Atemschutz link anchor (Drawing/BoardAnno · truppId) */
  truppId?: string
  startAttachment?: LineAttachment
  endAttachment?: LineAttachment
}

interface Props {
  drawing: DrawStyle
  /** how many vertices the shape has, for the header subtitle (circle uses its radius instead) */
  pointCount: number
  /** read-only surface (viewer role, Führungsansicht, replay): keep everything that
   *  ANSWERS a question — Messung, Höhenprofil, Verbindungen, «springe zu» — and drop every
   *  control that would change the shape. The EL must be able to ask how long the Leitung is
   *  without being able to move it. */
  readOnly?: boolean
  /** area + perimeter of an area/circle, so the Messung section states what the shape covers
   *  (a line uses `lengthM` instead). Absent → the rows are omitted. */
  areaM2?: number | null
  /** the ground box the outline occupies (lib/geo · bboxSizeM) — «wie breit ist das» about a
   *  Brandzone, asked against the map it is drawn on */
  boxM?: { widthM: number; heightM: number } | null
  perimeterM?: number | null
  /** offer the geodesic distance toggle — Lage only (a Plan has no metric scale) */
  supportsDistance?: boolean
  /** measured length of the selected line, so the Messung section can state it without the
   *  operator re-drawing it with the Messen tool. Lage passes the geodesic length, Plan the
   *  calibrated one; null/absent (uncalibrated plan, area, circle) hides the section. */
  lengthM?: number | null
  /** WGS84 path of the line, enabling the swisstopo Höhenprofil inside the Messung section.
   *  Omitted on the Plan — a building plan has no height data. */
  profileCoords?: LngLat[] | null
  onPreset: (presetId: string) => void
  onColor: (c: string) => void
  onWidth: (w: number) => void
  onDashed: (dashed: boolean) => void
  /** live, per keystroke — silent (see useMapDrawing · patchDrawingLabelLive) */
  onLabel: (label: string) => void
  /** blur/Enter: the one Verlauf row and the one undo step for the whole edit */
  onLabelCommit?: (label: string) => void
  onMarker: (marker: string) => void
  onArrow: (arrow: boolean) => void
  /** line end: 'none' | 'arrow' | 'teilstueck' (mutually exclusive). Absent ⇒ only the legacy arrow toggle. */
  onEnding?: (ending: 'none' | 'arrow' | 'arrowStop' | 'teilstueck') => void
  /** reverse the point order, so the Abschluss sits at the other end. Absent ⇒ the row is hidden. */
  onReverse?: () => void
  /** FKS device letter at the end (S/W/H/P) or undefined for plain Wasser */
  onContent?: (content: LineContent | undefined) => void
  /** Druckleitung number + storey badge on the line (undefined clears) */
  onLineNo?: (lineNo: number | undefined) => void
  onFloorTag?: (floor: number | undefined) => void
  /** link this hose to an Atemschutz-Trupp (undefined unlinks). Omitted ⇒ the row is hidden. */
  onTrupp?: (truppId: string | undefined) => void
  /** Trupps offerable in that picker (the ones still in — a Trupp that is out gets no new line) */
  trupps?: { id: string; name: string }[]
  /** the Trupp actually ON this Leitung (anchor OR number), for the «zeigen» jump. Separate from
   *  `drawing.truppId`: a Trupp matched by number alone is just as real a link. */
  truppOnLine?: string
  /** that Trupp is already out. It STAYS named here — it is the record of who worked this
   *  Leitung until someone takes it over — and reads as «draussen» rather than as the crew
   *  currently on the hose. (It is deliberately absent from the picker list: a Trupp that is out
   *  gets no new Leitung, so it can only be left as it is or replaced.) */
  truppOnLineOut?: boolean
  /** jump to the Atemschutz board for that Trupp */
  onShowTrupp?: () => void
  /** Leitung numbers already taken on THIS surface, so a duplicate can be flagged as it happens */
  usedLineNos?: number[]
  onShowDistance: (showDistance: boolean) => void
  onRadius: (radiusM: number) => void
  onFillOpacity: (fillOpacity: number) => void
  /** pick the fill KIND: hatched, or a flat wash at `fillOpacity`. One row, one answer. */
  onHatch?: (hatch: boolean, fillOpacity: number) => void
  /** lock the shape against accidental moves (it goes click-through; unlock via the centre
   *  lock chip). Absent → the lock control is hidden (e.g. surfaces without locking). */
  onToggleLock?: () => void
  locked?: boolean
  onDelete: () => void
  onClose: () => void
  /** This object is a Georeferenz twin: the editor is the surface's own, so the ONE thing that
   *  differs — which document persists it — is stated here as the way there (components/TwinOrigin). */
  onOriginal?: () => void
  attachmentLabels?: Partial<Record<LineEndpoint, string>>
  onRouting?: (endpoint: LineEndpoint, mode: LineRoutingMode) => void
  onDetach?: (endpoint: LineEndpoint) => void
  onFocusAttachment?: (endpoint: LineEndpoint) => void
  attachmentHidden?: Partial<Record<LineEndpoint, boolean>>
  onRevealAttachment?: (endpoint: LineEndpoint) => void
}

const FILL_OPACITIES = appConfig.drawing.fillOpacities

export function DrawEditor({ drawing, pointCount, readOnly = false, areaM2, boxM, perimeterM, supportsDistance = false, lengthM, profileCoords, onPreset, onColor, onWidth, onDashed, onLabel, onLabelCommit, onMarker, onArrow, onEnding, onReverse, onContent, onLineNo, onFloorTag, onTrupp, trupps = [], truppOnLine, truppOnLineOut = false, onShowTrupp, usedLineNos = [], onShowDistance, onRadius, onFillOpacity, onHatch, onToggleLock, locked, onDelete, onClose, onOriginal, attachmentLabels, onRouting, onDetach, onFocusAttachment, attachmentHidden, onRevealAttachment }: Props) {
  const color = drawing.color ?? DEFAULT_INK
  const width = drawing.width ?? 4
  const dashed = !!drawing.dashed
  const isCircle = drawing.kind === 'circle'
  const isArea = drawing.kind === 'area'
  // a freehand stroke (kind 'draw') and a node line (kind 'line') style identically
  const isLine = drawing.kind === 'line' || drawing.kind === 'draw'
  const activePreset = matchLinePreset(drawing.arrow, drawing.marker)
  const fillOpacity = drawing.fillOpacity ?? (isCircle ? appConfig.drawing.circleFillOpacity : 0.14)
  const headIcon = isCircle ? 'circle' : isArea ? 'area' : 'pen'
  const headTitle = isCircle ? appConfig.copy.drawingEditor.circle : isArea ? appConfig.copy.drawingEditor.area : appConfig.copy.drawingEditor.drawing
  // ⚠️ A circle states its RADIUS instead of a point count — and only when the surface can put a
  // number on it. On an uncalibrated Kroki `radiusM` is absent (the sheet has no metric scale
  // yet), and «0 m» would be a lie about a ring that is plainly there: the subtitle and the
  // stepper below simply stay away, and the ring's own grip sizes it until the Maßstab is set.
  const hasRadius = isCircle && drawing.radiusM != null
  const headSub = isCircle ? (hasRadius ? fmtDistance(drawing.radiusM!) : '') : `${pointCount} ${appConfig.copy.drawingEditor.points}`
  const radiusM = drawing.radiusM ?? 0
  const radStep = appConfig.drawing.circleRadiusStepM
  const radMin = appConfig.drawing.circleMinRadiusM
  // Messung on an ALREADY DRAWN line: the length is free (it comes from the geometry), the
  // Höhenprofil costs a swisstopo request — so it stays collapsed and only fetches once opened,
  // which also keeps a tap on a line offline-silent.
  const [profileOpen, setProfileOpen] = useState(false)
  const hasProfileCoords = isLine && !!profileCoords && profileCoords.length >= 2
  const { profile, loading: profileLoading } = useLineProfile(profileCoords ?? [], hasProfileCoords && profileOpen)
  // rendered twice: pinned at the sheet bottom on desktop/tablet, and again inside the
  // scrolling body for phones (.ctx-footer-inline) — CSS shows exactly one copy
  const actions = readOnly ? null : (
    <div className="ctx-actions">
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
        <div className="ph" style={{ borderColor: color, color }}><Icon id={headIcon} /></div>
        <div className="ctx-titlewrap"><h3>{headTitle}</h3>{headSub && <p>{headSub}</p>}</div>
        <button className="ctx-x" onClick={onClose} title={appConfig.copy.closeDialog} aria-label={appConfig.copy.closeDialog}><Icon id="close" /></button>
      </div>
      <div className="ctx-body">
        {/* shape group — the circle's radius. ⚠️ Füllung is NOT here any more (01.09.): it sat in
            its own group directly above Farbe, so a hairline was drawn between the two rows that
            answer the same question — what colour is this thing and how solid. They belong to one
            block, and the rule now falls where the subject actually changes. */}
        {!readOnly && hasRadius && (
          <div className="de-group">
            <div className="de-row"><span>{appConfig.copy.drawingEditor.radius}</span>
              <Stepper value={radiusM} min={radMin} max={100000} step={radStep} format={fmtDistance}
                onChange={onRadius} ariaLabel={appConfig.copy.drawingEditor.radius} />
            </div>
          </div>
        )}

        {/* style group — Füllung · Stil · Farbe · Stärke · Linie */}
        {!readOnly && <div className="de-group">
          {(isCircle || isArea) && (
            <div className="de-row"><span>{appConfig.copy.drawingEditor.fill}</span>
              <span className="dh-swatches">
                {FILL_OPACITIES.map((o) => (
                  <button key={o} className={`dh-color de-fill ${!drawing.hatch && Math.abs(fillOpacity - o) < 0.001 ? 'on' : ''}`}
                    title={`${Math.round(o * 100)} %`} aria-label={`${Math.round(o * 100)} %`}
                    style={{ background: o === 0 ? 'transparent' : color, opacity: o === 0 ? 1 : Math.max(0.25, o + 0.2) }}
                    onClick={() => onHatch?.(false, o)}>{o === 0 ? '∅' : ''}</button>
                ))}
                {/* Schraffur is a FILL, so it belongs in this row and not in a control of its own —
                    «wie ist die Fläche gefüllt» has one answer at a time. The swatch shows the
                    real pattern, in the shape's own colour (lib/draw · HatchDefs). */}
                {onHatch && (
                  <button className={`dh-color de-fill ${drawing.hatch ? 'on' : ''}`}
                    title={appConfig.copy.drawingEditor.fillHatch} aria-label={appConfig.copy.drawingEditor.fillHatch}
                    onClick={() => onHatch(true, fillOpacity)}>
                    {/* ⚠️ a CIRCLE, and three tile widths of viewBox. A square rect at the real
                        period drew one diagonal across a 30px chip and let it out past the round
                        border — the swatch read as a «no» slash, not as a Schraffur (02.09.). */}
                    <svg viewBox={`0 0 ${HATCH_CHIP_VB} ${HATCH_CHIP_VB}`} width="100%" height="100%" aria-hidden>
                      <HatchDefs colors={[color]} />
                      <circle cx={HATCH_CHIP_VB / 2} cy={HATCH_CHIP_VB / 2} r={HATCH_CHIP_VB / 2} fill={`url(#${hatchPatternId(color)})`} />
                    </svg>
                  </button>
                )}
              </span>
            </div>
          )}
          {/* ⚠️ The line presets live HERE and nowhere else — both docks deleted their own picker
              on the promise that the style is chosen in the post-draw editor (WbControls · the
              Plan's Zeichnen dock). `onPreset` was declared, passed by both surfaces, and then
              never destructured, so for a while «Rettungsachse» was three manual fields nobody
              would find at 3am. The chips are the ONE way in, on both surfaces. */}
          {isLine && (
            <div className="de-row"><span>{appConfig.copy.drawingEditor.preset}</span>
              <span className="de-presets">
                {LINE_PRESETS.map((p) => (
                  <button key={p.id} className={`de-preset ${activePreset === p.id ? 'on' : ''}`} title={p.label} onClick={() => onPreset(p.id)}>{p.label}</button>
                ))}
              </span>
            </div>
          )}
          <div className="de-row"><span>{appConfig.copy.drawingEditor.color}</span>
            <span className="dh-swatches">
              {/* named like the Form editor's identical rows (ShapeEditor · the Farbe/Strichstärke
                  swatches): a chip whose whole content is a colour or a bar has no text to read
                  out, so without this the row announces «Farbe» and then four blank buttons. */}
              {COLORS.map((c) => <button key={c} className={`dh-color ${color === c ? 'on' : ''}`} style={{ background: c }} aria-label={c} onClick={() => onColor(c)} />)}
            </span>
          </div>
          <div className="de-row"><span>{appConfig.copy.drawingEditor.width}</span>
            <span className="dh-widths">
              {WIDTHS.map((w) => <button key={w} className={`dh-width ${width === w ? 'on' : ''}`} aria-label={`${appConfig.copy.drawingEditor.width} ${w}`} onClick={() => onWidth(w)}><span style={{ height: w }} /></button>)}
            </span>
          </div>
          {isLine && (
            <div className="de-row"><span>{appConfig.copy.drawingEditor.lineStyle}</span>
              <span className="dh-widths">
                {/* the chains belong to the STROKE, so they sit here with solid and dashed — the
                    letter field below stays the letter field (lib/draw · LineStylePicker) */}
                <LineStylePicker dashed={dashed} onChange={onDashed} marker={drawing.marker} onMarker={onMarker} />
              </span>
            </div>
          )}
        </div>}

        {/* read-only: the shape's own text is the one style field worth stating — it names the
            thing («Sektor A»), and on a small marker the map label can be hard to read. */}
        {readOnly && (drawing.label ?? '').trim() && (
          <div className="de-group">
            <div className="de-row"><span>{appConfig.copy.drawingEditor.label}</span>
              <b className="de-measure-v">{drawing.label}</b>
            </div>
          </div>
        )}

        {/* text group — Text · Marker */}
        {!readOnly && (isLine || isArea) && (
          <div className="de-group">
            <div className="de-row"><span>{appConfig.copy.drawingEditor.label}</span>
              <input className="de-input" value={drawing.label ?? ''}
                placeholder={isArea ? appConfig.copy.drawingEditor.areaLabelPlaceholder : appConfig.copy.drawingEditor.labelPlaceholder}
                onChange={(e) => onLabel(e.target.value)}
                // ⚠️ the Verlauf row is written HERE, not on every keystroke: naming a Fläche
                // «Sicherung» used to leave eleven rows, one per letter (see useMapDrawing).
                onBlur={(e) => onLabelCommit?.(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
            </div>
            {isLine && (
              <div className="de-row"><span>{appConfig.copy.drawingEditor.marker}</span>
                {/* a chain style lives in the same field, so it would otherwise show up here as a
                    stray «▲» in a box the operator is meant to type a letter into */}
                <input className="de-input de-input-short" value={markerGlyph(drawing.marker) ? '' : (drawing.marker ?? '')} placeholder={appConfig.copy.drawingEditor.markerPlaceholder} maxLength={3} onChange={(e) => onMarker(e.target.value)} />
              </div>
            )}
          </div>
        )}

        {/* FKS line group — Abschluss · Inhalt · Leitung-Nr · Stockwerk · Länge */}
        {!readOnly && isLine && (
          <div className="de-group">
            {onEnding ? (
              <div className="de-row"><span>{appConfig.copy.drawingEditor.ending}</span>
                <Segmented
                  ariaLabel={appConfig.copy.drawingEditor.ending}
                  value={drawing.teilstueck ? 'teilstueck' : drawing.arrow ? (drawing.arrowStop ? 'arrowStop' : 'arrow') : 'none'}
                  onChange={onEnding}
                  // ⚠️ `explain`, like the Typ letters below (data-holdexplain): four pictures whose
                  // NAMES were all a hold ever gave, and the names are the least of it — «Pfeil mit
                  // Stopp» is the Entwicklungsgrenze, and deleting a Teilstück releases every line
                  // docked to its ports. Hold (touch) or hover (mouse) now answers with the
                  // consequence instead. No `title`: the native tooltip would say it again.
                  explain
                  options={[
                    { value: 'none', label: <EndingGlyph kind="none" />, title: appConfig.copy.drawingEditor.endingNoneWhat },
                    { value: 'arrow', label: <EndingGlyph kind="arrow" />, title: appConfig.copy.drawingEditor.endingArrowWhat },
                    { value: 'arrowStop', label: <EndingGlyph kind="arrowStop" />, title: appConfig.copy.drawingEditor.endingArrowStopWhat },
                    { value: 'teilstueck', label: <EndingGlyph kind="teilstueck" />, title: appConfig.copy.drawingEditor.endingTeilstueckWhat },
                  ]}
                />
              </div>
            ) : (
              <div className="de-row"><span>{appConfig.copy.drawingEditor.arrow}</span>
                <OnOff ariaLabel={appConfig.copy.drawingEditor.arrow} value={!!drawing.arrow} onChange={onArrow} />
              </div>
            )}
            {/* Which end the Abschluss sits at is the second half of the same question — so it sits
                in the same row block, directly under it. It does not MOVE the line: the drawn hose
                stays where it is, only its direction of travel turns around (lib/lineAttachments ·
                flipLine), and everything hooked to either end stays hooked where it physically is. */}
            {/* ⚠️ An ACTION, not a state — so it is not one of this panel's Segmented pairs and
                no longer wears their chrome (01.09.). It used to sit as a label plus a lone icon
                chip in the `.de-toggle` box, which reads as «umkehren: on/off» while nothing here
                is ever on: the row is one press that does one thing. */}
            {onReverse && (
              <button type="button" className="de-action" onClick={onReverse}>
                <Icon id="swap" />{appConfig.copy.drawingEditor.reverse}
              </button>
            )}
            {onContent && (
              <div className="de-row"><span>{appConfig.copy.drawingEditor.content}</span>
                <span className="de-presets">
                  <button className={`de-preset ${!drawing.content ? 'on' : ''}`} title={appConfig.copy.drawingEditor.contentPlain} onClick={() => onContent(undefined)}>{appConfig.copy.drawingEditor.contentPlain}</button>
                  {/* W = Wasser, and that is the default chip on the left — a Druckleitung with no
                      letter IS a water line, so W never needed a chip of its own. S/H/P are the
                      ends that are worth marking. Lines already stored with content 'W' keep it.
                      N/T/G are the Vegetationsbrand-Haltelinien (nass · trocken · Gegenfeuer): the
                      same question about a different line, so they sit in the same row rather than
                      in a second control nobody would look for. */}
                  {(['S', 'H', 'P', 'N', 'T', 'G'] as const).map((c) => (
                    // `data-holdexplain`: the letter IS the label, and it explains nothing to
                    // somebody who never learned the sheet. Hold it (touch) or hover it (mouse)
                    // and lib/holdTooltip answers with the word — ⚠️ deliberately NO `title`, or
                    // the native tooltip would arrive a second later and say it twice.
                    <button key={c} data-holdexplain className={`de-preset ${drawing.content === c ? 'on' : ''}`}
                      aria-label={CONTENT_LABELS[c]} onClick={() => onContent(c)}>{c}</button>
                  ))}
                </span>
              </div>
            )}
            {/* `seedOnDec`: a Leitung goes into a Keller as often as up a Treppe, so the first tap
                on − seeds EG (0) exactly like +, and the next − is −1. Same stepper as the
                Geschoss rows in the symbol panel (ContextPanel). */}
            {onFloorTag && (
              <div className="de-row"><span>{appConfig.copy.drawingEditor.floorTag}</span>
                <Stepper value={drawing.floorTag ?? null} min={-9} max={40} seed={0} seedOnDec format={floorBadge} placeholder="–"
                  onChange={(v) => onFloorTag(v)} onClear={() => onFloorTag(undefined)} canClear={drawing.floorTag != null}
                  ariaLabel={appConfig.copy.drawingEditor.floorTag} />
              </div>
            )}
            {onLineNo && (
              <div className="de-row"><span>{appConfig.copy.drawingEditor.lineNo}</span>
                <Stepper value={drawing.lineNo ?? null} min={1} max={99} placeholder="–"
                  onChange={(v) => onLineNo(v)} onClear={() => onLineNo(undefined)} canClear={drawing.lineNo != null}
                  ariaLabel={appConfig.copy.drawingEditor.lineNo} />
              </div>
            )}
            {/* A second «Leitung 1» on the same surface makes the number ambiguous — and the number
                is what an Atemschutz-Trupp is matched on. Warn rather than refuse: a real incident
                sometimes needs the wrong thing typed for a moment. */}
            {onLineNo && drawing.lineNo != null && usedLineNos.includes(drawing.lineNo) && (
              <p className="de-warn"><Icon id="warn" /><span>{fillTemplate(appConfig.copy.drawingEditor.lineNoDuplicate, { n: String(drawing.lineNo) })}</span></p>
            )}
            {/* «Gehört zu Trupp …» — the other direction of the Atemschutz link, for when the hose
                is drawn AFTER the Trupp was registered. Picking one stamps the Leitung number too
                (see useTruppActions · linkTruppLine), so the two sides always agree. Picker AND
                jump in one row: as two rows it printed the same name twice under a hairline.
                Order of the three: Stockwerk (where), Leitung (which), Trupp (who). */}
            {onTrupp && trupps.length > 0 && (
              <div className="de-row"><span>{appConfig.copy.drawingEditor.trupp}</span>
                <span className="de-trupp">
                  {/* the app's own menu, not a native <select>: a system dropdown lands with macOS
                      chrome in the middle of a panel that is otherwise all ours, and on a tablet it
                      opens the OS picker sheet. Base UI gives us the keyboard nav + flip-up for free. */}
                  <Menu
                    trigger={
                      <button className="de-menu-trigger" aria-label={appConfig.copy.drawingEditor.trupp}>
                        {/* an out Trupp keeps its name here (it is who worked this Leitung) but is
                            struck through + labelled, the same read as its dimmed marker on the map */}
                        <span className={truppOnLineOut ? 'de-trupp-out' : undefined}>{truppOnLine ?? appConfig.copy.drawingEditor.truppNone}</span>
                        {truppOnLine && truppOnLineOut && <em className="de-trupp-outnote">{appConfig.copy.drawingEditor.truppOut}</em>}
                        <Icon id="chevron-down" />
                      </button>
                    }
                    popupClassName="de-menu-pop"
                    itemClassName={() => 'de-menu-item'}
                    items={[
                      { label: <MenuPick label={appConfig.copy.drawingEditor.truppNone} on={!truppOnLine} />, onClick: () => onTrupp(undefined) },
                      ...trupps.map((t) => ({
                        label: <MenuPick label={t.name} on={t.name === truppOnLine} />,
                        onClick: () => onTrupp(t.id),
                      })),
                    ]}
                  />
                  {onShowTrupp && truppOnLine && (
                    <button
                      className="de-trupp-go" onClick={onShowTrupp}
                      aria-label={fillTemplate(appConfig.copy.drawingEditor.truppShow, { name: truppOnLine })}
                      title={fillTemplate(appConfig.copy.drawingEditor.truppShow, { name: truppOnLine })}
                    >
                      <span className="ctx-conn-go" aria-hidden>›</span>
                    </button>
                  )}
                </span>
              </div>
            )}
          </div>
        )}
        {/* Messung — the numbers of a line that is already on the map. Before this, length was
            only reachable by re-drawing the line with the Messen tool, and the Höhenprofil not at
            all; the old An/Aus toggle lives on here as «Auf Karte», which is what it always did. */}
        {(isLine ? lengthM != null || supportsDistance : areaM2 != null) && (
          <div className="de-group">
            <div className="de-conn-title">{appConfig.copy.drawingEditor.measurement}</div>
            {isLine && lengthM != null && (
              <>
                <div className="de-row"><span>{appConfig.copy.drawingEditor.distance}</span>
                  <b className="de-measure-v">{fmtDistance(lengthM)}</b>
                </div>
                <div className="de-row"><span>{appConfig.copy.measure.hoses} à {appConfig.drawing.hoseLengthM} m</span>
                  <b className="de-measure-v">{hoseCount(lengthM)}</b>
                </div>
              </>
            )}
            {/* an Absperrkreis / Fläche measures itself: what it covers, and how far around it —
                the same two numbers the Messen tool would give for the same outline */}
            {!isLine && areaM2 != null && (
              <>
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
              </>
            )}
            {/* «Auf Karte zeigen» was line-only, so a Fläche could work out its own size but had
                no way to put it on the map — the number lived in this panel and vanished the
                moment the panel closed. An Absperrkreis or Sektor whose area is the whole point
                gets the same switch a hose line has. */}
            {(isLine ? supportsDistance : areaM2 != null) && !readOnly && (
              <div className="de-row"><span>{appConfig.copy.drawingEditor.showOnMap}</span>
                <OnOff ariaLabel={appConfig.copy.drawingEditor.showOnMap} value={!!drawing.showDistance} onChange={onShowDistance} />
              </div>
            )}
            {hasProfileCoords && (
              <>
                <button type="button" className={`de-prof-toggle${profileOpen ? ' on' : ''}`} aria-expanded={profileOpen} onClick={() => setProfileOpen((o) => !o)}>
                  <span>{appConfig.copy.measure.profile}</span><Icon id="chevron-down" />
                </button>
                {profileOpen && (profileLoading ? (
                  <div className="de-prof-msg">{appConfig.copy.measure.profileLoading}</div>
                ) : profile ? (
                  <><ProfileChart p={profile} /><ProfileStats p={profile} /></>
                ) : (
                  <div className="de-prof-msg">{appConfig.copy.measure.profileNone}</div>
                ))}
              </>
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
                {/* the connection READS in read-only (who the line hangs on, and «springe zu»);
                    what it may not do is re-route or cut it — so the two mutating controls are
                    gated here, not only by each surface remembering to pass undefined. */}
                {!readOnly && onRouting && (
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
                {!readOnly && onDetach && <button type="button" className="de-conn-detach" onClick={() => onDetach(endpoint)}>{gps === 'paused' ? appConfig.copy.drawingEditor.gpsDetachHere : appConfig.copy.drawingEditor.detachConnection}</button>}
              </Fragment>
            })}
          </div>
        )}
        {actions && <div className="ctx-footer-inline">{actions}</div>}
      </div>
      {actions}
    </div>
  )
}
