import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { useTimedProgress } from '../lib/nodeHold'
import { MAGNET_DWELL_MS } from '../lib/lineAttachments'

/** Radius of the progress ring in its own 62px viewBox — the circumference the fill runs on. */
const R = 28
const RING_LEN = 2 * Math.PI * R

/** delete = hold a node until it goes · connect = dwell on a target until the line couples ·
 *  release = pull an attached end out of its socket · unlock = hold a locked shape's chip until
 *  it opens. Four things, one ring — red where something is taken away or broken, blue where
 *  something is joined or given back. */
export type NodeChipTone = 'delete' | 'connect' | 'release' | 'unlock'

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
 * old socket says «weiterziehen, dann ist es frei». Since 27.08. «Entsperren» wears it too, in
 * blue with a padlock. Connect, release, delete and unlock are everything that can happen at a
 * held point, so they get one shape and one ring — learn it once.
 *
 * `progress` (0…1) paints the ring, always. Whatever drives it — a hold's clock
 * (lib/nodeHold · useNodeHold), a dwell's deadline (useTimedProgress) or the hand's own
 * distance (lib/lineAttachments · detachProgress) — the fill is a plain attribute.
 *
 * ⚠️ It used to be a CSS keyframe for the timed connect case, and that was a bug: the global
 * `prefers-reduced-motion` rule in styles/03-map.css zeroes every animation with `!important`,
 * so the ring showed FULL while the dwell still had 350 ms to run. A progress indicator that a
 * decoration rule can silence is not an indicator. One driver, in JS, for all four tones.
 */
export function NodeDeleteChip({ progress, tone = 'delete', label }: {
  progress: number
  tone?: NodeChipTone
  label?: string
}) {
  const copy = appConfig.copy.measure
  const text = label ?? (tone === 'connect' ? copy.snapConnect : tone === 'release' ? copy.snapRelease : copy.deleteNode)
  const icon = tone === 'connect' ? 'attach' : tone === 'unlock' ? 'lock' : 'close'
  return (
    <span className={`node-del tone-${tone}`} aria-hidden>
      <span className="node-del-face" title={text}><Icon id={icon} /></span>
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

/**
 * The «halten, dann verbindet es» ring, in the one place that knows how it is driven.
 *
 * A component rather than a bare hook call at each site, because there are two of these live at
 * once per surface (the endpoint drag and the draft stroke) and a hook cannot be called inside
 * the conditional JSX where the ring appears. `since` is the dwell's own start stamp, so
 * re-entering a target restarts the fill by changing the hook's dependency — no React `key`
 * gymnastics required.
 *
 * `armed` short-circuits to a full ring: `armDwell` (lib/lineAttachments) fires the instant a
 * NEW stroke starts inside a target, and that case has nothing to wait for.
 */
export function ConnectRing({ since, armed }: { since: number; armed: boolean }) {
  const progress = useTimedProgress(since, MAGNET_DWELL_MS)
  return <NodeDeleteChip tone="connect" progress={armed ? 1 : progress} />
}
