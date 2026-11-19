// «Üben»'s sheet (owner pick 2C, 19.11.2026): «Als Nächstes» on top – the drill running now, else
// the first one not done on this device – then the three modules with every drill, ✓ where done
// here. A drill without goals yet says «bald» and cannot start. Opened from both menus' «Üben» row
// (lib/ueben/session · openUebenSheet); App renders it as a lazy chunk and starts the drill.

import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../../lib/format'
import { Icon } from '../../lib/icons'
import { Sheet } from '../../lib/overlays'
import { ALL_DRILLS, MODULES, drillById, drillCopy, drillPlace, nextDrill } from '../../lib/ueben/catalogue'
import type { DrillId } from '../../lib/ueben/model'
import { Button } from '../Button'
import { ListGroup, ListRow } from '../ListRow'
import s from './Ueben.module.css'

export default function UebenSheet({ done, current, onClose, onStart }: {
  done: ReadonlySet<DrillId>
  /** the drill on the card now – «Als Nächstes» resumes it */
  current: DrillId | null
  onClose: () => void
  onStart: (id: DrillId) => void
}) {
  const C = appConfig.copy.ueben
  const up = current && !done.has(current) ? current : nextDrill(done)
  const doneN = ALL_DRILLS.filter((id) => done.has(id)).length
  return (
    <Sheet open onClose={onClose} title={C.menu}>
      <p className={s.lead}>{C.sheetLead}</p>
      {up && (
        <div className={s.nextCard} data-ueben-next={up}>
          <span className={s.kicker}>{C.next} · {C.modules[drillPlace(up).module]}</span>
          <span className={s.title}>{drillCopy(up).title}</span>
          <Button variant="primary" className={s.go} onClick={() => onStart(up)}>{C.nextGo}</Button>
        </div>
      )}
      <ListGroup label={C.allDrills} end={fillTemplate(C.doneCount, { n: doneN, total: ALL_DRILLS.length })} bare>
        {MODULES.map((m) => (
          <ListGroup key={m.id} label={C.modules[m.id]}>
            {m.drills.map((id) => {
              const runnable = !!drillById(id)
              return (
                <ListRow
                  key={id}
                  data-ueben-drill={id}
                  title={drillCopy(id).title}
                  end={done.has(id) ? <Icon id="check" className={s.check} /> : runnable ? undefined : <span className={s.soon}>{C.soon}</span>}
                  aria-label={done.has(id) ? `${drillCopy(id).title} · ${C.doneMark}` : undefined}
                  disabled={!runnable}
                  onClick={runnable ? () => onStart(id) : undefined}
                />
              )
            })}
          </ListGroup>
        ))}
      </ListGroup>
    </Sheet>
  )
}
