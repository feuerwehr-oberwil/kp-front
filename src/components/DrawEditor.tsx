import { Fragment, useState } from 'react'
import { Icon } from '../lib/icons'
import { SheetGrip } from './SheetGrip'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { LineStylePicker } from '../lib/draw'
import { fmtDistance, fmtArea, hoseCount } from '../lib/geo'
import { CONTENT_LABELS } from '../lib/lineDecor'
import { floorBadge } from '../lib/symbolRender'
import { useLineProfile } from '../lib/useLineProfile'
import { ProfileChart, ProfileStats } from './ProfileChart'
import { Stepper } from './Stepper'
import { Menu } from '../lib/overlays'
import { Segmented } from './Segmented'
import type { LineAttachment, LineEndpoint, LngLat, LineRoutingMode } from '../types'

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
  /** the Atemschutz link anchor (Drawing/BoardAnno · truppId) */
  truppId?: string
  startAttachment?: LineAttachment
  endAttachment?: LineAttachment
}

interface Props {
  drawing: DrawStyle
  /** how many vertices the shape has, for the header subtitle (circle uses its radius instead) */
  pointCount: number
  /** read-only surface (viewer role, Einsatzleiter-Ansicht, replay): keep everything that
   *  ANSWERS a question — Messung, Höhenprofil, Verbindungen, «springe zu» — and drop every
   *  control that would change the shape. The EL must be able to ask how long the Leitung is
   *  without being able to move it. */
  readOnly?: boolean
  /** area + perimeter of an area/circle, so the Messung section states what the shape covers
   *  (a line uses `lengthM` instead). Absent → the rows are omitted. */
  areaM2?: number | null
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

/** One menu row with a leading tick when it is the current pick (the native select drew one; the
 *  app's menu has no built-in selected state). */
function MenuPick({ label, on }: { label: string; on: boolean }) {
  return (
    <>
      <span className={`de-menu-tick${on ? ' on' : ''}`} aria-hidden><Icon id="check" /></span>
      <span>{label}</span>
    </>
  )
}

export function DrawEditor({ drawing, pointCount, readOnly = false, areaM2, perimeterM, supportsDistance = false, lengthM, profileCoords, onColor, onWidth, onDashed, onLabel, onMarker, onArrow, onEnding, onContent, onLineNo, onFloorTag, onTrupp, trupps = [], truppOnLine, truppOnLineOut = false, onShowTrupp, usedLineNos = [], onShowDistance, onRadius, onFillOpacity, onToggleLock, locked, onDelete, onClose, attachmentLabels, onRouting, onDetach, onFocusAttachment, attachmentHidden, onRevealAttachment }: Props) {
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
        {!readOnly && (isCircle || isArea) && (
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
        {!readOnly && <div className="de-group">
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
        {!readOnly && isLine && (
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
                  {/* W = Wasser, and that is the default chip on the left — a Druckleitung with no
                      letter IS a water line, so W never needed a chip of its own. S/H/P are the
                      ends that are worth marking. Lines already stored with content 'W' keep it. */}
                  {(['S', 'H', 'P'] as const).map((c) => (
                    <button key={c} className={`de-preset ${drawing.content === c ? 'on' : ''}`} title={CONTENT_LABELS[c]} onClick={() => onContent(c)}>{c}</button>
                  ))}
                </span>
              </div>
            )}
            {onFloorTag && (
              <div className="de-row"><span>{appConfig.copy.drawingEditor.floorTag}</span>
                <Stepper value={drawing.floorTag ?? null} min={-9} max={40} seed={0} format={floorBadge} placeholder="–"
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
                <span className="dh-widths">
                  <button className={`de-toggle ${drawing.showDistance ? 'on' : ''}`} aria-pressed={!!drawing.showDistance} onClick={() => onShowDistance(!drawing.showDistance)}>{drawing.showDistance ? appConfig.copy.drawingEditor.on : appConfig.copy.drawingEditor.off}</button>
                </span>
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
        {actions && <div className="ctx-footer-inline">{actions}</div>}
      </div>
      {actions}
    </div>
  )
}
