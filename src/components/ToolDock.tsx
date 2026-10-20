import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { DockInfo } from './DockInfo'
import { useIsPhone } from '../lib/useIsPhone'

/** What a colour swatch is CALLED. The dock item's own title names the group («Truppfarbe»); the
 *  index names the one square, in the palette's order — a hex value is not a name for anybody. */
const swatchName = (title: string | undefined, i: number): string =>
  fillTemplate(appConfig.copy.toolDock.colorName, { group: title ?? appConfig.copy.toolDock.colorGroup, n: String(i + 1) })

const COLORS = appConfig.drawing.colors
const WIDTHS = appConfig.drawing.widths

/**
 * One declarative description of every control that can sit in a right-edge tool dock. The Lage
 * map and the Plan/Gebäude whiteboard both build their docks out of these — same code, same look;
 * any surface-specific difference is expressed as a different group/item list, never a fork of the
 * markup. (Both surfaces share the `.wb-dock` CSS, so this stays purely a renderer.)
 */
export type DockItem =
  /** Always the first item of the first group — and it stays put: `.wb-dock-x` is sticky at the
   *  leading end of the scrolling dock (09-whiteboard.css), so the way out of a tool never
   *  scrolls away with a busy tool's options. */
  | { type: 'close'; onClick: () => void; title?: string }
  /** `text` renders a short word/letter instead of a glyph — for options that have no honest
   *  icon (the note's S/M/L size steps, Zettel↔Klartext). Exactly one of icon/text is used. */
  | { type: 'toggle'; icon?: string; text?: string; label: string; on: boolean; onClick: () => void; disabled?: boolean }
  | { type: 'go'; onClick: () => void; disabled?: boolean; title?: string }
  | { type: 'glyph'; node: ReactNode }
  | { type: 'action'; icon: string; label: string; onClick: () => void; disabled?: boolean; cls?: string }
  | { type: 'colors'; value: string; onChange: (c: string) => void; colors?: readonly string[] }
  | { type: 'colorGrid'; value: string; onChange: (c: string) => void; colors: readonly string[]; title?: string }
  | { type: 'widths'; value: number; onChange: (w: number) => void; widths?: readonly number[] }
  // (no `lineStyle` item any more — since the «D pur» dock rework (09.09.) stroke styling
  // happens AFTER the draw, in the DrawEditor the finished line lands in)
  | { type: 'info'; text: string }

function renderItem(item: DockItem, key: string): ReactNode {
  switch (item.type) {
    case 'close':
      return <button key={key} className="wb-dock-x" title={item.title ?? appConfig.copy.cancel} aria-label={item.title ?? appConfig.copy.cancel} onClick={item.onClick}><Icon id="close" /></button>
    case 'toggle':
      return <button key={key} className={`wb-dock-tog ${item.text ? 'wb-dock-txt ' : ''}${item.on ? 'on' : ''}`} title={item.label} aria-label={item.label} aria-pressed={item.on} disabled={item.disabled} onClick={item.onClick}>{item.text ?? <Icon id={item.icon ?? ''} />}</button>
    case 'go':
      return <button key={key} className="wb-dock-go" disabled={item.disabled} title={item.title ?? appConfig.copy.done} aria-label={item.title ?? appConfig.copy.done} onClick={item.onClick}><Icon id="check" /></button>
    case 'glyph':
      return <span key={key} className="wb-dock-ic wb-dock-shape">{item.node}</span>
    case 'action':
      return <button key={key} className={item.cls ?? 'wb-dock-tog'} disabled={item.disabled} title={item.label} aria-label={item.label} onClick={item.onClick}><Icon id={item.icon} /></button>
    case 'colors':
      // 2-wide grid (same as colorGrid) so the swatches form a compact block instead of a tall
      // single-file ribbon — keeps the whole dock short without wrapping the dock itself
      // ⚠️ Every swatch gets a NAME. A bare coloured square has no accessible label at all, and
      // on this app a colour is not decoration — a Truppfarbe is which crew this is. The hex is
      // not a name either (that was the other half of the finding), so the swatches are numbered
      // in the palette's own order: «Farbe 3».
      return <div key={key} className="wb-sw-grid">{(item.colors ?? COLORS).map((c, i) => <button key={c} className={`wb-sw ${item.value === c ? 'on' : ''}`} style={{ background: c }} onClick={() => item.onChange(c)} title={swatchName(undefined, i)} aria-label={swatchName(undefined, i)} />)}</div>
    case 'colorGrid':
      return <div key={key} className="wb-sw-grid">{item.colors.map((c, i) => <button key={c} className={`wb-sw ${item.value === c ? 'on' : ''}`} style={{ background: c }} onClick={() => item.onChange(c)} title={swatchName(item.title, i)} aria-label={swatchName(item.title, i)} />)}</div>
    case 'widths':
      return <Fragment key={key}>{(item.widths ?? WIDTHS).map((w) => <button key={w} className={`wb-ww ${item.value === w ? 'on' : ''}`} onClick={() => item.onChange(w)}
        title={fillTemplate(appConfig.copy.toolDock.widthName, { n: String(w) })}
        aria-label={fillTemplate(appConfig.copy.toolDock.widthName, { n: String(w) })}><span style={{ height: w }} /></button>)}</Fragment>
    case 'info':
      return <DockInfo key={key} text={item.text} />
  }
}

/**
 * The right-edge tool option dock. `groups` are rendered in order with a `wb-style-sep` divider
 * between them; empty groups are dropped so an absent control (e.g. the ✓ that only shows in node
 * mode) leaves no stray separator.
 *
 * Controls only — no line of text (20.10.2026, owner: «Remove the line. I don't think they add
 * any value.»). The phone's one-line hint row (3am test r3, 25.09.2026) is gone on every surface;
 * what an armed tool expects is its ⓘ (`info` item).
 */
export function ToolDock({ groups }: { groups: DockItem[][] }) {
  const visible = groups.filter((g) => g.length)
  const ref = useRef<HTMLDivElement>(null)
  const level = useRailLevel(ref, !useIsPhone())
  return (
    <div ref={ref} className="wb-dock wb-dock-map" style={level}>
      {visible.map((g, gi) => (
        <Fragment key={gi}>
          {gi > 0 && <span className="wb-style-sep" />}
          {g.map((item, ii) => renderItem(item, `${gi}-${ii}`))}
        </Fragment>
      ))}
    </div>
  )
}

/** The tablet column dock stands level with the tool rail beside it: same top edge, and never
 *  past the rail band's foot (owner 20.10.2026: centred on the screen, the shorter dock stood
 *  higher than the rail). The rail is centred in the band under the top bar and its height
 *  follows its tools, so the dock reads the rail's top rather than guessing it. Off on a phone,
 *  where the dock is a bottom bar (15-mobile) and the CSS centring is the fallback until measured. */
function useRailLevel(ref: RefObject<HTMLDivElement | null>, on: boolean): CSSProperties | undefined {
  const [level, setLevel] = useState<CSSProperties>()
  useLayoutEffect(() => {
    const dock = ref.current
    const rail = on ? document.querySelector<HTMLElement>('.tool-rail') : null
    if (!dock || !rail) { setLevel(undefined); return }
    const read = () => {
      const host = (dock.offsetParent as HTMLElement | null)?.getBoundingClientRect().top ?? 0
      const top = rail.getBoundingClientRect().top
      setLevel({ top: top - host, transform: 'none', maxHeight: window.innerHeight - top - 16 })
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(rail)
    window.addEventListener('resize', read)
    return () => { ro.disconnect(); window.removeEventListener('resize', read) }
  }, [ref, on])
  return level
}
