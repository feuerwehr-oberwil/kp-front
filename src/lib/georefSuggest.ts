/** «Automatisch ausrichten» — the client half of the CV alignment suggestion.
 *
 *  The heavy lifting happens in the backend (POST /api/georef/suggest, app/georef_suggest.py):
 *  this module renders the plan into the same ≤1800 px bake «Deckung prüfen» uses, sends it with
 *  the object coordinate and the calibration-derived metres-per-pixel, and hands back the fit as
 *  two `kind: 'auto'` reference pairs. Those seed the mode's PROPOSAL review (lib/georefMode ·
 *  startGeorefProposal) — nothing is stored until the operator presses «Übernehmen».
 *
 *  The matcher is template-specific (the Modul-2 sheet family it was evaluated on), needs the
 *  printed scale via the station calibration, and an anchor coordinate to fetch OSM building
 *  rings around — `georefSuggestEligible` is the one place those preconditions live.
 */
import { ApiError, apiUploadRaw } from './api'
import { planMatcherImage, planPrintedMPerU } from '../components/PdfViewport'
import type { GeoPt, GeorefPair } from './georef'

/** The phases the busy card can show — 'render' is the client's own bake, the other two are
 *  the server's NDJSON progress lines (app/api/georef_suggest). */
export type GeorefSuggestStep = 'render' | 'osm' | 'match'

/** What the server hands back for a usable fit. `score`/`coverage` are the matcher's own
 *  internal quality reads (lower score = better; neither is metres or a probability);
 *  `confident: false` = the pose is in the review-carefully band — the coverage view leads
 *  with «Deckung nachprüfen» instead of the plain proposal head. */
export interface GeorefSuggestion {
  pairs: GeorefPair[]
  confident: boolean
  rotationDeg: number
  score: number
  coverage: number
  seconds: number
}

interface SuggestWire {
  found: boolean
  confident?: boolean | null
  pairs?: { plan: { x: number; y: number }; lngLat: { lng: number; lat: number } }[]
  rotationDeg?: number
  score?: number
  coverage?: number
  seconds: number
}

/** May «Automatisch ausrichten» be offered for this sheet? Every MODULE sheet with an
 *  object/incident coordinate to anchor the OSM reference box gets the chooser (decided
 *  08.09.2026 after the Modul-2-only gate proved undiscoverable twice): the matcher was
 *  evaluated on the Modul-2 template — on other templates it simply runs and comes back
 *  «kein Vorschlag» honestly (Modul 1 failed 4/4 in the experiment), which the operator can
 *  judge; a hidden capability they cannot. The SCALE is resolved at request time — the
 *  sheet's own printed «1:NNN» first, the calibration as fallback — so it is no precondition. */
export function georefSuggestEligible(planId: string, anchor: GeoPt | null | undefined): boolean {
  return /^modul\d/.test(planId) && !!anchor
}

/** What asking the matcher can come back with, short of a transport/server failure. */
export type GeorefSuggestOutcome =
  | { kind: 'fit'; suggestion: GeorefSuggestion }
  /** ran, found nothing confident — a normal outcome, the manual flow is the way on */
  | { kind: 'none' }
  /** never ran: neither a printed «1:NNN» on the sheet nor a calibration says the scale, and a
   *  fixed-scale matcher fed a guessed scale returns confident-LOOKING wrong poses */
  | { kind: 'noScale' }

/**
 * Ask the server for an alignment suggestion. Rejects on transport/server failure (offline,
 * 503 while the extra is not installed); everything else is a typed outcome.
 *
 * ⚠️ The expected scale comes from the sheet's own printed «1:NNN» (planPrintedMPerU) FIRST
 * and only falls back to the calibration: the station-default calibration is one number for
 * every sheet, but Oberwil's own Modul 2s mix 1:750 and 1:1000 — and the fixed-scale ICP fed a
 * scale 25 % off finds a WRONG pose that still clears the score cutoff (measured on the
 * Gymnasium sheet, 08.09.2026).
 *
 * Takes 3–14 s server-side — callers show a busy state and must tolerate the operator
 * navigating away meanwhile.
 */
export async function requestGeorefSuggestion(opts: {
  /** the plan's own PDF url (`PlanDocument.imageUrl`) — rendered here, not on the server */
  planUrl: string
  anchor: GeoPt
  /** calibration fallback: metres per aspect-corrected normalized unit (`PlanScale.mPerU`) */
  mPerU?: number
  /** which sheet TEMPLATE the matcher should segment — 'm1' for the Modul-1 family (red
   *  Einsatzobjekt compound, 1:2000+ extents), 'm2' (default) for everything else */
  template?: 'm1' | 'm2'
}, onStep?: (step: GeorefSuggestStep) => void): Promise<GeorefSuggestOutcome> {
  onStep?.('render')
  const printed = await planPrintedMPerU(opts.planUrl).catch(() => null)
  const mPerU = printed ?? opts.mPerU
  if (!mPerU || !(mPerU > 0)) return { kind: 'noScale' }
  // reuses the sheet's resident bake whenever possible (PdfViewport · planMatcherImage) —
  // «Plan rendern» is then an encode, not a second full pdf.js rasterization
  const blob = await planMatcherImage(opts.planUrl)
  const bmp = await createImageBitmap(blob)
  const mPerPx = mPerU / bmp.height
  bmp.close()
  const form = new FormData()
  form.append('image', blob, 'plan.jpg')
  const q = `lng=${opts.anchor.lng}&lat=${opts.anchor.lat}&mPerPx=${mPerPx}&template=${opts.template ?? 'm2'}`
  const res = await readSuggestStream(await apiUploadRaw(`/api/georef/suggest?${q}`, form), onStep)
  if (!res.found || !res.pairs || res.pairs.length < 2) return { kind: 'none' }
  return {
    kind: 'fit',
    suggestion: {
      pairs: res.pairs.map((p) => ({ plan: p.plan, lngLat: p.lngLat, kind: 'auto' as const })),
      confident: res.confident !== false,
      rotationDeg: res.rotationDeg ?? 0,
      score: res.score ?? 0,
      coverage: res.coverage ?? 0,
      seconds: res.seconds,
    },
  }
}

/** Read the endpoint's NDJSON answer: progress lines feed `onStep`, an in-band `{error}`
 *  becomes the same ApiError a plain failure would be, `{result}` is the payload. */
async function readSuggestStream(res: Response, onStep?: (step: GeorefSuggestStep) => void): Promise<SuggestWire> {
  const handle = (line: string): SuggestWire | null => {
    if (!line.trim()) return null
    const msg = JSON.parse(line) as { step?: string; error?: string; result?: SuggestWire }
    if (msg.step === 'osm' || msg.step === 'match') onStep?.(msg.step)
    if (msg.error) throw new ApiError(502, msg.error)
    return msg.result ?? null
  }
  const reader = res.body?.getReader()
  if (!reader) {
    // no streaming reader — the whole body arrived buffered; the progress is lost, the answer is not
    for (const line of (await res.text()).split('\n')) {
      const result = handle(line)
      if (result) return result
    }
    throw new ApiError(0, 'georef suggest: stream ended without a result')
  }
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (value) buf += dec.decode(value, { stream: !done })
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      const result = handle(line)
      if (result) return result
      nl = buf.indexOf('\n')
    }
    if (done) {
      const result = handle(buf)
      if (result) return result
      throw new ApiError(0, 'georef suggest: stream ended without a result')
    }
  }
}
