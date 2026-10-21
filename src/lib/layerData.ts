/**
 * **The GeoJSON Ebenen load through here, so the Ebenen row can say how far it got.**
 *
 * A reference layer like «Leitungen» is a few MB of GeoJSON on the device's own server. Left to
 * MapLibre the file is fetched inside the worker, which tells us nothing: the row stood there
 * unchanged and the map stayed empty until it was done (owner, review round 7: «I need some sort
 * of loading state … we don't have offline prefetching like in the emergency tab»). So the app
 * fetches it itself, counts the bytes as they arrive and hands MapLibre the parsed collection —
 * one fetch, not two, and a real number to show instead of a spinner that knows nothing
 * (the house rule from GeorefMode: never an indeterminate spinner over a long wait when a real
 * progress number exists).
 *
 * The store is module-level and keyed by layer id: the map (components/MapLayers) starts the
 * load, the Ebenen panel (components/LayerPanel) reads the same entry through `useLayerData()`
 * without anything being drilled through KarteApp or the IncidentWorkspace. Parsed collections
 * are kept, so toggling a layer off and on again is instant and costs no second download.
 */
import { useSyncExternalStore } from 'react'
import type { GeoJSONSourceSpecification } from 'maplibre-gl'
import type { LayerId } from '../types'

/** a FeatureCollection exactly as a MapLibre GeoJSON source takes it — we never touch the
 *  features, we only count them and hand the collection on */
export type LayerFeatureCollection = Extract<Exclude<GeoJSONSourceSpecification['data'], string>, { type: 'FeatureCollection' }>

export type LayerData =
  /** bytes so far; `total` only when the server sent a Content-Length */
  | { state: 'loading'; loaded: number; total: number | null }
  /** loaded and not empty — `data` is what the map draws */
  | { state: 'ready'; features: number; data: LayerFeatureCollection }
  /** loaded, but the file holds no features: say so, instead of looking like it is still loading */
  | { state: 'empty' }
  /** offline, 404, or not a FeatureCollection — switching the layer off and on tries again */
  | { state: 'failed' }

let store: ReadonlyMap<LayerId, LayerData> = new Map()
const listeners = new Set<() => void>()
/** urls whose fetch is running, so a re-render or a second surface never starts it twice */
const inFlight = new Set<string>()

function publish(id: LayerId, entry: LayerData) {
  const next = new Map(store)
  next.set(id, entry)
  store = next
  for (const l of listeners) l()
}

/** every ~120 ms while the bytes come in: a progress line is read, not animated frame by frame */
const PROGRESS_MS = 120

async function run(id: LayerId, url: string) {
  inFlight.add(url)
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    /* What to divide the bytes by. The reader hands out DECODED bytes while `Content-Length`
       counts the gzipped ones (the API gzips anything over 1 KB), so the backend states the raw
       size itself (`X-Raw-Bytes`, api/reference) and that is the number the bar uses. A response
       without it is only measurable when nothing was encoded; otherwise the row shows the loader
       alone rather than a figure that is wrong by the compression ratio. */
    const encoded = (res.headers.get('Content-Encoding') ?? '').replace(/identity/i, '').trim()
    const raw = Number(res.headers.get('X-Raw-Bytes'))
    const header = Number.isFinite(raw) && raw > 0 ? raw : encoded ? 0 : Number(res.headers.get('Content-Length'))
    const total = Number.isFinite(header) && header > 0 ? header : null
    let text: string
    if (res.body) {
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let loaded = 0
      let said = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        loaded += value.length
        const now = Date.now()
        if (now - said >= PROGRESS_MS) { said = now; publish(id, { state: 'loading', loaded, total }) }
      }
      const all = new Uint8Array(loaded)
      let at = 0
      for (const c of chunks) { all.set(c, at); at += c.length }
      text = new TextDecoder().decode(all)
    } else {
      // a body-less Response (jsdom, a cache hit without a stream): no progress to count
      text = await res.text()
    }
    const parsed = JSON.parse(text) as LayerFeatureCollection
    const features = Array.isArray(parsed?.features) ? parsed.features.length : null
    if (features == null) throw new Error('not a FeatureCollection')
    publish(id, features > 0 ? { state: 'ready', features, data: parsed } : { state: 'empty' })
  } catch {
    publish(id, { state: 'failed' })
  } finally {
    inFlight.delete(url)
  }
}

/**
 * Start loading one GeoJSON layer — from an EFFECT, never from a render: it publishes, and a
 * store written during someone's render updates a component while another one renders.
 * Idempotent per URL: a running fetch is never started twice, a loaded one is never fetched
 * again. A FAILED one starts over — the caller only asks while the layer is switched on, so
 * switching it off and on is the retry, with no button that promises more than it can do offline.
 */
export function loadLayerData(id: LayerId, url: string) {
  const at = store.get(id)
  if (at && at.state !== 'failed') return
  if (inFlight.has(url)) return
  publish(id, { state: 'loading', loaded: 0, total: null })
  void run(id, url)
}

/** where every GeoJSON layer stands, right now (outside React: the map's effects, tests) */
export const layerDataSnapshot = (): ReadonlyMap<LayerId, LayerData> => store
export function subscribeLayerData(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Where every GeoJSON layer stands — the map draws from it, the Ebenen row reports from it. */
export function useLayerData(): ReadonlyMap<LayerId, LayerData> {
  return useSyncExternalStore(subscribeLayerData, layerDataSnapshot, layerDataSnapshot)
}

/** tests only: forget every loaded layer */
export function __resetLayerData() {
  store = new Map()
  inFlight.clear()
  for (const l of listeners) l()
}
