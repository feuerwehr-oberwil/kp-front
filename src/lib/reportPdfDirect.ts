// The ONE Rapport-PDF path: the client sends pure DATA — form fields, the Kroki scene
// (entities with client-resolved SVGs, drawings, view), and plan references with board
// annotations — and the server composes everything, map render included.
// No browser capture, no Druckansicht detour.
//
// The rapport is a pre-filled FORM (decided 2026-07-17): the full roster and Material
// catalogue always travel in the payload so the server can print tick-off rows and amount
// stubs for everything not (yet) recorded digitally — printing never blocks on missing data.

import { appConfig } from '../config/appConfig'
import type { AttendanceState, BoardAnno, BoardDoc, BuildingDoc, CaptionMode, Drawing, Entity, LayerDef, LngLat, MittelEntry, PlanDocument, ReportAttachment, TimelineEvent, Trupp } from '../types'
import { TILE_AR, floorLabel } from './whiteboard'
import { buildView, fpBoxFrac } from './footprint'
import type { IncidentMeta } from './incidents'
import type { ReportDraft } from './report'
import {
  annotatedPlans, formatDateTime, journalRows, metaExtrasForPdf, mittelFormForPdf, pendenzRows, personalForPdf, readingBarIsMeasured, readingKindLabel, truppAuftragLabel, truppStatusLabel,
} from './report'
import { DEFAULT_HOURS_ROUNDING, fmtHours, hoursRows, hoursSummary } from './attendanceHours'
import { getDeploymentConfig } from './deploymentConfig'
import { fillTemplate } from './format'
import { buildKrokiPayload, shapeSvgString } from './krokiPayload'
import { SHAPE_DEFS } from './shapes'
import { placardSvgForSymbol } from './placard'
import { vehicleSymbolSvg } from './useVehiclePositions'
import { downloadReportPdf, reportFilenameHint } from './reportPdf'
import { resolvePlanAnnos } from './lineAttachments'
import type { JournalLink } from './journalLinks'

/** Board annotations of one plan, in the server's PlanAnnoIn shape (dynamic symbol
 *  glyphs resolved to SVG strings, like the whiteboard renders them). */
export function planAnnosForPdf(annos: BoardAnno[], _byName: Record<string, string>): Record<string, unknown>[] {
  return resolvePlanAnnos(annos).map((a) => {
    const out: Record<string, unknown> = {
      kind: a.kind, x: a.x, y: a.y, pts: a.pts, color: a.color, width: a.width,
      dashed: a.dashed, fillOpacity: a.fillOpacity, label: a.label, text: a.text, rotation: a.rotation,
      // note styling: wN is what makes it a wrapping box, so the sheet breaks the lines exactly
      // where the screen did. Absent on every other kind, and absent on legacy notes.
      wN: a.wN, noteSize: a.noteSize, notePlain: a.notePlain,
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
// label = 'text' pill, tile separator = dashed 'draw', north dial = a 'north' anno the
// SERVER draws. Real board annos are lifted from tile-local into page space here
// (the server has no floor model). Max 2 storeys per page so tiles print near full width.

const STACK_FLOORS_PER_PAGE = 2
const STACK_INK = '#3b4656'

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
    // ⚠️ The band grid is the PAGE's, not the chunk's. Dividing by the number of storeys that
    // happen to land on a page made the last page of an odd building a different SHAPE from the
    // ones before it — two storeys gave a tall page, one gave a wide one, and the Gebäude came
    // out of the printer half portrait and half landscape. A constant grid keeps every page
    // upright and every floor tile the same size; a page that is short of a storey simply
    // leaves its lower band empty, which is what a stack with nothing above it looks like.
    const N = STACK_FLOORS_PER_PAGE
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
    // ⚠️ The dial is the SERVER's (backend · kroki · north_dial_svg), not one this file draws.
    // It used to send its own SVG — a red triangle with the N under the centre — so the floor
    // page and the Kroki carried two different north marks onto the same stapled rapport. The
    // client sends the ANGLE; the glyph has one definition.
    if (ci === 0) page.push({ kind: 'north', x: 0.94, y: 0.045 / N, deg: viewAngle, sizeN: 0.055 })
    // board annos of these storeys, lifted tile-local → page space (x spans the full width)
    const lift = (a: BoardAnno, idx: number): BoardAnno => ({
      ...a,
      y: a.y != null ? (idx + a.y) / N : a.y,
      pts: a.pts?.map(([px, py, floor]) => {
        const pointIdx = chunk.indexOf(floor ?? a.floor ?? 0)
        return [px, ((pointIdx < 0 ? idx : pointIdx) + py) / N] as [number, number]
      }),
    })
    const lifted = resolvePlanAnnos(annos).flatMap((a) => {
      const pointFloors = a.pts?.map((p) => p[2] ?? a.floor ?? 0) ?? []
      const idx = chunk.indexOf(pointFloors.find((f) => chunk.includes(f)) ?? a.floor ?? 0)
      return idx < 0 ? [] : [lift(a, idx)]
    })
    page.push(...planAnnosForPdf(lifted, byName))
    const labels = chunk.map(floorLabel)
    return { label: `${plan.title} · ${labels.length > 1 ? `${labels[0]} – ${labels[labels.length - 1]}` : labels[0]}`, blankAspect: N * TILE_AR, annos: page }
  })
}

export interface DirectReportArgs {
  /** the linkable vocabulary (lib/journalLinks) — the printed journal marks the same terms the
   *  app marks, in bold. Absent = the entry prints verbatim, as it always did. */
  vocab?: JournalLink[]
  incident: IncidentMeta
  draft: ReportDraft
  trupps: Trupp[]
  /** the Funkkontakt-Intervall this Einsatz actually ran on, and the grace on top of it —
   *  what «überfällig» meant here, printed with the Atemschutz protocol */
  contactIntervalMin?: number
  contactGraceSec?: number
  attendance: AttendanceState
  events: TimelineEvent[]
  plans: PlanDocument[]
  /** Mittel event log — the Material worksheet's filled amounts derive from it */
  mittel?: MittelEntry[]
  /** full roster for the Personal-/Soldblatt's tick-off rows (id + display name) */
  roster?: { id: string; name: string }[]
  /** Rapport-Beilagen (document/damage photos) — printed as full-width plates at the end */
  attachments?: ReportAttachment[]
  /** Kroki scene (omit → PDF without map, e.g. the capture view) */
  scene?: {
    entities: Entity[]
    drawings: Drawing[]
    layers: LayerDef[]
    byName: Record<string, string>
    center: LngLat
    view: { center: LngLat; zoom: number }
    /** the map's Beschriftungen setting — the printed Kroki carries the same labels the
     *  screen it was framed on did (an Einsatzleiter symbol prints its name) */
    captionMode?: CaptionMode
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
  const { incident, draft, trupps, attendance, events, plans, mittel = [], roster = [], attachments = [], scene, board, building } = args
  const meta = draft.meta

  // journal photos: send the server-relative media URL — the composer loads the bytes
  // from its own media store (session-only blob: URLs can't be resolved there and are
  // simply not yet uploaded — the preflight already warns about pending media)
  const journal = journalRows(events, plans, meta.startedAt ?? incident.started_at, incident.closed_at, { includeBookkeeping: draft.options.detailedAudit, vocab: args.vocab })
    .map((r) => ({
      timeLabel: r.timeLabel, area: r.area, text: r.text, markup: r.markup, transcript: r.transcript || undefined,
      // only pictures the SERVER can fetch — a blob: URL is one that never finished uploading
      photoUrls: r.photoUrls?.filter((u) => u.startsWith('/')),
    }))

  // Aufträge / Pendenzen — derived from the same rows, printed as a section right after them
  const pendenzen = pendenzRows(events, meta.startedAt ?? incident.started_at)

  const kroki = draft.options.kroki && scene
    ? buildKrokiPayload({
        entities: scene.entities, drawings: scene.drawings, layers: scene.layers, byName: scene.byName,
        center: scene.center,
        currentView: draft.options.krokiView ?? null,
        captionMode: scene.captionMode,
        // so a hose on the printed Kroki names the Trupp that worked it
        trupps,
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
  // The caption dates the PICTURE, not the printing: a Kroki reconstructed for 21:14 says 21:14.
  const krokiCaption = fillTemplate(appConfig.copy.report.krokiState, {
    title: incident.title,
    at: formatDateTime(draft.options.krokiAt ?? draft.generatedAt),
  })
  const payload = {
    incident: {
      title: incident.title, id: incident.id, type: incident.type ?? undefined, address: incident.address ?? undefined,
      // an Übung has to be legible AS one on the paper — it is excluded from the statistics,
      // so a drill rapport that reads like a deployment contradicts the numbers behind it
      isExercise: incident.is_exercise,
    },
    meta: {
      alarmText: meta.alarmText, summary: meta.summary, lehren: meta.lehren, remarks: meta.remarks,
      kontaktperson: meta.kontaktperson, einsatzleiter: meta.einsatzleiter,
      kommandant: cfg.identity?.kommandant ?? undefined,
      // the same bounds the Personalblatt uses, so every clock on the sheet follows one
      // midnight rule instead of two
      ...metaExtrasForPdf(meta, { alarmedAt: meta.alarmiertAt ?? incident.started_at, endedAt: meta.endedAt ?? incident.closed_at }),
      alarmiertAt: formatDateTime(meta.alarmiertAt ?? incident.started_at),
      ausgeruecktAt: meta.ausgeruecktAt ? formatDateTime(meta.ausgeruecktAt) : undefined,
      endedAt: meta.endedAt ? formatDateTime(meta.endedAt) : undefined,
      partnerContacts: meta.partnerContacts,
    },
    options: { kroki: !!kroki, atemschutz: draft.options.atemschutz, attendance: draft.options.attendance, mittel: draft.options.mittel, journal: draft.options.journal, pendenzen: draft.options.pendenzen, krokiLandscape: draft.options.krokiLandscape },
    // Beilagen: only the ones actually ON the server. A blob: URL is a photo that has not
    // finished uploading, and the server cannot fetch it — printing would silently drop it, so
    // it is left out here and the preflight says so beside the row.
    attachments: draft.options.attachments
      ? attachments.filter((a) => a.url.startsWith('/')).map((a) => ({ url: a.url, caption: a.caption || undefined }))
      : [],
    ...mittelFormForPdf(mittel, catalogue),
    ...personalForPdf(roster, attendance, { alarmedAt: meta.alarmiertAt ?? incident.started_at, endedAt: meta.endedAt ?? incident.closed_at }),
    // Anwesende + Einsatzstunden as ONE line under the roster. Computed here, where the ISO
    // timestamps live: the printed rows carry «19:12 – 21:40», and re-deriving minutes from
    // formatted clock text on the server would be a second, disagreeing answer.
    personalSummary: (() => {
      const bounds = { alarmedAt: meta.alarmiertAt ?? incident.started_at ?? null, endedAt: meta.endedAt ?? incident.closed_at ?? null }
      const cfgRule = cfg.report?.hoursRounding
      const rule = {
        stepMin: cfgRule?.stepMin ?? DEFAULT_HOURS_ROUNDING.stepMin,
        graceMin: cfgRule?.graceMin ?? DEFAULT_HOURS_ROUNDING.graceMin,
      }
      const s = hoursSummary(hoursRows(attendance, bounds), rule)
      // `unresolved` travels too: those people are in NEITHER sum, and a total that quietly
      // leaves people out is worse than one that says it did
      // No Einsatzende → no block can be totalled, so there are no hours to state. The sheet
      // then prints the headcount alone rather than «0:00» twice with a paragraph explaining
      // that both zeros mean «unknown» — which is what a running Einsatz produced.
      const totalled = !!bounds.endedAt && s.minutes > 0
      return {
        present: s.present,
        hours: totalled ? fmtHours(s.minutes) : '',
        hoursRounded: totalled ? fmtHours(s.rounded) : '',
        unresolved: totalled ? s.unresolved : 0,
      }
    })(),
    partnerPresets: cfg.report?.partnerOrgs ?? [],
    generatedAt: formatDateTime(draft.generatedAt),
    kroki: kroki ?? undefined,
    krokiCaption: kroki ? krokiCaption : undefined,
    planPages,
    // ⚠️ WHAT «überfällig» MEANT on this Einsatz. The sheet reconstructs an Atemschutz-Einsatz
    // from its contact log, and every judgement about that log — was a gap acceptable, when did
    // the board go red — depends on an interval the paper never named. It is a per-incident
    // setting on top of a per-station one (IncidentSettings · contactIntervalMin), so a reader
    // six months later has no way to look it up: it has to travel with the document.
    atemschutzIntervalMin: args.contactIntervalMin,
    atemschutzGraceSec: args.contactGraceSec,
    trupps: (draft.options.atemschutz ? trupps : []).map((t) => ({
      name: t.name, statusLabel: truppStatusLabel(t), members: t.members ?? [], auftrag: truppAuftragLabel(t.auftrag), ziel: t.ziel,
      // the numeric Leitung, else the free text an older record still carries verbatim
      lineNumber: t.lineNo != null ? String(t.lineNo) : t.lineNumber?.trim() || undefined,
      entryTime: t.entryTime ? formatDateTime(t.entryTime) : undefined, exitTime: t.exitTime ? formatDateTime(t.exitTime) : undefined,
      // ⚠️ A Trupp whose log is empty still has a pressure somebody read off the cylinder and
      // typed in. Trupps registered from 2026-08-09 open their log with it (useTruppActions ·
      // createTrupp); one recorded BEFORE that has only `entryPressureBar`, and printing «Kein
      // Druckverlauf erfasst» over a number the Überwacher wrote down is the sheet contradicting
      // the record. Undated, because that is all the older shape knows — a made-up clock on a
      // legal document is worse than a missing one.
      readings: ((t.readings?.length ? t.readings : [{ t: '', bar: t.entryPressureBar, kind: 'registered' as const }])
        // ⚠️ no bar on a Kontakt/Rückzug row — that number was carried over, not read off a gauge
        // (lib/report · readingBarIsMeasured)
        .map((rr) => ({
          t: rr.t ? formatDateTime(rr.t) : '',
          kindLabel: readingKindLabel(rr.kind),
          bar: rr.bar != null && readingBarIsMeasured(rr.kind) ? String(rr.bar) : undefined,
        }))),
    })),
    journal: draft.options.journal ? journal : [],
    pendenzen: draft.options.pendenzen ? pendenzen : [],
  }
  return forPaper(payload) as Record<string, unknown>
}

/**
 * «→» and «←» become «->» and «<-» — for the PAPER only.
 *
 * The journal writes real arrows on purpose («EL → Sanität» is the shape of a Funkprotokoll line)
 * and they are what the app shows, searches and stores. The rapport, though, is composed in
 * Helvetica server-side, which has no glyph for either: ReportLab would draw a black box on the
 * one copy that gets signed — the exact failure `stripUnprintable` exists to prevent for emoji.
 *
 * ⚠️ Mapped HERE, at the single point where the payload is assembled, rather than by editing what
 * the operator typed: what the app holds stays the record, and only the rendering compromises.
 * ⚠️ Applied to the whole payload rather than to the journal rows alone — an arrow is just as
 * likely in a Kurzbericht, a Bemerkung or a Mittel remark.
 */
export function forPaper(v: unknown): unknown {
  if (typeof v === 'string') return v.replace(/→/g, '->').replace(/←/g, '<-')
  if (Array.isArray(v)) return v.map(forPaper)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, forPaper(x)]))
  }
  return v
}

export async function downloadDirectReportPdf(args: DirectReportArgs): Promise<void> {
  const payload = buildDirectReportPayload(args)
  await downloadReportPdf(args.incident.id, payload, reportFilenameHint(args.incident.title), args.transport)
}
