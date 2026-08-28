/** Non-symbol Karte content projected onto a georeferenced Modul.
 *
 * Derived, pointer-inert and below the sheet's own annotations: there is still exactly one
 * editable source object. Tactical symbols/live vehicles keep using GeorefTwinsBoard because
 * those twins already have selection, source-jump and drag semantics of their own.
 */
import type { CSSProperties } from 'react'
import type { GeorefFit } from '../lib/georef'
import type { BoardDrawingTwin, BoardEntityTwin } from '../lib/georefTwins'
import { WbInkLayer } from './WbControls'
import { ShapeGlyph } from '../lib/shapes'
import { TacticalSymbol } from '../lib/symbolRender'
import { glyphFor } from '../lib/twinGlyph'
import { noteScale, noteWPx } from '../lib/notes'
import { appConfig } from '../config/appConfig'
import type { BoardAnno } from '../types'
import s from './GeorefTwins.module.css'

export function GeorefContentBoard({ entities, drawings, fit, planAspect, sW, sH, byName }: {
  entities: BoardEntityTwin[]
  drawings: BoardDrawingTwin[]
  fit: GeorefFit
  /** width / height of the fitted sheet; turns ground metres into plan-width fractions */
  planAspect: number
  sW: number
  sH: number
  byName: Record<string, string>
}) {
  if (!sW || !sH || (!entities.length && !drawings.length)) return null

  const trailAnnos: BoardAnno[] = entities.flatMap(({ entity }) => {
    if (entity.kind !== 'team' || (entity.trail?.length ?? 0) < 2) return []
    return [{
      id: `twin-trail-${entity.id}`, kind: 'resource', color: entity.color,
      trail: entity.trail!.map(({ coord, t }) => {
        const p = fit.toPlan({ lng: coord[0], lat: coord[1] })
        return { x: p.x, y: p.y, t }
      }),
    }]
  })
  const ink = [...drawings.map((d) => d.anno), ...trailAnnos]
  // PlanScale/georef units are aspect-corrected: one normalized sheet width is ar·mPerU metres.
  const planWidthM = Math.max(0.001, fit.scaleMPerU * planAspect)

  return (
    <div className={s.contentBoard} aria-hidden>
      <WbInkLayer annos={ink} draft={null} draftFloor={0} color="#1f6feb" width={5} dashed={false}
        hiddenTrails={new Set()} mapY={(_floor, y) => y} />
      {drawings.flatMap(({ key, anno }) => {
        if (!anno.label || !anno.pts?.length) return []
        const points = anno.pts.map(([x, y]) => [x * sW, y * sH] as const)
        const anchor = anno.kind === 'area'
          ? [points.reduce((sum, p) => sum + p[0], 0) / points.length, points.reduce((sum, p) => sum + p[1], 0) / points.length]
          : points[Math.floor((points.length - 1) / 2)]
        return [<span key={`label-${key}`} className={`wb-line-label${anno.kind === 'area' ? ' wb-area-label' : ''}`}
          style={{ left: 0, top: 0, transform: `translate(${anchor[0] + (anno.labelDx ?? 0) * sW}px, ${anchor[1] + (anno.labelDy ?? 0) * sH}px) translate(-50%, ${anno.kind === 'area' ? '-50%' : '-100%'})` }}>
          {anno.label}
        </span>]
      })}
      {entities.map(({ key, entity, pt }) => {
        const pos: CSSProperties = { left: pt.x * sW, top: pt.y * sH }
        if (entity.kind === 'shape') {
          const px = Math.max(12, ((entity.sizeM ?? 40) / planWidthM) * sW)
          return <div key={key} className={`${s.contentPoint} shape-glyph`} style={{ ...pos, width: px, height: px, transform: `translate(-50%, -50%) rotate(${(entity.rotation ?? 0) + fit.rotationDeg}deg)` }}>
            <ShapeGlyph kind={entity.shape ?? 'square'} color={entity.color ?? '#1f6feb'} />
          </div>
        }
        if (entity.kind === 'note') {
          const tinted = !entity.notePlain && !!entity.color
          const cls = `note-pill box${entity.notePlain ? ' plain' : ''}${tinted ? ' tinted' : ''}`
          const style = {
            ...pos, width: noteWPx(entity.noteW), fontSize: 12 * noteScale(entity.noteSize),
            transform: 'translate(-50%, -50%)',
            ...(entity.color ? (entity.notePlain ? { color: entity.color } : { '--note-tint': entity.color }) : null),
          } as CSSProperties
          return <span key={key} className={`${s.contentPoint} ${cls}`} style={style}>{entity.label || appConfig.copy.whiteboard.text}</span>
        }
        if (entity.kind === 'team') {
          return <span key={key} className={`${s.contentPoint} team-dot`} style={{ ...pos, transform: 'translate(-50%, -50%)', '--team': entity.color || appConfig.drawing.teamColors[0] } as CSSProperties}>
            <i /><b>{entity.label}</b>
          </span>
        }
        // Shared responder positions are live map facts, not tactical symbols. Preserve their
        // own ringed-initials SVG so a projected phone fix cannot be mistaken for a placed unit.
        if (entity.kind === 'person') {
          return <span key={key} className={s.contentPoint} style={{ ...pos, width: 38, height: 38, transform: 'translate(-50%, -50%)' }}>
            <TacticalSymbol svg={glyphFor(entity, byName)} sizePx={38} rotation={0} caption={entity.label} />
          </span>
        }
        return null
      })}
    </div>
  )
}
