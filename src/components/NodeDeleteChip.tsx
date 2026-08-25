import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'

/** Radius of the progress ring in its own 62px viewBox — the circumference the fill runs on. */
const R = 28
const RING_LEN = 2 * Math.PI * R

/** delete = hold a node until it goes · connect = dwell on a target until the line couples ·
 *  release = pull an attached end out of its socket. Three things, one ring. */
export type NodeChipTone = 'delete' | 'connect' | 'release'

/**
 * What a node about to be deleted looks like: the app's own detach chip (× on white, red rim —
 * see `.line-detach-chip`) sitting BESIDE the node so the finger does not cover it, with a ring
 * that fills while the hold lasts.
 *
 * Deliberately the same object the map already uses for «Verbindung lösen»: both are the red,
 * destructive thing you can do to a line's end, and giving them one look means the gesture has
 * to be learned once. It is display-only — the hold itself lives in lib/nodeHold.
 *
 * Since 25.08. it is also the ONE picture of magnetic attachment on both surfaces: the same
 * chip in blue with a paperclip says «halten, dann verbindet es», the same chip in red at the
 * old socket says «weiterziehen, dann ist es frei». Connect, release and delete are the three
 * things that can happen at a line's end, so they get one shape and one ring — learn it once.
 *
 * `progress` paints the ring explicitly (hold-to-delete, pull-to-release, both driven by the
 * hand). Omit it and pass `fillMs` instead for the timed connect ring: CSS runs the fill, so a
 * motionless finger — which fires no pointermove and would freeze a computed value — still sees
 * it close. Give the element a React `key` that changes when the dwell restarts.
 */
export function NodeDeleteChip({ progress, fillMs, tone = 'delete', label }: {
  progress?: number
  fillMs?: number
  tone?: NodeChipTone
  label?: string
}) {
  const copy = appConfig.copy.measure
  const text = label ?? (tone === 'connect' ? copy.snapConnect : tone === 'release' ? copy.snapRelease : copy.deleteNode)
  return (
    <span className={`node-del tone-${tone}${progress != null ? ' ring-set' : ''}`} aria-hidden>
      <span className="node-del-face" title={text}><Icon id={tone === 'connect' ? 'attach' : 'close'} /></span>
      <svg
        className="node-del-ring"
        viewBox="0 0 62 62"
        style={{ ['--ring-len' as string]: `${RING_LEN}`, ['--ring-ms' as string]: fillMs != null ? `${fillMs}ms` : undefined }}
      >
        <circle className="node-del-track" cx="31" cy="31" r={R} />
        {/* an explicit progress wins (and `.ring-set` shuts the keyframe off for it); without
            one the `--ring-ms` animation owns the offset */}
        <circle
          className="node-del-fill"
          cx="31" cy="31" r={R}
          strokeDasharray={RING_LEN}
          {...(progress != null ? { strokeDashoffset: RING_LEN * (1 - Math.max(0, Math.min(1, progress))) } : {})}
        />
      </svg>
    </span>
  )
}
