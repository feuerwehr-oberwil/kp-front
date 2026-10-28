/** The Plan sheet: what no page of a plan states, behind the ONE chip the Plan's bar still carries
 *  (sweep 28.10.2026 #8, owner pick «B's bar + A's sheet»).
 *
 *  The bar used to say it in three chips – Objekt, «Ref. …» (Massstab) and «⌖ Karte» – two of them
 *  lamps for the same subject, and on a phone they squeezed the object's name down to its glyph.
 *  Now the Objekt chip (on the Gebäude: the building chip) carries a single lamp, the worse of link
 *  and scale (planScale · planFactsTone), and a tap opens this: the Objekt row on top (its switch),
 *  then «Karte» with its state and its actions INLINE (the Passung – no drill-down), then
 *  «Massstab» with its state. A section that does not apply is not passed: the Gebäude has no
 *  Karte section, a viewer no Massstab.
 *
 *  It only lays the facts out; the Whiteboard owns the state and the wiring, and frames it in the
 *  Passung's dock (GeorefMode · GeorefDock: a card above the row on a tablet, a non-modal bottom
 *  sheet on a phone).
 *
 *    <PlanFactsSheet title="Plan · Modul 2" onClose={close}
 *      place={{ icon: 'footprint', name: 'Schlossgasse 9', sub: '4104 Oberwil · anderes Objekt wählen', onClick: pick }}
 *      link={{ tone: 'grey', status: 'nicht verknüpft', note: '…', actions: [{ label: 'Karte verknüpfen', icon: 'link', onClick: begin, primary: true }] }}
 *      scale={{ tone: 'green', status: 'Ref. auto', note: 'aus der Kartenverknüpfung …' }} />
 */
import type { ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'
import type { LampTone } from '../lib/planScale'
import { ListRow } from './ListRow'
import s from './PlanFactsSheet.module.css'

/** One fact: its lamp and the word for the state, a quiet line on what that means, and below it
 *  what can be done about it – plain actions, or a whole panel (the embedded Passung). A locked
 *  session is handed neither. */
export interface PlanFact {
  tone: LampTone
  status: string
  note?: string
  actions?: { label: string; icon: string; onClick: () => void; primary?: boolean }[]
  body?: ReactNode
}

export function PlanFactsSheet({ title, onClose, place, link, scale }: {
  title: string
  onClose: () => void
  /** WHICH object (on the Gebäude: which building) – tappable when it can be switched */
  place: { icon: string; name: string; sub?: string; warn?: boolean; onClick?: () => void; label?: string }
  link?: PlanFact
  scale?: PlanFact
}) {
  return (
    <div className={s.sheet}>
      <div className={s.head}>
        <span>{title}</span>
        <button type="button" className={cx('ip-x', s.x)} onClick={onClose} aria-label={appConfig.copy.closeDialog}><Icon id="close" /></button>
      </div>
      <ListRow className={cx(s.place, place.warn && s.warn)} lead={<Icon id={place.icon} />}
        title={place.name} sub={place.sub} onClick={place.onClick} aria-label={place.label} />
      {link && <Fact icon="link" title={appConfig.copy.whiteboard.facts.karte} fact={link} />}
      {scale && <Fact icon="measure" title={appConfig.copy.whiteboard.scale.tool} fact={scale} />}
    </div>
  )
}

function Fact({ icon, title, fact }: { icon: string; title: string; fact: PlanFact }) {
  return (
    <section className={s.fact} aria-label={`${title}: ${fact.status}`}>
      <div className={s.factHead}>
        <Icon id={icon} />
        <span className={s.factTitle}>{title}</span>
        <span className={s.status}>
          <span className="wb-lamp" data-tone={fact.tone} aria-hidden="true" />
          {fact.status}
        </span>
      </div>
      {fact.note && <p className={s.note}>{fact.note}</p>}
      {fact.body && <div className={s.body}>{fact.body}</div>}
      {!!fact.actions?.length && (
        <div className={s.actions}>
          {fact.actions.map((a) => (
            <button key={a.label} type="button" className={cx('btn', a.primary && 'primary')} onClick={a.onClick}>
              <Icon id={a.icon} />{a.label}
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
