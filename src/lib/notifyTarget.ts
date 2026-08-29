// The routing target of a tapped system notification when the app was COLD-STARTED by the
// tap. A running app gets the target as a postMessage (sw-notify.js → the App listeners),
// but a killed app boots too late for that — so the SW opens '/?kpn=<target>' and the app
// consumes the param exactly once at mount, stripping it from the URL/history so a reload
// or bookmark never re-triggers the route.

/** Pure extraction — 'kpn' from a search string ('?kpn=divera' → 'divera'). */
export function extractNotifyTarget(search: string): string | null {
  const v = new URLSearchParams(search).get('kpn')
  return v || null
}

/** Does a target belong to one of the accepted surfaces? A target may carry a payload after the
 *  surface name — 'atemschutz:t123' points at one Trupp's card — so 'atemschutz' accepts both
 *  the bare form (old service workers / old pushes still send it) and any 'atemschutz:…'.
 *  ⚠️ Prefix + ':' only, never a bare startsWith: 'atemschutzXY' is a different target. */
export function matchesNotifyTarget(target: string, accepted: string[]): boolean {
  return accepted.some((a) => target === a || target.startsWith(`${a}:`))
}

let consumed = false
let bootTarget: string | null = null

/** Read-and-strip the boot notification target from the URL. Idempotent (StrictMode
 *  double-mount safe): the first call consumes the param; later calls return the held value
 *  until a surface claims it. */
function consumeBootNotifyTarget(): string | null {
  if (consumed) return bootTarget
  consumed = true
  try {
    bootTarget = extractNotifyTarget(window.location.search)
    if (bootTarget) {
      const url = new URL(window.location.href)
      url.searchParams.delete('kpn')
      window.history.replaceState(null, '', url.pathname + url.search + url.hash)
    }
  } catch { bootTarget = null }
  return bootTarget
}

/** One-shot claim by the surface that owns the target: returns the boot target if it names one
 *  of the `accepted` surfaces (bare or with a ':payload' suffix — see matchesNotifyTarget) and
 *  clears it — so a remounting consumer (e.g. IncidentWorkspace on an incident switch) can
 *  never route the same tap twice. The FULL target comes back; the claimer parses the suffix. */
export function claimBootNotifyTarget(accepted: string[]): string | null {
  const t = consumeBootNotifyTarget()
  if (t && matchesNotifyTarget(t, accepted)) {
    bootTarget = null
    return t
  }
  return null
}
