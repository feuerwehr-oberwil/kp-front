// Which Ebenen THIS DEVICE is looking at, per incident.
//
// Layer visibility is a way of LOOKING at the picture, not a fact about the Einsatz: the tablet on
// the Kommandotisch wants the Hydranten and the Leitungskataster on, the phone in a jacket pocket
// wants a bare map it can still read — and neither may decide that for the other. `mergeWorkspace`
// has kept `layerState` local through every merge for exactly that reason. What still leaked was
// the two ends the merge never sees: `deriveInitial` seeding a first open from the SERVER copy,
// and the save that put this device's toggles into the shared blob in the first place.
//
// So the live value lives here, and the blob field is left to the record (lib/replay folds
// `layer.toggle` events onto it when scrubbing, and an older workspace's stored value is still
// read once, as the seed — see deriveInitial).
//
// localStorage, not the prefs cookie (lib/prefs): a cookie rides on every request, and this is a
// per-incident map of ~20 rows rather than one small scalar. Same shape as the app's other small
// `kp.*` device stores (diveraDismiss, demoWelcome): best-effort throughout — a device with
// storage disabled simply falls back to the defaults, which is a working map.

import type { LayerId } from '../types'

/** One layer's device-local state — the same triple the workspace blob's `layerState` carries. */
export interface StoredLayerState {
  id: LayerId
  visible: boolean
  opacity?: number
}

const key = (incidentId: string) => `kp.layers.${incidentId}`

const isRow = (x: unknown): x is StoredLayerState =>
  !!x && typeof x === 'object' && typeof (x as StoredLayerState).id === 'string'
  && typeof (x as StoredLayerState).visible === 'boolean'

/** What this device last looked at on this incident, or `undefined` when it has never said —
 *  which is what tells deriveInitial to fall back to the blob's legacy seed. */
export function loadLayerPrefs(incidentId: string): StoredLayerState[] | undefined {
  try {
    const raw = localStorage.getItem(key(incidentId))
    if (!raw) return undefined
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return undefined
    const rows = v.filter(isRow)
    return rows.length ? rows : undefined
  } catch { return undefined }
}

/** Remember this device's Ebenen for this incident. Never reaches the server. */
export function saveLayerPrefs(incidentId: string, layers: readonly StoredLayerState[]): void {
  try { localStorage.setItem(key(incidentId), JSON.stringify(layers)) } catch { /* preference only */ }
}
