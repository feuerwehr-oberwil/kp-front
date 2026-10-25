// «Karte & Objekte» — which objects carry their name tag (lib/karte/labels; docs/karte-objekte.md ·
// «The viewer»). lib/karte/labels decides; this hook measures the tags and reads the chrome.

import { useEffect, useRef, useState, type RefObject } from 'react'
import type { MapRef } from 'react-map-gl/maplibre'
import type { StationObject } from '../../lib/api/stationReference'
import { LABEL_MIN_ZOOM, placeTags, samePlacement, tagRank, tagSize, type Rect, type TagCandidate } from '../../lib/karte/labels'
import { coordOf, openableCount } from '../../lib/karte/search'
import type { LngLat } from '../../types'

/** a tag's text: a number range («1-14») never folds at its hyphen (a word joiner after it) */
export const tagText = (name: string) => name.replace(/(\d)-(?=\d)/g, '$1-⁠')

/** the ring around the map whose tags are decided too, as a share of the map's longer side */
const RING = 0.6
/** how often the placement re-runs while the map moves (a pan, a pinch) */
const MOVE_PASS_MS = 200

/**
 * One greedy pass once the map has settled (`view` moves on moveend), again when what covers the
 * map changes (`covered`: panel, sheet, search, a tool …), on a resize, and once more after a
 * panel has slid in – and every `MOVE_PASS_MS` WHILE the map moves, over the map plus a ring
 * around it (`RING`): a pan brings the next tags in already standing instead of on release (owner,
 * 25.10.2026). `measureRef` is the tag's off-screen twin; `tagged` is id → how far its tag
 * slides sideways to stay on the map (an object not in it shows its dot), `fits` is name → the
 * width a FOLDED tag is given.
 */
export function useTagPlacement(p: {
  mapRef: RefObject<MapRef | null>
  rootRef: RefObject<HTMLDivElement | null>
  view: { center: LngLat; zoom: number }
  objects: readonly StationObject[]
  selId: string | null
  objectsOn: boolean
  covered: string
  phone: boolean
  catOff: (id: string) => boolean
}) {
  const { mapRef, rootRef, view, objects, selId, objectsOn, covered, phone, catOff } = p
  const measureRef = useRef<HTMLSpanElement>(null)
  const sizes = useRef(new Map<string, { w: number; h: number }>())
  /** name → the width a FOLDED tag is given: its widest line plus its chrome (the twin's measure) */
  const [fits, setFits] = useState<ReadonlyMap<string, number>>(() => new Map())
  const fitsRef = useRef(fits)
  const [tagged, setTagged] = useState<Map<string, number> | null>(null)
  const taggedRef = useRef<Map<string, number> | null>(null)
  const [resized, setResized] = useState(0)
  useEffect(() => {
    const on = () => setResized((n) => n + 1)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  useEffect(() => {
    if (!objectsOn) return
    let alive = true
    /** a tag's real size: the off-screen twin measured once per name (jsdom: an estimate). A
     *  name that folds keeps the box of its 280px cap in CSS (owner, round 3: «wrapped lines …
     *  fitted to the width»): its lines are read off the twin and the tag is given the widest
     *  one's width (`fit`) – measured again at that width, so the placement collides the fitted box */
    let folded: Map<string, number> | null = null
    const size = (name: string) => {
      const hit = sizes.current.get(name)
      if (hit) return hit
      const el = measureRef.current
      let box = { w: 0, h: 0 }
      if (el) {
        el.textContent = tagText(name)
        el.style.width = ''
        let r = el.getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(el)
        const lines = new Map<number, number>()
        for (const l of Array.from(range.getClientRects?.() ?? [])) lines.set(Math.round(l.top), Math.max(lines.get(Math.round(l.top)) ?? 0, l.width))
        if (lines.size > 1) {
          // the box is border-box: the line, its padding and border; +1 – a sub-pixel short of the
          // line, the balanced wrap would fold one word more
          const cs = getComputedStyle(el)
          const chrome = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)
          const fit = Math.ceil(Math.max(...lines.values()) + chrome) + 1
          el.style.width = `${fit}px`
          r = el.getBoundingClientRect()
          el.style.width = ''
          ;(folded ??= new Map(fitsRef.current)).set(name, fit)
        }
        box = { w: Math.ceil(r.width), h: Math.ceil(r.height) }
      }
      if (!box.w) box = tagSize(name.length * 7)
      sizes.current.set(name, box)
      return box
    }
    const run = () => {
      const map = mapRef.current
      const root = rootRef.current
      if (!alive || !map || !root) return
      let next = new Map<string, number>()
      if (map.getZoom() >= LABEL_MIN_ZOOM) {
        const box = map.getContainer().getBoundingClientRect()
        // the chrome: every piece of the surface that is not the map itself and not a full-screen
        // layer (an open plan) — the bars, the rails, an open panel or sheet, the hint bars
        const occupied: Rect[] = []
        for (const el of Array.from(root.children)) {
          if (!(el instanceof HTMLElement) || el.querySelector('.maplibregl-canvas')) continue
          const r = el.getBoundingClientRect()
          if (r.width < 1 || r.height < 1 || r.width * r.height > box.width * box.height * 0.6) continue
          occupied.push({ left: r.left - box.left, top: r.top - box.top, right: r.right - box.left, bottom: r.bottom - box.top })
        }
        const cands: TagCandidate[] = []
        for (const o of objects) {
          const at = coordOf(o)
          if (!at || (catOff(o.id) && o.id !== selId)) continue
          // the tag sits on the object's point (lib/karte/labels): only whether it shows is decided
          const pt = map.project(at)
          const { w, h } = size(o.name)
          cands.push({
            id: o.id, x: pt.x, y: pt.y, w, h,
            rank: tagRank({ kind: o.kind, plans: openableCount(o), selected: o.id === selId, wasShown: !!taggedRef.current?.has(o.id) }),
          })
        }
        next = placeTags(cands, { width: box.width, height: box.height, occupied, always: selId, pad: Math.round(Math.max(box.width, box.height) * RING) })
      }
      if (folded) { fitsRef.current = folded; setFits(folded); folded = null }
      if (samePlacement(taggedRef.current, next)) return
      taggedRef.current = next
      setTagged(next)
    }
    const raf = requestAnimationFrame(run)
    const t = setTimeout(run, 400)
    // …and during the move itself, at most every MOVE_PASS_MS, the last one trailing
    let last = 0
    let trailing = 0
    const onMove = () => {
      const now = performance.now()
      if (now - last >= MOVE_PASS_MS) { last = now; run() }
      else if (!trailing) trailing = window.setTimeout(() => { trailing = 0; last = performance.now(); run() }, MOVE_PASS_MS - (now - last))
    }
    const live = mapRef.current?.getMap?.()
    live?.on('move', onMove)
    return () => { alive = false; cancelAnimationFrame(raf); clearTimeout(t); clearTimeout(trailing); live?.off?.('move', onMove) }
  }, [view, objects, selId, objectsOn, covered, phone, resized, catOff, mapRef, rootRef])
  return { measureRef, fits, tagged }
}
