// The Offline-Vorbereitung of one Einsatz: the box around it, the download that warms the map,
// plans and Ebenen into the service-worker cache (by hand, and once by itself ~30 s after the
// open), and the URLs the Offline-Bereitschaft sheet probes. Split out of IncidentWorkspace
// (E1, 09.10.2026) unchanged; `online` rides along because the map's Ebenen read it with the box.

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { MapRef } from 'react-map-gl/maplibre'
import { appConfig } from '../config/appConfig'
import { cartoRasterTiles } from '../lib/carto'
import { fillTemplate, fmtFileSize } from '../lib/format'
import { isStorageDegraded } from '../lib/idb'
import { isStandalone } from '../lib/installPrompt'
import { fillTileTemplate, predownloadArea, tilesForBounds } from '../lib/offlineTiles'
import { WARM_BYTES, estimateStorage, fittedTileCap, prefetchFit } from '../lib/storageBudget'
import { confirmDialog, toast } from '../lib/ui'
import { useOnline } from '../lib/useOnline'
import type { LayerDef, LngLat } from '../types'

export interface OfflinePrefetchInputs {
  incidentId: string
  center: LngLat
  offlineRadiusM: number
  offlineAuto: boolean
  mapRef: RefObject<MapRef | null>
  layers: LayerDef[]
  backendPlans: Record<string, string>
}

export function useOfflinePrefetch({ incidentId, center, offlineRadiusM, offlineAuto, mapRef, layers, backendPlans }: OfflinePrefetchInputs) {
  // PWA: pre-download the current map area + plans/symbols/geodata so the base map and
  // reference data render offline at the scene (delivers the `offline`/`cachedTiles` promise).
  // One box around the incident (editable radius) — caches the map AND crops the region-wide
  // Leitungskataster GeoJSON to the scene via a `bbox` query the backend honours. A FIXED box
  // (not unioned with the viewport) keeps the tile count predictable on a memory-tight iPad.
  const incidentBounds = useMemo(() => {
    const [clng, clat] = center
    const dLat = offlineRadiusM / 111320
    const dLng = offlineRadiusM / (111320 * Math.cos((clat * Math.PI) / 180))
    return { west: clng - dLng, south: clat - dLat, east: clng + dLng, north: clat + dLat }
  }, [center, offlineRadiusM])
  const geoBbox = useMemo(
    () => `bbox=${incidentBounds.west.toFixed(5)},${incidentBounds.south.toFixed(5)},${incidentBounds.east.toFixed(5)},${incidentBounds.north.toFixed(5)}`,
    [incidentBounds],
  )
  // append the incident bbox to a reference/geo: URL so render + offline cache pull the SAME
  // cropped slice (non-geo URLs pass through unchanged).
  const withGeoBbox = useCallback(
    (url: string) => (url.includes('/api/reference/geo:') ? `${url}${url.includes('?') ? '&' : '?'}${geoBbox}` : url),
    [geoBbox],
  )
  // Online: render the FULL region-wide geodata (e.g. all PV-Anlagen across town), not just the
  // incident box — an operator zooming out expects to see the whole town. Offline: fall back to
  // the cropped `bbox` slice, which is exactly what `downloadOffline` warmed into the SW cache.
  const online = useOnline()

  const [offlineProgress, setOfflineProgress] = useState<{ done: number; total: number } | null>(null)
  // The running download's controller. Aborting stops the tile workers (offlineTiles · signal);
  // `cancelOffline` is what the sheet's «Abbrechen» will call, and the unmount effect below
  // calls it so an Einsatz switch does not leave three workers pulling tiles for a map nobody
  // is looking at.
  const offlineAbort = useRef<AbortController | null>(null)
  const cancelOffline = useCallback(() => { offlineAbort.current?.abort() }, [])
  useEffect(() => cancelOffline, [cancelOffline])
  // `quiet` = the automatic self-warm (Offline-Vorbereitung, see the effect below): no dialogs,
  // no toasts — the Offline-Bereitschaft sheet is where the resulting truth is read. A tight
  // storage budget silently takes the reduced download instead of asking; the manual button
  // remains the place where that trade is offered as a question.
  const downloadOffline = useCallback(async ({ quiet = false } = {}) => {
    const map = mapRef.current?.getMap()
    if (!map) return
    const base = layers.find((l) => l.base && l.visible)
    const templates = base?.tiles ?? cartoRasterTiles('rastertiles/voyager', ['a'])
    const rasterOverlays = layers.filter((l) => !l.base && l.tiles?.length).map((l) => l.tiles as string[])
    const bounds = incidentBounds
    // warm: per-object plan PDFs and the geojson overlays cropped to the box. NOT the symbol
    // library — it is a bundled asset (Workbox precaches every .json in the build) and the app
    // stopped reading the backend's copy of it entirely (lib/useSymbols · 01.09.).
    const warmUrls = [
      ...Object.values(backendPlans),
      ...layers.filter((l) => l.geojson).map((l) => withGeoBbox(l.geojson as string)),
    ]
    // Pre-flight: everything cached for offline shares ONE origin quota, so a download into a
    // nearly-full bucket used to succeed at the expense of whatever wrote next — the incident
    // record. Predict the cost and, when it won't fit, offer the reduced download instead of
    // silently starting a doomed one. An unknown budget is never treated as a full one.
    const HARD_CAP = 1200
    const coverageTileCount = Math.min(tilesForBounds(bounds, 14, 17).length, HARD_CAP)
    const rasterSourceCount = 1 + rasterOverlays.length
    const tileCount = coverageTileCount * rasterSourceCount
    const extraBytes = warmUrls.length * WARM_BYTES
    const budget = await estimateStorage()
    const fit = prefetchFit(budget, tileCount, extraBytes)
    let cap = HARD_CAP
    if (!fit.fits && budget) {
      const co = appConfig.copy.offline
      const reducedTotal = fittedTileCap(budget, HARD_CAP * rasterSourceCount, extraBytes)
      const reduced = Math.floor(reducedTotal / rasterSourceCount)
      if (reduced === 0) {
        // not even the plans fit — nothing useful to offer but the honest refusal
        if (!quiet) toast(fillTemplate(co.dlNoSpace, { free: fmtFileSize(budget.free) }), { icon: 'map', tone: 'warn' })
        return
      }
      if (!quiet) {
        const ok = await confirmDialog({
          title: co.dlTightTitle,
          message: fillTemplate(co.dlTightMsg, {
            need: fmtFileSize(fit.needBytes), free: fmtFileSize(budget.free), pct: String(Math.round((reduced / coverageTileCount) * 100)),
          }),
          confirmLabel: co.dlTightConfirm,
          cancelLabel: appConfig.copy.cancel,
        })
        if (!ok) return
      }
      cap = reduced
    }
    setOfflineProgress({ done: 0, total: 1 })
    const ctrl = new AbortController()
    offlineAbort.current = ctrl
    // throttle progress to whole-percent changes so we don't re-render this (huge) component
    // ~750× during the download — a real contributor to memory/CPU pressure on the device.
    let lastPct = -1
    try {
      const res = await predownloadArea({
        templates,
        overlayTemplates: rasterOverlays,
        bounds,
        minZoom: 14,
        // z17 (building-level), not 18: z18 ~4× the tiles and OOMs an iPad mid-download
        maxZoom: 17,
        cap,
        warmUrls,
        signal: ctrl.signal,
        onProgress: (done, total) => {
          const pct = total ? Math.floor((done / total) * 100) : 0
          if (pct !== lastPct) { lastPct = pct; setOfflineProgress({ done, total }) }
        },
      })
      // ⚠️ FOUR OUTCOMES, FOUR MESSAGES — not one message with different numbers. The bar
      // reaches 100 % whatever happens (it counts attempts finished, and it has to, or a dead
      // host would hang it for ever), so «fertig» said nothing about «geklappt»: tapped in the
      // Magazin on dead WLAN this toasted a green «Karte offline verfügbar (0 Kacheln)», and the
      // one figure that contradicted it stood in a bracket nobody reads at 03:10. Green is now
      // earned: it needs every FETCHABLE tile AND every plan/Ebene to have come back — a 404 is
      // not a miss (the tile does not exist at a layer's edge; «Weiterladen» could never fill
      // it, so counting it kept «Teilweise geladen» on screen for ever). Only retryable
      // failures (network/5xx) make the download partial. And all-404 with zero hits is its own
      // sentence: the source has no coverage here (or the Kachel-URL is wrong) — «kein Netz»
      // would mis-describe a host that answered every single request.
      const co = appConfig.copy.offline
      const got = res.fetched + res.warmFetched
      const retry = { label: co.dlRetry, onClick: () => { void downloadOfflineRef.current() } }
      if (quiet) return // self-warm: the Offline-Bereitschaft sheet reports the resulting truth
      if (got === 0 && res.failed > 0) {
        toast(co.dlNone, { icon: 'map', tone: 'warn', action: retry })
      } else if (got === 0 && res.notFound > 0) {
        // no retry offer: every request was answered, retrying returns the same 404s
        toast(co.dlNoCoverage, { icon: 'map', tone: 'warn' })
      } else if (res.failed > 0) {
        // capped AND partial: keep saying «Ausschnitt begrenzt», or «Weiterladen» promises
        // tiles the cap will exclude again
        toast(fillTemplate(res.capped ? co.dlPartialCapped : co.dlPartial, { n: got, total: got + res.failed }), { icon: 'map', tone: 'warn', action: { ...retry, label: co.dlContinue } })
      } else {
        toast(fillTemplate(res.capped ? co.dlDoneCapped : co.dlDone, { n: res.fetched }), { icon: 'map', tone: 'success' })
      }
    } catch {
      // a cancel is not a failure: the operator (or the unmount) asked for it, nothing to report
      if (!quiet && !ctrl.signal.aborted) toast(appConfig.copy.offline.dlFailed, { icon: 'map', tone: 'warn' })
    } finally {
      if (offlineAbort.current === ctrl) offlineAbort.current = null
      setOfflineProgress(null)
    }
  }, [layers, backendPlans, incidentBounds, withGeoBbox, mapRef])
  // «Weiterladen» / «Nochmals» re-runs the same download. Through a ref because the action rides
  // on a toast that outlives the render it was made in, and the callback cannot name itself.
  const downloadOfflineRef = useRef(downloadOffline)
  useEffect(() => { downloadOfflineRef.current = downloadOffline }, [downloadOffline])
  // ── Offline-Vorbereitung: the device prepares ITSELF (28.08. field feedback) ──
  // The button relied on someone remembering it before losing coverage. Now, ~30 s after an
  // Einsatz is open (long enough for the map, plans and layer list to have settled), the same
  // download runs quietly — installed app only, exactly like the sheet's own reasoning: a
  // browser tab's cache is evicted too readily to call it «bereit». Re-armed when what there is
  // to warm changes (another Objekt's plans, a new Leitungs-Ebene), so a plan attached mid-
  // incident still gets pulled; the signature keeps one warm per state, not one per minute.
  // Offline-Vorbereitung «Aus» (device pref) switches all of this off; the button always stays.
  // …and re-armed when the operator grows the offline radius (29.08.): the readiness probe
  // measures against the CURRENT bbox, so a warm run for the old radius would keep reporting
  // «nicht geladen» forever. Centre and raster-reference ids are explicit too: a corrected
  // Einsatz location or newly configured WMS/WMTS layer owes the device another warm pass.
  const offlineWarmSig = `${incidentId}|${center.join(',')}|${offlineRadiusM}|${Object.values(backendPlans).sort().join(',')}|${layers.filter((l) => l.geojson || (!l.base && l.tiles?.length)).map((l) => l.id).join(',')}`
  const offlineWarmed = useRef('')
  useEffect(() => {
    if (!offlineAuto || !isStandalone()) return
    if (offlineWarmed.current === offlineWarmSig) return
    const t = setTimeout(() => {
      if (!navigator.onLine || isStorageDegraded()) return // this round stays owed — the ref is only stamped on a start
      offlineWarmed.current = offlineWarmSig
      void downloadOfflineRef.current({ quiet: true })
    }, 30_000)
    return () => clearTimeout(t)
  }, [offlineAuto, offlineWarmSig])
  // Offline-readiness: the representative URLs the readiness sheet probes against the SW
  // Cache to report REAL offline presence (not a guess) for the runtime-cached resources.
  const offlineProbeUrls = useMemo(() => {
    const base = layers.find((l) => l.base && l.visible)
    const tpls = base?.tiles ?? []
    // The downloader cycles tile subdomains (Carto = a/b/c/d), so a given tile lands under ONE
    // of them. Probe the incident-centre tile across ALL subdomains and pass if any is cached —
    // checking only [0] gave a false "nicht geladen".
    let tiles: string[] = []
    if (tpls.length) {
      const z = 16
      const [lng, lat] = center
      const x = Math.floor(((lng + 180) / 360) * 2 ** z)
      const r = (lat * Math.PI) / 180
      const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z)
      tiles = tpls.map((t) => t.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)))
    }
    const z = 16
    const [lng, lat] = center
    const x = Math.floor(((lng + 180) / 360) * 2 ** z)
    const r = (lat * Math.PI) / 180
    const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z)
    const covered = tilesForBounds(incidentBounds, 14, 17).slice(0, 1200)
    const centreIndex = covered.findIndex((tile) => tile.z === z && tile.x === x && tile.y === y)
    return {
      tiles,
      plan: Object.values(backendPlans)[0] ?? null,
      // Every vector and raster reference layer. Raster layers use one representative centre
      // tile; vector layers use the incident crop. These are exact URLs from the warm pass.
      references: [
        ...layers.filter((l) => l.geojson).map((l) => withGeoBbox(l.geojson as string)),
        ...layers.filter((l) => !l.base && l.tiles?.length).map((l) => {
          const templates = l.tiles as string[]
          const template = templates[Math.max(0, centreIndex) % templates.length]
          return fillTileTemplate(template, z, x, y)
        }),
      ],
    }
  }, [layers, center, incidentBounds, backendPlans, withGeoBbox])
  return { incidentBounds, withGeoBbox, online, offlineProgress, cancelOffline, downloadOffline, offlineProbeUrls }
}
