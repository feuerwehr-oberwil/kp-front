import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { Sheet } from '../lib/overlays'
import { planGlyph } from '../lib/navRail'
import type { PlanDocument } from '../types'

/**
 * «Welcher Plan?» — the list behind the phone bar's folded «Pläne» tile (18.09.2026).
 *
 * The bar carries ONE tile for every plan document now, so the choice between them has to live
 * somewhere: a second tap on the already-selected tile (or a hold on it) opens this. One row per
 * document — the glyph the rail tile used to carry, the descriptive title, and the short code
 * under it — with the loaded document marked, so the answer to «which one am I on» is on the
 * same screen as «take me to another one». Tapping a row switches and closes; there is no
 * second step, because a chooser that needs confirming is a chooser you tapped twice.
 */
export function PlanChooser({ docs, activeId, onPick, onClose }: {
  docs: PlanDocument[]
  activeId: string
  onPick: (id: string) => void
  onClose: () => void
}) {
  const nav = appConfig.copy.navRail
  return (
    <Sheet open onClose={onClose} title={nav.plansChoose} fit sheetClassName="plan-choose">
      <div className="plan-choose-list" role="listbox" aria-label={nav.plansChoose}>
        {docs.map((d) => {
          const g = planGlyph(d)
          const on = d.id === activeId
          return (
            <button
              key={d.id}
              type="button"
              role="option"
              aria-selected={on}
              className={`pp-row${on ? ' on' : ''}`}
              onClick={() => { onPick(d.id); onClose() }}
            >
              <span className="plan-choose-glyph" aria-hidden>
                {'mono' in g ? <span className="nav-mono-chip">{g.mono}</span> : <Icon id={g.icon} />}
              </span>
              <span className="pp-row-main">
                <b>{d.title || d.code}</b>
                {/* the short code is what the folded tile shows, so the row that answers for it
                    carries the same word — and the subtitle after it where a station wrote one */}
                <span className="pp-row-addr">{[d.code, d.subtitle].filter(Boolean).join(' · ')}</span>
              </span>
              {on && <span className="pp-row-meta" aria-hidden><Icon id="check" /></span>}
            </button>
          )
        })}
      </div>
    </Sheet>
  )
}
