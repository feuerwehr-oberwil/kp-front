import { appConfig } from '../config/appConfig'
import { Icon } from '../lib/icons'
import { cx } from '../lib/cx'
import { Menu, type MenuActionItem, type MenuHeading } from '../lib/overlays'
import { labelText, offeredPages, type BoardTemplate, type TemplatePage } from '../lib/boardTemplate'
import { SKIZZE } from '../lib/tafelPages'
import type { FormAnno } from '../lib/boardForm'
import { Chip } from './Chip'

/**
 * The Tafel's page strip (10.10.2026): «Skizze» (the free board) · the pages added to this Einsatz
 * · «+ Seite». A tap switches; PageUp / PageDown do the same when no field has the keyboard
 * (Whiteboard). No swipe: a swipe pans the board. A new Tafel shows only «Skizze» and «+ Seite» —
 * no page is forced on anybody (owner, 10.10.2026), and the dropped «Womit beginnen?» cards
 * stay dropped.
 */
export function TafelPageStrip({ pages, current, templates, readOnly, onPick, onAdd, style }: {
  pages: FormAnno[]
  current: string
  templates: readonly BoardTemplate[]
  readOnly: boolean
  onPick: (page: string) => void
  /** add a template page — or, when it is already on the Tafel, go to it */
  onAdd: (tpl: BoardTemplate, page: TemplatePage) => void
  style?: React.CSSProperties
}) {
  const T = appConfig.copy.tafel
  const added = new Set(pages.map((p) => `${p.form.tpl.id}/${p.form.page.id}`))
  const items: (MenuActionItem | MenuHeading)[] = templates.flatMap((tpl) => [
    // the template's name heads its pages — which set the station runs is part of the answer
    { kind: 'head' as const, label: labelText(tpl.title) },
    ...offeredPages(tpl).map((p) => {
      const there = added.has(`${tpl.id}/${p.id}`)
      return {
        label: (
          <span className="tps-item">
            <span className="tps-code">{p.code ?? ''}</span>
            <span className="tps-name">{labelText(p.title)}</span>
            {there ? <span className="tps-there"><Icon id="check" />{T.alreadyThere}</span> : null}
          </span>
        ),
        onClick: () => onAdd(tpl, p),
      }
    }),
  ])
  return (
    <nav className="tps" aria-label={T.strip} style={style} onPointerDown={(e) => e.stopPropagation()} data-testid="tafel-strip">
      <div className="tps-scroll">
        <Chip selected={current === SKIZZE} icon={<Icon id="pen" />} onClick={() => onPick(SKIZZE)}>{T.skizze}</Chip>
        {pages.map((p) => (
          <Chip key={p.id} selected={current === p.id} icon={<Icon id="doc" />} onClick={() => onPick(p.id)}>
            {labelText(p.form.page.title)}
          </Chip>
        ))}
        {!readOnly && (
          <Menu
            align="start"
            popupClassName="de-menu-pop tps-menu"
            itemClassName={() => 'de-menu-item'}
            trigger={<Chip className={cx('tps-add')} icon={<Icon id="plus" />} aria-label={T.addPageTitle}>{T.addPage}</Chip>}
            items={items}
          />
        )}
      </div>
    </nav>
  )
}
