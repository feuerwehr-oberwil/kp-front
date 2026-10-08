import { appConfig } from '../config/appConfig'
import { Icon } from '../lib/icons'
import { cx } from '../lib/cx'
import { fillTemplate } from '../lib/format'
import { fmtDistance } from '../lib/geo'
import { startSuggestion } from '../lib/tafelStart'
import type { ObjectWithPlans } from '../lib/incidents'
import type { PlakatSeed } from '../lib/plakat'
import { Button } from './Button'
import s from './TafelStart.module.css'

/** What the workspace hands the empty Tafel: the Einsatz, the objects near it, and the doors. */
export interface TafelStartInfo {
  title: string
  address: string | null
  /** the nearest objects from the database, nearest first (useObjectPlans · nearObjects) */
  near: readonly ObjectWithPlans[]
  /** the Einsatz has a real coordinate — the Gebäude picker has a pin to start from */
  hasLocation: boolean
  /** take this object's plans (the picker's own `onSelect`) */
  onPickObject?: (o: ObjectWithPlans) => void
  /** open the object/plan picker (PlanPicker). Absent ⇒ no Objekt card (an Einsatz-Link). */
  onOpenObjects?: () => void
  /** open the Gebäude outline picker */
  onOpenBuilding?: () => void
  /** what the Einsatz already knows, for the Plakat's pre-fill — read at the moment of the tap */
  plakatSeed: () => PlakatSeed
}

interface Props {
  info: TafelStartInfo
  phone: boolean
  /** insert «Erstes Plakat (FKS)» (one ↶ step) */
  onPlakat: () => void
  /** «oder einfach losskizzieren» — arm the pen, which hides the cards */
  onSketch: () => void
  /** px the floating top bar covers (phone: the stage runs under it) */
  topInset?: number
}

const T = () => appConfig.copy.tafel

/** The «Vorlage» glyph: four tiles, one of them a plus (no sprite of its own for one card). */
function TemplateGlyph() {
  return (
    <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><path d="M16.75 13.5v6.5M13.5 16.75H20" />
    </svg>
  )
}

/** The poster glyph on the Vorlage row: a sheet with its header band and the column split. */
function PlakatGlyph() {
  return (
    <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9.5h18M12 9.5V20" />
    </svg>
  )
}

/**
 * «Womit beginnen?» — the starter cards on the empty Tafel (08.10.2026). A NON-MODAL layer: the
 * wrapper lets every pointer through to the board (CSS), only the cards take a tap, and the
 * whiteboard hides the layer the moment a tool is armed or anything stands on the sheet
 * (lib/tafelStart · tafelStartVisible). Tablet: three cards side by side. Phone: stacked rows.
 */
export function TafelStart({ info, phone, onPlakat, onSketch, topInset = 0 }: Props) {
  const c = T()
  const nearest = info.near[0]
  const suggest = startSuggestion(nearest ? { distanceM: nearest.distance_m, addressMatch: nearest.address_match } : null, info.hasLocation)
  const sub = info.address ? fillTemplate(c.startSub, { title: info.title, address: info.address }) : info.title
  const near = info.near.slice(0, 2)
  const badge = <span className={s.badge}>{c.suggestion}</span>

  if (phone) {
    const objSub = nearest
      ? `${nearest.name}${nearest.distance_m != null ? ` · ${fmtDistance(nearest.distance_m)}` : ''}`
      : c.objectRowNone
    const rows = [
      info.onOpenBuilding && { key: 'building', icon: <Icon id="footprint" />, title: c.buildingTitle, sub: c.buildingRowSub, on: info.onOpenBuilding, pick: suggest === 'building' },
      info.onOpenObjects && { key: 'object', icon: <Icon id="doc" />, title: c.objectTitle, sub: objSub, on: info.onOpenObjects, pick: suggest === 'object' },
      { key: 'plakat', icon: <TemplateGlyph />, title: c.templateTitle, sub: c.plakatName, on: onPlakat, pick: false },
    ].filter((r): r is Exclude<typeof r, undefined | false> => !!r)
    // the suggested door first — on a phone the first row is the one under the thumb
    rows.sort((a, b) => Number(b.pick) - Number(a.pick))
    return (
      <div className={cx(s.layer, s.phone)} style={{ paddingTop: topInset }} data-testid="tafel-start">
        <div className={s.head}>
          <h2 className={s.title}>{c.startTitle}</h2>
          <p className={s.sub}>{sub}</p>
        </div>
        <div className={s.rows}>
          {rows.map((r) => (
            // ⚠️ a whole card row is the tap target here: a card is a surface, not a button look
            <button key={r.key} type="button" className={cx(s.row, r.pick && s.pick)} onClick={r.on} data-start={r.key}>
              {r.pick && badge}
              <span className={s.glyph}>{r.icon}</span>
              <span className={s.rowText}><b>{r.title}</b><small>{r.sub}</small></span>
              <Icon id="chevron" className={s.chev} />
            </button>
          ))}
        </div>
        <Button variant="quiet" className={s.sketch} icon={<Icon id="pen" />} onClick={onSketch}>{c.sketchPhone}</Button>
      </div>
    )
  }

  return (
    <div className={s.layer} data-testid="tafel-start">
      <div className={s.head}>
        <h2 className={s.title}>{c.startTitle}</h2>
        <p className={s.sub}>{sub}</p>
      </div>
      <div className={s.cards}>
        {info.onOpenObjects && (
          <section className={cx(s.card, suggest === 'object' && s.pick)} data-start="object">
            {suggest === 'object' && badge}
            <span className={s.glyph}><Icon id="doc" /></span>
            <h3 className={s.cardTitle}>{c.objectTitle}</h3>
            <p className={s.body}>{near.length ? c.objectBody : c.objectNone}</p>
            <div className={s.foot}>
              {info.onPickObject && near.map((o) => (
                <Button key={o.id} variant="quiet" block className={s.hit} title={fillTemplate(c.objectPick, { name: o.name })}
                  icon={<Icon id="station" />} onClick={() => info.onPickObject?.(o)}>
                  <span className={s.hitName}>{o.name}</span>
                  {o.distance_m != null && <span className={s.hitDist}>{fmtDistance(o.distance_m)}</span>}
                </Button>
              ))}
              <Button variant={suggest === 'object' ? 'primary' : 'secondary'} block onClick={info.onOpenObjects}>{c.objectSearch}</Button>
            </div>
          </section>
        )}
        {info.onOpenBuilding && (
          <section className={cx(s.card, suggest === 'building' && s.pick)} data-start="building">
            {suggest === 'building' && badge}
            <span className={s.glyph}><Icon id="footprint" /></span>
            <h3 className={s.cardTitle}>{c.buildingTitle}</h3>
            <p className={s.body}>{c.buildingBody}</p>
            <div className={s.foot}>
              <Button variant={suggest === 'building' ? 'primary' : 'secondary'} block onClick={info.onOpenBuilding}>{c.buildingAction}</Button>
            </div>
          </section>
        )}
        <section className={s.card} data-start="template">
          <span className={s.glyph}><TemplateGlyph /></span>
          <h3 className={s.cardTitle}>{c.templateTitle}</h3>
          <div className={s.foot}>
            {/* ONE entry for now (owner, 08.10.2026): Raumordnung and Organigramm are not approved */}
            <Button block className={s.tplRow} icon={<PlakatGlyph />} onClick={onPlakat}>
              <span className={s.hitName}>{c.plakatName}</span><Icon id="chevron" className={s.chev} />
            </Button>
          </div>
        </section>
      </div>
      <Button variant="quiet" className={s.sketch} icon={<Icon id="pen" />} onClick={onSketch}>
        {c.sketch}<Icon id="chevron" className={s.chev} />
      </Button>
    </div>
  )
}
