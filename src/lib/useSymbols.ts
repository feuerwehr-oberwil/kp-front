import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SymbolLibrary } from '../types'
import { idbGet, idbSet } from './idb'
import { GROSSLUEFTER, GROSSLUEFTER_BODY, GROSSLUEFTER_FAN, HUBRETTER, COMPOSITE_PART_GLYPHS, composeCompositeSvg } from './symbolRender'

export interface SymbolsApi {
  ready: boolean
  /** every attempt failed AND no cached pack exists — Karte and Kroki run without glyphs */
  error: boolean
  /** start the whole load over (the Meldeleiste row's «Nochmals laden») */
  reload: () => void
  order: string[]
  symbols: SymbolLibrary['symbols']
  byName: Record<string, string>   // name -> svg markup
}

const EMPTY: Omit<SymbolsApi, 'reload'> = { ready: false, error: false, order: [], symbols: [], byName: {} }

/** the last pack that loaded, kept in IndexedDB so a failed fetch degrades to yesterday's
 *  artwork rather than to none (idb.ts — one blob keyed by string, like every other cache) */
export const SYMBOLS_CACHE_KEY = 'kp-front-symbols'
/** one fetch may take this long before it counts as failed — a captive portal or a dying WLAN
 *  otherwise holds the whole map hostage indefinitely */
const FETCH_TIMEOUT_MS = 15_000
/** the pauses between attempts: 1 try + 3 retries, ~14 s of waiting all told */
export const SYMBOLS_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000]

// WebKit/Safari (the iPad target) doesn't reliably honour `dominant-baseline="central"` on inline
// <text>, so a symbol's baked letter falls back to the alphabetic baseline and sits low / off-centre
// in its glyph. Swap it for a font-relative dy that centres uppercase glyphs identically in EVERY
// browser (≈0.35em down from the baseline lands the cap-height midpoint on the anchor point). Any
// intentional per-symbol y-offset is preserved — the dy stacks on top and scales with font-size.
// Applied at load so it normalises whatever dataset version the backend or the bundled copy serve.
const centerSymbolText = (svg: string) => svg.replace(/\s*dominant-baseline="central"/g, ' dy="0.35em"')

/** The pack's shape, checked before anything renders off it: a stale precache or a captive
 *  portal's HTML login page parse as JSON often enough to have to ask. */
function isSymbolLibrary(v: unknown): v is SymbolLibrary {
  if (typeof v !== 'object' || v === null) return false
  const p = v as Partial<SymbolLibrary>
  return Array.isArray(p.order) && Array.isArray(p.symbols)
}

const timeoutSignal = (ms: number): AbortSignal | undefined =>
  typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined

/** One bounded fetch of the pack: times out, rejects on a non-2xx, requires the pack's shape. */
async function fetchPack(url: string, fetchImpl: typeof fetch): Promise<SymbolLibrary> {
  const r = await fetchImpl(url, { signal: timeoutSignal(FETCH_TIMEOUT_MS) })
  if (!r.ok) throw new Error(`symbol pack HTTP ${r.status}`)
  const pack: unknown = await r.json()
  if (!isSymbolLibrary(pack)) throw new Error('symbol pack malformed')
  return pack
}

export interface LoadSymbolPackOptions {
  url: string
  /** injectable for tests — default to the globals */
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  delays?: readonly number[]
  cache?: { get: () => Promise<SymbolLibrary | null>; set: (pack: SymbolLibrary) => Promise<unknown> }
}

const idbCache: NonNullable<LoadSymbolPackOptions['cache']> = {
  get: async () => {
    const v = await idbGet<unknown>(SYMBOLS_CACHE_KEY)
    return isSymbolLibrary(v) ? v : null
  },
  set: (pack) => idbSet(SYMBOLS_CACHE_KEY, pack),
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Fetch the pack with retries and backoff; on total failure fall back to the last pack that
 * loaded. Resolves `null` only when the network failed every time AND nothing is cached — the
 * one state the caller has to show. Exported for the test; the hook is the only app caller.
 */
export async function loadSymbolPack(opts: LoadSymbolPackOptions): Promise<{ pack: SymbolLibrary; source: 'network' | 'cache' } | null> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const sleep = opts.sleep ?? defaultSleep
  const delays = opts.delays ?? SYMBOLS_RETRY_DELAYS_MS
  const cache = opts.cache ?? idbCache
  for (let attempt = 0; ; attempt++) {
    try {
      const pack = await fetchPack(opts.url, fetchImpl)
      // fire-and-forget: a cache that could not be written costs nothing now
      void cache.set(pack).catch(() => {})
      return { pack, source: 'network' }
    } catch (e) {
      console.error('Symbolbibliothek konnte nicht geladen werden', e)
      if (attempt >= delays.length) break
      await sleep(delays[attempt])
    }
  }
  const cached = await cache.get().catch(() => null)
  return cached ? { pack: cached, source: 'cache' } : null
}

export function useSymbols(): SymbolsApi {
  const [lib, setLib] = useState<SymbolLibrary | null>(null)
  const [error, setError] = useState(false)
  // bumped by reload(); the effect below re-runs the whole load
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    // ONE source: the bundled /public pack, KP-Front-authored and generated by
    // tools/gen_symbols.py. It owns which symbols exist, in what category order, AND their art.
    //
    // ⚠️ There used to be a second stage here that overlaid glyph artwork from the backend
    // dataset `symbols:tactical`, «purely for fresher glyph art». It could not be fresher, and
    // that was the bug (found 01.09.): `seed_reference` copies this very file into the database
    // ONCE, on a deployment's first boot, and never touches it again. So the row is frozen at
    // whatever the pack looked like the day that station was set up, and it silently reverted
    // every artwork change we shipped afterwards — for the symbols it already knew.
    //
    // It failed in the most confusing way possible: NEW symbols appeared (no row for that name,
    // so the bundled art stood) while CHANGED ones stayed old, in the same palette. And the
    // printed Kroki was right the whole time, because kroki.py reads the FILE — so the paper and
    // the screen disagreed about what a symbol looks like.
    //
    // A backend copy can only ever be equal to or older than the file the app was built with, so
    // the whole stage could only lose. Restoring some form of per-station artwork means giving
    // the dataset a version the app can compare — not trusting it by default.
    //
    // The IDB copy below is NOT that second stage: it is this same file as it last loaded on this
    // device, used only when the network cannot serve it at all (stale precache, captive portal,
    // evicted SW cache). Until 02.09. that case left Karte and Kroki unmounted behind the in-app
    // splash forever, with a 9 s hint that blamed the server.
    void loadSymbolPack({ url: `${import.meta.env.BASE_URL}tactical-symbols.json` }).then((res) => {
      if (!alive) return
      if (res) setLib(res.pack)
      else setError(true)
    })
    return () => { alive = false }
  }, [attempt])

  const reload = useCallback(() => {
    setError(false)
    setAttempt((n) => n + 1)
  }, [])

  return useMemo<SymbolsApi>(() => {
    if (!lib) return { ...EMPTY, error, reload }
    // normalise every glyph's text-centering once, up front, so both the palette (which renders
    // s.svg directly) and every byName consumer get the cross-browser-centred version.
    const all = lib.symbols.map((s) => ({ ...s, svg: centerSymbolText(s.svg) }))
    const byName: Record<string, string> = {}
    for (const s of all) byName[s.name] = s.svg
    // the composite overlay parts (the reversed-airflow Lüfter, the Drehleiter ladder, the Hubretter
    // boom) are render-only glyphs reached only as a composite's overlay — keep them in byName (above)
    // for rendering but drop them from the pickable palette.
    const partGlyphs = new Set(COMPOSITE_PART_GLYPHS)
    const symbols = all.filter((s) => !partGlyphs.has(s.name))
    // synthesise the composite Grosslüfter from the two authoritative FireGIS glyphs (vehicle +
    // fan) so it appears in the palette without hand-authoring artwork that could drift from the
    // source. byName carries the static composite (thumbnail/fallback); the map/plan render the
    // two layers separately for independent rotation. Inserted right AFTER the Hubretter (the
    // crews' Fahrzeuge order: Fahrzeug, Drehleiter, Hubretter, Grosslüfter, Boot, Pumpe, …), with
    // a fall-back to the end if the Hubretter is missing.
    if (byName[GROSSLUEFTER_BODY] && byName[GROSSLUEFTER_FAN] && !byName[GROSSLUEFTER]) {
      const cat = symbols.find((s) => s.name === GROSSLUEFTER_FAN)?.cat ?? 'Fahrzeuge / Mittel'
      const svg = composeCompositeSvg(byName[GROSSLUEFTER_BODY], byName[GROSSLUEFTER_FAN])
      byName[GROSSLUEFTER] = svg
      const at = symbols.findIndex((s) => s.name === HUBRETTER)
      const entry = { name: GROSSLUEFTER, cat, svg }
      if (at >= 0) symbols.splice(at + 1, 0, entry); else symbols.push(entry)
    }
    return { ready: true, error: false, reload, order: lib.order, symbols, byName }
  }, [lib, error, reload])
}
