// «Üben»: the drill on the practice Einsatz – the task card above the bar (owner pick 1A,
// 19.11.2026), its goals ticking live with a reason for every wrong one (3B), and the «Zeigen»
// ladder (round 2026-11-19-ueben-zeigen): 1 dim + a pulsing ring on the ONE next control or map
// spot, the path in words beside it, the map panned to it first · 2 a ghost hand plays the gesture
// on the real map, the card folded to one line · 3 «Lösung» does it. The drill itself – goals,
// hints, Lösung – is lib/ueben; this file only draws it.
//
// Mounted by IncidentWorkspace on the practice Einsatz only (lib/practice), as a lazy chunk. With
// no drill on the card it is the practice Einsatz's own small card: «Übung wählen» and the two ways
// out («Neu beginnen», «Übung verlassen») – what the spike's pill said.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { MapRef } from 'react-map-gl/maplibre'
import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../../lib/format'
import { Icon } from '../../lib/icons'
import { Menu } from '../../lib/overlays'
import { prefersReducedMotion } from '../../lib/reducedMotion'
import { confirmDialog } from '../../lib/ui'
import { resetPractice } from '../../lib/practice/practiceMode'
import { leavePractice } from '../../lib/practice/practiceSeed'
import { drillById, drillCopy, drillPlace, nextDrill } from '../../lib/ueben/catalogue'
import { goalStates, nextGoal, type Anchor, type DrillId, type Gesture, type Snapshot, type SolveApi, type UiState } from '../../lib/ueben/model'
import { markDone, openUebenSheet, startDrill, stopDrill, useUeben } from '../../lib/ueben/session'
import { siteOf } from '../../lib/ueben/site'
import type { Doc } from '../../lib/workspace'
import type { LngLat } from '../../types'
import { Button } from '../Button'
import s from './Ueben.module.css'

export interface UebenRunnerProps {
  doc: Doc
  ui: UiState
  /** a detail sheet is up (a symbol or line selected): on a phone the card folds out of its way */
  detailOpen: boolean
  mapRef: RefObject<MapRef | null>
  api: SolveApi
  commit: (updater: (d: Doc) => Doc) => void
}

type Rect = { x: number; y: number; w: number; h: number }
type MenuItems = Parameters<typeof Menu>[0]['items']
type Level = 0 | 1 | 2

/** The first VISIBLE element `sel` names – the phone and the tablet carry the same anchor twice. */
function controlRect(sel: string): Rect | null {
  for (const el of document.querySelectorAll<HTMLElement>(sel)) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden') return { x: r.left, y: r.top, w: r.width, h: r.height }
  }
  return null
}
function mapPoint(map: MapRef | null, at: LngLat): { x: number; y: number } | null {
  if (!map) return null
  const box = map.getContainer().getBoundingClientRect()
  const p = map.project(at)
  return { x: box.left + p.x, y: box.top + p.y }
}
/** The ring's box: a control's own, or a 56px circle round a map spot. */
function anchorRect(map: MapRef | null, a: Anchor): Rect | null {
  if (a.kind === 'control') return controlRect(a.sel)
  const p = mapPoint(map, a.at)
  return p ? { x: p.x - 28, y: p.y - 28, w: 56, h: 56 } : null
}
const sameRect = (a: Rect | null, b: Rect | null) =>
  a === b || (!!a && !!b && Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y) && Math.round(a.w) === Math.round(b.w))

/** Is `el` wholly inside the viewport and inside every scrolling box around it? */
function inView(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  if (r.top < 0 || r.bottom > window.innerHeight) return false
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY
    if (o !== 'auto' && o !== 'scroll') continue
    const b = p.getBoundingClientRect()
    if (r.top < b.top || r.bottom > b.bottom) return false
  }
  return true
}

/** Frame `points` on the map in the room the card leaves free. */
function frame(map: MapRef | null, points: LngLat[], card: HTMLElement | null, phone: boolean) {
  if (!map || !points.length) return
  const lng = points.map((p) => p[0]), lat = points.map((p) => p[1])
  const top = card?.getBoundingClientRect().top ?? window.innerHeight
  const padding = phone
    ? { top: 110, bottom: Math.max(80, window.innerHeight - top + 24), left: 48, right: 48 }
    // right: the tool rail AND an armed tool's dock beside it (≈ 250 px) – a gesture must never end under it
    : { top: 110, bottom: 120, left: (card?.getBoundingClientRect().right ?? 120) + 72, right: 260 }
  // a padding larger than the map would throw – fall back to a plain centre
  if (padding.top + padding.bottom >= window.innerHeight - 40) { map.easeTo({ center: points[0], duration: 600 }); return }
  map.fitBounds([[Math.min(...lng), Math.min(...lat)], [Math.max(...lng), Math.max(...lat)]], { padding, maxZoom: 19, duration: prefersReducedMotion() ? 0 : 700 })
}

/** …only when one of `points` is hidden: under the card, under the top bar, off the side. */
function keepInView(map: MapRef | null, points: LngLat[], card: HTMLElement | null, phone: boolean) {
  const r = card?.getBoundingClientRect()
  const hidden = points.some((at) => {
    const p = mapPoint(map, at)
    if (!p) return false
    const underCard = !!r && r.height > 0 && p.x > r.left - 24 && p.x < r.right + 24 && p.y > r.top - 24 && p.y < r.bottom + 24
    return underCard || p.y < 100 || p.x < 24 || p.x > window.innerWidth - 24 || p.y > window.innerHeight - 24
  })
  if (hidden) frame(map, points, card, phone)
}

export default function UebenRunner({ doc, ui, detailOpen, mapRef, api, commit }: UebenRunnerProps) {
  const C = appConfig.copy.ueben
  const { drill: drillId, run, again, done } = useUeben()
  const drill = drillId ? drillById(drillId) : undefined
  const cardRef = useRef<HTMLDivElement>(null)
  const site = useMemo(() => siteOf(doc.entities), [doc.entities])
  const snap: Snapshot = useMemo(() => ({ entities: doc.entities, drawings: doc.drawings }), [doc])
  const states = useMemo(() => (drill ? goalStates(drill, snap, site) : []), [drill, snap, site])
  const next = drill ? nextGoal(states) : -1
  const finished = !!drill && next === -1

  // «Zeigen»'s step, and whether «Lösung» did it (done, no mark – owner, 19.11.2026). Both are
  // keyed: a new goal, drill or run starts the ladder at the bottom again, a new run is unsolved.
  const stepKey = `${drillId}|${run}|${next}`
  const [ladder, setLadder] = useState<{ key: string; level: Level }>({ key: '', level: 0 })
  const level: Level = ladder.key === stepKey ? ladder.level : 0
  const setLevel = (l: Level) => setLadder({ key: stepKey, level: l })
  const runKey = `${drillId}|${run}`
  const [solvedRun, setSolvedRun] = useState<string | null>(null)
  const solved = solvedRun === runKey
  useEffect(() => { if (finished && drillId) markDone(drillId) }, [finished, drillId])

  // a fresh start (from the sheet, «Nochmals»): clear an earlier run's result, frame the problem.
  // A reload keeps the run in progress (`run` starts at 0 on every page).
  const prepared = useRef(-1)
  const frameRun = useRef<number | null>(null)
  useEffect(() => {
    if (!drill || prepared.current === run) return
    const first = prepared.current === -1
    prepared.current = run
    if (run > 0 && drill.prepare) commit(drill.prepare)
    if (run > 0 || first) frameRun.current = run
  }, [drill, run, commit])
  // …framed once the workspace has loaded the site and the map's style stands (both come after
  // mount). The points travel by value (`focusKey`), so a re-render is no new frame.
  const focusKey = drill ? JSON.stringify(drill.focus(site, snap)) : '[]'
  const phone = ui.phone
  useEffect(() => {
    const pts = JSON.parse(focusKey) as LngLat[]
    if (frameRun.current == null || !pts.length) return
    let tries = 0
    const t = setInterval(() => {
      const map = mapRef.current
      if (map?.isStyleLoaded() || ++tries > 20) {
        clearInterval(t)
        frame(map, pts, cardRef.current, phone)
        frameRun.current = null
      }
    }, 250)
    return () => clearInterval(t)
  }, [run, focusKey, phone, mapRef])

  // the card grows back over the map (a phone's detail sheet closed) or turns into the done card:
  // the problem must not lie under it. After the sheet's slide, so the card stands where it will
  // stay. NOT when «Zeigen» folds back – the camera must never move under a finger about to draw.
  const shape = !drill ? 'idle' : finished ? 'done' : level === 2 || (phone && detailOpen) ? 'folded' : 'task'
  const sheetUp = phone && detailOpen
  useEffect(() => {
    const pts = JSON.parse(focusKey) as LngLat[]
    if (sheetUp || !pts.length) return
    const t = setTimeout(() => keepInView(mapRef.current, pts, cardRef.current, phone), 350)
    return () => clearTimeout(t)
  }, [sheetUp, finished, focusKey, phone, mapRef])

  const hint = drill && next >= 0 && level > 0 ? drill.hint(snap, ui, site, next) : null
  const gesture: Gesture | undefined = level === 2 ? hint?.gesture : undefined

  // «Zeigen» pans the map to what it shows before it shows it – once per thing shown (by value)
  const shownPts = JSON.stringify(!hint ? [] : hint.gesture ? (hint.gesture.kind === 'tap' ? [hint.gesture.at] : [hint.gesture.from, hint.gesture.to])
    : hint.anchor.kind === 'map' ? [hint.anchor.at] : [])
  const shownKey = `${level}:${shownPts}`
  useEffect(() => {
    const pts = JSON.parse(shownKey.slice(shownKey.indexOf(':') + 1)) as LngLat[]
    if (pts.length) frame(mapRef.current, pts, cardRef.current, phone)
  }, [shownKey, phone, mapRef])

  // follow the target every frame while something is shown: the map moves, sheets slide in
  const [ring, setRing] = useState<Rect | null>(null)
  const [hand, setHand] = useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null)
  const anchorKey = hint ? JSON.stringify(hint.anchor) : ''
  const gestureKey = gesture ? JSON.stringify(gesture) : ''
  useLayoutEffect(() => {
    if (!anchorKey) return
    const anchor = JSON.parse(anchorKey) as Anchor
    const g = gestureKey ? (JSON.parse(gestureKey) as Gesture) : null
    let raf = 0
    const tick = () => {
      const map = mapRef.current
      const r = level === 1 || !g ? anchorRect(map, anchor) : null
      setRing((cur) => (sameRect(cur, r) ? cur : r))
      const a = g ? mapPoint(map, g.kind === 'tap' ? g.at : g.from) : null
      const b = g ? mapPoint(map, g.kind === 'tap' ? g.at : g.to) : null
      const near = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.round(p.x) === Math.round(q.x) && Math.round(p.y) === Math.round(q.y)
      setHand((cur) => (!a || !b ? null : cur && near(cur.a, a) && near(cur.b, b) ? cur : { a, b }))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [anchorKey, gestureKey, level, mapRef])

  // the ring's control may stand in a scrolled list (the palette's Fahrzeug, the line editor's
  // Linienende below the fold): bring it into view once, when the ring first points at it
  useEffect(() => {
    if (!anchorKey) return
    const anchor = JSON.parse(anchorKey) as Anchor
    if (anchor.kind !== 'control') return
    const t = setTimeout(() => {
      const el = [...document.querySelectorAll<HTMLElement>(anchor.sel)].find((x) => x.getClientRects().length > 0)
      if (el && !inView(el)) el.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    }, 250)
    return () => clearTimeout(t)
  }, [anchorKey])

  // the intro card (owner, round 2): what is practised and why, before the task – once per start
  // from the sheet; «Nochmals» (`again`) and a reload in the middle of a drill go straight on
  const [introRead, setIntroRead] = useState<string | null>(null)

  const restart = async () => {
    const ok = await confirmDialog({ title: C.restartTitle, message: C.restartMessage, confirmLabel: C.restartConfirm, danger: true })
    if (!ok) return
    resetPractice()
    window.location.reload()
  }
  const solve = () => {
    if (!drill) return
    drill.solve(snap, site, api)
    setSolvedRun(runKey)
    setLevel(0)
  }
  const ways: MenuItems = [
    { label: C.allDrills, onClick: openUebenSheet },
    { kind: 'sep' as const },
    { label: C.restart, onClick: () => void restart(), danger: true },
    { label: C.leave, onClick: () => { stopDrill(); leavePractice() } },
  ]
  // the app's menu skin (13-incident · .rp-print-menu, the Rapport's and the Trupps' ⋯ menus)
  const more = (items: MenuItems) => (
    <Menu
      trigger={<button type="button" className={`ip-btn ${s.more}`} aria-label={C.more} title={C.more}><Icon id="more" /></button>}
      items={items} side="top" popupClassName="rp-print-menu" itemClassName={() => 'rp-print-menu-item'}
    />
  )

  // the palette is the one place the next tap goes while it is up – a full-screen sheet on a phone,
  // a centred modal on a tablet that the lifted card would cover: the card steps aside, the ring
  // and its words point into the palette
  const hidden = ui.paletteOpen
  const folded = shape === 'folded'
  const hinting = !!hint && level === 1 && !!ring
  // ⚠️ on <body>, not in the workspace: the palette and the detail sheets are portalled dialogs,
  // and a ring inside the workspace's stacking context could never stand above them
  const out = (node: ReactNode) => createPortal(node, document.body)

  if (!drill || !drillId) {
    return out(
      <div ref={cardRef} className={`${s.card} ${s.idle}`} hidden={hidden} data-ueben-card="idle">
        <div className={s.title}>{C.idleTitle}</div>
        <p className={s.task}>{C.idleText}</p>
        <div className={s.actions}>
          <Button variant="primary" className={s.go} onClick={openUebenSheet}>{C.idlePick}</Button>
          <span className={s.grow} />
          {more(ways.slice(2))}
        </div>
      </div>,
    )
  }

  const copy = drillCopy(drillId)
  const place = drillPlace(drillId)
  const kicker = fillTemplate(C.kicker, { module: C.modules[place.module], i: place.i, n: place.n })

  if (finished) {
    const after: DrillId | null = nextDrill(done, drillId)
    return out(
      <div ref={cardRef} className={s.card} hidden={hidden} data-ueben-card="done">
        <span className={s.kicker}>{kicker}</span>
        <div className={s.doneHead}><span className={s.doneMark}><Icon id="check" /></span><span className={s.title}>{C.doneTitle} · {copy.title}</span></div>
        {solved && <p className={s.task}>{C.doneSolved}</p>}
        <div className={s.actions}>
          {after
            ? <Button variant="primary" className={s.go} onClick={() => startDrill(after)}>{C.doneNext}</Button>
            : <Button variant="primary" className={s.go} onClick={openUebenSheet}>{C.doneList}</Button>}
          <Button onClick={() => startDrill(drillId, { again: true })}>{C.doneAgain}</Button>
          <span className={s.grow} />
          {more(after ? ways : ways.slice(1))}
        </div>
      </div>,
    )
  }

  if (copy.intro && run > 0 && !again && introRead !== runKey) {
    return out(
      <div ref={cardRef} className={s.card} hidden={hidden} data-ueben-card="intro">
        <span className={s.kicker}>{kicker}</span>
        <div className={s.title}>{copy.title}</div>
        <p className={s.task}>{copy.intro}</p>
        <div className={s.actions}>
          <Button variant="primary" className={s.go} onClick={() => setIntroRead(runKey)}>{C.introGo}</Button>
          <span className={s.grow} />
          {more(ways)}
        </div>
      </div>,
    )
  }

  const goals = drill.goals.map((g, i) => ({ id: g.id, label: copy.goals?.[g.id] ?? g.id, st: states[i] }))
  const step = level === 0 ? C.show : level === 1 ? C.showMore : C.solve

  return out(
    <>
      {hint && level > 0 && (
        <HintLayer ring={hinting ? ring : null} words={hint.words} hand={level === 2 ? hand : null} tap={gesture?.kind === 'tap'} />
      )}
      {folded ? (
        <div ref={cardRef} className={`${s.card} ${s.folded}`} hidden={hidden} data-ueben-card="folded">
          <div className={s.grow}>
            <span className={s.kicker}>{kicker}</span>
            <div className={s.foldText}>{level === 2 && hint ? hint.words : copy.title}</div>
          </div>
          {level === 2
            ? <Button variant="primary" className={s.go} onClick={solve}>{C.solve}</Button>
            : <Button className={s.go} onClick={() => setLevel(1)}>{C.show}</Button>}
          {level > 0 && <button type="button" className={`ip-btn ${s.more}`} aria-label={C.hideHint} title={C.hideHint} onClick={() => setLevel(0)}><Icon id="close" /></button>}
        </div>
      ) : (
        <div ref={cardRef} className={`${s.card}${hinting ? ` ${s.lifted}` : ''}`} hidden={hidden} data-ueben-card="task">
          <span className={s.kicker}>{kicker}</span>
          <div className={s.title}>{copy.title}</div>
          <p className={s.task}>{copy.task}</p>
          <ul className={s.goals}>
            {goals.map(({ id, label, st }) => (
              <li key={id} className={s.goal} data-goal={id} data-state={st.s}>
                <span className={s.dot} aria-hidden>{st.s === 'ok' ? <Icon id="check" /> : st.s === 'wrong' ? '!' : null}</span>
                <span className={s.grow}>
                  <span className={st.s === 'ok' ? s.goalDone : st.s === 'wrong' ? s.goalWrong : undefined}>{label}</span>
                  {st.s === 'wrong' && <span className={s.reason}>{st.reason}</span>}
                </span>
              </li>
            ))}
          </ul>
          <div className={s.actions}>
            <Button variant={level === 0 ? 'secondary' : 'primary'} className={s.go}
              onClick={() => (level === 2 ? solve() : setLevel((level + 1) as Level))}>{step}</Button>
            {level > 0 && <Button variant="quiet" onClick={() => setLevel(0)}>{C.hideHint}</Button>}
            <span className={s.grow} />
            {more([{ label: C.solve, onClick: solve }, { kind: 'sep' as const }, ...ways])}
          </div>
        </div>
      )}
    </>,
  )
}

/** «Zeigen» 1: the dim with the ring cut out of it and the path in words · 2: the ghost hand. */
function HintLayer({ ring, words, hand, tap }: { ring: Rect | null; words: string; hand: { a: { x: number; y: number }; b: { x: number; y: number } } | null; tap: boolean }) {
  const pad = 6
  // the words above the ring, or under it when the ring sits high up
  const below = ring ? ring.y < 140 : false
  return (
    <div className={s.hint} aria-live="polite">
      {ring && (
        <>
          <div className={s.ring} style={{ left: ring.x - pad, top: ring.y - pad, width: ring.w + 2 * pad, height: ring.h + 2 * pad }} />
          <div className={s.bubble} style={{
            left: Math.min(Math.max(12, ring.x + ring.w / 2 - 140), window.innerWidth - 292),
            ...(below ? { top: ring.y + ring.h + pad + 10 } : { bottom: window.innerHeight - ring.y + pad + 10 }),
          }}>{words}</div>
        </>
      )}
      {hand && (
        <>
          {!tap && (
            <svg className={s.trail} width="100%" height="100%" aria-hidden>
              <line x1={hand.a.x} y1={hand.a.y} x2={hand.b.x} y2={hand.b.y} />
            </svg>
          )}
          <div className={`${s.hand}${tap ? ` ${s.handTap}` : ''}`} aria-hidden
            style={{ '--hx0': `${hand.a.x}px`, '--hy0': `${hand.a.y}px`, '--hx1': `${hand.b.x}px`, '--hy1': `${hand.b.y}px` } as React.CSSProperties}>
            <span className={s.touch} />
            <Icon id="hand" />
          </div>
        </>
      )}
    </div>
  )
}
