import { Fragment, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { LineStylePicker } from '../lib/draw'
import { DockInfo } from './DockInfo'

const COLORS = appConfig.drawing.colors
const WIDTHS = appConfig.drawing.widths

/**
 * One declarative description of every control that can sit in a right-edge tool dock. The Lage
 * map and the Plan/Gebäude whiteboard both build their docks out of these — same code, same look;
 * any surface-specific difference is expressed as a different group/item list, never a fork of the
 * markup. (Both surfaces share the `.wb-dock` CSS, so this stays purely a renderer.)
 */
export type DockItem =
  | { type: 'close'; onClick: () => void; title?: string }
  | { type: 'toggle'; icon: string; label: string; on: boolean; onClick: () => void; disabled?: boolean }
  | { type: 'go'; onClick: () => void; disabled?: boolean; title?: string }
  | { type: 'glyph'; node: ReactNode }
  | { type: 'action'; icon: string; label: string; onClick: () => void; disabled?: boolean; cls?: string }
  | { type: 'colors'; value: string; onChange: (c: string) => void; colors?: readonly string[] }
  | { type: 'colorGrid'; value: string; onChange: (c: string) => void; colors: readonly string[]; title?: string }
  | { type: 'widths'; value: number; onChange: (w: number) => void; widths?: readonly number[] }
  | { type: 'lineStyle'; dashed: boolean; onChange: (d: boolean) => void }
  | { type: 'info'; text: string }

function renderItem(item: DockItem, key: string): ReactNode {
  switch (item.type) {
    case 'close':
      return <button key={key} className="wb-dock-x" title={item.title ?? appConfig.copy.cancel} aria-label={item.title ?? appConfig.copy.cancel} onClick={item.onClick}><Icon id="close" /></button>
    case 'toggle':
      return <button key={key} className={`wb-dock-tog ${item.on ? 'on' : ''}`} title={item.label} aria-label={item.label} aria-pressed={item.on} disabled={item.disabled} onClick={item.onClick}><Icon id={item.icon} /></button>
    case 'go':
      return <button key={key} className="wb-dock-go" disabled={item.disabled} title={item.title ?? appConfig.copy.done} aria-label={item.title ?? appConfig.copy.done} onClick={item.onClick}><Icon id="check" /></button>
    case 'glyph':
      return <span key={key} className="wb-dock-ic wb-dock-shape">{item.node}</span>
    case 'action':
      return <button key={key} className={item.cls ?? 'wb-dock-tog'} disabled={item.disabled} title={item.label} aria-label={item.label} onClick={item.onClick}><Icon id={item.icon} /></button>
    case 'colors':
      // 2-wide grid (same as colorGrid) so the swatches form a compact block instead of a tall
      // single-file ribbon — keeps the whole dock short without wrapping the dock itself
      return <div key={key} className="wb-sw-grid">{(item.colors ?? COLORS).map((c) => <button key={c} className={`wb-sw ${item.value === c ? 'on' : ''}`} style={{ background: c }} onClick={() => item.onChange(c)} />)}</div>
    case 'colorGrid':
      return <div key={key} className="wb-sw-grid">{item.colors.map((c) => <button key={c} className={`wb-sw ${item.value === c ? 'on' : ''}`} style={{ background: c }} onClick={() => item.onChange(c)} title={item.title} />)}</div>
    case 'widths':
      return <Fragment key={key}>{(item.widths ?? WIDTHS).map((w) => <button key={w} className={`wb-ww ${item.value === w ? 'on' : ''}`} onClick={() => item.onChange(w)}><span style={{ height: w }} /></button>)}</Fragment>
    case 'lineStyle':
      return <LineStylePicker key={key} dashed={item.dashed} onChange={item.onChange} />
    case 'info':
      return <DockInfo key={key} text={item.text} />
  }
}

/**
 * The right-edge tool option dock. `groups` are rendered in order with a `wb-style-sep` divider
 * between them; empty groups are dropped so an absent control (e.g. the ✓ that only shows in node
 * mode) leaves no stray separator.
 */
export function ToolDock({ groups }: { groups: DockItem[][] }) {
  const visible = groups.filter((g) => g.length)
  return (
    <div className="wb-dock wb-dock-map">
      {visible.map((g, gi) => (
        <Fragment key={gi}>
          {gi > 0 && <span className="wb-style-sep" />}
          {g.map((item, ii) => renderItem(item, `${gi}-${ii}`))}
        </Fragment>
      ))}
    </div>
  )
}
