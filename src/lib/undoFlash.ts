import { showHoldBubble } from './holdTooltip'

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

let current: { el: HTMLElement; timer: number } | null = null

/** Flash `text` at `anchor`. A second flash replaces the first – two of these overlapping would
 *  be two different answers to one question. */
export function flashUndoCaption(anchor: HTMLElement, text: string): void {
  clearUndoCaption()
  const bubble = showHoldBubble(anchor, text)
  const timer = window.setTimeout(() => { bubble.remove(); current = null }, LINGER_MS)
  current = { el: bubble, timer }
}

/** Drop a flash early (unmount, a new one arriving). Safe to call when nothing is showing. */
export function clearUndoCaption(): void {
  if (!current) return
  clearTimeout(current.timer)
  current.el.remove()
  current = null
}
