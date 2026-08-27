import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { useNodeHold } from '../lib/nodeHold'
import { NodeDeleteChip } from './NodeDeleteChip'

/**
 * The chip sitting on a locked line / area — its ONLY tap target, because the ink itself is
 * click-through once locked.
 *
 * A SHORT HOLD (not a tap) unlocks, so a stray fingertip on a big Absperrkreis never opens it.
 * The hold is `lib/nodeHold` — the same clock, the same 250 ms of stillness before anything is
 * drawn, and the same ring beside the chip that every other hold in the app uses. It carries
 * the blue, constructive tone: unlocking gives editing back, it does not take anything away.
 *
 * ⚠️ It used to run its own 700 ms `setTimeout` behind a 4 px linear bar in a floating card.
 * Three things were wrong with that. The picture was unlike the three rings the same hand
 * already knows; there was no arm delay on the one control most likely to be brushed; and the
 * timer had no unmount cleanup, so a chip that disappeared mid-hold (a tool change, a workspace
 * sync dropping the anno) still unlocked the shape 700 ms later. `useNodeHold` cancels on
 * unmount, on release and on any movement past 10 px.
 *
 * Shared by the Lage (MapView, over `Drawing.locked`) and the Plan (Whiteboard, over
 * `BoardAnno.locked`): one gesture, one hold duration, one wording — the two surfaces cannot
 * teach the same hand two different unlocks.
 */
export function LockChip({ onUnlock }: { onUnlock: () => void }) {
  const hold = useNodeHold()
  const label = appConfig.copy.drawingEditor.unlockHold
  const press = hold.press('unlock', onUnlock)
  return (
    <button
      className={`draw-lock-chip${hold.armed ? ' holding' : ''}`}
      title={label} aria-label={label}
      // ⚠️ The stop has to WRAP the hold's own handler, not sit in a capture-phase one beside
      // it: `stopPropagation()` during React's capture phase also cancels the bubble-phase
      // handler on this very element, so a separate `onPointerDownCapture` silently ate every
      // hold. The surface underneath must still not start a pan under this chip.
      onPointerDown={(e) => { e.stopPropagation(); press.onPointerDown(e) }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* the ring sits BESIDE the chip (.node-del is absolutely placed off it), so the
          fingertip never covers the one thing that says how much longer to hold */}
      {hold.armed && <NodeDeleteChip tone="unlock" progress={hold.armed.progress} label={label} />}
      <Icon id="lock" />
    </button>
  )
}
