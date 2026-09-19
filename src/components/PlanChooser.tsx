import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { planGlyph } from '../lib/navRail'
import { GroupChooser } from './GroupChooser'
import type { PlanDocument } from '../types'

/**
 * «Welcher Plan?» — the list behind the phone bar's folded «Pläne» tile (18.09.2026).
 *
 * The bar carries ONE tile for every plan document now, so the choice between them has to live
 * somewhere: a second tap on the already-selected tile (or a hold on it) opens this. One row per
 * document — the glyph the rail tile used to carry and the plan's own short name — with the
 * loaded document marked, so the answer to «which one am I on» is on the same screen as «take me
 * to another one».
 *
 * The list itself is GroupChooser, shared with the «Rapport» tile's three pages: two tiles on
 * that bar stand for a group, they are opened by the same tap-again/hold, and they must not
 * answer the same question in two different shapes.
 */
export function PlanChooser({ docs, activeId, onPick, onClose }: {
  docs: PlanDocument[]
  activeId: string
  onPick: (id: string) => void
  onClose: () => void
}) {
  const nav = appConfig.copy.navRail
  return (
    <GroupChooser
      title={nav.plansChoose}
      activeId={activeId}
      onPick={onPick}
      onClose={onClose}
      rows={docs.map((d) => {
        const g = planGlyph(d)
        return {
          id: d.id,
          // ⚠️ the letter count rides on the chip: the box is a fixed square and CSS cannot count
          // characters, so «RWA» at the digit's size painted straight through its own border
          glyph: 'mono' in g ? <span className="nav-mono-chip" data-mono-len={g.mono.length}>{g.mono}</span> : <Icon id={g.icon} />,
          // the plan's own name as the station calls it («Modul 1», «RWA», «Gebäude») — the same
          // word the rail wears. What a Modul holds differs per station and they know it best;
          // the catalogue's description only made every row two lines (18.09.2026).
          title: d.code || d.title,
        }
      })}
    />
  )
}
