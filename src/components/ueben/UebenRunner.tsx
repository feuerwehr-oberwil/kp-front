// «Üben»: one step of a topic on the practice Einsatz – the task card above the bar (owner pick
// 1A, 19.11.2026), its goals ticking live with a reason for a wrong one (3B), and the «Zeigen»
// ladder (round 2026-11-19-ueben-zeigen): 1 dim + a pulsing ring on the ONE next control or map
// spot, the path in words beside it, the map panned to it first · 2 a ghost hand plays the gesture
// on the real map, the card folded to one line · 3 «Lösung» does it. The step itself – goals,
// hints, Lösung – is lib/ueben; this file only draws it.
//
// A topic is a chain of steps (owner pick, 20.11.2026): the done card says what the step taught and
// «Weiter» starts the next one on the same Lage; the last one ends on the topic's closing card,
// which names what was not practised. Goals are reached IN ORDER and stay reached for the run
// (`marks`, lib/ueben/model), so a goal may be about a change.
//
// Mounted by IncidentWorkspace on the practice Einsatz only (lib/practice), as a lazy chunk. With
// no step on the card it is the practice Einsatz's own small card: «Übung wählen» and the two ways
// out («Neu beginnen», «Übung verlassen») – what the spike's pill said. It also takes the practice
// Einsatz to the surface «Ausprobieren» named (lib/ueben/session · goTo).
//
// `data-ueben-card`, the ring's `data-anchor` / `data-hold` and the hand's `data-gesture` are what
// the e2e walker reads (e2e/ueben.spec.ts): it follows «Zeigen» to the end of every topic.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { MapRef } from 'react-map-gl/maplibre'
import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../../lib/format'
import { Icon } from '../../lib/icons'
import { resolveMapDrawings } from '../../lib/lineAttachments'
import { Menu } from '../../lib/overlays'
import { prefersReducedMotion } from '../../lib/reducedMotion'
import { confirmDialog } from '../../lib/ui'
import { resetPractice } from '../../lib/practice/practiceMode'
import { leavePractice } from '../../lib/practice/practiceSeed'
import { placeOf, stepAfter, stepCopy, topicCopy } from '../../lib/ueben/catalogue'
import type { Anchor, Gesture, GoalState, Snapshot, UiState } from '../../lib/ueben/model'
import { clearGoTo, markDone, openUebenSheet, startDrill, stopDrill, useUeben } from '../../lib/ueben/session'
import type { TryTarget } from '../../lib/ueben/tryOut'
import { siteOf } from '../../lib/ueben/site'
import type { Doc } from '../../lib/workspace'
import type { LngLat } from '../../types'
import { Button, IconButton } from '../Button'
import s from './Ueben.module.css'

export interface UebenRunnerProps {
  doc: Doc
  ui: UiState
  /** a detail sheet is up (a symbol or line selected): on a phone the card folds out of its way */
  detailOpen: boolean
  /** put that detail sheet away (nothing selected any more) */
  closeDetail: () => void
  mapRef: RefObject<MapRef | null>
  /** one undoable step of the workspace – a step's start and «Lösung» go through it */
  commit: (updater: (d: Doc) => Doc) => void
  /** show a surface of the practice Einsatz («Ausprobieren») */
  go: (target: TryTarget) => void
}

type Rect = { x: number; y: number; w: number; h: number }
type MenuItems = Parameters<typeof Menu>[0]['items']
type Level = 0 | 1 | 2

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, w: r.width, h: r.height }
}
/** The first VISIBLE element the selectors name, in their order of preference (model · Anchor) –
 *  the phone and the tablet carry the same anchor twice. */
function controlEl(sels: readonly string[]): HTMLElement | null {
  for (const sel of sels) {
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden') return el
    }
  }
  return null
}
/** The ✕ of whatever lies OVER the control `sel` names – on a phone, the detail sheet of the
 *  symbol just placed covers the tool bar. A control under a sheet cannot be tapped, so the ring
 *  goes to that ✕ first. Null when the control is on top, or nothing with a ✕ covers it. */
function coverClose(sels: readonly string[]): HTMLElement | null {
  const target = controlEl(sels)
  if (!target) return null
  const r = target.getBoundingClientRect()
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  if (!top || target.contains(top) || top.contains(target)) return null
  const label = appConfig.copy.closeDialog
  for (let p: Element | null = top; p && p !== document.body; p = p.parentElement) {
    const x = [...p.querySelectorAll<HTMLElement>('button')].find((b) => b.getAttribute('aria-label') === label && b.getClientRects().length > 0)
    if (x) return x
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
  if (a.kind === 'control') {
    const el = controlEl(a.sel)
    return el ? rectOf(el) : null
  }
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

/** px of a phone's bottom that is not free map: the tool bar, the dock of the tool that is out
 *  above it and the «Eintrag» button beside that. */
function phoneBars(): number {
  const bar = controlEl(['.vrail'])
  return (bar ? window.innerHeight - bar.getBoundingClientRect().top : 140) + 110
}

/** Frame `points` on the map in the room the card leaves free. The card stands at the bottom (the
 *  task) or hangs folded under the top bar («Zeigen» 2, a phone's detail sheet) – a gesture must
 *  never start or end under either. */
function frame(map: MapRef | null, points: LngLat[], card: HTMLElement | null, phone: boolean) {
  if (!map || !points.length) return
  const lng = points.map((p) => p[0]), lat = points.map((p) => p[1])
  const r = card?.getBoundingClientRect()
  const top = r?.top ?? window.innerHeight
  const hangs = !!r && r.height > 0 && r.bottom < window.innerHeight / 2
  // the detail sheet of what is selected: a phone's bottom sheet, a tablet's side card
  const sheet = controlEl(['.ctx'])?.getBoundingClientRect()
  const underSheet = sheet ? window.innerHeight - sheet.top + 24 : 0
  const besideSheet = sheet && sheet.left > window.innerWidth / 2 ? window.innerWidth - sheet.left + 24 : 0
  const padding = phone
    ? hangs
      ? { top: r.bottom + 32, bottom: Math.max(phoneBars(), underSheet), left: 48, right: 48 }
      : { top: 110, bottom: Math.max(80, window.innerHeight - top + 24, underSheet), left: 48, right: 48 }
    // a tablet's side card takes the right half: the room left is ABOVE the task card, not beside
    // it – beside it only a strip is free, and the whole scene shrank to a thumb's width in it
    // (found by e2e/ueben.spec.ts, 20.11.2026: the points of a Leitung lay on top of each other)
    : besideSheet
      ? { top: 110, bottom: hangs ? 120 : Math.max(120, window.innerHeight - top + 24), left: 140, right: besideSheet }
      // right: the tool rail AND an armed tool's dock beside it (≈ 250 px) – a gesture must never end under it
      : { top: 110, bottom: 120, left: (r?.right ?? 120) + 72, right: 260 }
  // a padding larger than the map would throw – fall back to a plain centre
  if (padding.top + padding.bottom >= window.innerHeight - 40) { map.easeTo({ center: points[0], duration: 600 }); return }
  map.fitBounds([[Math.min(...lng), Math.min(...lat)], [Math.max(...lng), Math.max(...lat)]], { padding, maxZoom: 19, duration: prefersReducedMotion() ? 0 : 700 })
}

/** …only when one of `points` is hidden: under the card, under the detail sheet, under the top
 *  bar, off the side. Says whether the camera moved. */
function keepInView(map: MapRef | null, points: readonly LngLat[], card: HTMLElement | null, phone: boolean): boolean {
  const boxes = [card?.getBoundingClientRect(), controlEl(['.ctx'])?.getBoundingClientRect()].filter((b): b is DOMRect => !!b && b.height > 0)
  const hidden = points.some((at) => {
    const p = mapPoint(map, at)
    if (!p) return false
    const under = boxes.some((b) => p.x > b.left - 24 && p.x < b.right + 24 && p.y > b.top - 24 && p.y < b.bottom + 24)
    return under || p.y < 100 || p.x < 24 || p.x > window.innerWidth - 24 || p.y > window.innerHeight - 24
  })
  if (hidden) frame(map, [...points], card, phone)
  return hidden
}

/** The Lage as the goals and «Zeigen» read it: every Leitung where the map DRAWS it. A coupled end
 *  is stored where it was dropped and drawn on its symbol (lib/lineAttachments) – after the
 *  Fahrzeug moved, the stored line lies beside the drawn one, and a tap aimed at it misses. */
const seen = (doc: Doc): Snapshot => ({ entities: doc.entities, drawings: resolveMapDrawings(doc.drawings, doc.entities) })

const OK: GoalState = { s: 'ok' }
const OPEN: GoalState = { s: 'open' }
/** the map points a hint shows – what the camera brings into the free part of the map */
const shownPoints = (hint: { anchor: Anchor; gesture?: Gesture } | null): readonly LngLat[] =>
  !hint ? [] : hint.gesture ? (hint.gesture.kind === 'tap' ? [hint.gesture.at] : [hint.gesture.from, hint.gesture.to])
    : hint.anchor.kind === 'map' ? [hint.anchor.at] : hint.anchor.at ?? []

export default function UebenRunner({ doc, ui, detailOpen, closeDetail, mapRef, commit, go }: UebenRunnerProps) {
  const C = appConfig.copy.ueben
  const { drill: stepId, run, intro, done, goTo } = useUeben()
  // «Ausprobieren»: the surface a Hilfe section named, once (the session clears it)
  useEffect(() => {
    if (!goTo) return
    go(goTo)
    clearGoTo()
  }, [goTo, go])
  const placed = stepId ? placeOf(stepId) : undefined
  const step = placed?.step
  const cardRef = useRef<HTMLDivElement>(null)
  const site = useMemo(() => siteOf(doc.entities), [doc.entities])
  const snap = useMemo(() => seen(doc), [doc])
  const phone = ui.phone
  const runKey = `${stepId}|${run}`

  // The run's MARKS (lib/ueben/model): the Lage at the step's start, then at every goal reached.
  // `marks.length - 1` goals are reached, and they stay reached; goal i reads `marks[i]` as `since`.
  const [reach, setReach] = useState<{ key: string; marks: Snapshot[] } | null>(null)
  const marks = reach?.key === runKey ? reach.marks : null
  const frameRun = useRef<number | null>(null)
  // A fresh start (the sheet, «Weiter», «Nochmals») builds the step's start on the Lage; a reload
  // keeps the Lage as it is (`run` starts at 0 on every page). Only once the workspace has loaded –
  // the site stands in every practice Lage.
  const siteUp = !!site.h1 || !!site.eingang
  const begun = useRef<string | null>(null)
  useEffect(() => {
    if (!step || !stepId || !siteUp || begun.current === runKey) return
    begun.current = runKey
    const start = run > 0 ? step.setup(doc, site) : doc
    // the SAME Lage goes to the workspace and into the marks: the goals compare by id
    if (start !== doc) commit(() => start)
    // a reload on a step that is through here stands on its done card again: its goals may be
    // about changes made before the reload, which no Lage shows any more
    const through = run === 0 && done.has(stepId)
    setReach({ key: runKey, marks: Array.from({ length: through ? step.goals.length + 1 : 1 }, () => seen(start)) })
    frameRun.current = run
  }, [step, stepId, siteUp, runKey, run, done, doc, site, commit])

  const goals = step?.goals ?? []
  const reached = marks ? marks.length - 1 : 0
  const next = marks && reached < goals.length ? reached : -1
  const live = step && marks && next >= 0 ? goals[next].check(snap, site, marks[next]) : null
  // a goal reached is marked in the very render that sees it (React's «adjust state while
  // rendering»): the next render already reads the goal after it, against this Lage
  if (marks && live?.s === 'ok') setReach({ key: runKey, marks: [...marks, snap] })
  const states: GoalState[] = goals.map((_, i) => (i < reached ? OK : i === next && live ? live : OPEN))
  const finished = !!step && !!marks && reached >= goals.length
  useEffect(() => { if (finished && stepId) markDone(stepId) }, [finished, stepId])
  // A phone's detail sheet lies over the bottom of the screen, and the done card stands there: the
  // step is through, so the sheet of what was just edited steps aside – once, the operator may open
  // it again (found by e2e/ueben.spec.ts, 20.11.2026: «Weiter» was under the sheet).
  const closedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!finished || closedFor.current === runKey) return
    closedFor.current = runKey
    if (phone && detailOpen) closeDetail()
  }, [finished, runKey, phone, detailOpen, closeDetail])

  // «Zeigen»'s step, and whether «Lösung» did it (done, no mark – owner, 19.11.2026). Both are
  // keyed: a new goal, step or run starts the ladder at the bottom again, a new run is unsolved.
  const stepKey = `${runKey}|${reached}`
  const [ladder, setLadder] = useState<{ key: string; level: Level }>({ key: '', level: 0 })
  const level: Level = ladder.key === stepKey ? ladder.level : 0
  const setLevel = (l: Level) => setLadder({ key: stepKey, level: l })
  const [solvedRun, setSolvedRun] = useState<string | null>(null)
  const solved = solvedRun === runKey

  // the problem framed once the run has begun and the map's style stands (both come after mount).
  // The points travel by value (`focusKey`), so a re-render is no new frame.
  const focusKey = step ? JSON.stringify(step.focus(site, snap)) : '[]'
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
  }, [run, marks, focusKey, phone, mapRef])

  // the card grows back over the map (a phone's detail sheet closed) or turns into the done card:
  // the problem must not lie under it. After the sheet's slide, so the card stands where it will
  // stay. NOT when «Zeigen» folds back – the camera must never move under a finger about to draw.
  const shape = !step ? 'idle' : finished ? 'done' : level === 2 || (phone && detailOpen) ? 'folded' : 'task'
  const sheetUp = phone && detailOpen
  useEffect(() => {
    const pts = JSON.parse(focusKey) as LngLat[]
    if (sheetUp || !pts.length) return
    const t = setTimeout(() => keepInView(mapRef.current, pts, cardRef.current, phone), 350)
    return () => clearTimeout(t)
  }, [sheetUp, finished, focusKey, phone, mapRef])

  const hint = step && marks && next >= 0 && level > 0 ? step.hint(snap, ui, site, next, marks[next]) : null
  const gesture: Gesture | undefined = level === 2 ? hint?.gesture : undefined

  // «Zeigen» pans the map to what it shows before it shows it – once per thing shown (by value).
  // A control ON the map (a point's pad, the «+» between two) waits for the detail sheet's slide –
  // the room the sheet leaves free is measured where it will stay – and moves the camera only when
  // the line lies hidden. Its ring holds back until that is settled (`quietUntil`): a ring that
  // jumps a moment after it appeared is tapped where it no longer is.
  const onMap = hint?.anchor.kind === 'control' && !!hint.anchor.at
  const shownKey = `${level}:${onMap ? 1 : 0}:${JSON.stringify(shownPoints(hint))}`
  const quietUntil = useRef(0)
  useEffect(() => {
    const [, control, ...rest] = shownKey.split(':')
    const pts = JSON.parse(rest.join(':')) as LngLat[]
    if (!pts.length) return
    if (control === '0') { frame(mapRef.current, pts, cardRef.current, phone); return }
    quietUntil.current = performance.now() + 420
    const t = setTimeout(() => {
      if (keepInView(mapRef.current, pts, cardRef.current, phone)) quietUntil.current = performance.now() + (prefersReducedMotion() ? 60 : 780)
    }, 350)
    return () => clearTimeout(t)
  }, [shownKey, phone, mapRef])

  // follow the target every frame while something is shown: the map moves, sheets slide in
  const [ring, setRing] = useState<Rect | null>(null)
  // a sheet lies over the control the hint names: the ring stands on that sheet's ✕ (coverClose)
  const [covered, setCovered] = useState(false)
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
      // a control on the map is never «covered»: the camera brings it out from under the sheet
      const close = anchor.kind === 'control' && !anchor.at && (level === 1 || !g) ? coverClose(anchor.sel) : null
      const quiet = performance.now() < quietUntil.current
      const r = quiet ? null : close ? rectOf(close) : level === 1 || !g ? anchorRect(map, anchor) : null
      setRing((cur) => (sameRect(cur, r) ? cur : r))
      setCovered((cur) => (cur === !!close ? cur : !!close))
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
    if (anchor.kind !== 'control' || anchor.at) return
    const t = setTimeout(() => {
      const el = controlEl(anchor.sel)
      if (el && !inView(el)) el.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    }, 250)
    return () => clearTimeout(t)
  }, [anchorKey])

  // the topic's intro card (owner, round 2): what is practised and why, before the task – on a
  // start of the topic's FIRST step from the sheet; a topic taken up again, «Weiter», «Nochmals»
  // and a reload in the middle of a step go straight on
  const [introRead, setIntroRead] = useState<string | null>(null)

  const restart = async () => {
    const ok = await confirmDialog({ title: C.restartTitle, message: C.restartMessage, confirmLabel: C.restartConfirm, danger: true })
    if (!ok) return
    resetPractice()
    window.location.reload()
  }
  // «Lösung» reaches the goal whose turn it is – one undoable step of the workspace
  const solve = () => {
    if (!step || !marks || next < 0) return
    const since = marks[next]
    commit((d) => step.solve(d, siteOf(d.entities), next, since))
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
      trigger={<IconButton label={C.more} variant="secondary"><Icon id="more" /></IconButton>}
      items={items} side="top" popupClassName="rp-print-menu" itemClassName={() => 'rp-print-menu-item'}
    />
  )

  // the palette is the one place the next tap goes while it is up – a full-screen sheet on a phone,
  // a centred modal on a tablet that the lifted card would cover: the card steps aside, the ring
  // and its words point into the palette
  const hidden = ui.paletteOpen
  const folded = shape === 'folded'
  // the ring: step 1, and step 2 where there is no gesture to play (model · Hint.gesture)
  const hinting = !!hint && !!ring && (level === 1 || !gesture)
  // ⚠️ «Zeigen»'s layer, and the card it lifts over its own dim, go on <body>: the palette and the
  // detail sheets are portalled dialogs, and a ring inside the workspace's stacking context could
  // never stand above them. The card AT REST stays in the workspace, under its menus, drawers and
  // sheets (--z-ueben) – on <body> it lay over the open Einsatz menu (20.11.2026).
  const onBody = (node: ReactNode) => createPortal(node, document.body)

  if (!step || !stepId || !placed) {
    return (
      <div ref={cardRef} className={`${s.card} ${s.idle}`} hidden={hidden} data-ueben-card="idle">
        <div className={s.title}>{C.idleTitle}</div>
        <p className={s.task}>{C.idleText}</p>
        <div className={s.actions}>
          <Button variant="primary" className={s.go} onClick={openUebenSheet}>{C.idlePick}</Button>
          <span className={s.grow} />
          {more(ways.slice(2))}
        </div>
      </div>
    )
  }

  const copy = stepCopy(stepId)
  const topic = topicCopy(placed.topic)
  const kicker = fillTemplate(C.kicker, { topic: topic.title, i: placed.i, n: placed.n })

  if (finished) {
    const after = stepAfter(stepId)
    // the topic's last step ends on its closing card: what was learned, and what else there is
    return (
      <div ref={cardRef} className={s.card} hidden={hidden} data-ueben-card={after ? 'done' : 'end'}>
        <span className={s.kicker}>{kicker}</span>
        <div className={s.doneHead}><span className={s.doneMark}><Icon id="check" /></span><span className={s.title}>{after ? copy.title : fillTemplate(C.endTitle, { topic: topic.title })}</span></div>
        <p className={s.task}>{copy.learned}</p>
        {solved && <p className={s.note}>{C.doneSolved}</p>}
        {!after && (
          <>
            <div className={s.moreTitle}>{C.moreTitle}</div>
            <ul className={s.moreList}>{topic.more.map((line) => <li key={line}>{line}</li>)}</ul>
          </>
        )}
        <div className={s.actions}>
          {after
            ? <Button variant="primary" className={s.go} onClick={() => startDrill(after)}>{C.doneNext}</Button>
            : <Button variant="primary" className={s.go} onClick={openUebenSheet}>{C.doneList}</Button>}
          <Button onClick={() => startDrill(stepId)}>{C.doneAgain}</Button>
          <span className={s.grow} />
          {more(after ? ways : ways.slice(1))}
        </div>
      </div>
    )
  }

  if (intro && placed.i === 1 && run > 0 && introRead !== runKey) {
    return (
      <div ref={cardRef} className={s.card} hidden={hidden} data-ueben-card="intro">
        <span className={s.kicker}>{C.menu}</span>
        <div className={s.title}>{topic.title}</div>
        <p className={s.task}>{topic.intro}</p>
        <div className={s.actions}>
          <Button variant="primary" className={s.go} onClick={() => setIntroRead(runKey)}>{C.introGo}</Button>
          <span className={s.grow} />
          {more(ways)}
        </div>
      </div>
    )
  }

  const rows = goals.map((g, i) => ({ id: g.id, label: copy.goals[g.id] ?? g.id, st: states[i] }))
  // ONE button climbs the ladder, on the task card and on the folded one alike
  const climb = level === 0 ? C.show : level === 1 ? C.showMore : C.solve
  const advance = () => (level === 2 ? solve() : setLevel((level + 1) as Level))

  const lift = hinting ? ` ${s.lifted}` : ''
  const taskCard = folded ? (
    <div ref={cardRef} className={`${s.card} ${s.folded}${lift}`} hidden={hidden} data-ueben-card="folded">
      <div className={s.grow}>
        <span className={s.kicker}>{kicker}</span>
        <div className={s.foldText}>{level === 2 && hint ? hint.words : copy.title}</div>
      </div>
      <Button variant={level === 2 ? 'primary' : 'secondary'} className={s.go} onClick={advance}>{climb}</Button>
      {level > 0 && <IconButton label={C.hideHint} variant="secondary" onClick={() => setLevel(0)}><Icon id="close" /></IconButton>}
    </div>
  ) : (
    <div ref={cardRef} className={`${s.card}${lift}`} hidden={hidden} data-ueben-card="task">
      <span className={s.kicker}>{kicker}</span>
      <div className={s.title}>{copy.title}</div>
      <p className={s.task}>{copy.task}</p>
      <ul className={s.goals}>
        {rows.map(({ id, label, st }) => (
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
        <Button variant={level === 0 ? 'secondary' : 'primary'} className={s.go} onClick={advance}>{climb}</Button>
        {level > 0 && <Button variant="quiet" onClick={() => setLevel(0)}>{C.hideHint}</Button>}
        <span className={s.grow} />
        {more([{ label: C.solve, onClick: solve }, { kind: 'sep' as const }, ...ways])}
      </div>
    </div>
  )
  return (
    <>
      {hint && level > 0 && onBody(
        <HintLayer ring={hinting ? ring : null} anchor={hint.anchor} words={covered ? C.closeFirst : hint.words} hand={level === 2 ? hand : null} gesture={gesture} />,
      )}
      {hinting ? onBody(taskCard) : taskCard}
    </>
  )
}

/** Where the words stand by the ring (fixed px): beside it, vertically centred, when one side has
 *  room for a short bubble; otherwise above it, or under it near the top of the screen. */
function bubblePlace(ring: Rect, pad: number): CSSProperties {
  const gap = pad + 10, edge = 12, need = 180, maxW = 280
  const right = window.innerWidth - (ring.x + ring.w + gap) - edge
  const left = ring.x - gap - edge
  const midY = ring.y + ring.h / 2
  const side = { top: midY, transform: 'translateY(-50%)' }
  if (right >= need) return { ...side, left: ring.x + ring.w + gap, maxWidth: Math.min(maxW, right) }
  if (left >= need) return { ...side, right: window.innerWidth - ring.x + gap, maxWidth: Math.min(maxW, left) }
  const x = { left: Math.min(Math.max(edge, ring.x + ring.w / 2 - maxW / 2), window.innerWidth - maxW - edge) }
  return ring.y < 140 ? { ...x, top: ring.y + ring.h + gap } : { ...x, bottom: window.innerHeight - ring.y + gap }
}

/** «Zeigen» 1: the dim with the ring cut out of it and the path in words · 2: the ghost hand. */
function HintLayer({ ring, anchor, words, hand, gesture }: { ring: Rect | null; anchor: Anchor; words: string; hand: { a: { x: number; y: number }; b: { x: number; y: number } } | null; gesture: Gesture | undefined }) {
  const pad = 6
  // the words BESIDE the ring where a side has room – in a grid (the palette) above or below would
  // lie on the section heading or the next row – else above it, or under it when it sits high up
  const place = ring ? bubblePlace(ring, pad) : null
  const tap = gesture?.kind === 'tap'
  // a drag that ends in a HOLD: the hand rests at the end while the connect ring fills
  const hold = gesture?.kind === 'drag' && !!gesture.hold
  return (
    <div className={s.hint} aria-live="polite">
      {ring && (
        <>
          <div className={s.ring} data-anchor={anchor.kind} data-hold={anchor.kind === 'control' && anchor.hold ? '' : undefined}
            style={{ left: ring.x - pad, top: ring.y - pad, width: ring.w + 2 * pad, height: ring.h + 2 * pad }} />
          <div className={s.bubble} style={place ?? undefined}>{words}</div>
        </>
      )}
      {hand && (
        <>
          {!tap && (
            <svg className={s.trail} width="100%" height="100%" aria-hidden>
              <line x1={hand.a.x} y1={hand.a.y} x2={hand.b.x} y2={hand.b.y} />
            </svg>
          )}
          <div className={`${s.hand}${tap ? ` ${s.handTap}` : hold ? ` ${s.handHold}` : ''}`} aria-hidden data-gesture={tap ? 'tap' : hold ? 'drag-hold' : 'drag'}
            style={{ '--hx0': `${hand.a.x}px`, '--hy0': `${hand.a.y}px`, '--hx1': `${hand.b.x}px`, '--hy1': `${hand.b.y}px` } as CSSProperties}>
            <span className={s.touch} />
            <Icon id="hand" />
          </div>
        </>
      )}
    </div>
  )
}
