import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { DockInfo } from './DockInfo'
import { useIsPhone } from '../lib/useIsPhone'
import { useRailLabels } from '../lib/useDevicePrefs'

/**
 * One declarative description of every control that can sit in a tool dock. The Lage map and the
 * Plan/Gebäude whiteboard both build their docks out of these — same code, same look; any
 * surface-specific difference is expressed as a different group/item list, never a fork of the
 * markup. (Both surfaces share the `.wb-dock` CSS, so this stays purely a renderer.)
 *
 * Every item has a WORD (ToolDock · `worded`). The colour swatches, width steps and lettered
 * S/M/L toggles the dock once carried left it with «D pur» (09.09.2026: styling happens after the
 * draw, in the editor) and are gone from this list (round 15.11.2026) – a new item brings its word.
 *
 * A control's `label` is its title and accessible name. Where that is longer than a tile's word
 * room (the tablet column's ≈74px: «Mehrere platzieren», «Zurücksetzen»; round 15.11.2026 r2, owner:
 * «check some of the widths of words») the item brings a `short` – its own `…Short` copy key – and
 * the tile wears that; the long form stays the title / aria-label / long-press tip.
 */
export type DockItem =
  /** Listed first by every caller, but the dock draws it at the END: «X on the right everywhere»
   *  (owner, sweep 27.10.2026 #3) — the phone's bar reads [options · ⓘ | ✕]. It stays put:
   *  `.wb-dock-x` is sticky at the trailing end of the scrolling bar, and the tablet's column
   *  lifts it back to its head with `order` (09-whiteboard.css), so the way out of a tool never
   *  scrolls away with a busy tool's options. */
  | { type: 'close'; onClick: () => void; title?: string }
  | { type: 'toggle'; icon: string; label: string; short?: string; on: boolean; onClick: () => void; disabled?: boolean }
  /** «✓ Fertig» — commits the draft being drawn (a Punkte-Linie, -Fläche, a Wand). The one FILLED
   *  tile (M7 C, 13.11.2026): the control that commits, not a ✕ look-alike; the ✕ beside it closes,
   *  and a committable draft is asked about, never thrown away (useMapDrawing · settleDraft). */
  | { type: 'go'; onClick: () => void; disabled?: boolean; title?: string }
  | { type: 'action'; icon: string; label: string; short?: string; onClick: () => void; disabled?: boolean; cls?: string }
  | { type: 'info'; text: string }

/** a dock tile's word under its glyph, the rail tile's `.vrail-label` look (09-whiteboard) */
const word = (w: string, on: boolean) => on ? <span className="wb-dock-word">{w}</span> : null

/** One dock tile – the ToolDock's own, and the symbol's [Mehrere · ✕] beside the armed pill
 *  (ArmedToolPill), so the two are the same control by construction, not by a copied look. */
export function DockTile({ item, worded }: { item: DockItem; worded: boolean }): ReactNode {
  switch (item.type) {
    case 'close':
      return <button className="wb-dock-x" title={item.title ?? appConfig.copy.cancel} aria-label={item.title ?? appConfig.copy.cancel} onClick={item.onClick}><Icon id="close" />{word(appConfig.copy.cancel, worded)}</button>
    case 'toggle':
      return <button className={`wb-dock-tog ${item.on ? 'on' : ''}`} title={item.label} aria-label={item.label} aria-pressed={item.on} disabled={item.disabled} onClick={item.onClick}><Icon id={item.icon} />{word(item.short ?? item.label, worded)}</button>
    case 'go':
      return <button className="wb-dock-go" disabled={item.disabled} title={item.title ?? appConfig.copy.done} aria-label={item.title ?? appConfig.copy.done} onClick={item.onClick}><Icon id="check" />{word(item.title ?? appConfig.copy.done, worded)}</button>
    case 'action':
      return <button className={item.cls ?? 'wb-dock-tog'} disabled={item.disabled} title={item.label} aria-label={item.label} onClick={item.onClick}><Icon id={item.icon} />{word(item.short ?? item.label, worded)}</button>
    case 'info':
      return <DockInfo text={item.text} word={worded ? appConfig.copy.toolDock.infoWord : undefined} />
  }
}

/**
 * The right-edge tool option dock. `groups` are rendered in order with a wider gap between them
 * (`wb-dock-gap`) – no divider line (M8 rework, 21.10.2026, owner: the lines add nothing); empty
 * groups are dropped so an absent control (e.g. the ✓ that only shows in node mode) leaves no
 * stray gap.
 *
 * Controls only — no line of text (20.10.2026, owner: «Remove the line. I don't think they add
 * any value.»). The phone's one-line hint row (3am test r3, 25.09.2026) is gone on every surface;
 * what an armed tool expects is its ⓘ (`info` item).
 *
 * The dock follows the rails (round 2b, 13.11.2026; round 15.11.2026 #2, owner: «adding the
 * subtitles there too when enabled in settings»): with «Beschriftung der Werkzeugleisten» on,
 * EVERY item wears its word under its glyph like a rail tile («Abbrechen», the mode names,
 * «Fertig», «Info») – on the tablet's column and on the phone's row alike; off, every item is a
 * bare glyph. Never a mix, so the dock reads as one family.
 *
 * Controls only, and no tile that repeats the armed pill (button sweep CHROME.11, 17.11.2026): a
 * Form's name is the pill's (ArmedToolPill), the dock carries its ✕, «Mehrere» and ⓘ.
 */
export function ToolDock({ groups }: { groups: DockItem[][] }) {
  // the ✕ leaves its group for the dock's end (see DockItem · close); it carries its own group gap
  const isClose = (item: DockItem) => item.type === 'close'
  const close = groups.flat().filter(isClose)
  const visible = groups.map((g) => g.filter((item) => !isClose(item))).filter((g) => g.length)
  const ref = useRef<HTMLDivElement>(null)
  const phone = useIsPhone()
  const level = useRailLevel(ref, !phone)
  const worded = useRailLabels() === 'short'
  return (
    <div ref={ref} className={`wb-dock wb-dock-map${worded ? ' wb-dock-worded' : ''}`} style={level}>
      {visible.map((g, gi) => (
        <Fragment key={gi}>
          {gi > 0 && <span className="wb-dock-gap" aria-hidden />}
          {g.map((item, ii) => <DockTile key={`${gi}-${ii}`} item={item} worded={worded} />)}
        </Fragment>
      ))}
      {close.map((item, i) => <DockTile key={`x-${i}`} item={item} worded={worded} />)}
    </div>
  )
}

/** The tablet column dock stands level with the tool rail beside it: same top edge, and never
 *  past the rail band's foot (owner 20.10.2026: centred on the screen, the shorter dock stood
 *  higher than the rail). The rail is centred in the band under the top bar and its height
 *  follows its tools, so the dock reads the rail's top rather than guessing it. The foot is the
 *  view bar's top less the floating gap where the bar stands in the corner (07-toolrail ·
 *  .view-bar), the screen's 16px edge otherwise. Off on a phone, where the dock is a bottom bar
 *  (15-mobile) and the CSS centring is the fallback until measured. */
function useRailLevel(ref: RefObject<HTMLDivElement | null>, on: boolean): CSSProperties | undefined {
  const [level, setLevel] = useState<CSSProperties>()
  useLayoutEffect(() => {
    const dock = ref.current
    const rail = on ? document.querySelector<HTMLElement>('.tool-rail') : null
    if (!dock || !rail) { setLevel(undefined); return }
    const read = () => {
      const host = (dock.offsetParent as HTMLElement | null)?.getBoundingClientRect().top ?? 0
      const top = rail.getBoundingClientRect().top
      const bar = document.querySelector('.view-bar')?.getBoundingClientRect()
      const foot = bar?.height ? bar.top - 8 : window.innerHeight - 16
      setLevel({ top: top - host, transform: 'none', maxHeight: foot - top })
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(rail)
    window.addEventListener('resize', read)
    return () => { ro.disconnect(); window.removeEventListener('resize', read) }
  }, [ref, on])
  return level
}
