import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../lib/icons'
import { Menu, Overlay } from '../lib/overlays'
import { appConfig } from '../config/appConfig'
import { getDeploymentConfig } from '../lib/deploymentConfig'
import { acceptPhrase, suggestPhrases, type PhraseMatch } from '../lib/quickPhrases'
import { fillTemplate, formatTime, stripUnprintable } from '../lib/format'
import { toast } from '../lib/ui'
import { ApiError } from '../lib/api'
import {
  AUDIO_IMPORT_ACCEPT,
  MAX_AUDIO_UPLOAD_MB,
  formatAudioDuration,
  probeAudioDuration,
  resolveRecordingStart,
  validateAudioImport,
} from '../lib/audioImport'
import type { JournalEntryType, TimelineEvent } from '../types'
import { acceptName, suggestLinks } from '../lib/journalEntry'
import { linkParts, type JournalLink } from '../lib/journalLinks'
import { suggestPendenzen, type OpenReminder } from '../lib/reminders'
import { startChips } from '../lib/startChips'
import { clearDraft, useKeptState } from '../lib/draftKeep'
import { useHoldRepeat } from '../lib/useHoldRepeat'
import { useTapToType } from '../lib/useTapToType'
import { useKeyboardInset } from '../lib/useKeyboardInset'

// `C` (appConfig.copy.journal) is read at the top of each component below rather than captured
// here at module-load, so the locale resolved at boot (config/copy) applies.
const MIN_STEP = 1 // exact-time minute granularity (hold the ± to repeat-fast)
/** ⚠️ U+2192 / U+2190, never «->» and «<-». The same character has to survive into the Verlauf,
 *  the Rapport and the PDF, and an ASCII pair renders as two characters that a search will never
 *  find as one. Both directions, because a Funkprotokoll has both: «EL → Sanität» is an order
 *  going out, «EL ← Sanität» is a message coming in, and rewriting the second as the first means
 *  reversing the sentence you just heard. */
const ARROW = '→'
const ARROW_BACK = '←'
const pad2 = (n: number) => String(n).padStart(2, '0')

export interface JournalDraft {
  text: string
  audioUrl?: string
  secs?: number
  /** structured audio metadata; for an imported memo audioUrl is already the SERVER url
   *  (upload happened during save) and startedAt is the operator-confirmed recording start */
  audioMeta?: TimelineEvent['audioMeta']
  /** several: one damage is rarely one picture (see the composer's photos state) */
  photoUrls?: string[]
  /** ISO time this entry becomes due — the clock beside the ring. ANY entry can carry one: an
   *  Erinnerung is not a second kind of row, it is an open item that additionally says when it
   *  should come back (see lib/reminders · the dueAt distinction). */
  dueAt?: string
  /** Info · Auftrag · Sofortmassnahme; absent = an ordinary entry */
  entryType?: JournalEntryType
  /** the ○ switch: this entry stays open until it is ticked off. `urgent` sorts it to the top.
   *  Absent = an ordinary entry that nothing tracks. */
  pendenz?: { urgent: boolean }
  /** this entry is a Meldung ON an existing Pendenz (the composer was opened from its row) */
  noteFor?: { id: string }
  /** «Wer», read off the sentence (first vocabulary name) — never typed into a field */
  assignee?: string
}

// Wiedervorlage due selection: a relative "+N min" chip, or an exact date + wall-clock time.
// ⚠️ The exact one carries its DAY. It used to be «HH:MM, and if that is already past, tomorrow»
// — a rule that is right nine times out of ten and silent the tenth, on the one surface where a
// Wiedervorlage set for the wrong day is a check nobody makes. An Einsatz also runs over midnight
// and over a second day often enough that «morgen» is a real answer, not an edge case.
type DueSel = { kind: 'in'; mins: number } | { kind: 'at'; day: string; hhmm: string } | null

/** local YYYY-MM-DD — never `toISOString().slice(0,10)`, which is UTC and jumps a day every
 *  evening west of Greenwich (and every morning east of it). */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function resolveDueAt(sel: DueSel): string | null {
  if (!sel) return null
  if (sel.kind === 'in') return new Date(Date.now() + sel.mins * 60_000).toISOString()
  const [y, mo, da] = sel.day.split('-').map(Number)
  const [h, m] = sel.hhmm.split(':').map(Number)
  if ([y, mo, da, h, m].some(Number.isNaN)) return null
  return new Date(y, mo - 1, da, h, m, 0, 0).toISOString()
}

// default exact due when «Uhrzeit …» is first chosen: ~5 min out, snapped to the grid — which
// rolls the DAY too, so the dialog opens on tomorrow when it is a few minutes before midnight.
function defaultExact(): { day: string; hhmm: string } {
  const d = new Date(Date.now() + 5 * 60_000)
  d.setMinutes(Math.ceil(d.getMinutes() / MIN_STEP) * MIN_STEP, 0, 0)
  return { day: dayKey(d), hhmm: `${pad2(d.getHours())}:${pad2(d.getMinutes())}` }
}

/** «Heute · Di 18.08.» — the day the dialog is set to, named the way a person would say it. */
function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const today = new Date()
  const C = appConfig.copy.journal
  const diff = Math.round((date.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000)
  const rel = diff === 0 ? C.dayToday : diff === 1 ? C.dayTomorrow : null
  const stamp = date.toLocaleDateString(appConfig.locale, { weekday: 'short', day: '2-digit', month: '2-digit' })
  return rel ? `${rel} · ${stamp}` : stamp
}

/** step the day by ±1, never before today: a Wiedervorlage in the past fires the moment it is
 *  saved, which is a banner nobody asked for rather than a reminder. */
function stepDay(day: string, by: 1 | -1): string {
  const [y, m, d] = day.split('-').map(Number)
  const next = new Date(y, m - 1, d + by)
  const now = new Date()
  const floor = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return dayKey(next < floor ? floor : next)
}

// Custom HH:MM stepper — replaces the native <input type="time"> (whose OS spinner clashed with
// the dark UI). ± hours/minutes via the shared hold-repeat steppers; both columns wrap.
function TimeStepper({ hhmm, onChange }: { hhmm: string; onChange: (v: string) => void }) {
  const C = appConfig.copy.journal // read per-render so the resolved locale applies
  const [h, m] = hhmm.split(':').map(Number)
  const set = (nh: number, nm: number) => onChange(`${pad2((nh + 24) % 24)}:${pad2((nm + 60) % 60)}`)
  const hDec = useHoldRepeat(() => set(h - 1, m))
  const hInc = useHoldRepeat(() => set(h + 1, m))
  const mDec = useHoldRepeat(() => set(h, m - MIN_STEP))
  const mInc = useHoldRepeat(() => set(h, m + MIN_STEP))
  // tap either column's value to type it (commit wraps modulo, like the ± buttons)
  const hEdit = useTapToType({ min: 0, max: 23, onCommit: (v) => set(v, m) })
  const mEdit = useTapToType({ min: 0, max: 59, onCommit: (v) => set(h, v) })
  return (
    <div className="jc-time">
      <div className="jc-time-col">
        <button type="button" className="jc-time-btn" aria-label={C.hourUp} {...hInc}><Icon id="chevron-up" /></button>
        {hEdit.editing
          ? <input className="jc-time-input" aria-label={C.hourUp} {...hEdit.inputProps} />
          : <button type="button" className="jc-time-val" onClick={() => hEdit.start(h)} title={appConfig.copy.stepper.typeToEnter}>{pad2(h)}</button>}
        <button type="button" className="jc-time-btn" aria-label={C.hourDown} {...hDec}><Icon id="chevron-down" /></button>
      </div>
      <span className="jc-time-sep">:</span>
      <div className="jc-time-col">
        <button type="button" className="jc-time-btn" aria-label={C.minUp} {...mInc}><Icon id="chevron-up" /></button>
        {mEdit.editing
          ? <input className="jc-time-input" aria-label={C.minUp} {...mEdit.inputProps} />
          : <button type="button" className="jc-time-val" onClick={() => mEdit.start(m)} title={appConfig.copy.stepper.typeToEnter}>{pad2(m)}</button>}
        <button type="button" className="jc-time-btn" aria-label={C.minDown} {...mDec}><Icon id="chevron-down" /></button>
      </div>
    </div>
  )
}

// Quick-add for the unified journal: a free-text note and/or a voice memo. Reachable from both
// surfaces (mounted at app level), it records its own clip so the audio is attached to the entry
// rather than auto-logged.
// ⚠️ It no longer knows WHICH surface it was opened over, and does not need to: the «anheften»
// toggle is gone (14.08.). Its whole payoff was that the row could later fly the map to a
// coordinate, which is the weak version of what the Wiedergabe does — scrub to the moment and
// the entire picture is the one from back then. The row still records its surface; that is
// addJournal's business, not this sheet's.
export function JournalComposer({ onSubmit, onClose, incidentStartAt, uploadAudio, vocab = [], timeline = [], noteOn, onClearNote, openPendenzen = [], onLinkPendenz }: {
  onSubmit: (d: JournalDraft) => void
  onClose: () => void
  /** opened from a Pendenz row: everything written here becomes a Meldung ON that item rather
   *  than a free-standing entry. Deliberately the ORDINARY composer — a Meldung then gets
   *  Textbausteine, marked names, Sprachnotiz and Foto without a line of extra code. */
  noteOn?: { id: string; text: string }
  /** unlink — the entry goes back to being an ordinary one */
  onClearNote?: () => void
  /** every still-open Pendenz, so an entry being written can be attached to one without leaving
   *  this sheet. Absent/empty ⇒ nothing is offered and the row behaves exactly as before. */
  openPendenzen?: { id: string; text: string; urgent?: boolean }[]
  /** attach the entry being written to one of them (the workspace owns `noteOn`) */
  onLinkPendenz?: (p: { id: string; text: string }) => void
  /** this incident's own rows, for the chips offered while the field is still empty (see
   *  lib/startChips). Absent ⇒ the station's list is offered as it stands. */
  timeline?: TimelineEvent[]
  /** everything this Einsatz has words for — Mannschaft, Mittel, Partnerorganisationen,
   *  Fahrzeuge, Alarmgruppen (see lib/journalLinks · journalVocabulary). Typing three letters
   *  of any of them completes it; whatever ends up in the text is marked. */
  vocab?: JournalLink[]
  /** alarm/start time of the incident — prefill for the imported memo's «Aufnahme begann» */
  incidentStartAt?: string
  /** uploads an imported memo during save (large files never enter the offline queue) */
  uploadAudio?: (blob: Blob, filename: string) => Promise<{ url: string }>
}) {
  const C = appConfig.copy.journal // read per-render so the resolved locale applies
  // station Textbausteine over the national defaults (deployment config wins when set)
  const quickPhrases = getDeploymentConfig().journal?.quickPhrases?.length
    ? getDeploymentConfig().journal!.quickPhrases!
    : appConfig.journal.quickPhrases
  // ⚠️ The typed sentence outlives the sheet. This overlay closes on a backdrop press, and a
  // sheet this size on a tablet is mostly backdrop — one stray touch beside it threw away a
  // half-written entry with nothing said. The draft is per-session and per-incident (draftKeep
  // clears on incident change) and is cleared on send and on the ✕, so «✕» keeps meaning
  // «discard this» while closing any other way means «not now». A Meldung keeps its OWN draft
  // per item, or two items would hand each other's half-typed text back.
  // ⚠️ Captured ONCE, from how the sheet opened. It cannot follow `noteOn`, because attaching a
  // Pendenz from inside the composer changes that — and the key changing mid-composition would
  // swap the kept draft under the operator and blank the sentence they were half-way through.
  const [draftKey] = useState(() => (noteOn ? `journal-note:${noteOn.id}` : 'journal-entry'))
  const [text, setText] = useKeptState(draftKey, '')
  const suggestions = useMemo(() => suggestPhrases(text, quickPhrases), [text, quickPhrases])
  // ⚠️ NAMES come before the Textbausteine, and only from the word being typed (not the whole
  // fragment): you write the sentence you were going to write anyway and the SPELLING of the
  // name comes for free. A journal holding «Baumann», «Baumann M.» and «Bauman» is one nobody
  // can search afterwards, and that is the whole of it — accepting one inserts text, nothing
  // more. Who REPORTED the entry is the Von field below; the two are different questions.
  const nameHits = useMemo(() => suggestLinks(text, vocab), [text, vocab])
  // …and what is already in the text, so the field can mark it as you type
  const parts = useMemo(() => linkParts(text, vocab), [text, vocab])
  // ── the arrow, offered right after somebody has been named ────────────────────────────────
  // ⚠️ The Verlauf is a Funkprotokoll, and «wer sagt was zu wem» is the shape of nearly every line
  // in it — written today as «meldet», «an», «über Funk an», «:» or nothing at all. One sign that
  // always means the same thing makes the column readable, and later searchable.
  // It is an ORDINARY suggestion: same row, same size, it inserts text and nothing else. Offered
  // only when the sentence has just named somebody (a person, a post, a Partnerorganisation, a
  // Fahrzeug, a Gruppe) and does not already end in one — «EL → → Sanität» is nobody's intention.
  // ⚠️ Offered while the sentence ENDS on somebody — a name, a post, an organisation, a Fahrzeug —
  // with or without the space after it, and never once other words have followed. The arrow says
  // «…and now the other side», so its moment is exactly there; kept alive through the rest of the
  // sentence it was a chip that never went away, competing with the Textbausteine for the row.
  // (The trailing space HAS to count: nobody writes the name and then stops mid-air.)
  const arrowHit = useMemo(() => {
    const end = text.trimEnd()
    if (!end || end.endsWith(ARROW) || end.endsWith(ARROW_BACK)) return false
    const last = linkParts(end, vocab).pop()
    return !!last?.kind
  }, [text, vocab])
  // ── and what the sheet offers before a single letter is typed ──
  // ⚠️ Only while the field is EMPTY. The Textbausteine stopped being a permanent strip on
  // 02.07. because a row of them competed with the sentence; these are gone with the first
  // keystroke, so the row they sit in is the one that was standing empty anyway (on a phone it is
  // even reserved). What they buy is the first tap, which is the one moment a blank field says
  // nothing about what belongs in it.
  // ⚠️ The opener is the ARROW one («EL → »): a Funkprotokoll's first token is a post, and unlike
  // any phrase that is true on every kind of Einsatz. It only exists if the vocabulary has the
  // post (journalLinks · commandRoles), so a deployment without one simply gets phrases.
  // ⚠️ They stay until somebody TYPES, not until the field has something in it. Tapping «EL →» is
  // exactly the moment the second chip becomes useful — a row that empties itself on its own first
  // tap offers help once and then takes it away. The first keystroke is the real signal: from
  // there the fragment under the cursor has better answers (names, Textbausteine) than any list.
  // ⚠️ seeded from the text, not `false`: this sheet restores a kept draft (draftKeep), and a
  // half-written sentence with «EL →» and the station's phrases sitting over it is a row offering
  // to start something that is already started — tapping one would append to the middle of it.
  const [typed, setTyped] = useState(() => text.trim().length > 0)
  const starters = useMemo(() => {
    if (typed) return []
    const el = vocab.find((l) => l.word)?.name
    return startChips(timeline, quickPhrases, el ? `${el} ${ARROW}` : undefined)
  }, [typed, vocab, timeline, quickPhrases])
  /** …and a second chip APPENDS. «EL → » followed by «Polizei aufgeboten» is one sentence being
   *  built out of two taps, which is the whole point of leaving the row standing. */
  const takeStarter = (insert: string) => {
    setText((t) => (t.trim() ? `${t.trimEnd()} ${insert}` : insert))
    requestAnimationFrame(() => {
      const el = textRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }
  const takeArrow = (ch: string = ARROW) => {
    setText((t) => `${t.trimEnd()} ${ch} `)
    requestAnimationFrame(() => {
      const el = textRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }
  const textRef = useRef<HTMLTextAreaElement>(null)
  const marksRef = useRef<HTMLDivElement>(null)
  // Accepting a Textbaustein must keep the operator in the writing flow: textarea stays
  // focused (tablet keyboard stays up) with the caret right after the inserted phrase,
  // ready to type on. rAF so the refocus runs after React committed the new value.
  const accept = (m: PhraseMatch) => {
    setText((t) => acceptPhrase(t, m.phrase, m.frag))
    requestAnimationFrame(() => {
      const el = textRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }
  const takeName = (name: string) => {
    setText((t) => acceptName(t, name))
    requestAnimationFrame(() => {
      const el = textRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }
  // ── the clock: any entry may say when it has to come back ─────────────────────────────────
  // ⚠️ There is no «Eintrag · Erinnerung» switch any more. Asking for the KIND of row first cost
  // the Erinnerung everything the ordinary sheet has — Art, Foto, Sprachnotiz, the ring — and made
  // «Auftrag erteilt» and «um 22:10 nachfassen» two rows about one thing. The clock is now a
  // property of the entry, exactly as the open ring already is.
  // ⚠️ Resolved PER RENDER, not when the chip is picked: «+10 min» means ten minutes from the moment
  // it is saved, and the sheet can stand open for a while (unchanged behaviour).
  const [dueSel, setDueSel] = useState<DueSel>(null)
  const dueAt = resolveDueAt(dueSel) ?? undefined
  // the exact due dialog (day + time), opened from the clock menu's «Uhrzeit …» row
  const [exact, setExact] = useState<{ day: string; hhmm: string } | null>(null)
  // …and whether what it currently says has already gone by (see the dialog)
  const exactAt = exact ? resolveDueAt({ kind: 'at', ...exact }) : null
  const pastDue = !!exactAt && Date.parse(exactAt) <= Date.now()
  // ── the ○ switch: aus → offen → dringend → aus ────────────────────────────────────────────
  // ⚠️ THREE states on ONE control, not a second chip appearing beside it. A chip that shows up
  // on tap pushes the row onto a second line — the sheet grows under the thumb on the one surface
  // already fighting the keyboard for every row it has. The switch reserves the width of its
  // longest state instead, so tapping changes colour and word and moves nothing.
  // ⚠️ And it is a NEW control, which is why a second tap may mean something here: on the Art
  // chips the second tap has always meant «off» (`cur === t ? null : t`), and redefining a
  // learned gesture is exactly what shipped as a bug once already.
  // ⚠️ NOT shown while writing a Meldung. It was, as a two-state «normal / dringend» that edited
  // the PENDENZ — so a control sitting on one Meldung silently re-ranked the whole item, and the
  // switch beside it said «offen» about something that was open before this sheet existed. A
  // Meldung reports on an item; it does not re-decide it.
  const [openState, setOpenState] = useState<0 | 1 | 2>(0)
  // ⚠️ A due time and an open ring are ONE fact, so the two controls keep each other honest: a
  // Fälligkeit on a line nobody can tick off would fire a banner with no way to answer it, and a
  // line taken off the Pendenzen would keep an alarm nothing owns. Setting a time therefore opens
  // the ring, and closing the ring drops the time.
  const setDue = (sel: DueSel) => { setDueSel(sel); if (sel && openState === 0) setOpenState(1) }
  const setOpen = (s: 0 | 1 | 2) => { setOpenState(s); if (s === 0) setDueSel(null) }
  // …and the open Pendenzen this sentence already names. Offered only while writing an ordinary
  // entry: once it IS a Meldung the question is answered.
  const pendenzHits = useMemo(
    () => (noteOn ? [] : suggestPendenzen(text, openPendenzen as OpenReminder[])),
    [text, openPendenzen, noteOn],
  )
  const canLink = openPendenzen.length > 0 && !!onLinkPendenz
  // ── the ○ opens a menu; it no longer cycles ───────────────────────────────────────────────
  // ⚠️ Three states reached by tapping the same ring in turn were a guessing game, and the way to
  // «hang this on something already open» was a long press — a gesture that cannot announce
  // itself. One menu says the whole model out loud instead: this line is a new open item, or it
  // is urgent, or it reports on one of these. Nothing to discover, nothing to cycle past.
  // ⚠️ It costs the common case a second tap («offen halten» was one). Worth it: «Neue Pendenz»
  // is the first row every time, so it is two taps in the same two places rather than one tap
  // whose result depends on how many times you pressed before.
  /** one row of that menu: the ring in the state it stands for, the words, and a tick when it is
   *  the state the switch is in right now. */
  const menuRow = (state: 0 | 1 | 2, label: string, active: boolean) => (
    <>
      <span className="jc-menu-ring" data-state={state}>{state === 2 && <span className="jc-bang" />}</span>
      <span className="jc-menu-label">{label}</span>
      {active && <Icon id="check" />}
    </>
  )
  /** …and one row of the clock's menu, laid out the same way so the two popups read as siblings:
   *  a leading slot (empty for the plain minute rows), the words, a tick when it is the choice. */
  const dueRow = (lead: React.ReactNode, label: string, active: boolean) => (
    <>
      <span className="jc-menu-ring jc-menu-lead">{lead}</span>
      <span className="jc-menu-label">{label}</span>
      {active && <Icon id="check" />}
    </>
  )
  // Who said it, and what kind of statement it is. Both OPTIONAL and both empty by
  // default: the composer's job is still to take a sentence, and a form that asks two
  // questions before it accepts one is a form nobody opens at 3am.
  const [entryType, setEntryType] = useState<JournalEntryType | null>(null)
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [clip, setClip] = useState<{ url: string; secs: number; startedAt: string } | null>(null)
  // SEVERAL photos per entry: one damage is rarely one picture, and the picker used to REPLACE
  // what was already attached — the second pick silently threw the first away.
  const [photos, setPhotos] = useState<string[]>([])
  // imported external voice memo (Voice Memos → Files → picker); mutually exclusive with `clip`
  const [imported, setImported] = useState<{
    file: File; url: string; name: string; durationSec: number | null; contentType: string
  } | null>(null)
  const [startHHMM, setStartHHMM] = useState(() => {
    const d = incidentStartAt ? new Date(incidentStartAt) : new Date()
    return Number.isNaN(d.getTime()) ? `${pad2(new Date().getHours())}:${pad2(new Date().getMinutes())}` : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  })
  // hard gate (2026-07-15 decision): save stays disabled until the operator edits the
  // stepper or explicitly confirms — the row lands at this time in the Verlauf
  const [startConfirmed, setStartConfirmed] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [clipPlaying, setClipPlaying] = useState(false)
  const clipAudio = useRef<HTMLAudioElement | null>(null)
  // recorded clip and imported memo are exclusive, so one preview player serves both
  const previewUrl = clip?.url ?? imported?.url ?? null
  const toggleClip = () => {
    if (!previewUrl) return
    if (clipPlaying && clipAudio.current) { clipAudio.current.pause(); setClipPlaying(false); return }
    const a = new Audio(previewUrl)
    clipAudio.current = a
    a.onended = () => setClipPlaying(false)
    a.onpause = () => setClipPlaying(false)
    void a.play().then(() => setClipPlaying(true)).catch(() => setClipPlaying(false))
  }
  const recRef = useRef<{ rec: MediaRecorder; startedAt: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const audioFileRef = useRef<HTMLInputElement>(null)
  // closing the composer mid-upload means "cancel": the upload may finish server-side (the
  // orphaned blob is harmless) but no journal row is created after unmount. The unmount also
  // revokes the imported preview URL — saves/closes must not pin up to 100 MB per import.
  const alive = useRef(true)
  const importedUrlRef = useRef<string | null>(null)
  importedUrlRef.current = imported?.url ?? null
  useEffect(() => () => {
    alive.current = false
    if (importedUrlRef.current) URL.revokeObjectURL(importedUrlRef.current)
  }, [])

  // In-app voice-to-text dictation was removed — use the native OS keyboard dictation
  // (e.g. iPadOS mic key) to fill the text field instead.

  // live recording timer
  useEffect(() => {
    if (!recording) return
    const id = setInterval(() => { const s = recRef.current; if (s) setElapsed(Math.round((Date.now() - s.startedAt) / 1000)) }, 250)
    return () => clearInterval(id)
  }, [recording])

  // stop any in-flight recording + release the stream when the composer unmounts
  useEffect(() => () => { try { recRef.current?.rec.stop() } catch { /* already stopped */ } }, [])

  // ⚠️ Caret at the END of a restored draft — driven by the FOCUS EVENT, not by a frame counted
  // from mount. A focused textarea puts the caret at position 0, so re-opening a half-written
  // entry landed the cursor in front of it and the next word went to the start of the sentence.
  // The first attempt set the selection in a rAF after mount and did nothing: the Overlay does
  // its own focus (`initialFocus`) on its own schedule, and whichever of the two ran last won.
  // Hanging it on the focus itself cannot lose that race. Once only, so clicking into the middle
  // of the text later still puts the caret where it was clicked.
  const caretPlaced = useRef(false)
  const caretToEnd = (el: HTMLTextAreaElement) => {
    if (caretPlaced.current) return
    caretPlaced.current = true
    if (el.value) el.setSelectionRange(el.value.length, el.value.length)
  }

  const toggleRecord = async () => {
    if (recording) { recRef.current?.rec.stop(); return }
    discardImport() // one audio per entry — a fresh recording replaces an imported memo
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream); const chunks: Blob[] = []
      const startedAt = Date.now()
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        const url = URL.createObjectURL(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }))
        setClip({ url, secs: Math.max(1, Math.round((Date.now() - startedAt) / 1000)), startedAt: new Date(startedAt).toISOString() })
        setRecording(false); setElapsed(0)
      }
      recRef.current = { rec, startedAt }; setRecording(true); rec.start()
    } catch { toast(appConfig.copy.toast.micDenied, { icon: 'mic', tone: 'warn' }) }
  }

  const discardClip = () => { clipAudio.current?.pause(); setClipPlaying(false); if (clip) URL.revokeObjectURL(clip.url); setClip(null) }
  const discardImport = () => {
    clipAudio.current?.pause(); setClipPlaying(false)
    setImported((cur) => { if (cur) URL.revokeObjectURL(cur.url); return null })
    setStartConfirmed(false)
  }

  const pickSeq = useRef(0)
  const importAudioFile = async (f: File) => {
    const v = validateAudioImport(f)
    if (!v.ok) {
      toast(v.reason === 'size' ? fillTemplate(C.audioTooLarge, { max: MAX_AUDIO_UPLOAD_MB }) : C.audioUnsupported, { icon: 'warn', tone: 'warn' })
      return
    }
    discardClip(); discardImport() // one audio per entry — the new pick replaces both
    const seq = ++pickSeq.current
    const url = URL.createObjectURL(f)
    const durationSec = await probeAudioDuration(url)
    // a slow probe must not resurrect a pick the operator already replaced
    if (seq !== pickSeq.current || !alive.current) { URL.revokeObjectURL(url); return }
    setImported({ file: f, url, name: f.name, durationSec, contentType: v.contentType })
  }
  const onAudioPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = ''
    if (f) void importAudioFile(f)
  }

  // Pasting a copied Voice Memo (or photo) is the easier mobile path than the Files detour —
  // handled on the composer root so a paste into the textarea bubbles here too.
  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? [])
    const audio = files.find((f) => f.type.startsWith('audio/') || /\.m4a$/i.test(f.name))
    const image = files.find((f) => f.type.startsWith('image/'))
    if (!audio && !image) return // plain text paste stays with the textarea
    e.preventDefault()
    if (audio) void importAudioFile(audio)
    else if (image) setPhotos((ps) => [...ps, URL.createObjectURL(image)])
  }

  // recording start resolved to the most recent past occurrence (no date picker by design)
  const importStartAt = imported ? resolveRecordingStart(startHHMM) : null

  // Upload during save (2026-07-15 decision): the row is only created once the server URL
  // exists — an imported memo never enters the offline IndexedDB queue, so offline is an
  // explicit refusal and a failed upload keeps the composer open for a retry.
  const submitImported = async () => {
    if (!imported || !uploadAudio) return
    // resolve at SAVE time — the render-time value can carry a stale day-rollover decision
    // (e.g. 23:50 entered at 23:49 rolled to yesterday, but the operator saves at 23:52)
    const startAt = resolveRecordingStart(startHHMM)
    if (!startAt) return
    if (!navigator.onLine) { toast(C.audioOffline, { icon: 'warn', tone: 'warn' }); return }
    setUploading(true)
    try {
      // re-wrap when the picker's MIME needed normalising (empty/x-wav) so the backend
      // allowlist sees a supported content type
      const blob = imported.file.type === imported.contentType
        ? imported.file
        : new File([imported.file], imported.name, { type: imported.contentType })
      const { url } = await uploadAudio(blob, imported.name)
      if (!alive.current) return // closed mid-upload — cancelled, no row
      onSubmit({
        text: text.trim(), photoUrls: photos.length ? photos : undefined,
        entryType: entryType ?? undefined,
        // …and the same three facts the typed entry carries. An imported memo used to drop them
        // silently: the ring could be set on the sheet and the row landed as an ordinary line.
        dueAt,
        assignee: parts.find((p) => p.kind)?.text,
        ...(noteOn ? { noteFor: { id: noteOn.id } } : openState > 0 ? { pendenz: { urgent: openState === 2 } } : {}),
        audioUrl: url, secs: imported.durationSec ?? undefined,
        audioMeta: {
          source: 'imported', startedAt: startAt.toISOString(),
          durationSec: imported.durationSec ?? undefined, originalName: imported.name,
        },
      })
    } catch (e) {
      if (!alive.current) return
      const msg = e instanceof ApiError && e.status === 413 ? fillTemplate(C.audioTooLarge, { max: MAX_AUDIO_UPLOAD_MB })
        : e instanceof ApiError && e.status === 415 ? C.audioUnsupported
        : C.audioUploadFailed
      toast(msg, { icon: 'warn', tone: 'warn' })
      setUploading(false)
    }
  }

  const onPhotoPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])]
    e.target.value = '' // the same file twice in a row must still fire
    if (files.length) setPhotos((ps) => [...ps, ...files.map((f) => URL.createObjectURL(f))])
  }
  const discardPhoto = (url: string) => {
    URL.revokeObjectURL(url)
    setPhotos((ps) => ps.filter((p) => p !== url))
  }

  const canSend = imported != null
    // hard gate: an imported memo saves only with a confirmed, valid start time
    ? startConfirmed && importStartAt != null && !uploading
    : text.trim().length > 0 || clip != null || photos.length > 0
  const submit = () => {
    if (!canSend || uploading) return
    clearDraft(draftKey) // sent — the next open starts empty
    if (imported) { void submitImported(); return }
    onSubmit({
      text: text.trim(), audioUrl: clip?.url, secs: clip?.secs, photoUrls: photos.length ? photos : undefined,
      entryType: entryType ?? undefined,
      dueAt,
      // «Wer»: the first name the sentence marks. No field asks for it — whoever writes «Trupp 2
      // entraucht Treppenhaus» has already said who it is for, and a Trupp is titled by its
      // Gruppenführer, who is in the vocabulary anyway (lib/journalLinks).
      assignee: parts.find((p) => p.kind)?.text,
      ...(noteOn
        ? { noteFor: { id: noteOn.id } }
        : openState > 0 ? { pendenz: { urgent: openState === 2 } } : {}),
      audioMeta: clip ? { source: 'recorded', startedAt: clip.startedAt, durationSec: clip.secs } : undefined,
    })
  }

  const kbInset = useKeyboardInset()
  return (
    // <Overlay> (Base UI) owns focus-trap + scroll-lock + backdrop-close; its pointerdown-based
    // outside-press already ignores the opening tap, so the old Android `armed` delay is gone.
    // dismissEscape=false: the composer holds unsaved text — Esc must not discard it (parity with
    // the old surface, which never closed on Esc). The keyboard inset lifts the phone bottom sheet.
    // `--jc-kb` carries the measured keyboard height into CSS as well as the phone sheet's
    // marginBottom: on a TABLET the card is top-anchored, so a bottom margin does nothing —
    // the height has to be capped against the keyboard instead (see 10-journal.css).
    // `is-kb` is the same fact as a class: on a PHONE it collapses the four media buttons to
    // icons so the whole sheet still fits in what the keyboard leaves (see 15-mobile.css).
    <Overlay open onClose={onClose} className={`journal-composer ${kbInset > 0 ? 'is-kb' : ''}`} backdropClassName="modal-backdrop"
      ariaLabel={C.composerTitle} dismissEscape={false} initialFocus={textRef}
      style={{ marginBottom: kbInset, '--jc-kb': `${kbInset}px` } as React.CSSProperties}>
      <div onPaste={onPaste} style={{ display: 'contents' }}>
        {/* What this sheet is, and the ✕ beside it.
            ⚠️ There is no «Eintrag · Erinnerung» switch here any more (17.08.). It asked which KIND
            of row this would be BEFORE the sentence was written — and the answer stripped the
            Erinnerung of Art, Foto, Sprachnotiz and the ring, so «Auftrag erteilt» and «um 22:10
            nachfassen» had to be written as two rows about one thing. Whether something has to come
            back is a property of the entry, like the open ring, and it is asked by the clock down
            in the meta row. The title takes the space the tabs had. */}
        <div className="jc-mode">
          {noteOn
            ? (
              // ⚠️ The link lives IN the title row, not on one of its own. As a separate amber
              // band it pushed everything below it down, so the Meldung sheet stood a row taller
              // than the ordinary one — the same card, two heights, depending on how it was
              // opened. «Meldung» leads, the item follows: what this is, then what it is about.
              // ⚠️ A LABEL, not a control. It was a button opening the same menu the ○ switch
              // opens — and then «what is this line?» had two places to be asked, at opposite ends
              // of the sheet, depending on how the sheet had been opened. The ring is that one
              // place in both modes now (it stays visible while writing a Meldung and carries the
              // note-mode rows); this line says what the answer currently is.
              <span className="jc-mode-title jc-mode-note">
                <span className="jc-ring" aria-hidden />
                <b>{C.noteOnTitle}</b>
                <em>{C.noteOnLabel}</em>
                <span className="jc-mode-note-name">{noteOn.text}</span>
              </span>
            )
            // the word alone: the «T» beside it said «text» about the one surface that could not be
            // anything else, next to a sheet full of controls that all mean something
            : <span className="jc-mode-title"><b>{C.composerTitle}</b></span>}
          <button className="journal-x" title={appConfig.copy.closeDialog} aria-label={appConfig.copy.closeDialog}
            onClick={() => { clearDraft(draftKey); onClose() }}><Icon id="close" /></button>
        </div>

        {/* The backdrop that marks known names. A <textarea> cannot style part of its own
            content, so the same text is painted behind it in a transparent div and only the
            <mark> spans show — the field itself is see-through. Both share one font, one
            padding and one line-height, and the backdrop follows the field's scroll, or the
            marks would drift off their words the moment the text got long. */}
        <div className="jc-text-wrap">
          <div className="jc-text-marks" ref={marksRef} aria-hidden>
            {parts.map((p, i) => (p.kind
              ? <mark key={i} className={`jc-mark-${p.kind}`}>{p.text}</mark>
              : <span key={i}>{p.text}</span>))}
            {/* the trailing newline needs a character after it or the div collapses a line
                short of the textarea and every mark below it sits one line too high */}
            {'\n'}
          </div>
        <textarea
          ref={textRef}
          className="jc-text"
          value={text}
          onChange={(e) => {
            const v = stripUnprintable(e.target.value)
            setText(v)
            // …and an emptied field is a fresh start: the chips come back
            setTyped(v.trim().length > 0)
          }}
          placeholder={C.textPlaceholder}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
            // Tab accepts the top Textbaustein suggestion (keyboard path; touch just taps)
            // Tab takes the top suggestion — a NAME first when one is offered, because that
            // is the one you were mid-word on
            else if (e.key === 'Tab' && (nameHits.length > 0 || arrowHit || suggestions.length > 0)) {
              e.preventDefault()
              // ⚠️ The name still wins the keystroke. The arrow is only offered once a name is
              // COMPLETE, so in practice the two never compete — and where they do, the word being
              // typed is the one the reflex was aimed at.
              if (nameHits.length > 0) takeName(nameHits[0].name)
              // …and Tab takes the OUTGOING one. Both are one tap away; the keyboard shortcut
              // can only have one meaning, and «wer sagt es wem» is written that way round.
              else if (arrowHit) takeArrow(ARROW)
              else accept(suggestions[0])
            }
          }}
          onFocus={(e) => caretToEnd(e.currentTarget)}
          onScroll={(e) => { if (marksRef.current) marksRef.current.scrollTop = e.currentTarget.scrollTop }}
        />
        </div>

        {/* Textbausteine as autocomplete (2026-07-02 decision: no static chip row) — while
            typing, the current fragment fuzzy-matches the station's phrase list and the best
            completions appear here; tap (or Tab for the first) replaces the fragment.
            ⚠️ The empty row is still MOUNTED, so its space can be reserved on a phone. The
            composer is a bottom-anchored sheet there: a row appearing and disappearing between
            the field and the chips moves the field itself, and with matches coming and going on
            almost every keystroke the text you were typing hopped around under the caret. On a
            wide screen the row still collapses to nothing (see .jc-phrases.is-empty). */}
        {/* ⚠️ `canLink` is NOT part of this test any more. It was, while a «Zu einer Pendenz» chip
            lived in this row — and once that chip moved onto the ○ switch, the condition kept
            holding an otherwise empty 44px row open for it, so the ordinary Eintrag sheet stood
            taller than the Meldung sheet with nothing in the gap. */}
        {(nameHits.length === 0 && !arrowHit && starters.length === 0 && suggestions.length === 0 && pendenzHits.length === 0)
          ? <div className="jc-phrases is-empty" aria-hidden /> : (
          <div className="jc-phrases" role="group" aria-label={C.quickPhrasesAria}>
            {/* the empty-field chips: the opener first, then what this Einsatz keeps writing */}
            {starters.map((c) => (
              <button
                key={c.label}
                className={`jc-phrase${c.kind === 'opener' ? ' jc-phrase-starter' : ''}`}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => takeStarter(c.insert)}
              >{c.label}</button>
            ))}
            {/* FIRST — it is the chip whose moment has just arrived (a name was completed), and the
                one the next keystroke would otherwise have to be typed around. */}
            {arrowHit && ([ARROW, ARROW_BACK] as const).map((ch) => (
              <button
                key={ch}
                className="jc-phrase jc-phrase-arrow"
                title={ch === ARROW ? C.arrowTitle : C.arrowBackTitle}
                aria-label={ch === ARROW ? C.arrowTitle : C.arrowBackTitle}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => takeArrow(ch)}
              >{ch}</button>
            ))}
            {nameHits.map((n) => (
              <button
                key={`n:${n.kind}:${n.id ?? n.name}`}
                className={`jc-phrase jc-phrase-link jc-link-${n.kind}`}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => takeName(n.name)}
              >{n.name}</button>
            ))}
            {suggestions.map((m) => (
              <button
                key={m.phrase}
                className="jc-phrase"
                // keep the textarea focused through the tap — no blur, no keyboard close
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => accept(m)}
              >{m.phrase}</button>
            ))}
            {/* ── an open Pendenz this sentence already names ──
                ⚠️ LAST in the row, and never the Tab target. Every other chip here INSERTS TEXT;
                these change what the entry is. Tab takes the top suggestion, so a Pendenz sitting
                first would mean a reflex keystroke re-filed the entry instead of completing a
                name — and both look like «the thing I was about to type» from the corner of an eye.
                Amber and ringed, the colours of the link chip they produce, so the row shows at a
                glance which of its chips write words and which one changes the sheet. */}
            {pendenzHits.map((r) => (
              <button
                key={`p:${r.id}`}
                className="jc-phrase jc-phrase-pendenz"
                title={C.linkPendenzTitle}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => onLinkPendenz?.({ id: r.id, text: r.text })}
              ><span className="jc-ring" />{C.noteOnLabel}{r.text}</button>
            ))}
          </div>
        )}

        {/* ── Who said it, what kind of statement it is, and whether it has to come back ──
            All of it lives BELOW the text and above the media, in one quiet strip: the sentence is
            still what this surface is for, and none of these may look like a field that has to be
            filled in before it will accept one. */}
        {(
          <div className="jc-meta">
            {/* Art — quiet by design: three small chips, none preselected. «Info» is the
                ordinary case and prints no marker at all (lib/journalEntry).
                ⚠️ No «ART» eyebrow above them. Info · Auftrag · Sofortmassnahme say what they
                are; a heading that only repeated it cost a row on the one surface fighting the
                keyboard for every row it has. The group keeps the word as its accessible name,
                so a screen reader still hears it. */}
            <div className="jc-meta-row" role="group" aria-label={C.typeLabel}>
              {(['info', 'auftrag', 'sofort'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`jc-chip jc-type-${t}${entryType === t ? ' on' : ''}`}
                  aria-pressed={entryType === t}
                  onClick={() => setEntryType((cur) => (cur === t ? null : t))}
                  // ⚠️ …the label with its break points written in (copy · entryTypesWrap), never
                  // the plain one. This chip is the narrowest control on the sheet; the word that
                  // has to wrap in it is a doctrine word, and where it breaks is not the browser's
                  // guess to make. What gets WRITTEN is still `entryTypes` (lib/journalEntry).
                >{C.entryTypesWrap[t] ?? C.entryTypes[t]}</button>
              ))}
              {/* ── … and whether anything has to come back to it ──
                  Separated from the three by a rule, because it answers a DIFFERENT question.
                  The chips say what kind of statement this is; the ring says whether it stays
                  open. Folding it in as a fourth chip would pretend the four are alternatives —
                  and then «Auftrag» and «Pendenz» would both be true of the same sentence.
                  ⚠️ The ring, not a word: it is the same ring that appears on the Verlauf row and
                  in the Pendenzen list, where tapping it fills it in. Three sightings of one shape
                  carry further than a label that only exists here.
                  ⚠️ It stays while writing a MELDUNG, and carries that mode's menu — re-target the
                  item, or let the link go. It was hidden there for a while and the same choices
                  lived on the header link instead, which meant the control moved to the other end
                  of the sheet depending on how the sheet had been opened. One place for «what is
                  this line?», whatever the answer currently is.
                  ⚠️ What it does NOT do while a Meldung is linked is set urgency ON THAT ITEM. That
                  was tried, as a two-state switch, and it re-ranked the whole Pendenz the Meldung
                  merely reports on. «Dringende Pendenz» in that menu means something else: let the
                  link go and make THIS line a dringende one. */}
              {/* ── … and WHEN it has to come back ──
                  A second round control beside the ring, and deliberately a second one: the ring
                  says «bleibt offen», the clock says «meldet sich». It carries a MENU rather than a
                  strip of chips, for the same reason the ring does — a row that unfolds inside the
                  sheet pushes the field it belongs to under the keyboard, and the answers here are
                  one-of-N. The preset minutes and «Uhrzeit …» live in that one popup.
                  ⚠️ The two controls are not independent (see setDue/setOpen): a Fälligkeit implies
                  an open item, because a banner nobody can tick off has no answer. */}
              <span className="jc-openwrap">
              <Menu
                side="top"
                align="end"
                popupClassName="rp-print-menu jc-pendenz-menu"
                itemClassName={() => 'rp-print-menu-item'}
                // BOTTOM-UP like the ring's menu: this popup opens upwards, so the rows nearest the
                // finger are the ones at the END of the list. The minutes therefore descend —
                // the shortest wait sits closest to the control that was just pressed.
                items={[
                  { kind: 'head' as const, label: C.dueHead },
                  { label: dueRow(<Icon id="clock" />, C.reminderExact, dueSel?.kind === 'at'),
                    onClick: () => setExact(dueSel?.kind === 'at' ? { day: dueSel.day, hhmm: dueSel.hhmm } : defaultExact()) },
                  ...[...C.reminderChips].reverse().map((n) => ({
                    label: dueRow(null, C.reminderChipLabel.replace('{n}', String(n)), dueSel?.kind === 'in' && dueSel.mins === n),
                    onClick: () => setDue({ kind: 'in', mins: n }),
                  })),
                  // …and the way back out, pinned under the thumb — only once there is one
                  ...(dueSel ? [{ label: dueRow(null, C.dueNone, false), onClick: () => setDueSel(null), sticky: true }] : []),
                ]}
                trigger={(
                  <button
                    type="button"
                    className="jc-due-btn"
                    data-on={dueAt ? '1' : undefined}
                    title={dueAt ? fillTemplate(C.dueSetTitle, { t: formatTime(new Date(dueAt)) }) : C.dueHead}
                    aria-label={dueAt ? fillTemplate(C.dueSetTitle, { t: formatTime(new Date(dueAt)) }) : C.dueHead}
                  >
                    <Icon id="clock" />
                    {/* the time itself on the button, not just a lit icon: «meldet sich» without
                        «wann» is the half of the answer nobody can act on */}
                    {dueAt && <span className="jc-due-badge">{formatTime(new Date(dueAt))}</span>}
                  </button>
                )}
              />
              </span>
              <span className="jc-openwrap">
              <Menu
                side="top"
                align="end"
                popupClassName="rp-print-menu jc-pendenz-menu"
                itemClassName={() => 'rp-print-menu-item'}
                // ⚠️ BOTTOM-UP, because this menu opens UPWARDS (side="top"): the ring sits low in
                // the sheet — on a phone right above the thumb — so a list read top-first put its
                // most-used row furthest from the finger that just pressed. The nearest row to the
                // control is the one it is usually reached for: «Neue Pendenz» is LAST here, which
                // on screen means bottom, which means under the thumb.
                // The «Meldung zu» group keeps its heading ABOVE its own rows: a label under the
                // things it names is not a heading, whichever way the list is read.
                items={noteOn
                  ? [
                    // Writing a Meldung — and the menu asks the SAME question it asks anywhere
                    // else, with the same rows in the same places. «this is its own thing after
                    // all» is a normal thing to realise halfway through a sentence, and it was
                    // two steps: let the link go, then say what the line is instead.
                    { kind: 'head' as const, label: C.linkPendenzTitle },
                    ...openPendenzen.map((r) => ({
                      label: menuRow(r.urgent ? 2 : 1, r.text, r.id === noteOn.id),
                      onClick: () => onLinkPendenz?.(r),
                    })),
                    ...(onClearNote
                      ? [
                        { label: menuRow(0, C.noteOnClear, false), onClick: onClearNote, sticky: true },
                        // ⚠️ Both of these UNLINK first. `submit` reads `noteFor` before `pendenz`,
                        // so a draft still carrying the link would quietly ignore the choice just
                        // made and file the line as a Meldung anyway.
                        { label: menuRow(2, C.pendenzNewUrgent, false), onClick: () => { onClearNote(); setOpen(2) }, sticky: true },
                        { label: menuRow(1, C.pendenzNew, false), onClick: () => { onClearNote(); setOpen(1) }, sticky: true },
                      ]
                      : []),
                  ]
                  : [
                  // ⚠️ Every row carries THE RING, in the state it produces — empty, amber, or red
                  // with the bang. The menu is opened from that ring and sets that ring, so a list
                  // of bare sentences made the two look like unrelated things; the same shape in
                  // three fills says what the words would have to spell out.
                  ...(canLink
                    ? [
                      { kind: 'head' as const, label: C.linkPendenzTitle },
                      // the open items in the order the Pendenzen block itself uses: dringend
                      // first, then the oldest. An item shows ITS OWN urgency, the block's red.
                      ...openPendenzen.map((r) => ({ label: menuRow(r.urgent ? 2 : 1, r.text, false), onClick: () => onLinkPendenz?.(r) })),
                      // …no separator: the pinned block below carries its own edge, and one in the
                      // flow would scroll away from the boundary it is supposed to mark
                    ]
                    : []),
                  // ⚠️ PINNED to the bottom, not merely last. Last alone meant one of the two ends
                  // of a scrolling list had to lose: opening at the top hid «Neue Pendenz» below
                  // the fold, opening at the bottom hid the most pressing items above it. Pinned,
                  // the list keeps its own order — dringend first, then oldest, read from the top —
                  // while the rows you nearly always want stay under the thumb.
                  ...(openState > 0 ? [{ label: menuRow(0, C.pendenzNotOpen, false), onClick: () => setOpen(0), sticky: true }] : []),
                  { label: menuRow(2, C.pendenzNewUrgent, openState === 2), onClick: () => setOpen(2), sticky: true },
                  { label: menuRow(1, C.pendenzNew, openState === 1), onClick: () => setOpen(1), sticky: true },
                  ]}
                // ⚠️ The ring IS the trigger. It was an invisible anchor beside it for a while,
                // with the open state held here — and then a second press on the ring counted as
                // an OUTSIDE press, so Base UI closed the menu and the click handler opened it
                // again on the same tap. Base UI's own trigger toggles, and it is the only thing
                // that can: it knows about the press before the outside-press handler runs.
                trigger={(
                  <button
                    type="button"
                    className="jc-open"
                    data-state={noteOn ? 1 : openState}
                    title={noteOn ? C.linkPendenzTitle : C.openStates[openState]}
                    aria-label={noteOn ? C.linkPendenzTitle : C.openStates[openState]}
                  >
                    {/* ⚠️ Not the `warn` triangle. A triangle's optical centre sits below its
                        bounding box, so inside a ring it reads as hanging — and a triangle inside
                        a circle is two outlines fighting at 21px. Solid disc + a drawn bang. */}
                    <span className="jc-ring">{openState === 2 && <span className="jc-bang" />}</span>
                  </button>
                )}
              />
              </span>
            </div>
          </div>
        )}

        {/* media: record a voice memo or attach a photo — on EVERY entry now, including one that
            carries a due time. An Erinnerung used to be text-only, which is why «Foto vom Zähler,
            in 10 min nachschauen» had to be two rows. */}
        {(<>
          {/* ⚠️ `.file-picker`, never `hidden`: Safari opens a file chooser only for an input it
              actually renders, so `.click()` on a display:none input is a silent no-op on iOS
              (see 02-base.css). Off-screen and transparent, both pickers work on a phone. */}
          <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple
            className="file-picker" tabIndex={-1} onChange={onPhotoPicked} />
          <input ref={audioFileRef} type="file" accept={AUDIO_IMPORT_ACCEPT}
            className="file-picker" tabIndex={-1} onChange={(e) => void onAudioPicked(e)} />
          <div className="jc-audio">
            {/* recording shows the stop square + the running time, NOT «Aufnahme stoppen · 22s»:
                this button is one of three in a fixed 1fr grid and that label never fitted, so it
                ran out past the red rounded corner. It is also what the TopBar and the FAB already
                turn into while recording — a red pulsing button with a square and a clock reads as
                «tap to stop» without spending a third of the row saying so. */}
            {/* ⚠️ Every label in this row sits in its own <span class="jc-lbl">. On a phone with
                the keyboard up the row shrinks to four icons (see 15-mobile.css · .is-kb), and a
                bare text node cannot be hidden by CSS. The `title` carries the word for anyone
                hovering, and the labels come straight back the moment the keyboard closes. */}
            <button className={`jc-rec ${recording ? 'on' : ''}`} onClick={toggleRecord} title={recording ? C.recordStop : C.record} aria-label={recording ? C.recordStop : C.record}>
              {recording
                ? <><span className="tb-stop" /><span className="jc-rec-time">{elapsed}s</span></>
                : <><Icon id="mic" /><span className="jc-lbl">{C.record}</span></>}
            </button>
            {/* the media buttons share one row at a third of the width each — not even a
                desktop third fits «Audio hochladen», so the short form labels the button and the
                full one stays as its tooltip. The upload arrow carries the rest. */}
            <button className="jc-rec" onClick={() => audioFileRef.current?.click()} title={C.audioUpload} aria-label={C.audioUpload}>
              <Icon id="upload" /><span className="jc-lbl">{C.audioUploadShort}</span>
            </button>
            <button className="jc-rec" onClick={() => fileRef.current?.click()} title={C.photo} aria-label={C.photo}><Icon id="cam" /><span className="jc-lbl">{C.photo}</span></button>
            {clip && (
              <span className="jc-clip">
                <button className={`tl-play ${clipPlaying ? 'playing' : ''}`} title={clipPlaying ? C.recordStop : appConfig.copy.play} aria-label={clipPlaying ? C.recordStop : appConfig.copy.play} onClick={toggleClip}><Icon id={clipPlaying ? 'pause' : 'play'} /></button>
                <span className="jc-clip-name">
                  <strong>{C.audioClipLabel}</strong>
                  <em>{clip.secs}s</em>
                </span>
                <button className="jc-clip-x" title={C.discardAudio} aria-label={C.discardAudio} onClick={discardClip}><Icon id="close" /></button>
              </span>
            )}
          </div>
          {imported && (
            <div className="jc-import">
              <div className="jc-import-row">
                <button className={`tl-play ${clipPlaying ? 'playing' : ''}`} title={clipPlaying ? C.recordStop : appConfig.copy.play} aria-label={clipPlaying ? C.recordStop : appConfig.copy.play} onClick={toggleClip}><Icon id={clipPlaying ? 'pause' : 'play'} /></button>
                <span className="jc-import-name">
                  <strong>{C.audioImportLabel}</strong>
                  <em>{imported.name}{imported.durationSec != null ? ` · ${formatAudioDuration(imported.durationSec)}` : ''}</em>
                </span>
                <button className="jc-clip-x" title={C.audioDiscardImport} aria-label={C.audioDiscardImport} onClick={discardImport}><Icon id="close" /></button>
              </div>
              <div className="jc-import-start">
                <span className="jc-due-label">{C.audioStartLabel}</span>
                <TimeStepper hhmm={startHHMM} onChange={(v) => { setStartHHMM(v); setStartConfirmed(true) }} />
                <button className={`jc-due-chip ${startConfirmed ? 'on' : ''}`} aria-pressed={startConfirmed} onClick={() => setStartConfirmed(true)}>
                  <Icon id="check" />{C.audioStartConfirm}
                </button>
              </div>
              <p className="jc-import-hint">{C.audioStartHint}</p>
            </div>
          )}
          {photos.length > 0 && (
            <div className="jc-photos">
              {photos.map((url) => (
                <div className="jc-photo" key={url}>
                  <img src={url} alt="" />
                  <button className="jc-clip-x" title={C.discardPhoto} aria-label={C.discardPhoto} onClick={() => discardPhoto(url)}><Icon id="close" /></button>
                </div>
              ))}
            </div>
          )}
        </>)}

        {/* the send, alone. The pin moved up into the media row (see .jc-audio) — it describes
            the entry, not the act of saving it, and «Erfassen» is the one thing on this sheet
            that must never share a row with anything else. */}
        <div className="jc-foot">
          <button className="jc-send" disabled={!canSend || uploading} onClick={submit}>
            <Icon id="check" />{uploading ? C.audioUploading : C.send}
          </button>
        </div>
      </div>
      {/* «Uhrzeit …» — the one answer that is not a row in a menu. A dialog rather than a strip
          unfolding inside the sheet: the composer is already fighting the keyboard for its rows,
          and this is the rare path. It carries the SAME ± stepper the imported memo uses. */}
      {/* ⚠️ `ui-dialog` is not decoration: it is what POSITIONS and stacks a dialog at all (see
          08-toasts.css · «der Stift öffnet nichts»). Without it this card mounted into the DOM
          unstyled at the top of <body> and under the sheet — «Uhrzeit tut nichts», with a DOM that
          looked perfectly correct. Its z-index (96) is also what puts it over the composer (81).
          There is deliberately no second backdrop: Base UI renders none for a NESTED dialog, so
          the sheet stays visible behind — right for a popup that answers one question about it. */}
      {exact != null && (
        <Overlay open onClose={() => setExact(null)} className="confirm-card ui-dialog jc-exact" backdropClassName="modal-backdrop"
          ariaLabel={C.reminderExact}>
          <h3 className="jc-exact-title">{C.dueExactTitle}</h3>
          {/* ⚠️ THE DAY, always — not «and if that time is already past, then tomorrow». An Einsatz
              runs over midnight often enough that the rule was silently right most of the time and
              silently wrong the rest, on a surface where nobody re-reads what they set. It steps
              rather than opens a calendar: a Wiedervorlage lands today or tomorrow in nearly every
              case, and ± is one tap with a glove on. */}
          <div className="jc-exact-day">
            <button type="button" className="jc-time-btn" aria-label={C.dayBack}
              onClick={() => setExact((e) => (e ? { ...e, day: stepDay(e.day, -1) } : e))}
              disabled={exact.day === dayKey(new Date())}
            ><Icon id="chevron" className="jc-exact-prev" /></button>
            <b>{dayLabel(exact.day)}</b>
            <button type="button" className="jc-time-btn" aria-label={C.dayForward}
              onClick={() => setExact((e) => (e ? { ...e, day: stepDay(e.day, 1) } : e))}
            ><Icon id="chevron" /></button>
          </div>
          <TimeStepper hhmm={exact.hhmm} onChange={(hhmm) => setExact((e) => (e ? { ...e, hhmm } : e))} />
          {/* what the two together mean, resolved exactly as `resolveDueAt` will resolve them —
              including the case the day picker now makes possible: a time that has already gone by */}
          <p className={`jc-exact-preview${pastDue ? ' is-past' : ''}`}>
            {pastDue ? C.duePast : `${dayLabel(exact.day)} · ${exact.hhmm}`}
          </p>
          <div className="jc-exact-actions">
            <button className="jc-exact-cancel" onClick={() => setExact(null)}>{appConfig.copy.cancel}</button>
            {/* ⚠️ Disabled on a past instant rather than quietly rolling it forward: a reminder that
                fires the second it is saved is not what «22:57» meant, and the fix is one tap on
                the day. */}
            <button className="jc-exact-ok" disabled={pastDue}
              onClick={() => { setDue({ kind: 'at', day: exact.day, hhmm: exact.hhmm }); setExact(null) }}>
              <Icon id="check" />{C.dueExactConfirm}
            </button>
          </div>
        </Overlay>
      )}
    </Overlay>
  )
}
