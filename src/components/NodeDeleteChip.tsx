import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'

/** Radius of the progress ring in its own 62px viewBox — the circumference the fill runs on. */
const R = 28
const RING_LEN = 2 * Math.PI * R

/**
 * What a node about to be deleted looks like: the app's own detach chip (× on white, red rim —
 * see `.line-detach-chip`) sitting BESIDE the node so the finger does not cover it, with a ring
 * that fills while the hold lasts.
 *
 * Deliberately the same object the map already uses for «Verbindung lösen»: both are the red,
 * destructive thing you can do to a line's end, and giving them one look means the gesture has
 * to be learned once. It is display-only — the hold itself lives in lib/nodeHold.
 */
export function NodeDeleteChip({ progress }: { progress: number }) {
  const label = appConfig.copy.measure.deleteNode
  return (
    <span className="node-del" aria-hidden>
      <span className="node-del-face" title={label}><Icon id="close" /></span>
      <svg className="node-del-ring" viewBox="0 0 62 62">
        <circle className="node-del-track" cx="31" cy="31" r={R} />
        <circle
          className="node-del-fill"
          cx="31" cy="31" r={R}
          strokeDasharray={RING_LEN}
          strokeDashoffset={RING_LEN * (1 - Math.max(0, Math.min(1, progress)))}
        />
      </svg>
    </span>
  )
}
