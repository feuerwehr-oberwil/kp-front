import { useEffect, useMemo, useRef, useState } from 'react'
import {
  pickLevel, sheetLayout, sourcePages, tileUrl, underlayLevel, visibleTiles,
  type PageBox, type Tile, type TileManifest, type TileSource,
} from '../lib/planTiles'
import s from './PdfViewport.module.css'

interface Props {
  source: TileSource
  manifest: TileManifest
  fitW: number
  fitH: number
  scale: number
  pos: { x: number; y: number }
  vw: number
  vh: number
  onAspect: (a: number) => void
  /** the underlay painted – the sheet is on the glass, however soft */
  onReady: () => void
  /** a tile could not be had (offline with a cold cache, a server without the revision): the
   *  caller falls back to pdf.js, which may still hold the PDF itself */
  onFail: () => void
}

/** View changes are SETTLED before they pick tiles: a pinch crosses several levels in a second,
 *  and asking for each would fetch and decode tiles nobody ever looks at. Nothing blanks while
 *  waiting – mounted tiles are laid out in fractions of the board and simply follow it. */
const SETTLE_MS = 90
/** …and a sharper set that does not finish loading stops holding the previous one hostage. */
const RETAIN_MS = 4000
const DPR = () => Math.min(window.devicePixelRatio || 1, 2)
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

interface Placed extends Tile { key: string; url: string; box: PageBox }
type TileSet = { id: string; tiles: Placed[] }

/** Tile URLs this session has seen decode – a set made only of these needs no waiting. Capped:
 *  it is a hint, and a forgotten URL merely keeps the previous set a moment longer. */
const seen = new Set<string>()
const remember = (url: string) => {
  seen.add(url)
  if (seen.size > 6000) for (const u of seen) { seen.delete(u); if (seen.size <= 4000) break }
}

/**
 * A plan sheet drawn from the server's tile pyramid (backend · app/plan_tiles) – what
 * `PdfViewport` shows whenever the revision has one.
 *
 * Three layers, all plain `<img>`s laid out in FRACTIONS of the board (which is layout-scaled:
 * its box is fit × zoom), so pan and zoom move them with the board and cost nothing:
 *
 *  · the UNDERLAY – one small level, every tile, always mounted: what is on the glass while
 *    anything sharper is still coming, so the sheet never blanks;
 *  · the CURRENT set – the level the zoom asks for, only the tiles on screen plus a ring;
 *  · the RETAINED set – the previous current one, kept until its successor has loaded, so a
 *    zoom goes sharp → sharp instead of sharp → soft → sharp.
 *
 * What this device holds is therefore about two screenfuls of decoded tiles at any zoom and for
 * any sheet – an A1 at 600 dpi costs what an A4 costs.
 */
export function PlanTileLayer({ source, manifest, fitW, fitH, scale, pos, vw, vh, onAspect, onReady, onFail }: Props) {
  const layout = useMemo(() => sheetLayout(sourcePages(manifest, source)), [manifest, source])
  useEffect(() => { onAspect(layout.aspect) }, [layout.aspect]) // eslint-disable-line react-hooks/exhaustive-deps

  const place = (box: PageBox, z: number, tiles: Tile[]): Placed[] =>
    tiles.map((t) => {
      const url = tileUrl(source, box.page.page, z, t.x, t.y)
      return { ...t, box, url, key: url }
    })

  const underlay = useMemo(
    () => layout.boxes.flatMap((box) => {
      const level = underlayLevel(box.page)
      return place(box, level.z, visibleTiles(level, manifest.tileSize, [0, 0, 1, 1]))
    }),
    [layout, manifest.tileSize], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const [current, setCurrent] = useState<TileSet | null>(null)
  const [retained, setRetained] = useState<TileSet | null>(null)
  const currentRef = useRef<TileSet | null>(null)
  const pending = useRef(new Set<string>())

  useEffect(() => {
    if (!vw || !vh || !fitW || !fitH) return
    const t = setTimeout(() => {
      // the viewport in BOARD fractions – the same arithmetic the pdf.js refine pass uses
      const bx0 = clamp01((-vw / 2 - pos.x) / (scale * fitW) + 0.5), bx1 = clamp01((vw / 2 - pos.x) / (scale * fitW) + 0.5)
      const by0 = clamp01((-vh / 2 - pos.y) / (scale * fitH) + 0.5), by1 = clamp01((vh / 2 - pos.y) / (scale * fitH) + 0.5)
      const tiles = layout.boxes.flatMap((box) => {
        const level = pickLevel(box.page, fitW * scale * box.width * DPR())
        if (level.z <= underlayLevel(box.page).z) return [] // the underlay already IS this level
        const rect: [number, number, number, number] = [
          clamp01((bx0 - box.left) / box.width), clamp01((by0 - box.top) / box.height),
          clamp01((bx1 - box.left) / box.width), clamp01((by1 - box.top) / box.height),
        ]
        return place(box, level.z, visibleTiles(level, manifest.tileSize, rect, 1))
      })
      const id = tiles.map((p) => p.key).join('|')
      if (id === (currentRef.current?.id ?? '')) return
      const previous = currentRef.current
      const next = { id, tiles }
      currentRef.current = next
      pending.current = new Set(tiles.filter((p) => !seen.has(p.url)).map((p) => p.url))
      setCurrent(next)
      // keep the old set under the new one only while the new one has something left to load
      setRetained(pending.current.size && previous?.tiles.length ? previous : null)
    }, SETTLE_MS)
    return () => clearTimeout(t)
  }, [layout, manifest.tileSize, scale, pos.x, pos.y, vw, vh, fitW, fitH]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!retained) return
    const t = setTimeout(() => setRetained(null), RETAIN_MS)
    return () => clearTimeout(t)
  }, [retained])

  const underlayLeft = useRef(-1)
  if (underlayLeft.current < 0) underlayLeft.current = underlay.filter((p) => !seen.has(p.url)).length
  useEffect(() => { if (underlayLeft.current === 0) onReady() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const loaded = (p: Placed, isUnderlay: boolean) => {
    const first = !seen.has(p.url)
    remember(p.url)
    if (isUnderlay && first && --underlayLeft.current === 0) onReady()
    if (pending.current.delete(p.url) && pending.current.size === 0) setRetained(null)
  }
  // A failed DETAIL tile just stays soft (the underlay shows through) and stops blocking the
  // hand-over; a failed UNDERLAY tile means there is no sheet to show, and pdf.js gets its turn.
  const failed = (p: Placed, isUnderlay: boolean) => {
    if (isUnderlay) onFail()
    else if (pending.current.delete(p.url) && pending.current.size === 0) setRetained(null)
  }

  const img = (p: Placed, isUnderlay = false) => (
    <img
      key={p.key}
      src={p.url}
      alt=""
      draggable={false}
      decoding="async"
      className={s['wb-tile']}
      onLoad={() => loaded(p, isUnderlay)}
      onError={() => failed(p, isUnderlay)}
      style={{
        left: `${(p.box.left + p.left * p.box.width) * 100}%`,
        top: `${(p.box.top + p.top * p.box.height) * 100}%`,
        // half a px of overlap: neighbouring tiles land on fractional device px, and the seam
        // that rounding leaves would show the soft underlay through as a hairline grid
        width: `calc(${p.width * p.box.width * 100}% + 0.5px)`,
        height: `calc(${p.height * p.box.height * 100}% + 0.5px)`,
      }}
    />
  )

  // a pan within one level keeps most tiles: those are the current set's, mounted once
  const currentKeys = new Set(current?.tiles.map((p) => p.key))

  return (
    <div className={s['wb-tiles']}>
      {underlay.map((p) => img(p, true))}
      {retained?.tiles.filter((p) => !currentKeys.has(p.key)).map((p) => img(p))}
      {current?.tiles.map((p) => img(p))}
    </div>
  )
}
