// The ONE Rapport-PDF path: the client sends pure DATA — form fields, the Kroki scene
// (entities with client-resolved SVGs, drawings, view), and plan references with board
// annotations — and the server composes everything, map render included.
// No browser capture, no Druckansicht detour.
//
// The rapport is a pre-filled FORM (decided 2026-07-17): the full roster and Material
// catalogue always travel in the payload so the server can print tick-off rows and amount
// stubs for everything not (yet) recorded digitally — printing never blocks on missing data.

import { appConfig } from '../config/appConfig'
import type { AttendanceState, BoardAnno, BoardDoc, BuildingDoc, Drawing, Entity, LayerDef, LngLat, MittelEntry, PlanDocument, TimelineEvent, Trupp } from '../types'
import { TILE_AR, floorLabel } from './whiteboard'
import { buildView, fpBoxFrac } from './footprint'
import type { IncidentMeta } from './incidents'
import type { ReportDraft } from './report'
import {
  annotatedPlans, formatDateTime, journalRows, metaExtrasForPdf, mittelFormForPdf, personalForPdf, readingKindLabel, truppStatusLabel,
} from './report'
import { getDeploymentConfig } from './deploymentConfig'
import { fillTemplate } from './format'
import { buildKrokiPayload, shapeSvgString } from './krokiPayload'
import { SHAPE_DEFS } from './shapes'
import { placardSvgForSymbol } from './placard'
import { vehicleSymbolSvg } from './useVehiclePositions'
import { downloadReportPdf, reportFilenameHint } from './reportPdf'

/** Board annotations of one plan, in the server's PlanAnnoIn shape (dynamic symbol
 *  glyphs resolved to SVG strings, like the whiteboard renders them). */
export function planAnnosForPdf(annos: BoardAnno[], byName: Record<string, string>): Record<string, unknown>[] {
  return annos.map((a) => {
    const out: Record<string, unknown> = {
      kind: a.kind, x: a.x, y: a.y, pts: a.pts, color: a.color, width: a.width,
      dashed: a.dashed, fillOpacity: a.fillOpacity, label: a.label, text: a.text, rotation: a.rotation,
    }
    if (a.kind === 'symbol') {
      const veh = a.symbol === appConfig.symbols.vehicleName
      const svg = veh ? vehicleSymbolSvg(a.label ?? '', a.rotation ?? 0) : placardSvgForSymbol(a.symbol, a.fields)
      if (svg) {
        out.symbolSvg = svg
        if (veh) out.rotation = undefined // heading is baked into the vehicle glyph
      } else {
        out.symbol = a.symbol
      }
    }
    if (a.kind === 'shape') {
      // a plan shape prints as a client-resolved glyph (like map shapes); sizeN scales it
      // to the plan width server-side instead of the fixed symbol size
      const kind = a.shape ?? 'square'
      out.kind = 'symbol'
      out.symbolSvg = shapeSvgString(kind, a.color ?? SHAPE_DEFS[kind].defaultColor)
      out.sizeN = a.sizeN ?? SHAPE_DEFS[kind].defaultSizeN
      out.label = undefined // the shape's implicit name (Rauch/Pfeil/…) is not an on-plan label
    }
    return out
  })
}

// ---- Gebäude floor-stack export (server-side-rendering.md Phase 2) ----------------------
// The stack has no PDF behind it, so the client expresses each page entirely with the
// server's existing anno primitives on a BLANK base: footprint outline = 'area', floor
// label = 'text' pill, tile separator = dashed 'draw', north dial = pre-resolved
// 'symbol' svg. Real board annos are lifted from tile-local into page space here
// (the server has no floor model). Max 2 storeys per page so tiles print near full width.

const STACK_FLOORS_PER_PAGE = 2
const STACK_INK = '#3b4656'

const northDialSvg = (deg: number) => (
  `<svg viewBox="-26 -26 52 52" xmlns="http://www.w3.org/2000/svg">`
  + `<circle r="24" fill="#ffffff" fill-opacity="0.92" stroke="#94a0ad" stroke-width="2"/>`
  + `<g transform="rotate(${deg})"><path d="M0 -19 L6 2 L-6 2 Z" fill="#e8392b"/>`
  + `<text y="14" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="12" font-weight="700" fill="${STACK_INK}">N</text></g></svg>`
)

/** The floor-stack rendered as blank-base plan pages (chunked, top storey first). */
export function floorStackPages(
  plan: PlanDocument, building: BuildingDoc, annos: BoardAnno[], byName: Record<string, string>,
): { label: string; blankAspect: number; annos: Record<string, unknown>[] }[] {
  const floorsTTB = [...building.floors].sort((a, b) => b - a)
  if (!floorsTTB.length) return []
  const viewAngle = building.northUp ? 0 : building.orientDeg ?? 0
  const fp = building.src?.length
    ? buildView(building.src, viewAngle)
    : { rings: building.rings ?? [building.ring], aspect: building.ringAspect || 1 }
  const chunks: number[][] = []
  for (let i = 0; i < floorsTTB.length; i += STACK_FLOORS_PER_PAGE) chunks.push(floorsTTB.slice(i, i + STACK_FLOORS_PER_PAGE))
  return chunks.map((chunk, ci) => {
    const N = chunk.length
    const { rw, rh } = fpBoxFrac(fp.aspect, 1, N * TILE_AR, N)
    const page: Record<string, unknown>[] = []
    chunk.forEach((f, idx) => {
      if (idx > 0) page.push({ kind: 'draw', pts: [[0.02, idx / N], [0.98, idx / N]], color: '#b9c2cc', width: 1.5, dashed: true })
      // centred footprint box (mirror of the app's fpBox): rw of the page width, rh of one tile band
      for (const ring of fp.rings) {
        page.push({
          kind: 'area', color: STACK_INK, width: 2.5, fillOpacity: 0,
          pts: ring.map(([rx, ry]) => [0.5 - rw / 2 + rx * rw, (idx + 0.5 - rh / 2 + ry * rh) / N]),
        })
      }
      page.push({ kind: 'text', x: 0.06, y: (idx + 0.06) / N, text: floorLabel(f) })
    })
    if (ci === 0) page.push({ kind: 'symbol', x: 0.94, y: 0.045 / chunks[0].length, symbolSvg: northDialSvg(viewAngle), sizeN: 0.055 })
    // board annos of these storeys, lifted tile-local → page space (x spans the full width)
    const lift = (a: BoardAnno, idx: number): BoardAnno => ({
      ...a,
      y: a.y != null ? (idx + a.y) / N : a.y,
      pts: a.pts?.map(([px, py]) => [px, (idx + py) / N] as [number, number]),
    })
    const lifted = annos.flatMap((a) => {
      const idx = chunk.indexOf(a.floor ?? 0)
      return idx < 0 ? [] : [lift(a, idx)]
    })
    page.push(...planAnnosForPdf(lifted, byName))
    const labels = chunk.map(floorLabel)
    return { label: `${plan.title} · ${labels.length > 1 ? `${labels[0]} – ${labels[labels.length - 1]}` : labels[0]}`, blankAspect: N * TILE_AR, annos: page }
  })
}

export interface DirectReportArgs {
  incident: IncidentMeta
  draft: ReportDraft
  trupps: Trupp[]
  attendance: AttendanceState
  events: TimelineEvent[]
  plans: PlanDocument[]
  /** Mittel event log — the Material worksheet's filled amounts derive from it */
  mittel?: MittelEntry[]
  /** full roster for the Personal-/Soldblatt's tick-off rows (id + display name) */
  roster?: { id: string; name: string }[]
  /** Kroki scene (omit → PDF without map, e.g. the capture view) */
  scene?: {
    entities: Entity[]
    drawings: Drawing[]
    layers: LayerDef[]
    byName: Record<string, string>
    center: LngLat
    view: { center: LngLat; zoom: number }
  }
  /** plan whiteboard (with `plans` + the annotatedPlans options → server-rendered pages) */
  board?: BoardDoc
  /** the picked Gebäude (floor stack) — exports as blank-base plan pages when present */
  building?: BuildingDoc | null
  /** alternate endpoint/auth (capture view: poster token instead of the kiosk cookie) */
  transport?: import('./reportPdf').ReportTransport
}

/** The ONE payload builder — shared by the PDF download and the station-printer enqueue
 *  (src/lib/printRelay.ts), so both always produce the identical document. */
export function buildDirectReportPayload(args: DirectReportArgs): Record<string, unknown> {
  const { incident, draft, trupps, attendance, events, plans, mittel = [], roster = [], scene, board, building } = args
  const meta = draft.meta

  // journal photos: send the server-relative media URL — the composer loads the bytes
  // from its own media store (session-only blob: URLs can't be resolved there and are
  // simply not yet uploaded — the preflight already warns about pending media)
  const journal = journalRows(events, plans, meta.startedAt ?? incident.started_at, incident.closed_at, { includeBookkeeping: draft.options.detailedAudit })
    .map((r) => ({
      timeLabel: r.timeLabel, area: r.area, text: r.text, transcript: r.transcript || undefined,
      photoUrl: r.photoUrl?.startsWith('/') ? r.photoUrl : undefined,
    }))

  const kroki = draft.options.kroki && scene
    ? buildKrokiPayload({
        entities: scene.entities, drawings: scene.drawings, layers: scene.layers, byName: scene.byName,
        center: scene.center,
        currentView: draft.options.krokiView ?? null,
      })
    : null

  // annotated Objektpläne as references + board annos; the Gebäude floor-stack has no PDF
  // behind it and exports as client-composed blank-base pages instead (floorStackPages)
  const selectedPlans = board && (draft.options.annotatedPlans || draft.options.allPlans)
    ? annotatedPlans(plans, board, draft.options.allPlans)
    : []
  const printPlans = selectedPlans.filter((p) => p.imageUrl && !p.floorStack)
  const planPages: Record<string, unknown>[] = printPlans.map((p) => ({
    label: `${p.code} · ${p.title}`,
    url: p.imageUrl,
    annos: planAnnosForPdf(board?.[p.id] ?? [], scene?.byName ?? {}),
  }))
  if (building) {
    for (const p of selectedPlans.filter((x) => x.floorStack)) {
      planPages.push(...floorStackPages(p, building, board?.[p.id] ?? [], scene?.byName ?? {}))
    }
  }

  const cfg = getDeploymentConfig()
  const catalogue = cfg.mittel?.catalogue ?? appConfig.mittel.catalogue
  const krokiCaption = fillTemplate(appConfig.copy.report.krokiState, { title: incident.title, at: formatDateTime(draft.generatedAt) })
  const payload = {
    incident: {
      title: incident.title, id: incident.id, type: incident.type ?? undefined, address: incident.address ?? undefined,
    },
    meta: {
      alarmText: meta.alarmText, summary: meta.summary, lehren: meta.lehren, remarks: meta.remarks,
      kontaktperson: meta.kontaktperson, einsatzleiter: meta.einsatzleiter,
      kommandant: cfg.identity?.kommandant ?? undefined,
      ...metaExtrasForPdf(meta),
      alarmiertAt: formatDateTime(meta.alarmiertAt ?? incident.started_at),
      ausgeruecktAt: meta.ausgeruecktAt ? formatDateTime(meta.ausgeruecktAt) : undefined,
      endedAt: meta.endedAt ? formatDateTime(meta.endedAt) : undefined,
      partnerContacts: meta.partnerContacts,
    },
    options: { kroki: !!kroki, atemschutz: draft.options.atemschutz, attendance: draft.options.attendance, mittel: draft.options.mittel, journal: draft.options.journal },
    ...mittelFormForPdf(mittel, catalogue),
    ...personalForPdf(roster, attendance),
    partnerPresets: cfg.report?.partnerOrgs ?? [],
    generatedAt: formatDateTime(draft.generatedAt),
    kroki: kroki ?? undefined,
    krokiCaption: kroki ? krokiCaption : undefined,
    planPages,
    trupps: (draft.options.atemschutz ? trupps : []).map((t) => ({
      name: t.name, statusLabel: truppStatusLabel(t.status), members: t.members ?? [], auftrag: t.auftrag, ziel: t.ziel,
      lineNumber: t.lineNumber != null ? String(t.lineNumber) : undefined,
      entryTime: t.entryTime ? formatDateTime(t.entryTime) : undefined, exitTime: t.exitTime ? formatDateTime(t.exitTime) : undefined,
      readings: (t.readings ?? []).map((rr) => ({ t: formatDateTime(rr.t), kindLabel: readingKindLabel(rr.kind), bar: rr.bar != null ? String(rr.bar) : undefined })),
    })),
    journal: draft.options.journal ? journal : [],
  }
  return payload
}

export async function downloadDirectReportPdf(args: DirectReportArgs): Promise<void> {
  const payload = buildDirectReportPayload(args)
  await downloadReportPdf(args.incident.id, payload, reportFilenameHint(args.incident.title), args.transport)
}
