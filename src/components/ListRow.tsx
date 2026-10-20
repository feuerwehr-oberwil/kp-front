import type { HTMLAttributes, ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { cx } from '../lib/cx'

// THE list row, its card and its group, and THE back row (20.10.2026, Karte Haus round 3 · reuse
// audit `component-reuse-2026-10-19`). Four list rows were built in four weeks – the Karte's
// `.row`, the library's `Row`, Objektbesuche's `CardRow`, the devices' `dv-row`/`dv-chapter` –
// each glyph · title/sub · end · chevron with its own sizes, and two «‹ Label» back rows that
// called each other «the twin». A new list of things to open is these; a surface PLACES them
// (`className`, margins) and fills the lead slot, it never re-skins them.
//
// The look is global (13-incident · «THE LIST ROW»), so a `*.module.css` surface can reach it too:
// `.list-row`, `.list-card` (+ `.list-card-rail`), `.list-group`, `.back-row`.
//
//   <ListGroup label="Checklisten" end="zum Lesen">
//     <ListRow lead={<Icon id="check" />} title="Aufgaben FU" end="3 Phasen" onClick={…} />
//   </ListGroup>
//   <BackRow label="TLF" onClick={…} />   →   «‹ TLF»

/** One row of a list: lead · title (+ a quiet sub line) · end · chevron. A `<button>` when it
 *  has `onClick` (with the chevron), a static `<div>` without (no chevron, no press). `on` = «where
 *  you are» (the document beside the list shows this row): the ink pill, aria-current. Density
 *  comes from the container: 56px with a 16px title on a `ListCard` (or on its own), the compact
 *  --tap row with a 14px title in a `look="rail"` card (a list column beside a document).
 *  `children` go under the text, inside its column – a progress bar (Objektbesuche's rounds). */
export function ListRow({ lead, title, sub, end, chevron, on, disabled, onClick, className, children, ...rest }: {
  /** the leading slot: a 18px glyph, a hazard chip, a thumbnail, a number – sized by itself */
  lead?: ReactNode
  title: ReactNode
  /** the quiet second line – a device, a reason, a count in words */
  sub?: ReactNode
  /** a short read-out before the chevron – «3 Phasen», «40%», a distance */
  end?: ReactNode
  /** the › at the end; default: shown when the row opens something */
  chevron?: boolean
  on?: boolean
  disabled?: boolean
  onClick?: () => void
  className?: string
  children?: ReactNode
} & Omit<HTMLAttributes<HTMLElement>, 'title' | 'onClick' | 'className' | 'children'>) {
  const body = (
    <>
      {lead != null && <span className="list-row-lead">{lead}</span>}
      <span className="list-row-text">
        <span className="list-row-title">{title}</span>
        {sub != null && sub !== '' && <span className="list-row-sub">{sub}</span>}
        {children}
      </span>
      {end != null && end !== '' && <span className="list-row-end">{end}</span>}
      {(chevron ?? !!onClick) && <Icon id="chevron" className="list-row-chev" />}
    </>
  )
  const cls = cx('list-row', on && 'on', className)
  return onClick
    ? <button type="button" className={cls} onClick={onClick} disabled={disabled} aria-current={on || undefined} {...rest}>{body}</button>
    : <div className={cls} {...rest}>{body}</div>
}

/** Rows on one white card with hairlines between them. `look="rail"`: a list column's rows on
 *  the column's own ground – no card, compact rows with the one corner (the tablet library column,
 *  the Einsatz Checkliste rail). */
export function ListCard({ look = 'card', className, children, ...rest }: {
  look?: 'card' | 'rail'
  className?: string
  children: ReactNode
} & Omit<HTMLAttributes<HTMLDivElement>, 'className'>) {
  return <div className={cx('list-card', look === 'rail' && 'list-card-rail', className)} {...rest}>{children}</div>
}

/** A labelled group: the eyebrow (with an optional word or count at its right end), then its rows
 *  on a `ListCard`. `bare` puts the children straight under the label (photo cards, a grid). */
export function ListGroup({ label, end, look, bare, className, children }: {
  label: string
  end?: ReactNode
  look?: 'card' | 'rail'
  bare?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <section className={cx('list-group', className)} aria-label={label}>
      <div className="list-group-label"><span>{label}</span>{end != null && <span className="list-group-end">{end}</span>}</div>
      {bare ? children : <ListCard look={look}>{children}</ListCard>}
    </section>
  )
}

/** THE way one level up: «‹ Label», naming where it goes («‹ TLF», «‹ Checkliste») – never a
 *  bare «Zurück». Quiet (ink-dim, no frame), --tap tall, at the top of the page it leaves. */
export function BackRow({ label, onClick, className }: { label: ReactNode; onClick: () => void; className?: string }) {
  return (
    <button type="button" className={cx('back-row', className)} onClick={onClick}>
      <Icon id="chevron-left" />{label}
    </button>
  )
}
