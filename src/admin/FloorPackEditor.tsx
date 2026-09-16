import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { Icon } from '../lib/icons'
import { joinShifts } from '../lib/floorPackBinding'
import { ActionMenu } from './ui'
import { hasMarkerWarnings } from './markerNotes'
import { alignmentPagePreview, type AlignmentItem } from './planAlignmentApi'
import type { PlanFloor } from '../lib/api/reference'
import {
  appendFloor, clampToClip, defaultStack, dropFromStack, entryJoined, floorsFromStack, hitJoinPoint, indexOf, joinPointClip, moveJoinPoint, patchEntry, reorderStack,
  restoreToStack, reverseStack, sameStack, signedIndex, stackComplete, stackFromFloors, standardFloorName, trayOf, type Clip, type FloorEntry, type FloorStack, type JoinPointHit, type Pt,
} from './floorPack'

/**
 * «Geschosse» – the floors tab of the full-screen plan preparation, where a PDF becomes a floor
 * pack (mock A «Inspektor rechts», 15.09.2026): the SHEET on the left, the storey rows on the
 * right. The admin stacks the floors like the building, top floor first, taps ONE index to say
 * «this is level 0», names a floor, and – on an A0/A1 that carries several floors – draws a
 * rectangle around each drawing and JOINS two floors at a time: a point in one drawing, the same
 * point (staircase, lift, grid crossing) in another. Joined floor by floor, the sheet's drawings
 * are laid on each other. A row without a rectangle is a whole page. The server moves the shared
 * map fit onto the level-0 page and re-queues it there.
 *
 * Every row is a record row – index · name · its state as WORDS – and the SELECTED one expands in
 * place into its inspector, so what is being edited stands where it was read. The COLUMN owns
 * everything that is not one floor's business: the dashed row at its foot adds the next storey
 * BELOW the lowest (which is how a building is read downwards), the kebab in its head holds what
 * concerns the whole list («Wie im PDF», «Umkehren», «Zurücksetzen»), and reordering is the grip.
 *
 * ⚠️ The fit page belongs to the PAGE, not to the floor: `stack.fitPage` is a page number, so on
 * a pack whose floors all sit on one page there is nothing to choose and the row is a sentence.
 * Indices are never typed. An approved fit is locked to its page – the server refuses to move it
 * (409) and the copy says why, so nothing moves under a running Einsatz's feet.
 *
 * The editor never saves and never undoes on its own: the full-screen editor (`FloorPackDetail`)
 * owns ONE save for floors + fit, reads the draft through `onDraft`, and drives undo through
 * `historyRef`/`onUndoState`. `view` says which of its tabs is up – the draft stays mounted.
 *
 * ⚠️ It also draws the editor's ONE bar (15.09.2026, second pass): the tabs come in as `tabs` and
 * stand in the same row as the sheet's zoom and the floors column's head. That is why the editor
 * is mounted on the Karte tab too, where it is the bar and nothing else – the row used to be two
 * (tabs, then an almost empty sheet toolbar holding the zoom cluster alone).
 */
type Mode = { key: string; kind: 'region' } | { key: string; kind: 'join'; at?: Pt } | null

export interface FloorDraft { floors: PlanFloor[]; fitPage?: number; dirty: boolean; complete: boolean }

export function FloorPackEditor({ item, onDraft, view, tabs, historyRef, onUndoState, mapPreview }: {
  item: AlignmentItem
  onDraft?: (draft: FloorDraft) => void
  /** which tab is up – `map` shows the bar alone, because the Karte tab's pane is the parent's */
  view: 'edit' | 'map' | 'preview'
  /** the full-screen editor's tab switch, drawn into the bar's first slot */
  tabs?: ReactNode
  historyRef?: React.RefObject<{ undo: () => void } | null>
  onUndoState?: (canUndo: boolean) => void
  /** the fit as the field will see it, built by the full-screen editor (it owns the map preview
   *  and the fit page's image); it is the Vorschau's FIRST tile, spanning the row. Left out
   *  where no fit stands – then there is no tile and nothing said about it. */
  mapPreview?: ReactNode
}) {
  const C = appConfig.copy.admin.alignment.floors
  const pageCount = item.page_count ?? 0
  const published = stackFromFloors(item.floors, item.page)
  const [history, setHistory] = useState<{ stack: FloorStack; past: FloorStack[] }>(() => ({ stack: published ?? defaultStack(pageCount), past: [] }))
  const stack = history.stack
  const setStack = (change: FloorStack | ((s: FloorStack) => FloorStack)) => setHistory((h) => {
    const next = typeof change === 'function' ? change(h.stack) : change
    return sameStack(next, h.stack) ? h : { stack: next, past: [...h.past, h.stack] }
  })
  const [mode, setMode] = useState<Mode>(null)
  const undo = () => { setHistory((h) => h.past.length ? { stack: h.past[h.past.length - 1], past: h.past.slice(0, -1) } : h); setMode(null) }
  useEffect(() => {
    if (historyRef) historyRef.current = { undo }
    onUndoState?.(history.past.length > 0)
    return () => { if (historyRef) historyRef.current = null }
  }, [history.past.length, historyRef, onUndoState])
  const [zoom, setZoom] = useState(1)
  const [selected, setSelected] = useState<string | null>(() => (published ?? defaultStack(0)).zero || null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  // a fresh answer from the server (our save, or somebody else's) resets the draft: the parent
  // keys this editor by the item's edit_version, so it simply mounts anew
  const dirty = !sameStack(stack, published)
  const locked = item.status === 'approved'
  const tray = trayOf(stack, pageCount)
  const zeroEntry = stack.order.find((e) => e.key === stack.zero)
  /** the page the shared map fit is measured on – the explicit choice, or level 0's page. It is a
   *  PAGE, so on a pack whose floors all sit on one page there is nothing to choose. */
  const fitPage = stack.fitPage ?? zeroEntry?.page
  const pages = new Set(stack.order.map((e) => e.page))
  const anyRegion = stack.order.some((e) => e.clip)
  const selectedEntry = stack.order.find((e) => e.key === selected) ?? zeroEntry ?? stack.order[0]
  const sheetPage = selectedEntry?.page ?? item.page
  const complete = stackComplete(stack)
  useEffect(() => { onDraft?.({ floors: floorsFromStack(stack), fitPage: stack.fitPage, dirty, complete }) }, [stack, dirty, complete]) // eslint-disable-line react-hooks/exhaustive-deps
  const regionsOn = (page: number) => stack.order.filter((e) => e.page === page && e.clip)
  /** «Geschoss hinzufügen», the dashed row at the FOOT of the list: the next storey BELOW the
   *  lowest, on the same page as that one – or, on a fresh single-page pack, the one whole-page
   *  entry itself becomes the first drawing (= level 0). Then straight into region mode; the
   *  rectangle hands over to the join when another drawing is already there. */
  const addFloor = () => {
    const fresh = stack.order.length === 1 && !stack.order[0].clip && pageCount === 1
    if (fresh) { setSelected(stack.order[0].key); setMode({ key: stack.order[0].key, kind: 'region' }); return }
    const page = stack.order[stack.order.length - 1]?.page ?? sheetPage
    const { stack: next, key } = appendFloor(stack, page)
    setStack(next)
    setSelected(key); setMode({ key, kind: 'region' })
  }
  /** what concerns the whole list rather than one floor – the kebab in the column's head */
  const listActions = [
    { label: C.orderPdf, onClick: () => setStack((s) => ({ ...s, order: [...s.order].sort((a, b) => a.page - b.page) })) },
    { label: C.orderReverse, onClick: () => setStack(reverseStack) },
    { label: C.reset, disabled: !dirty, onClick: () => { setHistory({ stack: published ?? defaultStack(pageCount), past: [] }); setMode(null) } },
  ]

  const labelOf = (e: FloorEntry) => `${signedIndex(indexOf(stack, e.key))} · ${e.name || standardFloorName(indexOf(stack, e.key))}`

  return <section className={`adm-floors${view === 'map' ? ' adm-floors-baronly' : ''}`} aria-label={C.title}>
    {/* ONE row over both columns: the editor's tabs left, then – only where there is a sheet to
        look at – what belongs to the SHEET (which page, how close) right above it, and the floors
        column's own head above its column. The zoom is the Geschosse tab's business: the Karte
        tab has the map's own zoom, the Vorschau none. */}
    <div className={`adm-floors-bar${view === 'edit' ? '' : ' solo'}`}>
      <div className="adm-floors-bar-main">
        {tabs}
        {view === 'edit' && <div className="adm-floors-bar-tools">
          {mode && <button type="button" className="btn" onClick={() => setMode(null)}>{appConfig.copy.cancel}</button>}
          {pageCount > 1 && <span className="adm-hint" role="status">{fillTemplate(C.pageOf, { n: sheetPage + 1, total: pageCount })}</span>}
          <div className="adm-floors-zoom">
            <button type="button" aria-label={appConfig.copy.nav.zoomOut} disabled={zoom <= 1} onClick={() => setZoom((z) => Math.max(1, z / 1.5))}><Icon id="minus" /></button>
            <button type="button" className="adm-floors-zoom-value" onClick={() => setZoom(1)}>{Math.round(zoom * 100)} %</button>
            <button type="button" aria-label={appConfig.copy.nav.zoomIn} disabled={zoom >= 4} onClick={() => setZoom((z) => Math.min(4, z * 1.5))}><Icon id="plus" /></button>
          </div>
        </div>}
      </div>
      {/* the head names the column against the sheet beside it and carries the list's own menu –
          the «4 Geschosse · +1 bis −2» line said what the rows already say, and is gone */}
      {view === 'edit' && <div className="adm-floors-colhead"><h4>{C.title}</h4>
        <ActionMenu ariaLabel={C.menu} actions={listActions} />
      </div>}
    </div>
    {view === 'preview' && <FloorPreview item={item} floors={floorsFromStack(stack)} fitPage={stack.fitPage ?? zeroEntry?.page ?? item.page} map={mapPreview} />}
    <div className="adm-floors-split" hidden={view !== 'edit'}>
      <div className="adm-floors-sheetcol">
        <FloorSheet zoom={zoom} item={item} page={sheetPage} entries={stack.order} selected={selectedEntry?.key ?? null} mode={mode} labelOf={labelOf} indexOf={(k) => indexOf(stack, k)} zero={stack.zero}
          onClip={(key, clip) => { setStack((s) => patchEntry(s, key, { clip })); setMode(regionsOn(sheetPage).some((e) => e.key !== key) ? { key, kind: 'join' } : null) }}
          onJoinAt={(key, at) => setMode({ key, kind: 'join', at })}
          onJoin={(key, at, toKey, there) => { setStack((s) => patchEntry(s, key, { join: { toKey, at, there } })); setMode(null) }}
          onMove={(key, clip, dx, dy) => setStack((s) => ({
            ...s,
            // the rectangle and its own join point move; a join of ANOTHER floor that lands in this
            // drawing (its `there`) moves with it too – the staircase went along
            order: s.order.map((e) => e.key === key
              ? { ...e, clip, ...(e.join ? { join: { ...e.join, at: [e.join.at[0] + dx, e.join.at[1] + dy] as Pt } } : {}) }
              : e.join?.toKey === key ? { ...e, join: { ...e.join, there: [e.join.there[0] + dx, e.join.there[1] + dy] as Pt } } : e),
          }))}
          onMovePoint={(hit, at) => setStack((s) => moveJoinPoint(s, hit, [round(at[0]), round(at[1])]))}
          onSelect={setSelected} />
      </div>
      <aside className="adm-floors-col">
        {/* ONE line, and only here: a pack with nothing assigned yet is a fact about this column,
            not about the Vorschau or the Karte, where it used to repeat as an amber band.
            When the reason is the PDF's own broken §-markers, the editor's header already lists
            them – the column only says that THAT is why it is empty, rather than repeating the
            whole note half a screen further down. */}
        {!published && (hasMarkerWarnings(item)
          ? <p className="adm-hint adm-floors-none" role="status">{C.noneMarkers}</p>
          : <p className="adm-hint adm-floors-none" role="status">{C.none}</p>)}
        <div className="adm-floors-stack" role="list" onDragOver={(e) => { if (dragging != null) { e.preventDefault(); setOver(null) } }}
          onDrop={(e) => { e.preventDefault(); if (dragging != null) setStack((s) => reorderStack(s, dragging, undefined)); setDragging(null); setOver(null) }}>
          {stack.order.map((entry) => {
            const active = entry.key === selectedEntry?.key
            const joined = entryJoined(stack, entry.key)
            const index = indexOf(stack, entry.key)
            const zero = entry.key === stack.zero
            const standard = standardFloorName(index)
            const chip = signedIndex(index)
            // Only what DIFFERS between the rows: the page on a one-page pack is not news, nor is
            // «Ganze Seite» where no floor is a region, nor «Verbunden» where nothing shares a
            // page. «Nicht verbunden» always stands – it is the one thing that blocks the save.
            const state = entry.clip
              ? (!joined ? C.stateUnjoined : regionsOn(entry.page).length > 1 ? C.stateJoined : null)
              : anyRegion ? C.stateWhole : null
            const tags = <span className="adm-floor-tags">
              {pageCount > 1 && <span className="adm-floor-tag">{fillTemplate(C.page, { n: entry.page + 1 })}</span>}
              {state && <span className={`adm-floor-tag${entry.clip && !joined ? ' warn' : ''}`}>{state}</span>}
              {pages.size > 1 && fitPage === entry.page && <span className="adm-floor-tag on">{C.stateReference}</span>}
            </span>
            const name = <b>{entry.name || standard}</b>
            return <div key={entry.key} role="listitem" aria-label={labelOf(entry)} className={`adm-floor${active ? ' active' : ''}${dragging === entry.key ? ' dragging' : ''}${over === entry.key ? ' over' : ''}`}
              onClick={() => setSelected(entry.key)}
              onDragOver={(e) => { if (dragging != null && dragging !== entry.key) { e.preventDefault(); e.stopPropagation(); setOver(entry.key) } }}
              onDrop={(e) => { e.preventDefault(); e.stopPropagation(); if (dragging != null) setStack((s) => reorderStack(s, dragging, entry.key)); setDragging(null); setOver(null) }}>
              <div className="adm-floor-head">
                <span className="adm-floor-grip" draggable onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDragging(entry.key) }} onDragEnd={() => { setDragging(null); setOver(null) }} aria-hidden><Icon id="move" /></span>
                {/* the chip says WHICH storey; on the open row it is also the one tap that says
                    «this one is level 0» – nested in a select button it could never be that */}
                {active
                  ? <button type="button" className={`adm-floor-index${zero ? ' zero' : ''}`} aria-pressed={zero} title={zero ? C.isZero : C.makeZero} aria-label={`${chip} · ${zero ? C.isZero : C.makeZero}`}
                    onClick={(e) => { e.stopPropagation(); setStack((s) => ({ ...s, zero: entry.key })) }}>{chip}</button>
                  : <span className="adm-floor-index">{chip}</span>}
                {active
                  ? <span className="adm-floor-id">{name}{tags}</span>
                  : <button type="button" className="adm-floor-select" aria-pressed={false} onClick={() => setSelected(entry.key)}>
                    <span className="adm-floor-id">{name}{tags}</span>
                  </button>}
                {/* the page goes back to the Ablage, so this ENTFERNT a floor – it deletes
                    nothing – and it stands in the open row's head, where what is being edited is */}
                {active && <button type="button" className="btn adm-floor-remove" aria-label={C.remove} title={C.remove} disabled={stack.order.length <= 1}
                  onClick={(e) => { e.stopPropagation(); setStack((s) => dropFromStack(s, entry.key)); setMode(null) }}><Icon id="close" /></button>}
              </div>
              {active && <div className="adm-floor-body">
                <input className="adm-input adm-floor-name" value={entry.name} placeholder={fillTemplate(C.namePlaceholder, { name: standard })} aria-label={fillTemplate(C.standardName, { name: standard })} maxLength={80}
                  onChange={(e) => setStack((s) => patchEntry(s, entry.key, { name: e.target.value }))} />
                {/* the fit belongs to the page, so it is a setting to read, not a chip to decode */}
                {locked ? <p className="adm-hint adm-floor-fit-note">{C.fitLocked}</p>
                  : pages.size < 2 ? <p className="adm-hint adm-floor-fit-note">{fillTemplate(C.fitOnly, { n: (fitPage ?? entry.page) + 1 })}</p>
                  : <label className={`adm-floor-fit${fitPage === entry.page ? ' on' : ''}`}>
                    <input type="checkbox" className="adm-set-check" checked={fitPage === entry.page} disabled={fitPage === entry.page}
                      onChange={() => setStack((s) => ({ ...s, fitPage: entry.page === zeroEntry?.page ? undefined : entry.page }))} />
                    <span><b>{C.fitHere}</b><small>{C.fitWhy}</small></span>
                  </label>}
                <div className="adm-floor-acts">
                  <button type="button" className="btn adm-floor-mode" aria-pressed={mode?.key === entry.key && mode.kind === 'region'} title={C.regionHint.replace('{floor}: ', '')}
                    onClick={(e) => { e.stopPropagation(); setSelected(entry.key); setMode((m) => m?.key === entry.key && m.kind === 'region' ? null : { key: entry.key, kind: 'region' }) }}><Icon id="marquee" />{C.region}</button>
                  <button type="button" className="btn adm-floor-mode" aria-pressed={mode?.key === entry.key && mode.kind === 'join'} disabled={stack.order.length < 2} title={C.joinWhat}
                    onClick={(e) => { e.stopPropagation(); setSelected(entry.key); setMode((m) => m?.key === entry.key && m.kind === 'join' ? null : { key: entry.key, kind: 'join' }) }}><Icon id="cross" />{C.join}</button>
                  {entry.clip && <button type="button" className="btn" onClick={(e) => { e.stopPropagation(); setStack((s) => ({ ...s, order: s.order.map((o) => o.key === entry.key ? { ...o, clip: undefined, join: undefined } : o.join?.toKey === entry.key ? { ...o, join: undefined } : o) })); setMode(null) }}>{C.wholePage}</button>}
                </div>
              </div>}
            </div>
          })}
        </div>
        {/* the next storey comes in at the FOOT of the list, one level below the lowest – where
            the eye already is after reading the stack downwards. Outside the `role="list"`, so
            the list stays a list of floors. */}
        <button type="button" className="adm-formlink-add adm-floors-add" disabled={!!mode} onClick={addFloor}><Icon id="plus" />{C.addFloor}</button>
        <div className="adm-floors-tray"><span>{C.tray}</span>
          <span className="adm-floors-tray-pages">{tray.length === 0 ? <span className="adm-hint">{C.trayEmpty}</span>
            : tray.map((page) => <button key={page} type="button" className="btn" onClick={() => setStack((s) => restoreToStack(s, page))} title={C.restore}>{fillTemplate(C.page, { n: page + 1 })} · {C.restore}</button>)}</span></div>
      </aside>
    </div>
  </section>
}

/** The sheet: one page as its exact raster, the floors on it as rectangles and join lines. In
 *  `region` mode a drag draws the selected floor's rectangle; in `join` mode the first tap picks a
 *  point in the floor's own drawing, the second the same point in another drawing. Outside any
 *  mode a press GRABS: a join point if one is within reach, otherwise the rectangle under the
 *  finger. Coordinates are normalized to the page, exactly what the pack fit speaks. */
function FloorSheet({ zoom, item, page, entries, selected, mode, labelOf, indexOf: indexOfKey, zero, onClip, onJoinAt, onJoin, onMove, onMovePoint, onSelect }: {
  zoom: number; item: AlignmentItem; page: number; entries: FloorEntry[]; selected: string | null; mode: Mode
  labelOf: (e: FloorEntry) => string; indexOf: (key: string) => number; zero: string
  onClip: (key: string, clip: Clip) => void
  onJoinAt: (key: string, at: Pt) => void
  onJoin: (key: string, at: Pt, toKey: string, there: Pt) => void
  /** a placed rectangle dragged to a new place */
  onMove: (key: string, clip: Clip, dx: number, dy: number) => void
  /** a placed join point dragged to a new place – the reference point, not its drawing */
  onMovePoint: (hit: JoinPointHit, at: Pt) => void
  onSelect: (key: string) => void
}) {
  const C = appConfig.copy.admin.alignment.floors
  const source = `${item.id}:${page}`
  const [preview, setPreview] = useState<{ source: string; url: string | null; failed: boolean } | null>(null)
  const url = preview?.source === source ? preview.url : null
  const failed = preview?.source === source && preview.failed
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const moving = useRef<{ kind: 'clip'; key: string; from: Pt; clip: Clip } | { kind: 'point'; hit: JoinPointHit } | null>(null)
  const [shift, setShift] = useState<{ key: string; dx: number; dy: number } | null>(null)
  /** the join point under the finger while it is being dragged – drawn there, committed on release */
  const [held, setHeld] = useState<{ hit: JoinPointHit; at: Pt } | null>(null)
  const [aim, setAim] = useState<{ point: Pt; left: number; top: number } | null>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })
  const [pageAspect, setPageAspect] = useState(item.aspect ?? 1.414)
  const box = useRef<HTMLDivElement>(null)
  const visibleEntries = entries.filter((e) => e.page === page)
  const [size, setSize] = useState({ width: 1000, height: 1000 / (item.aspect ?? 1.414) })
  useEffect(() => {
    const el = viewport.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const { width, height } = el.getBoundingClientRect()
      if (width > 0 && height > 0) setViewportSize({ width, height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const { width, height } = el.getBoundingClientRect()
      if (width > 0 && height > 0) setSize({ width, height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const abort = new AbortController()
    let made: string | undefined
    void alignmentPagePreview(item.id, page, abort.signal).then((blob) => {
      if (abort.signal.aborted) return
      made = URL.createObjectURL(blob); setPreview({ source, url: made, failed: false })
    }).catch(() => { if (!abort.signal.aborted) setPreview({ source, url: null, failed: true }) })
    return () => { abort.abort(); if (made) URL.revokeObjectURL(made) }
  }, [item.id, page, source])
  const norm = (e: ReactPointerEvent): Pt | null => {
    const r = box.current?.getBoundingClientRect()
    if (!r || !r.width || !r.height) return null
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]
  }
  const inside = (p: Pt, c: Clip) => p[0] >= c[0] && p[0] <= c[2] && p[1] >= c[1] && p[1] <= c[3]
  const hitRegion = (p: Pt, except?: string) => visibleEntries.filter((en) => en.clip && en.key !== except && inside(p, en.clip))
    .sort((a, b) => (a.clip![2] - a.clip![0]) * (a.clip![3] - a.clip![1]) - (b.clip![2] - b.clip![0]) * (b.clip![3] - b.clip![1]))[0]
  const modeEntry = mode ? entries.find((e) => e.key === mode.key) : undefined
  const clampShift = (c: Clip, dx: number, dy: number): Pt => [Math.min(1 - c[2], Math.max(-c[0], dx)), Math.min(1 - c[3], Math.max(-c[1], dy))]
  const down = (e: ReactPointerEvent) => {
    const p = norm(e); if (!p) return
    setAim({ point: p, left: e.clientX, top: e.clientY })
    moving.current = null; setShift(null); setHeld(null)
    if (!mode) {
      // the points are the smallest marks and they sit INSIDE the rectangles, so they are asked
      // first: grabbing a staircase point must not drag the whole drawing away under it
      const point = hitJoinPoint(entries, page, p, size, POINT_GRAB)
      if (point) {
        e.preventDefault(); e.stopPropagation()
        ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
        onSelect(point.key)
        moving.current = { kind: 'point', hit: point }
        setHeld({ hit: point, at: clampToClip(p, joinPointClip(entries, point)) })
        return
      }
      const hit = hitRegion(p)
      if (!hit?.clip) return
      e.preventDefault(); e.stopPropagation()
      ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
      onSelect(hit.key)
      moving.current = { kind: 'clip', key: hit.key, from: p, clip: hit.clip }
      return
    }
    if (!modeEntry) return
    e.preventDefault(); e.stopPropagation()
    if (mode.kind === 'join') {
      if (!mode.at) { if (modeEntry.page === page && (!modeEntry.clip || inside(p, modeEntry.clip))) onJoinAt(mode.key, [round(p[0]), round(p[1])]); return }
      const picked = visibleEntries.find((entry) => entry.key === selected && entry.key !== mode.key && (!entry.clip || inside(p, entry.clip)))
      const other = picked ?? hitRegion(p, mode.key) ?? visibleEntries.find((entry) => entry.key !== mode.key && !entry.clip)
      if (other) onJoin(mode.key, mode.at, other.key, [round(p[0]), round(p[1])])
      return
    }
    if (modeEntry.page !== page) return
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    setDraft({ x0: p[0], y0: p[1], x1: p[0], y1: p[1] })
  }
  const move = (e: ReactPointerEvent) => {
    const p = norm(e); if (!p) return
    setAim({ point: p, left: e.clientX, top: e.clientY })
    if (moving.current?.kind === 'point') { const hit = moving.current.hit; setHeld({ hit, at: clampToClip(p, joinPointClip(entries, hit)) }); return }
    if (moving.current) { const [dx, dy] = clampShift(moving.current.clip, p[0] - moving.current.from[0], p[1] - moving.current.from[1]); setShift({ key: moving.current.key, dx, dy }); return }
    if (draft) setDraft({ ...draft, x1: p[0], y1: p[1] })
  }
  const up = () => {
    if (moving.current?.kind === 'point') {
      const { hit } = moving.current; moving.current = null
      // one undo step per drag; a point put back where it was changes nothing and makes none
      if (held) onMovePoint(hit, held.at)
      setHeld(null); return
    }
    if (moving.current) {
      const m = moving.current; moving.current = null
      if (shift && (Math.abs(shift.dx) > 0.002 || Math.abs(shift.dy) > 0.002)) {
        const dx = round(shift.dx), dy = round(shift.dy)
        onMove(m.key, [round(m.clip[0] + dx), round(m.clip[1] + dy), round(m.clip[2] + dx), round(m.clip[3] + dy)], dx, dy)
      }
      setShift(null); return
    }
    if (!draft || !mode) { setDraft(null); return }
    const x0 = Math.min(draft.x0, draft.x1), x1 = Math.max(draft.x0, draft.x1), y0 = Math.min(draft.y0, draft.y1), y1 = Math.max(draft.y0, draft.y1)
    setDraft(null)
    if (x1 - x0 < 0.02 || y1 - y0 < 0.02) return // a tap, not a rectangle
    onClip(mode.key, [round(x0), round(y0), round(x1), round(y1)])
  }
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`
  const hint = mode && modeEntry
    ? mode.kind === 'region' ? fillTemplate(C.regionHint, { floor: labelOf(modeEntry) }) : mode.at ? C.joinHint2 : fillTemplate(C.joinHint1, { floor: labelOf(modeEntry) })
    : null
  const shifted = (key: string, p: Pt): Pt => shift?.key === key ? [p[0] + shift.dx, p[1] + shift.dy] : p
  return <div className="adm-floors-paper"><div ref={viewport} className="adm-floors-viewport"><div style={{ width: viewportSize.width ? Math.min(viewportSize.width, viewportSize.height * pageAspect) * zoom : `${zoom * 100}%` }} ref={box} className={`adm-floors-sheet${mode ? ' drawing' : ''}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={() => setAim(null)} onPointerCancel={() => { setAim(null); moving.current = null; setShift(null); setHeld(null); setDraft(null) }}>
    {failed ? <div className="adm-floors-sheet-wait" role="alert">{appConfig.copy.admin.alignment.previewFailed}</div>
      : url ? <img src={url} alt={fillTemplate(C.page, { n: page + 1 })} draggable={false} onLoad={(e) => { if (e.currentTarget.naturalHeight) setPageAspect(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight) }} />
      : <div className="adm-floors-sheet-wait" role="status">{C.sheetLoading}</div>}
    {visibleEntries.map((e) => {
      const d = shift?.key === e.key ? shift : { dx: 0, dy: 0 }
      return e.clip ? <div key={e.key} className={`adm-floors-box${e.key === selected ? ' active' : ''}${shift?.key === e.key ? ' moving' : ''}`} style={{ left: pct(e.clip[0] + d.dx), top: pct(e.clip[1] + d.dy), width: pct(e.clip[2] - e.clip[0]), height: pct(e.clip[3] - e.clip[1]) }}>
        <span className={`adm-floor-index adm-floors-box-chip${e.key === zero ? ' zero' : ''}`}>{signedIndex(indexOfKey(e.key))}</span></div> : null
    })}
    {/* Pixel coordinates preserve circular targets on sheets of any aspect. Cross-page joins
        show only the endpoint belonging to this page; the other stays on its own sheet. */}
    <svg className="adm-floors-joins" viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" aria-hidden>
      {entries.filter((e) => e.join).map((e) => {
        const target = entries.find((o) => o.key === e.join!.toKey)
        const here = e.page === page, there = target?.page === page
        if (!here && !there) return null
        const grabbed = (end: 'at' | 'there') => held?.hit.key === e.key && held.hit.end === end ? held.at : null
        const a = grabbed('at') ?? shifted(e.key, e.join!.at), b = grabbed('there') ?? shifted(e.join!.toKey, e.join!.there)
        return <g key={`j-${e.key}`}>
          {here && there && <line x1={a[0] * size.width} y1={a[1] * size.height} x2={b[0] * size.width} y2={b[1] * size.height} />}
          {here && <circle className={grabbed('at') ? 'held' : undefined} cx={a[0] * size.width} cy={a[1] * size.height} r={6} />}
          {there && <circle className={grabbed('there') ? 'held' : undefined} cx={b[0] * size.width} cy={b[1] * size.height} r={6} />}
        </g>
      })}
      {mode?.kind === 'join' && mode.at && modeEntry?.page === page && <circle className="pending" cx={mode.at[0] * size.width} cy={mode.at[1] * size.height} r={8} />}
    </svg>
    {draft && <div className="adm-floors-box draft" style={{ left: pct(Math.min(draft.x0, draft.x1)), top: pct(Math.min(draft.y0, draft.y1)), width: pct(Math.abs(draft.x1 - draft.x0)), height: pct(Math.abs(draft.y1 - draft.y0)) }} />}
  </div></div>
    {/* the sentence stands ON the paper, where the eye is while drawing – dark while a mode is
        on (something is expected of you), quiet when it only says what the rectangles can do */}
    {hint ? <span className="adm-floors-hint" role="status">{hint}</span>
      : visibleEntries.some((e) => e.clip) ? <span className="adm-floors-hint quiet" role="status">{C.moveHint}</span> : null}
    {/* the loupe is for HITTING the same staircase twice – it belongs to the join, and nowhere
        else: while drawing or moving a rectangle it only covers the paper being worked on */}
    {url && aim && mode?.kind === 'join' && <div className="adm-floors-loupe" aria-hidden style={{
      left: Math.max(8, Math.min(window.innerWidth - 168, aim.left + 28)), top: Math.max(8, aim.top - 184),
      backgroundImage: `url("${url}")`, backgroundSize: `${size.width * 3}px ${size.height * 3}px`,
      backgroundPosition: `${80 - aim.point[0] * size.width * 3}px ${80 - aim.point[1] * size.height * 3}px`,
    }}><span /></div>}
  </div>
}
const round = (v: number) => Math.round(v * 10000) / 10000
/** how close a press has to be to a join point to grab it, in screen pixels – a 6px circle is a
 *  mark to read, not a target to hit, so the reach is a fingertip's */
const POINT_GRAB = 22


/**
 * The Vorschau tab: the pack as the Einsatz will read it, and NOTHING said in words (15.09.2026).
 *
 * A grid of tiles – one per floor, each the crop in the pack's common frame and scale (the same
 * join shifts and reference frame Gebäude uses, with no per-floor centering), captioned with the
 * floors list's own index chip and name. The tiles run in building order: top storey first,
 * top-down and left-to-right, exactly the order the list reads in.
 *
 * The one thing a crop cannot show – where level 0 LIES on the map – is the FIRST tile, spanning
 * the row. Where no fit stands there is no tile and no sentence: the Karte tab's own badge
 * already says «Nicht ausgerichtet».
 */
function FloorPreview({ item, floors, fitPage, map }: { item: AlignmentItem; floors: PlanFloor[]; fitPage: number; map?: ReactNode }) {
  const pages = [...new Set(floors.map((f) => f.page))].sort((a, b) => a - b).join(',')
  const [images, setImages] = useState<Record<number, string>>({})
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    const urls: string[] = []
    for (const page of pages.split(',').filter(Boolean).map(Number)) {
      void alignmentPagePreview(item.id, page, abort.signal).then((blob) => {
        if (abort.signal.aborted) return
        const url = URL.createObjectURL(blob); urls.push(url)
        setImages((current) => ({ ...current, [page]: url }))
      }).catch(() => { if (!abort.signal.aborted) setFailed(true) })
    }
    return () => { abort.abort(); urls.forEach(URL.revokeObjectURL) }
  }, [item.id, pages])
  const onFitPage = floors.filter((f) => f.page === fitPage)
  const reference = onFitPage.find((f) => f.index === 0) ?? onFitPage[0] ?? floors[0]
  if (!reference) return null
  const frame = reference.clip ?? [0, 0, 1, 1]
  const width = frame[2] - frame[0], height = frame[3] - frame[1]
  const shifts = joinShifts(floors, reference)
  return <div className="adm-floor-preview">
    {map && <div className="adm-floor-preview-map">{map}</div>}
    {failed && <p role="alert">{appConfig.copy.admin.alignment.previewFailed}</p>}
    {floors.map((floor) => {
      const shift = shifts.get(floor.index) ?? [0, 0]
      const clip = floor.clip ?? [0, 0, 1, 1]
      const clipId = `floor-preview-${item.id}-${floor.index}`
      const chip = signedIndex(floor.index)
      const name = floor.name || standardFloorName(floor.index)
      return <div className="adm-floor-tile" key={floor.index}>
        <svg viewBox={`${frame[0]} ${frame[1]} ${width} ${height}`} preserveAspectRatio="none" style={{ aspectRatio: `${width * (item.aspect ?? 1.414)} / ${height}` }} role="img" aria-label={`${chip} · ${name}`}>
          <defs><clipPath id={clipId}><rect x={clip[0] + shift[0]} y={clip[1] + shift[1]} width={clip[2] - clip[0]} height={clip[3] - clip[1]} /></clipPath></defs>
          {images[floor.page] && <image href={images[floor.page]} x={shift[0]} y={shift[1]} width={1} height={1} preserveAspectRatio="none" clipPath={`url(#${clipId})`} />}
        </svg>
        <span className="adm-floor-tile-cap" aria-hidden><span className="adm-floor-index">{chip}</span><b>{name}</b></span>
      </div>
    })}
  </div>
}
