import type { ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { Sheet } from '../lib/overlays'

/** One destination in a chooser: the glyph its rail tile wears, its name, and — where there is
 *  one — a live read-out of what is behind it («12 anwesend», «3 offen»). */
export interface GroupRow {
  id: string
  glyph: ReactNode
  title: string
  meta?: string
}

/**
 * «Welches davon?» — the list behind a phone bar tile that stands for a GROUP of destinations.
 *
 * The folded phone bar (18.09.2026) has five tiles and more than five destinations, so two of
 * them carry a group: «Pläne» stands for every plan document (PlanChooser), «Rapport» for the
 * three pages Rapport · Anwesenheit · Material (NavRail). Both are opened the same way — a
 * second tap on the tile you are already standing on, or a hold from anywhere — so both look and
 * behave the same way too, and that is what this file is: ONE list, so the second group could
 * not drift into a second idiom for the same question.
 *
 * Rows are the app's existing option-list vocabulary (.pp-row) with a glyph column in front of
 * them, so a row is recognised as the tile it replaced. Tapping a row switches and closes; there
 * is no second step, because a chooser that needs confirming is a chooser you tapped twice.
 */
export function GroupChooser({ title, rows, activeId, onPick, onClose }: {
  /** the sheet's own title — «Plan wählen», «Seite wählen» */
  title: string
  rows: GroupRow[]
  activeId: string
  onPick: (id: string) => void
  onClose: () => void
}) {
  return (
    <Sheet open onClose={onClose} title={title} fit sheetClassName="group-choose">
      <div className="group-choose-list" role="listbox" aria-label={title}>
        {rows.map((r) => {
          const on = r.id === activeId
          return (
            <button
              key={r.id}
              type="button"
              role="option"
              aria-selected={on}
              className={`pp-row${on ? ' on' : ''}`}
              onClick={() => { onPick(r.id); onClose() }}
            >
              <span className="group-choose-glyph" aria-hidden>{r.glyph}</span>
              {/* ONE line. Whatever the row is about names itself in the word the rail already
                  wears; a description underneath made every row two lines high for something
                  nobody reads twice (18.09.2026). */}
              <span className="pp-row-main">
                <b>{r.title}</b>
              </span>
              {(r.meta || on) && (
                <span className="pp-row-meta">
                  {r.meta && <span className="group-choose-count">{r.meta}</span>}
                  {on && <Icon id="check" aria-hidden />}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </Sheet>
  )
}
