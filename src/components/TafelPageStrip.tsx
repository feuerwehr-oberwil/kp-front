import { appConfig } from '../config/appConfig'
import { Icon } from '../lib/icons'
import { Menu, type MenuActionItem, type MenuHeading } from '../lib/overlays'
import { labelText, offeredPages, type BoardTemplate, type TemplatePage } from '../lib/boardTemplate'
import { SKIZZE } from '../lib/tafelPages'
import type { FormAnno } from '../lib/boardForm'
import { Button } from './Button'
import { Segmented } from './Segmented'

/**
 * The Tafel's page strip (10.10.2026): «Skizze» (the free board) · the pages added to this Einsatz
 * · «+ Seite». The pages are the app's ONE segmented control in its `tabs` form (they are pages of
 * one surface), on a floating bar of the top bar's own make, standing right under it — same left
 * edge, same corner, same 44px controls (owner, staging round 2). A tap switches; PageUp /
 * PageDown do the same when no field has the keyboard (Whiteboard). No swipe: a swipe pans the
 * board. A new Tafel shows only «Skizze» and «+ Seite» — no page is forced on anybody, and the
 * dropped «Womit beginnen?» cards stay dropped. Pages are named by their titles only; the FKS
 * sheet numbers stay in the template's metadata (owner, round 2).
 */
export function TafelPageStrip({ pages, current, templates, readOnly, onPick, onAdd }: {
  pages: FormAnno[]
  current: string
  templates: readonly BoardTemplate[]
  readOnly: boolean
  onPick: (page: string) => void
  /** add a template page — or, when it is already on the Tafel, go to it */
  onAdd: (tpl: BoardTemplate, page: TemplatePage) => void
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
            <span className="tps-name">{labelText(p.title)}</span>
            {there ? <span className="tps-there"><Icon id="check" />{T.alreadyThere}</span> : null}
          </span>
        ),
        onClick: () => onAdd(tpl, p),
      }
    }),
  ])
  return (
    <nav className="tps" aria-label={T.strip} onPointerDown={(e) => e.stopPropagation()} data-testid="tafel-strip">
      <Segmented
        tabs
        ariaLabel={T.strip}
        value={current}
        onChange={onPick}
        options={[
          { value: SKIZZE, label: <><Icon id="pen" />{T.skizze}</> },
          ...pages.map((p) => ({ value: p.id, label: <><Icon id="doc" />{labelText(p.form.page.title)}</> })),
        ]}
      />
      {!readOnly && (
        <Menu
          align="start"
          popupClassName="de-menu-pop tps-menu"
          itemClassName={() => 'de-menu-item'}
          trigger={<Button variant="quiet" className="tps-add" icon={<Icon id="plus" />} aria-label={T.addPageTitle}>{T.addPage}</Button>}
          items={items}
        />
      )}
    </nav>
  )
}
