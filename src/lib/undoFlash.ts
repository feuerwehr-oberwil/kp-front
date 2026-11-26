import { useEffect } from 'react'
import { appConfig } from '../config/appConfig'
import type { SyncStatus } from './incidents'
import { placeHoldBubble, showHoldBubble } from './holdTooltip'

/**
 * The confirmation for a cross-surface undo: press ↶ on the Karte and the words «Rückgängig:
 * Kontakt Trupp 2» appear at the button for a moment.
 *
 * There has to be one, because the header pair now reaches every surface: the operator is looking
 * at the Karte, and the thing that just came back happened on the Atemschutz-Tafel two taps ago.
 * Without a word he sees nothing change and taps again.
 *
 * ⚠️ It is NOT a toast. A toast is the app telling you about something that happened on its own
 * schedule — it stacks, it queues behind other toasts, it has a dismiss. This is the button
 * answering the press that was just made, so it is the hold-tooltip's own bubble (`showHoldBubble`)
 * at the same place, and it goes on its own. Held, ↶ promises these words; pressed, it says them.
 */
const LINGER_MS = 1400
/** How long a caption waits for the server's word before it goes without it (owner pick UX
 *  journeys M·11, 25.11.2026). «Saved» waits for every record queue – the workspace pushes 600 ms
 *  after the step (appConfig · saveDebounceMs), but the step's Verlauf row and audit event took
 *  ~3.5 s on the demo stack; offline, the head's own sync state speaks instead. */
const SAVE_WAIT_MS = 8000
/** the check the «gespeichert» chip carries (lib/icons' check, as markup: this bubble is DOM) */
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'

/** What a flash hands back (owner pick UX journeys M·11, 25.11.2026): `holdForSave` keeps the
 *  caption up while the step is on its way to the server, `saved` then adds «✓ gespeichert». */
export interface UndoFlash { holdForSave: () => void; saved: () => void }

let current: { el: HTMLElement; timer: number } | null = null

/**
 * Flash `text` at `anchor`. A second flash replaces the first – two of these overlapping would
 * be two different answers to one question.
 *
 * «Bestätigung am Ort» (owner pick UX journeys M·11, 25.11.2026): the walker undid a move and
 * could not tell whether the old place was STORED – the head says nothing while all is well
 * (round 2b, 13.11.2026, still holds). So the caller (IncidentWorkspace, on the records' sync
 * status) says `holdForSave` while the step is pending – the caption then stays up to
 * SAVE_WAIT_MS – and `saved` once every queue has it: «✓ gespeichert» for a moment. A step
 * nothing had to send, or no word in time: it goes as before, claiming nothing.
 */
export function flashUndoCaption(anchor: HTMLElement, text: string): UndoFlash {
  clearUndoCaption()
  const bubble = showHoldBubble(anchor, text)
  const entry = { el: bubble, timer: 0 }
  const end = (ms: number) => {
    clearTimeout(entry.timer)
    entry.timer = window.setTimeout(() => { bubble.remove(); if (current === entry) current = null }, ms)
  }
  end(LINGER_MS)
  current = entry
  let held = false
  let said = false
  return {
    holdForSave: () => {
      if (held || said || current !== entry) return
      held = true
      end(SAVE_WAIT_MS)
    },
    saved: () => {
      if (said || current !== entry) return
      said = true
      const chip = document.createElement('span')
      chip.className = 'hold-tip-saved'
      chip.innerHTML = CHECK_SVG
      chip.append(appConfig.copy.undoStep.saved)
      bubble.classList.add('with-saved')
      bubble.append(chip)
      placeHoldBubble(bubble, anchor)
      end(LINGER_MS)
    },
  }
}

/** Drop a flash early (unmount, a new one arriving). Safe to call when nothing is showing. */
export function clearUndoCaption(): void {
  if (!current) return
  clearTimeout(current.timer)
  current.el.remove()
  current = null
}

const RING_MS = 1900
const RING_DELAY_MS = 60

/**
 * Ring the Karte marker of object `id` – the object a ↶ / ↷ just named (owner pick UX journeys
 * M·11, 25.11.2026: the signal stands where the eye goes after the tap). Found by its
 * `data-object-id` (components/EntityMarker); a marker that is not drawn – another surface, off
 * screen, the step took it away – rings nothing. A Leitung or Fläche has no marker: the caller
 * flashes its outline instead (MapView · flashDrawingId).
 */
export function ringStepObject(id: string): void {
  // after the render that puts the object back: a ↶ of a removal draws its marker anew
  window.setTimeout(() => {
    const el = document.querySelector<HTMLElement>(`.marker[data-object-id="${CSS.escape(id)}"]`)
    if (!el) return
    el.classList.remove('step-flash')
    void el.offsetWidth // restart the beats on a second ↶ of the same object
    el.classList.add('step-flash')
    window.setTimeout(() => el.classList.remove('step-flash'), RING_MS)
  }, RING_DELAY_MS)
}

/**
 * The ↶ caption waiting for the server's word (owner pick UX journeys M·11, 25.11.2026): `watch`
 * takes the caption a press just showed, `status` hears every change of the records' sync status.
 * Pending after the press holds the caption; synced after pending says «✓ gespeichert». A save
 * already under way at the press counts – «synced» after it covers this step too. Offline or
 * failing: no word, the head's own sync state speaks. The app runs ONE (`watchSave` /
 * `useSaveWaitStatus` below), as it shows one caption.
 */
export function createSaveWait() {
  let last: SyncStatus = 'synced'
  let wait: { flash: UndoFlash; seen: boolean } | null = null
  return {
    watch: (flash: UndoFlash) => {
      wait = { flash, seen: last === 'pending' }
      if (wait.seen) flash.holdForSave()
    },
    status: (s: SyncStatus) => {
      last = s
      if (!wait) return
      if (s === 'pending') { wait.seen = true; wait.flash.holdForSave(); return }
      if (s === 'synced' && wait.seen) wait.flash.saved()
      wait = null
    },
  }
}

const saveWait = createSaveWait()

/** Let the caption a ↶ / ↷ press just showed wait for «✓ gespeichert» (IncidentWorkspace · stepHistory). */
export function watchSave(flash: UndoFlash): void {
  saveWait.watch(flash)
}

/** Feed the waiter the records' sync status (IncidentWorkspace, beside `recordsSyncStatus`). */
export function useSaveWaitStatus(status: SyncStatus): void {
  useEffect(() => saveWait.status(status), [status])
}
