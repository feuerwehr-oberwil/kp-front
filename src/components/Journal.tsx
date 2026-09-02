import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { PlanDocument, TimelineEvent } from '../types'
import { linkParts, type JournalLink } from '../lib/journalLinks'
import { Icon } from '../lib/icons'
import { EmptyState } from './EmptyState'
import { Overlay, Sheet } from '../lib/overlays'
import { caretToEnd, openPhoto } from '../lib/ui'
import { appConfig } from '../config/appConfig'
import { dueClock, fillTemplate, fmtDuration, formatTime } from '../lib/format'
import { thumbUrl } from '../lib/mediaUrl'
import { groupByDay, isHandWritten, isNachtrag, repeatRuns, rowPhotos, rowText, rowTime } from '../lib/verlauf'
import { journalDisc } from '../lib/report'
import type { OpenReminder } from '../lib/reminders'

/** HH:MM of an ISO instant — the Pendenzen block's time column and its Meldung lines. */
function rowClock(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '–' : formatTime(d)
}

/** «vor 54 min» / «vor 3 h» — the other half of the time column, one tap away. */
function ageLabel(iso: string, nowMs: number, C: typeof appConfig.copy.journal): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '–'
  const mins = Math.max(0, Math.round((nowMs - t) / 60_000))
  return mins < 90 ? C.ageLabel.replace('{n}', String(mins)) : C.ageLabelHours.replace('{n}', String(Math.round(mins / 60)))
}

// One <audio> for the whole drawer: play toggles, a second tap pauses, and the row that
// is sounding shows a pause icon + a "playing" pulse so it's obvious what's playing.
function useAudioPlayer() {
  const ref = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  useEffect(() => () => { ref.current?.pause(); ref.current = null }, [])
  const toggle = (id: string, url: string) => {
    if (playing === id && ref.current) { ref.current.pause(); setPlaying(null); return }
    ref.current?.pause()
    const a = new Audio(url)
    ref.current = a
    a.onended = () => setPlaying((p) => (p === id ? null : p))
    a.onpause = () => setPlaying((p) => (p === id ? null : p))
    void a.play().then(() => setPlaying(id)).catch(() => setPlaying(null))
  }
  return { playing, toggle }
}

/** Breathing room, in px, at each end of the activity strip. THE source of truth for it: the
 *  track is inset by this and the tap→time maths subtracts it, so the two cannot drift apart
 *  and leave a tap landing a few minutes off what the ticks show. */
const STRIP_INSET = 10

/** Rows the log mounts at first, and how many more each scroll to the tail reveals. */
const PAGE_ROWS = 150

// A row is clickable only when it carries a real jump target: a map entity, a
// pinned map point, or something ON a plan. Plain log lines (undo/redo, deletions,
// surface-only journal notes) are read-only — the journal is a record, not a UI.
//
// ⚠️ A plan row is a target when it is about a THING on the plan: it names the annotation
// (`annoId`) or its spot (`px`), or — for the rows written before either was recorded — it is one
// of the kinds only a placement writes (`symbol` · `team`; a Pendenz or a typed note on a plan is
// about neither, and an undo is `history`).
//
// How well it lands is the second question. A placement logged since 23.08. carries annoId · px/py
// · floor, and the jump selects the object and brings it into view, the way the Lage's `entityId`
// jump always has (IncidentWorkspace · focusEvent). One logged before that carries the plan
// document alone and lands on it — which is all any plan row ever did. The record is append-only,
// so those rows are never going to grow coordinates; landing them on the right plan with nothing
// selected is the graceful floor, not a bug to guard against.
const targetOf = (e: TimelineEvent): 'map-entity' | 'map-pin' | 'plan' | null => {
  if (e.entityId) return 'map-entity'
  if (e.coord) return 'map-pin'
  const placedOnPlan = e.annoId != null || e.px != null || e.kind === 'symbol' || e.kind === 'team'
  if (e.surface === 'plan' && e.planId && placedOnPlan) return 'plan'
  return null
}

/** What the disc draws for a Pendenz, or null on every other row.
 *  ⚠️ Only the row that RAISED an item, and the row that closed it, wear the ring. A Meldung and
 *  a snooze are log lines ABOUT the item — they keep their own glyph and, in the Meldung's case,
 *  the anchor that names which item they answer. */
type RingState = 'open' | 'urgent' | 'overdue' | 'done'

/** The 26px classification disc: the row's glyph in its Bereich tint, or the Pendenz ring.
 *  The ring is the composer's own ring (18-audio · .jc-ring) at row size — which is what
 *  JournalComposer's «the same ring that appears on the Verlauf row» has claimed all along.
 *
 *  ⚠️ With `onTick` the ring becomes the TICK-OFF control, identical to the one in the pinned
 *  Pendenzen block (.jr-pinned-row .jr-rem) — same ring, same call, same appended `done` row.
 *  It is offered on exactly the rows that are still open; a closed one is a fact, not a switch. */
function Disc({ icon, surface, ring, title, onTick, tickTitle }: {
  icon?: string
  surface?: 'map' | 'plan' | null
  ring?: RingState | null
  title?: string
  /** tick this row's Pendenz off in place — appends, never mutates (see onReminderDone) */
  onTick?: () => void
  tickTitle?: string
}) {
  if (ring) {
    const inner = (
      <span className={`jr-ring jr-ring-${ring}`}>
        {/* the ghost check a tickable ring shows under the finger — the pinned block's ring does
            exactly this. Not on `urgent`: that ring is a filled disc with the drawn bang in it,
            and a second glyph in the same 20px would be two marks fighting for one centre. */}
        {(ring === 'done' || (!!onTick && ring !== 'urgent')) && <Icon id="check" />}
        {ring === 'urgent' && <i className="jr-bang" />}
      </span>
    )
    if (onTick) {
      return (
        <button
          type="button" className="ic jr-ic-ring jr-ic-tick"
          title={tickTitle} aria-label={tickTitle}
          onClick={(ev) => { ev.stopPropagation(); onTick() }}
        >{inner}</button>
      )
    }
    return <span className="ic jr-ic-ring" title={title}>{inner}</span>
  }
  return (
    <span className={`ic${surface ? ` jr-ic-${surface}` : ''}`} title={title}>
      <Icon id={icon || 'doc'} />
    </span>
  )
}

/** The Verlauf's icon legend, opened from the drawer head. Read at call time so the resolved
 *  locale applies. Deliberately NOT exhaustive: it names the Bereiche a reader meets, not every
 *  glyph the app can stamp on a row — a complete table would be a page, and the question it
 *  answers is «what is that circle beside the sentence». */
function legendEntries(): { label: string; icon?: string; surface?: 'map' | 'plan'; ring?: RingState }[] {
  const C = appConfig.copy.journal
  const R = appConfig.copy.report
  return [
    { icon: 'circle', surface: 'map', label: C.surfaceMap },
    { icon: 'flag', surface: 'plan', label: C.surfacePlan },
    { icon: 'people', label: R.areaAnwesenheit },
    { icon: 'gauge', label: R.areaAtemschutz },
    { icon: 'box', label: R.areaMittel },
    { icon: 'clipboard', label: R.areaRapport },
    { icon: 'check', label: R.areaChecklist },
    { icon: 'type', label: R.areaManual },
    { ring: 'open', label: C.legendPendenzOpen },
    { ring: 'urgent', label: C.legendPendenzUrgent },
    { ring: 'done', label: C.legendPendenzDone },
  ]
}

// The unified Verlauf — the single, append-only stream of everything that
// happens on either surface. Rendered as a slide-over so it can open over the
// map or the plan; a row jumps back to wherever its event happened.
export function Journal({ events, plans, closedAt, vocab = [], onSelect, onClose, onTranscript, onReplay, openReminders, onReminderDone, onReminderNote, mediaStatusOf, onOpenPlayer, onEditText, replayAtMs, onSeekTo, landOn }: {
  events: TimelineEvent[]
  plans: PlanDocument[]
  /** the linkable vocabulary (lib/journalLinks) — the SAME memo the composer marks with, so a
   *  name that lit up while it was being typed still lights up once it is a row */
  vocab?: JournalLink[]
  /** the Einsatzende (incident closed_at) — rows appended after it render as Nachträge */
  closedAt?: string | null
  onSelect: (e: TimelineEvent) => void
  onClose: () => void
  onTranscript?: (id: string, transcript: string) => void
  /** start time-travel replay from the Verlauf (closes the drawer). Absent while
   *  replay is already running. */
  onReplay?: () => void
  /** still-open reminders (by derived state) — lets a `created` row show its due time
   *  and a checklist-style done toggle. Absent ⇒ reminder rows render as plain log lines. */
  openReminders?: OpenReminder[]
  /** mark a reminder done preemptively from its Verlauf row (appends a done event). */
  onReminderDone?: (r: OpenReminder) => void
  /** write a Meldung on an open item — opens the ordinary composer pre-linked to it. */
  onReminderNote?: (r: OpenReminder) => void
  /** offline-queue status of a row's media (photo/audio not yet on the server), or undefined
   *  once uploaded — drives the "wird geladen"/"nicht geladen" chip on media rows. */
  mediaStatusOf?: (rowId: string) => 'pending' | 'failed' | undefined
  /** open the Durchhören player sheet for a long recording (rows with audioMeta);
   *  seekSec jumps straight to a moment inside it (annotation rows link back) */
  onOpenPlayer?: (e: TimelineEvent, seekSec?: number) => void
  /** correct a HAND-WRITTEN row's text — append-only `textEdit` patch, same pattern as the
   *  transcript edit. Offered on everything a person typed (composer entries, Meldungen,
   *  Nachdokumentation in the player) and on nothing the app wrote about an action; the
   *  corrected line is marked «korrigiert HH:MM». See lib/verlauf · isHandWritten. */
  onEditText?: (id: string, text: string) => void
  /**
   * The replay playhead. Set ⇒ this Verlauf is being read alongside a Wiedergabe: rows after
   * this instant are the FUTURE and render dimmed, and the row the playhead stands in is marked.
   * ⚠️ It is not a live clock — it only changes when the playhead crosses a row (ReplayBar ·
   * onPlayhead), so this list does not re-render on every playback frame.
   */
  replayAtMs?: number | null
  /** during replay a row sets the MOMENT rather than flying to a place — the whole picture then
   *  reads as it did when the line was written, which is the question a pin only half answered */
  onSeekTo?: (e: TimelineEvent) => void
  /** scroll to one row and flash it when the drawer opens onto it (the Wiedergabe caption's
   *  «im Verlauf»). `nonce` so the same row twice in a row still lands. */
  landOn?: { id: string; nonce: number } | null
}) {
  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const C = appConfig.copy.journal
  const audio = useAudioPlayer()
  // open reminders keyed by id, plus a clock captured when the drawer opens (it remounts on
  // each open, so this is "now" at open time) to flag overdue rows
  const openMap = new Map((openReminders ?? []).map((r) => [r.id, r]))
  // id → the item's own words, so a Meldung row can name what it is an answer to. Built from the
  // `created` rows themselves (not from `openReminders`), or a Meldung on an item that has since
  // been ticked off would lose its anchor the moment it was closed.
  const pendenzTitles = useMemo(() => new Map(
    events.filter((e) => e.reminder?.op === 'created')
      .map((e) => [e.reminder!.id, (e.reminder!.text ?? e.text).trim()] as const),
  ), [events])
  /** …and the row each one was raised on, so the reference on a Meldung can jump back to it. */
  const pendenzRowIds = useMemo(() => new Map(
    events.filter((e) => e.reminder?.op === 'created').map((e) => [e.reminder!.id, e.id] as const),
  ), [events])
  const [now] = useState(() => Date.now())
  // Whether the Pendenzen box's time column shows the clock or the age. Per-opening (the drawer
  // remounts on each open) — a reading preference for the minute you are in, not a setting.
  // ⚠️ EVERY open item is rendered, and nothing measures whether they fit any more. The box is a
  // scroll container of its own (see `.jr-pinned`), so the eleventh item is reached by the same
  // flick as the second. The cap-and-«Aufklappen» pair this replaces existed only because the
  // block used to be sticky INSIDE the log, where it could not scroll itself.
  const [showAge, setShowAge] = useState(false)
  // the icon legend. Per-opening like `showAge`, and closed to begin with — see the button.
  const [showLegend, setShowLegend] = useState(false)
  const [editTx, setEditTx] = useState<{ id: string; value: string } | null>(null)
  const saveTranscript = () => {
    if (!editTx) return
    onTranscript?.(editTx.id, editTx.value)
    setEditTx(null)
  }
  // text correction on an annotation row (same UI pattern as the transcript edit above)
  const [editRow, setEditRow] = useState<{ id: string; value: string } | null>(null)
  const saveRowText = () => {
    if (!editRow) return
    const v = editRow.value.trim()
    if (v) onEditText?.(editRow.id, v)
    setEditRow(null)
  }
  // ── the row's detail sheet (decided 29.08., variant 2) ──
  // The paperwork actions that used to sit as ~30px icons in the row's trail — Durchhören,
  // Transkript, the typed row's pen, and the jump to the row's place — live behind a tap on
  // the ROW now (rendered at the bottom). Only the play circle stays inline: of the row's
  // actions it is the one that happens mid-incident under time pressure, so it keeps (and
  // grows) its one-tap spot.
  const [detailId, setDetailId] = useState<string | null>(null)
  // recordings as windows on the incident timeline: a row whose time falls inside one is
  // an annotation of that recording and links back into the player at its moment
  const audioWindows = useMemo(() => events
    .filter((e) => e.audioUrl && e.audioMeta?.startedAt && (e.audioMeta.durationSec ?? 0) > 0)
    .map((e) => {
      const start = Date.parse(e.audioMeta!.startedAt)
      return { row: e, start, end: start + (e.audioMeta!.durationSec ?? 0) * 1000 }
    })
    .filter((w) => !Number.isNaN(w.start)), [events])

  // A state the app re-states («Trupp X überfällig» every few seconds, an undo tapped six times)
  // reads as one line that repeated, not as twenty lines. Display only — see lib/verlauf.
  const repeats = useMemo(() => repeatRuns(events), [events])

  // ── the log, grouped once and mounted in pages ──
  // Grouping and the repeat filter run once per timeline, not per render — the drawer re-renders
  // on every store nonce (every poll that adopts a row, every overlay change). And the DOM holds
  // only the newest `visibleCount` rows: a long Einsatz reaches 1–2k of them (Funkkontakt every
  // 10 min per Trupp, Druckmeldungen, GPS vor Ort/zurück), each ~10 nodes with chips and actions,
  // and mounting all of them made opening the drawer a several-hundred-ms stall on an iPad. A
  // sentinel at the tail reveals the next page as it scrolls into view; a jump to an older row
  // reveals up to it first (`revealRow`), so the strip and a Meldung's reference still land.
  const groups = useMemo(
    () => groupByDay(events).map((g) => ({ ...g, events: g.events.filter((e) => !repeats.hidden.has(e.id)) })),
    [events, repeats],
  )
  const [pageCount, setVisibleCount] = useState(PAGE_ROWS)
  // no observer (jsdom, an old WebView): everything, as before
  const visibleCount = typeof IntersectionObserver === 'undefined' ? Infinity : pageCount
  /** rendered position of every row id — the count a reveal has to reach */
  const rowIndex = useMemo(() => {
    const m = new Map<string, number>()
    let i = 0
    for (const g of groups) for (const e of g.events) m.set(e.id, i++)
    return m
  }, [groups])
  const totalRows = rowIndex.size
  const shown = useMemo(() => {
    let left = visibleCount
    const out: typeof groups = []
    for (const g of groups) {
      if (left <= 0) break
      out.push(left >= g.events.length ? g : { ...g, events: g.events.slice(0, left) })
      left -= g.events.length
    }
    return out
  }, [groups, visibleCount])
  const listRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) setVisibleCount((c) => c + PAGE_ROWS)
    }, { root: listRef.current, rootMargin: '400px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [visibleCount, totalRows])

  // The strip's own state: the incident's time span, one tick per dated row, and the jump.
  // Rows WITHOUT an absolute time (legacy HH:MM-only entries) are simply not on it — a tick at a
  // guessed position would send the operator to the wrong place, which is worse than no tick.
  const strideRef = useRef(0)
  const stripTicks = useMemo(
    () => events.map((e) => (e.at ? Date.parse(e.at) : NaN)).filter((t) => Number.isFinite(t)).sort((a, b) => a - b),
    [events],
  )
  const stripSpan = useMemo(() => {
    if (stripTicks.length < 2) return null // one moment is not a timeline
    const from = stripTicks[0]
    const to = stripTicks[stripTicks.length - 1]
    return to > from ? { from, to } : null
  }, [stripTicks])
  /** Scroll the list to the row nearest a moment on the strip. */
  const jumpTo = (ms: number) => {
    let best: string | null = null
    let bestD = Infinity
    for (const e of events) {
      if (!e.at) continue
      const d = Math.abs(Date.parse(e.at) - ms)
      if (d < bestD) { bestD = d; best = e.id }
    }
    if (!best) return
    jumpToRow(best)
  }
  /** The row element for an id. ⚠️ Matched on `dataset`, not through a `[data-ev="…"]` selector:
   *  that needs `CSS.escape` for ids it cannot predict, and reaching for a global that does not
   *  exist everywhere (jsdom has no `CSS`) threw inside a requestAnimationFrame, where nothing
   *  catches it. A row id is data; walking the rows is cheap and cannot be mis-escaped. */
  const findRow = (id: string) => {
    const list = listRef.current
    if (!list) return null
    for (const el of list.querySelectorAll<HTMLElement>('[data-ev]')) if (el.dataset.ev === id) return el
    return null
  }
  /** How far the row is from the middle of the list, in px. 0 = centred. */
  const offCentre = (list: HTMLElement, el: HTMLElement) => {
    const lr = list.getBoundingClientRect()
    const er = el.getBoundingClientRect()
    return (er.top - lr.top) - (lr.height - er.height) / 2
  }
  /**
   * Scroll to one row by id and flash it — the strip, the reference on a Meldung row and the
   * Wiedergabe's «im Verlauf» all share it. Returns whether the row was there to scroll to.
   *
   * ⚠️ It scrolls `.history-list`, which is the LOG's scrollport and only the log's: every row it
   * can land on carries `data-ev` and lives there. The Pendenzen box above is a second scrollport
   * with no landing targets of its own — a Meldung's reference points at the log row that raised
   * the item, not at the box's copy of it — so the two never fight over one scroll.
   *
   * ⚠️ The list is scrolled by a MEASURED delta first, and `scrollIntoView` is only the fallback.
   * That call walks up to whatever it decides is the scroll parent and animates it, and here it
   * is asked to do so on a drawer that is still animating open — so it scrolled the wrong box or
   * was undone by the layout that followed, and the Verlauf opened at the top with the row
   * nowhere in sight. Two rects and one assignment cannot pick the wrong container; but if the
   * assignment provably did not move the list (a scroll container this code did not expect),
   * the platform's own method still gets its turn rather than leaving the operator stranded.
   */
  // one marking for every piece of prose in the drawer — the row text and the transcript
  // subtitle lines mark the same vocabulary the composer marked while it was being typed
  const marked = (text: string) => linkParts(text, vocab).map((p, pi) => {
    if (!p.kind) return <span key={pi}>{p.text}</span>
    // ⚠️ An address is the one mark that DOES something, so it is the one that must not also do
    // what the row does. A row selects, seeks or opens a place under the finger; without the
    // stop, opening the link would fly the map somewhere at the same time.
    if (p.kind === 'url') {
      return (
        <a key={pi} className="jr-link jr-link-url" href={p.href}
          target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>{p.text}</a>
      )
    }
    return (
      <b key={pi} className={`jr-link jr-link-${p.kind}`}>
        {p.text}
        {p.role && <i className="jr-link-role"> ({p.role})</i>}
      </b>
    )
  })

  /** Make sure the row is mounted. True when that needed a reveal — the DOM has it only after
   *  the re-render, so the caller lands on it then (`pendingJump`, or the landing loop below).
   *  Checked against the DOM, not the count: the landing loop keeps calling through the closure
   *  of the render that asked, whose `visibleCount` is stale once the reveal has happened. */
  const revealRow = (id: string) => {
    if (findRow(id)) return false
    const idx = rowIndex.get(id)
    if (idx == null) return false
    setVisibleCount((c) => Math.max(c, idx + PAGE_ROWS))
    return true
  }
  const pendingJump = useRef<{ id: string; smooth: boolean } | null>(null)
  const jumpToRow = (id: string, smooth = false) => {
    if (revealRow(id)) { pendingJump.current = { id, smooth }; return true }
    const list = listRef.current
    const el = findRow(id)
    if (!list || !el) return false
    // ⚠️ removed + reflowed + re-added, so landing on the SAME row twice runs the ring again;
    // an animation that is already on the element does not restart by itself (the Rapport's
    // jumpToStep does the same for its chips)
    el.classList.remove('jr-flash')
    void el.offsetWidth
    el.classList.add('jr-flash')
    window.setTimeout(() => el.classList.remove('jr-flash'), 2000)
    const lr = list.getBoundingClientRect()
    // before layout (jsdom, or a frame too early) every rect is 0 — the flash above is what says
    // «this is the one» either way
    if (lr.height <= 0) return true
    const before = list.scrollTop
    const delta = offCentre(list, el)
    // ⚠️ `smooth` only where a PERSON asked to go somewhere (the reference on a Meldung): the
    // travel is what shows that the target row is a different row, further up, rather than the
    // list having silently redrawn. The landing loop below must stay instant — it re-corrects for
    // a few hundred ms as fonts and media settle, and an animation would be fighting the next
    // correction on every frame.
    if (smooth) list.scrollBy({ top: delta, behavior: 'smooth' })
    else {
      list.scrollTop += delta
      // it should have moved. If it did not, this list is not the box that scrolls.
      // (Not checked for a smooth scroll — nothing has moved yet by the time this line runs.)
      if (Math.abs(delta) > 2 && list.scrollTop === before) el.scrollIntoView({ block: 'center' })
    }
    return true
  }
  // a jump that had to reveal its row first lands once the page holding it is mounted
  useEffect(() => {
    const p = pendingJump.current
    if (!p) return
    pendingJump.current = null
    jumpToRow(p.id, p.smooth)
  }, [visibleCount]) // eslint-disable-line react-hooks/exhaustive-deps
  /**
   * Opened ONTO one row — «im Verlauf» on the Wiedergabe caption.
   *
   * Three things have to go right, and each of them bit:
   *   · LAYOUT — the drawer mounts on the same click that asks it to land, so for the first
   *     frames the row exists while the list has no box, and a delta computed from two
   *     zero-height rects moves nothing. So: wait for the list to have a height.
   *   · SETTLING — web fonts swap, media chips arrive, transcripts render. Every one of them
   *     changes the height of rows ABOVE the target, which slides it back out of the middle
   *     after a correct scroll. So: keep correcting for a few hundred ms until it holds still.
   *   · THE OPERATOR — who may start scrolling in the middle of all that, and must win. Any
   *     touch, wheel or drag on the list ends the settling immediately.
   *
   * ⚠️ NO «already landed» ref guard. There was one, and under <StrictMode> — which this app
   * mounts in — it made the whole thing dead code in development: React runs an effect, its
   * cleanup, then the effect again, so the first run recorded the nonce, the cleanup cancelled
   * its frame, and the second run saw its own nonce and returned. Nothing ever scrolled. The
   * dependency is the whole guard that is needed: `landOn` is state, so its identity changes
   * exactly when a new landing is requested.
   */
  useEffect(() => {
    if (!landOn) return
    revealRow(landOn.id) // an older row than the DOM holds — the attempt loop finds it once mounted
    let raf = 0
    let tries = 0
    let stable = 0
    let cancelled = false
    const stop = () => { cancelled = true }
    const list0 = listRef.current
    list0?.addEventListener('wheel', stop, { passive: true })
    list0?.addEventListener('touchstart', stop, { passive: true })
    list0?.addEventListener('pointerdown', stop)

    const settle = () => {
      if (cancelled) return
      const list = listRef.current
      const el = findRow(landOn.id)
      if (!list || !el || list.getBoundingClientRect().height <= 0) return
      const delta = offCentre(list, el)
      if (Math.abs(delta) > 2) { list.scrollTop += delta; stable = 0 } else stable += 1
      // three quiet frames, or ~40 frames of trying — whichever comes first
      if (stable < 3 && ++tries < 40) raf = requestAnimationFrame(settle)
    }
    const attempt = () => {
      if (cancelled) return
      const list = listRef.current
      const el = findRow(landOn.id)
      const laidOut = !!list && !!el && list.getBoundingClientRect().height > 0
      if (laidOut || ++tries > 20) {
        if (el) { jumpToRow(landOn.id); tries = 0; raf = requestAnimationFrame(settle) }
        return
      }
      raf = requestAnimationFrame(attempt)
    }
    raf = requestAnimationFrame(attempt)
    // fonts land late and re-flow every row above the target — one more correction when they do
    document.fonts?.ready.then(() => { if (!cancelled) settle() }).catch(() => {})
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      list0?.removeEventListener('wheel', stop)
      list0?.removeEventListener('touchstart', stop)
      list0?.removeEventListener('pointerdown', stop)
    }
  }, [landOn])

  // ⚠️ NOT re-sorted here. lib/reminders already orders them — dringend first, then oldest first
  // — and it is the same order the Rapport prints. Two sorts in two places is how the list on
  // screen and the list on paper start disagreeing about what is most urgent.
  const pinnedReminders = openReminders ?? []


  return (
    <Overlay open onClose={onClose} className="journal-drawer" backdropClassName="journal-scrim" ariaLabel={C.title} dismissEscape={false}>
        <div className="journal-head">
          <span className="journal-title"><Icon id="history" />{C.title} · {events.length}</span>
          {/* ⚠️ ON A TAP, never by itself. The disc carries the Bereich now, and a glyph has to be
              learned — but a panel that opens on its own, or one the app remembers having opened,
              is a thing to dismiss on the way to the record. This one is a question somebody asks
              once. No hover either: the primary device has none. */}
          <button
            type="button" className={`journal-legend-btn${showLegend ? ' on' : ''}`}
            title={C.legend} aria-label={C.legend} aria-expanded={showLegend}
            onClick={() => setShowLegend((v) => !v)}
          ><Icon id="info" /></button>
          {/* ⚠️ `aria-label`, because the word inside it is hidden on a phone (10-journal.css) —
              the head is one item wider since the legend button joined it, and this is the label
              that can most afford to go. */}
          {onReplay && (
            <button className="journal-replay" onClick={onReplay} title={C.replayHint} aria-label={C.replay}>
              <Icon id="play" /><span>{C.replay}</span>
            </button>
          )}
          <button className="journal-x" title={appConfig.copy.closeDialog} aria-label={appConfig.copy.closeDialog} onClick={onClose}><Icon id="close" /></button>
        </div>
        {showLegend && (
          <div className="jr-legend">
            {legendEntries().map((l) => (
              <span className="jr-legend-item" key={l.label}>
                <Disc icon={l.icon} surface={l.surface} ring={l.ring} />{l.label}
              </span>
            ))}
          </div>
        )}
        {/* WHEN the Einsatz has substance, as one strip. A long Verlauf is a wall of rows in
            which «was war um halb zehn» means scrolling and reading — the strip answers it by
            position instead, and a tap on it lands on the nearest row. Ticks are not targets
            (the strip takes the tap as a whole), so nothing here needs a gloved-finger hit box. */}
        {stripSpan && (
          <div
            className="jr-strip" role="slider" tabIndex={0}
            aria-label={C.stripLabel}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={0}
            onPointerDown={(ev) => {
              // …against the TRACK, not the strip: the ticks are inset by STRIP_INSET, so a tap
              // on the strip's rounded end has to land on the first tick and not somewhere
              // before it. Same inset on both, from the one constant.
              const box = ev.currentTarget.getBoundingClientRect()
              const span = Math.max(1, box.width - STRIP_INSET * 2)
              const frac = Math.min(1, Math.max(0, (ev.clientX - box.left - STRIP_INSET) / span))
              jumpTo(stripSpan.from + frac * (stripSpan.to - stripSpan.from))
            }}
            onKeyDown={(ev) => {
              const step = (stripSpan.to - stripSpan.from) / 20
              if (ev.key === 'ArrowRight') { ev.preventDefault(); jumpTo(stripSpan.from + step * ++strideRef.current) }
              if (ev.key === 'ArrowLeft') { ev.preventDefault(); jumpTo(stripSpan.from + step * --strideRef.current) }
            }}
          >
            {/* the ticks live on an INSET track. Positioned against the strip itself, the first
                and last tick sat on its rounded ends — half-swallowed by the corner radius and
                the inset hairline, so the two moments that bracket the whole Einsatz were the
                two you could not see. */}
            <div className="jr-strip-track" style={{ insetInline: STRIP_INSET }}>
              {stripTicks.map((t, i) => (
                <i key={i} style={{ left: `${((t - stripSpan.from) / (stripSpan.to - stripSpan.from)) * 100}%` }} />
              ))}
            </div>
          </div>
        )}
        {/* ── OFFENE ERINNERUNGEN · the upper of the drawer's TWO stacked scroll areas ──
            The one part of the drawer that is not the chronology. A Wiedervorlage is about what
            still has to be done, and on an Einsatz that writes a row a minute it was thirty rows
            up within ten — so it is held out of the stream in a box of its own, with the log
            ENTIRELY below it in a second box. Each scrolls itself; neither covers the other.
            ⚠️ This reverses «one scrollbar for the whole drawer». That argument — two scrollbars
            are two guesses about which one a flick will move — was about two that OVERLAPPED: the
            block was sticky and opaque INSIDE the log, so the rows ran behind it and one crossing
            its lower edge was sliced through its letters. Stacked, with the box's border and the
            gap below it as the seam, the finger is in one box or the other.
            ⚠️ No box at all when nothing is open — the log then has the whole drawer, which is
            the state most of an Einsatz is in. See `.jr-pinned` in 06-contextpanel.css. */}
        {pinnedReminders.length > 0 && (
          <div className="jr-pinned">
            <div className="jr-pinned-head">
              <Icon id="checklist" /><span>{C.openRemindersHead}</span>
              <b>{C.openCount.replace('{n}', String(pinnedReminders.length))}</b>
            </div>
            {pinnedReminders.map((r) => {
              // ⚠️ The time column says WHEN IT WAS RAISED, for every row, always. It used to
              // say «fällig 22:10 / überfällig», which only a timed Erinnerung can answer — an
              // Auftrag has no Fälligkeit, because nobody checks in on a Schadenplatz. What is
              // actually being asked here is «seit wann läuft das», and the sort order (oldest
              // first) already answers it positionally; tapping swaps the column to the age for
              // the times the clock stops answering it. Überfällig stays the banner's business.
              const dueLater = r.dueAt && Date.parse(r.dueAt) > now
              return (
                <div key={r.id} className={`jr-pinned-row ${r.urgent ? 'urgent' : ''}`}>
                  <button
                    type="button" className="jr-when"
                    title={C.ageToggle} aria-label={C.ageToggle}
                    onClick={() => setShowAge((v) => !v)}
                  >{showAge ? ageLabel(r.createdAt, now, C) : rowClock(r.createdAt)}</button>
                  {/* ⚠️ The ring sits in the VERLAUF'S ICON SLOT, before the text, not out at the
                      right margin. Two things come of it: the item's text starts on exactly the
                      same axis as every line in the log below, so the block reads as the same
                      list filtered rather than as a separate component — and the ring IS this
                      row's icon, which is what a checklist circle has always been. */}
                  <button
                    type="button" className="jr-rem"
                    disabled={!onReminderDone}
                    title={C.markDoneTitle} aria-label={C.markDoneTitle}
                    onClick={() => onReminderDone?.(r)}
                  ><span className="jr-rem-box"><Icon id="check" /></span></button>
                  {/* ⚠️ The Meldungen are SIBLINGS of the button, not children of it. Inside it
                      they rendered outside its box: a <button> is a replaced-ish element whose
                      height does not follow block children the way a div's does, so a row with
                      three Meldungen kept the height of one and the next row was drawn straight
                      over them. The button stays a button — one line, one action — and the
                      thread hangs under it in an ordinary div. */}
                  <div className="jr-pinned-body">
                    <button
                      type="button" className="jr-pinned-text"
                      title={C.noteOpen} aria-label={C.noteOpen}
                      disabled={!onReminderNote}
                      onClick={() => onReminderNote?.(r)}
                    >{r.text}</button>
                    {/* ⚠️ EVERY Meldung, not the latest one. They stand scattered through the
                        Verlauf where they happened, so this is the only place the thread reads
                        as a thread — and showing one of three looked like the whole story. */}
                    {r.notes.map((n) => (
                      <span className="jr-pinned-note" key={n.rowId}>
                        <b>{rowClock(n.at)}</b>{n.text}
                      </span>
                    ))}
                  </div>
                  {/* ⚠️ …and it says WHEN, not just that there is a when. The bare clock glyph
                      answered «meldet sich selbst» and left the one thing to act on — «um wie
                      viel Uhr?» — inside a tooltip nobody on a tablet can open. The row's own
                      time column says when the item was RAISED, so the two are never the same
                      number. `dueClock` adds «· morgen» where the Fälligkeit fell to the next
                      day, which is exactly the case a bare «06:30» reads as long overdue. */}
                  {dueLater && (
                    <span className="jr-pinned-alarm" title={C.dueAtLabel.replace('{t}', dueClock(r.dueAt!))}>
                      <Icon id="clock" /><b>{dueClock(r.dueAt!)}</b>
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )}
        <div className="history-list" ref={listRef}>
          {events.length === 0 && <EmptyState icon="history" title={C.empty} />}
          {shown.map((g, gi) => (
            <Fragment key={g.label ?? `today-${gi}`}>
              {g.label && <div className="jr-day-sep" role="separator">{g.label}</div>}
              {g.events.map((e) => {
            const target = targetOf(e)
            // ── during a Wiedergabe every row is a way into the picture ──
            // A row's tap sets the MOMENT, so the map, the Trupps and the Plan all read as they
            // did when the line was written. That is the question the old «anheften» toggle was
            // really being asked, and this answers it for EVERY row rather than for the few
            // somebody remembered to pin — including the ones written before the toggle existed.
            const rowMs = e.at ? Date.parse(e.at) : NaN
            const seekable = onSeekTo != null && Number.isFinite(rowMs)
            // sections written in the player count as transcription too — the amber asks
            // for words that are missing, not for a particular field to be filled
            const hasTx = !!e.transcript || !!e.transcriptSections?.length
            // Rows with paperwork actions (Durchhören / Transkript on a memo, the pen on a
            // hand-written line) open the detail sheet on their tap — variant 2, 29.08. The
            // jump the tap used to be moves into the sheet with them. NOT during a Wiedergabe:
            // there the tap keeps setting the moment, which outranks after-action paperwork.
            const hasDetail = (!!e.audioUrl && ((!!e.audioMeta && !!onOpenPlayer) || !!onTranscript))
              || (!!onEditText && isHandWritten(e) && !e.audioUrl)
            const opensDetail = !seekable && hasDetail
            const clickable = seekable || opensDetail || target != null
            const onRow = seekable ? () => onSeekTo(e)
              : opensDetail ? () => setDetailId(e.id)
              : target != null ? () => onSelect(e) : undefined
            // …and rows the playhead has not reached yet are the future: shown (the Verlauf stays
            // whole and searchable) but visibly not-yet, so nothing on screen claims to be part of
            // the moment being looked at.
            const future = replayAtMs != null && Number.isFinite(rowMs) && rowMs > replayAtMs
            // a `created` reminder row: still-open (look up derived state) ⇒ show due + done
            // toggle; gone from the open set ⇒ already erledigt (checked + struck through).
            // ⚠️ Keyed off the LIFECYCLE EVENT, not off `kind === 'reminder'`. A Pendenz rides on
            // an ordinary entry row (kind 'journal' / 'audio' / 'photo'), because the entry IS the
            // open item — «Auftrag · Trupp 2 entraucht Treppenhaus» is the record and the Pendenz
            // in one line. Only the timed Erinnerung still writes a row of its own.
            const isReminder = e.reminder?.op === 'created'
            const openRem = isReminder && e.reminder ? openMap.get(e.reminder.id) : undefined
            const remDone = isReminder && !openRem
            const remOverdue = !!openRem?.dueAt && Date.parse(openRem.dueAt) <= now
            // ── the disc ──
            // ONE classification column, and the row's only one. A Pendenz shows the ring (the
            // composer's own, which is what it has always promised); every other row shows its
            // glyph, tinted where the Bereich is one of the two drawing surfaces. The WORD used
            // to sit in a chip before the sentence — beside a sentence that already carried it
            // («Auftrag · …») and, on a Pendenz, beside a second chip saying «Pendenz» again.
            // The word now lives in the disc's title and in the legend in the head.
            const ring: RingState | null = isReminder
              ? (remDone ? 'done' : openRem?.urgent ? 'urgent' : remOverdue ? 'overdue' : 'open')
              // …and the row that CLOSED the item wears the closed ring. `snoozed` and `note` do
              // not: they are log lines about the item, not the item.
              : e.reminder?.op === 'done' ? 'done' : null
            const disc = journalDisc(e, plans)
            // the footnotes on the row — appended facts about it, so they read AFTER the sentence
            const repeated = repeats.counts.get(e.id) ?? 1
            const nachtrag = isNachtrag(e, closedAt)
            const hasFootnotes = nachtrag || !!e.correctedAt || repeated > 1 || e.via === 'atemschutz-link'
            return (
              <div
                className={`hist-ev ${clickable ? 'clickable' : ''} ${future ? 'jr-future' : ''}`}
                key={e.id}
                data-ev={e.id}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                onClick={onRow}
                onKeyDown={onRow ? (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onRow() } } : undefined}
              >
                <span className="t">{rowTime(e)}</span>
                {/* ⚠️ The ring is the tick-off, HERE as well as in the pinned block. It was taken
                    off the row on the grounds that two controls did the same thing and this one
                    scrolls away — but a Pendenz is met in the log at least as often as in the
                    block (a Meldung on it, a search, the row it was raised on), and «scroll back
                    up and find it again» is not a way to close an Auftrag at 3am. The ring is the
                    one vocabulary both places share, so it means the same thing in both: one tap
                    appends a `done` row (onReminderDone → useReminders · markDone). It is not a
                    second path to the state — it is the same call. */}
                <Disc
                  icon={e.icon} surface={disc.surface} ring={ring} title={disc.label}
                  onTick={openRem && onReminderDone ? () => onReminderDone(openRem) : undefined}
                  tickTitle={C.markDoneTitle}
                />
                {/* ⚠️ THE SENTENCE, and nothing before it. Every row's text starts on one x —
                    the same axis the sub-lines below it use — so reading 200 rows in the dark is
                    riding one edge instead of scanning a ragged column. Six decorations used to
                    stand in front of it, all of them `flex: none` against the one shrinkable
                    child, which is how «Audionotiz (6s)» once came out as fourteen lines of one
                    character on a phone. In a grid there is nothing left to shrink.
                    The names in it are marked with the same vocabulary the composer marked them
                    with while they were being typed — and the job after a name on its first
                    mention («Widmer Céline (EL)»), because a Verlauf full of surnames tells a
                    reader who was talking only if they already know the Wehr. */}
                {/* ⚠️ `rowText`, not `e.text`: a picture row with no caption of its own reads
                    «Foto» (reversed 31.08. — a run of them was a column of bare timestamps). The
                    RECORD is untouched either way (lib/verlauf · rowText). */}
                <span className={`jr-text ${remDone ? 'jr-rem-struck' : ''}`}>{marked(rowText(e))}</span>
                <span className="jr-trail">
                  {/* Footnotes ABOUT the row — «Nachtrag», «korrigiert HH:MM», «6×». They say
                      that the append-only record holds more than the row shows, which is worth
                      keeping and worth reading last: a footnote belongs after the thing it
                      annotates, not in front of it. */}
                  {hasFootnotes && (
                    <span className="jr-foot">
                      {nachtrag && <b className="jr-foot-nachtrag">{C.nachtrag}</b>}
                      {e.correctedAt && (
                        <span title={C.correctHint}>{fillTemplate(C.corrected, { t: formatTime(new Date(e.correctedAt)) })}</span>
                      )}
                      {repeated > 1 && (
                        <span className="jr-foot-rep" title={C.repeatedTitle}>{fillTemplate(C.repeated, { n: String(repeated) })}</span>
                      )}
                      {/* The row came in over the Atemschutz-Link — the board handed to somebody's
                          own phone. It is deliberately NOT a name (that session is asked for
                          none), so the footnote says WHERE it was written, which is the honest
                          answer and the one the Rapport can be read against. Server-written
                          (types · TimelineEvent.via); this client never sets it. */}
                      {e.via === 'atemschutz-link' && (
                        <span title={C.viaAtemschutzLinkTitle}>{C.viaAtemschutzLink}</span>
                      )}
                    </span>
                  )}
                  {/* ⚠️ A MELDUNG names the ITEM it answers. The word «PENDENZ» on all of them said
                      only what one could already see; what was missing is WHICH one, and three
                      «PENDENZ» rows in a row were three unrelated sentences. The Verlauf is
                      chronological, so each link has to carry its own anchor — and the anchor is
                      the item's own opening words, not a label.
                      …and it is a WAY BACK, not a caption. The reference has to be truncated to
                      fit, so the words alone often cannot identify the item — tapping it scrolls
                      to the row that raised it and flashes it, which answers «which one» in full
                      and in its own context. */}
                  {e.reminder?.op === 'note' && pendenzTitles.get(e.reminder.id) && (
                    <button
                      type="button" className="jr-note-on"
                      title={C.openReminderGo} aria-label={C.openReminderGo}
                      onClick={(ev) => { ev.stopPropagation(); jumpToRow(pendenzRowIds.get(e.reminder!.id)!, true) }}
                      disabled={!pendenzRowIds.has(e.reminder.id)}
                    ><i>{pendenzTitles.get(e.reminder.id)}</i></button>
                  )}
                  {/* ⚠️ No CONTROL out here — the tick lives on the ring in the icon slot (see the
                      Disc above), where it is the same shape and the same gesture as in the pinned
                      block. What stays at this end is the FACT: a timed Erinnerung's Fälligkeit.
                      The old pill-shaped «erledigt» button that stood here was the thing worth
                      removing — a second, differently-shaped control for the same state. */}
                  {isReminder && openRem?.dueAt && (
                    <span className={`jr-remstate ${remOverdue ? 'overdue' : ''}`}>
                      {remOverdue ? C.overdueLabel : C.dueAtLabel.replace('{t}', dueClock(openRem.dueAt))}
                    </span>
                  )}
                  {/* opens IN the app (lib/ui · openPhoto): `target="_blank"` handed the picture to
                      Safari on an installed iPad, which means leaving a running Einsatz to look at
                      a photo of it. The viewer keeps the one thing the new tab was good for — a
                      download. */}
                  {rowPhotos(e).map((url, i) => (
                    <button
                      key={url} type="button" className="jr-thumb" title={C.photoOpen} aria-label={C.photoOpen}
                      onClick={(ev) => { ev.stopPropagation(); openPhoto(url, { caption: e.text, filename: `foto-${e.id}-${i + 1}.jpg` }) }}
                    >
                      {/* the SMALL copy — a 40 px chip pointed at the full picture is what
                          killed the tab on a phone (lib/mediaUrl · thumbUrl). The viewer the tap
                          opens still gets `url` itself. */}
                      <img src={thumbUrl(url)} alt="" loading="lazy" decoding="async" />
                    </button>
                  ))}
                  {/* Beilagen that are not pictures (PDF, Dokument): a named chip that DOWNLOADS
                      on tap. No in-app viewer — the server hands generic files out as an
                      attachment on purpose (backend/app/api/media.py · get_media), so the OS
                      opens it in whatever can read it. ⚠️ The server's Content-Disposition BEATS
                      the `download` attribute, so the operator's own filename travels as `?name=`
                      and the route sanitises it there; `download` stays as the same-origin hint. */}
                  {(e.files ?? []).map((f) => (
                    <a
                      key={f.url} className="jr-file" download={f.name}
                      href={`${f.url}${f.url.includes('?') ? '&' : '?'}name=${encodeURIComponent(f.name)}`}
                      title={C.attachOpen} aria-label={`${C.attachOpen}: ${f.name}`}
                      onClick={(ev) => ev.stopPropagation()}
                    >
                      <Icon id="attach" /><span>{f.name}</span>
                    </a>
                  ))}
                  {/* ── Der Stift ist von der Zeile gezogen (29.08., Variante 2) ──
                      Correcting a hand-written line stays exactly what it was — an appended
                      `textEdit` patch, both wordings in the record and in the hash chain, the
                      line says «korrigiert HH:MM» — but the pen now lives in the row's detail
                      sheet (tap the row), not as an inline icon. It is paperwork, not a 3am
                      action. Still NEVER on system rows («Trupp 2 eingerückt» is the app
                      reporting an action), and NOT on audio rows (their words live in the
                      transcript). See the sheet at the bottom of the drawer. */}
                  {!e.audioUrl && e.at && onOpenPlayer && (() => {
                    // annotation of a recording → jump into the player at this moment
                    const t = Date.parse(e.at)
                    const w = audioWindows.find((x) => t >= x.start && t <= x.end)
                    if (!w) return null
                    return (
                      <button
                        className="jr-jump"
                        title={C.playerOpen}
                        aria-label={C.playerOpen}
                        onClick={(ev) => { ev.stopPropagation(); onOpenPlayer(w.row, (t - w.start) / 1000) }}
                      ><Icon id="wave" /></button>
                    )
                  })()}
                  {/* ── Durchhören + Transkript sind aus der Zeile gezogen (29.08., Variante 2) ──
                      They stood as ~30px icons beside the play circle: three equal-weight targets
                      where only playback is time-critical mid-incident. Both live in the row's
                      detail sheet now (tap the row) and the play circle is the row's ONE inline
                      control, grown to the tap floor (.hist-ev .tl-play, 10-journal.css). The
                      missing-transcript state keeps its amber ON the row — as a chip on the row
                      meta, since the button that carried it is no longer here. The transcript
                      TEXT still gets its own lines below (see .jr-subs): content, not a control. */}
                  {e.audioUrl && onTranscript && !hasTx && (
                    <span className="jr-media-state jr-tx-miss" title={C.transcriptAdd}>
                      <Icon id="warn" />
                      <span>{appConfig.copy.report.transcript}</span>
                    </span>
                  )}
                  {e.audioUrl && (
                    <button
                      className={`tl-play ${audio.playing === e.id ? 'playing' : ''}`}
                      title={audio.playing === e.id ? appConfig.copy.journal.recordStop : appConfig.copy.play}
                      aria-label={audio.playing === e.id ? appConfig.copy.journal.recordStop : appConfig.copy.play}
                      onClick={(ev) => { ev.stopPropagation(); audio.toggle(e.id, e.audioUrl!) }}
                    ><Icon id={audio.playing === e.id ? 'pause' : 'play'} /></button>
                  )}
                  {(rowPhotos(e).length > 0 || e.audioUrl) && mediaStatusOf?.(e.id) && (
                    <span className={`jr-media-state ${mediaStatusOf(e.id) === 'failed' ? 'failed' : 'pending'}`}
                      title={mediaStatusOf(e.id) === 'failed' ? C.mediaFailed : C.mediaPending}>
                      <Icon id={mediaStatusOf(e.id) === 'failed' ? 'warn' : 'rotate'} />
                      <span>{mediaStatusOf(e.id) === 'failed' ? C.mediaFailed : C.mediaPending}</span>
                    </span>
                  )}
                  {/* a detail-opening row is a chevron even when pinned — the tap opens the
                      sheet, and the jump to the pinned place lives inside it */}
                  {clickable && <span className="hist-go" aria-hidden><Icon id={e.pinned && !opensDetail ? 'coords' : 'chevron'} /></span>}
                </span>
                {/* the words, as SUBTITLE lines under the row — the plain transcript first (the
                    memo's words as one text, no offset), then the player's timed sections with
                    their offset into the recording. The row's own text stays «Audionotiz (8s)»:
                    that is what the entry IS; these lines are what it says. */}
                {e.audioUrl && editTx?.id !== e.id && (e.transcript || e.transcriptSections?.length) && (
                  <div className="jr-subs">
                    {e.transcript && <p><span>{marked(e.transcript)}</span></p>}
                    {(e.transcriptSections ?? []).map((s, i) => (
                      <p key={i}><i>{fmtDuration(s.at)}</i><span>{marked(s.text)}</span></p>
                    ))}
                  </div>
                )}
                {/* the transcript editor, on its own line under the row */}
                {e.audioUrl && editTx?.id === e.id && (
                  <div className="jr-transcript" onClick={(ev) => ev.stopPropagation()}>
                    <textarea
                      value={editTx.value}
                      rows={3}
                      autoFocus
                      onFocus={caretToEnd}
                      placeholder={C.transcriptPlaceholder}
                      onChange={(ev) => setEditTx({ id: e.id, value: ev.target.value })}
                      onKeyDown={(ev) => { if (ev.key === 'Escape') setEditTx(null) }}
                    />
                    <div className="jr-transcript-actions">
                      {/* re-editing an existing transcript is a correction like any other —
                          appended, never overwritten — and says so; a first transcript has no
                          original wording to reassure about */}
                      {e.transcript && <span className="jr-korr-hint">{C.correctHint}</span>}
                      <button onClick={() => setEditTx(null)}>{appConfig.copy.cancel}</button>
                      <button onClick={saveTranscript}><Icon id="check" />{C.transcriptSave}</button>
                    </div>
                  </div>
                )}
                {editRow?.id === e.id && (
                  <div className="jr-transcript" onClick={(ev) => ev.stopPropagation()}>
                    <textarea
                      value={editRow.value}
                      rows={2}
                      autoFocus
                      onFocus={caretToEnd}
                      onChange={(ev) => setEditRow({ id: e.id, value: ev.target.value })}
                      onKeyDown={(ev) => { if (ev.key === 'Escape') setEditRow(null) }}
                    />
                    <div className="jr-transcript-actions">
                      <span className="jr-korr-hint">{C.correctHint}</span>
                      <button onClick={() => setEditRow(null)}>{appConfig.copy.cancel}</button>
                      <button onClick={saveRowText}><Icon id="check" />{C.transcriptSave}</button>
                    </div>
                  </div>
                )}
              </div>
            )
              })}
            </Fragment>
          ))}
          {/* the tail's sentinel: scrolling it into view mounts the next page (see `shown`) */}
          {visibleCount < totalRows && <div ref={sentinelRef} style={{ height: 1 }} aria-hidden />}
        </div>
        {/* ── the row's detail sheet (variant 2, 29.08.) — see `detailId` above ──
            One modal Sheet per open row, over the drawer (--z-dialog > --z-drawer). Every action
            hands over to the machinery that already existed: Durchhören opens the player sheet,
            Transkript/Text open the inline editors under the row, the jump is the row tap of old
            («zur Stelle springen» lives here now — the located-note trade-off the variant named). */}
        {(() => {
          if (!detailId) return null
          const e = events.find((x) => x.id === detailId)
          if (!e) return null
          const hasTx = !!e.transcript || !!e.transcriptSections?.length
          const target = targetOf(e)
          const photos = rowPhotos(e)
          const disc = journalDisc(e, plans)
          const repeated = repeats.counts.get(e.id) ?? 1
          const lastRepeat = repeats.lastAt.get(e.id)
          // A row is «von Hand erfasst» exactly where the pen is offered (lib/verlauf ·
          // isHandWritten) — so the sheet answers «warum kann ich das nicht ändern» with the
          // same rule that decides it, instead of leaving an absent button to explain itself.
          const byHand = isHandWritten(e)
          const facts: { k: string; v: string; sub?: string }[] = [
            ...(e.at ? [{ k: C.detailTime, v: formatTime(new Date(e.at), true) }] : []),
            ...(disc ? [{ k: C.detailArea, v: disc.label }] : []),
            {
              k: C.detailSource,
              v: byHand ? C.detailSourceManual : C.detailSourceSystem,
              ...(byHand ? {} : { sub: C.detailSourceSystemHint }),
            },
            ...(photos.length
              ? [{ k: C.detailAttachments, v: photos.length === 1 ? C.detailAttachmentsOne : fillTemplate(C.detailAttachmentsN, { n: photos.length }) }]
              : []),
            ...(e.correctedAt
              ? [{
                  k: C.detailCorrected,
                  v: formatTime(new Date(e.correctedAt), true),
                  ...(e.textOriginal ? { sub: fillTemplate(C.detailCorrectedFirst, { text: e.textOriginal }) } : {}),
                }]
              : []),
            ...(repeated > 1
              ? [{ k: C.detailRepeated, v: lastRepeat ? fillTemplate(C.detailRepeatedN, { n: repeated, t: formatTime(new Date(lastRepeat)) }) : fillTemplate(C.repeated, { n: repeated }) }]
              : []),
            ...(isNachtrag(e, closedAt) ? [{ k: C.detailNachtrag, v: C.detailNachtragHint }] : []),
          ]
          return (
            <Sheet open onClose={() => setDetailId(null)} fit sheetClassName="jr-detail"
              title={`${rowTime(e)} · ${e.audioUrl ? C.audioClipLabel : C.composerTitle}`}>
              {/* THE PICTURES, before the paperwork. A photo row's text is «Foto» or the Bereich's
                  own word (lib/verlauf · rowText), so the sheet used to open on a sentence that
                  said nothing about the one thing the row was written to carry — and the picture
                  itself was only reachable from the thumbnail back in the list.
                  ⚠️ `thumbUrl`, not the full media URL: a strip of full-size pictures in a modal
                  is exactly what jetsammed the tab once (lib/mediaUrl). The tap opens `url`. */}
              {photos.length > 0 && (
                <div className="jr-detail-shots">
                  {photos.map((url, i) => (
                    <button
                      key={url} type="button" title={C.photoOpen} aria-label={C.photoOpen}
                      onClick={() => openPhoto(url, { caption: e.text, filename: `foto-${e.id}-${i + 1}.jpg` })}
                    >
                      <img src={thumbUrl(url)} alt="" loading="lazy" decoding="async" />
                    </button>
                  ))}
                </div>
              )}
              {/* the row's own words, and — on a memo — what it says (the list's subtitle chrome) */}
              <p className="jr-detail-text">{marked(rowText(e))}</p>
              {e.audioUrl && hasTx && (
                <div className="jr-subs">
                  {e.transcript && <p><span>{marked(e.transcript)}</span></p>}
                  {(e.transcriptSections ?? []).map((s, i) => (
                    <p key={i}><i>{fmtDuration(s.at)}</i><span>{marked(s.text)}</span></p>
                  ))}
                </div>
              )}
              {/* ── THE FACTS ──
                  One line per thing the append-only record actually holds about this row, in the
                  order the questions get asked after the fact: when exactly, under what, written
                  by whom or by what, what came with it, and what happened to it afterwards.
                  ⚠️ Only lines with an answer are printed — a table of «–» teaches nothing and
                  buries the one fact that IS there. And the time is the only place in the app
                  that prints SECONDS: the list shows HH:MM, so «why is this line above that one»
                  has no answer anywhere else (the Verlauf now sorts on the full stamp —
                  lib/journalStore · chronological). */}
              <dl className="jr-detail-facts">
                {facts.map((f) => (
                  <div key={f.k}>
                    <dt>{f.k}</dt>
                    <dd>{f.v}{f.sub && <small>{f.sub}</small>}</dd>
                  </div>
                ))}
              </dl>
              <div className="jr-detail-acts">
                {e.audioUrl && e.audioMeta && onOpenPlayer && (
                  <button type="button" className="btn"
                    onClick={() => { setDetailId(null); onOpenPlayer(e) }}>
                    <Icon id="wave" />{C.playerOpen}
                  </button>
                )}
                {e.audioUrl && onTranscript && (
                  <button type="button" className={`btn${hasTx ? '' : ' jr-da-miss'}`}
                    onClick={() => { setDetailId(null); setEditTx({ id: e.id, value: e.transcript ?? '' }) }}>
                    <Icon id={hasTx ? 'type' : 'warn'} />{hasTx ? C.transcriptEdit : C.transcriptAdd}
                  </button>
                )}
                {onEditText && isHandWritten(e) && !e.audioUrl && (
                  <button type="button" className="btn"
                    onClick={() => { setDetailId(null); setEditRow({ id: e.id, value: e.text }) }}>
                    <Icon id="pen" />{C.editEntry}
                  </button>
                )}
                {target != null && (
                  <button type="button" className="btn"
                    onClick={() => { setDetailId(null); onSelect(e) }}>
                    <Icon id={target === 'plan' ? 'flag' : 'pin'} />
                    {target === 'plan' ? appConfig.copy.atemschutz.showOnPlan : appConfig.copy.atemschutz.showOnMap}
                  </button>
                )}
              </div>
            </Sheet>
          )
        })()}
    </Overlay>
  )
}
