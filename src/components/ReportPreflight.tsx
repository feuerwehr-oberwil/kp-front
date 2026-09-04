import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { cx } from '../lib/cx'
import { parseAlarmText } from '../lib/alarmText'
import { confirmDialog, openPhoto, toast, type ToastAction } from '../lib/ui'
import { buildDirectReportPayload, downloadDirectReportPdf } from '../lib/reportPdfDirect'
import { thumbUrl } from '../lib/mediaUrl'
import { geretteteFromLage, geretteteOffer } from '../lib/gerettete'
import { rowPhotos } from '../lib/verlauf'
// the geometry every full surface stands in — the Rapport is the fifth of them
import surface from './Surface.module.css'
import { KrokiFramingPanel } from './KrokiFramingPanel'
import { ShareIncident } from './panels/ShareIncident'
import { cancelPrint, editorPrintTransport, enqueuePrint, fetchJobStatus, fetchPrintStatus, prewarmPrint, type PrintJobStatus, type PrintRelayStatus } from '../lib/printRelay'
import { trackPrintJob } from '../lib/printJobToast'
import { appConfig } from '../config/appConfig'
import { fillTemplate, fmtSpanShort, hhmm, dtLocalValue, dtLocalToIso, stripUnprintable, telHref } from '../lib/format'
import type { IncidentMeta } from '../lib/incidents'
import { getIncident, verifyChain } from '../lib/incidents'
import type { FahrzeugZeit, GruppeZeit, PartnerContact, ReportMeta } from '../lib/workspace'
import { deriveAusgerueckt, fahrzeugRows, gruppenRows, setFahrzeugZeit, setGruppeZeit, zeitFromClock, zeitIssues } from '../lib/alarmzeiten'
import type { ZeitKind } from '../lib/alarmzeiten'
import type { AssignableRole } from '../lib/roleAssignment'
import { deploymentName, getDeploymentConfig, reportLinks } from '../lib/deploymentConfig'
import { linkTokenValues, resolveLinkUrl, type ReportLink } from '../lib/reportLinks'
import { activityMoments, loadReplay, stateAt, vehiclesAt, type ReplayBundle } from '../lib/replay'
import { autoRotation, vehicleSymbolSvg } from '../lib/useVehiclePositions'
import type { AuditProof, ReportDraft, ReportOptions } from '../lib/report'
import {
  defaultReportOptions, einsatzleiterFromScene, formatDateTime, missingTranscriptCount, pendenzRows, proofLabel,
} from '../lib/report'
import { missingSteps, stepDone, type AbschlussFacts, type AbschlussStep } from '../lib/abschluss'
import { hoursRows, unresolvedHoursRows } from '../lib/attendanceHours'
import { openConflicts, sideLabel, sideValue, type OpenConflict } from '../lib/attendanceConflict'
import { incidentDays } from '../lib/zeitplanFormat'
import type { AttendanceState, BoardAnno, BoardDoc, BuildingDoc, CaptionMode, Drawing, Entity, LayerDef, LngLat, MittelEntry, Person, PlanDocument, ReportAttachment, TimelineEvent, Trupp } from '../types'
import { visibleMittel } from '../lib/mittel'
import { ClearableInput } from './ClearableInput'
import { PersonField } from './PersonField'
import { Segmented } from './Segmented'
import { useIsPhone } from '../lib/useIsPhone'
import { journalVocabulary } from '../lib/journalLinks'
import { CaptureUsageChip, type CaptureUsage } from './CaptureUsageChip'
import { DateTimeField, TimeField } from './TimeField'
import { Stepper } from './Stepper'
import { Menu, Popover } from '../lib/overlays'
import { useMediaQuery } from '../lib/useIsPhone'

const NO_IDS = new Set<string>()

/** Does this partner row say anything at all? Blank rows live on screen and never reach the blob. */
const partnerFilled = (p: PartnerContact) => [p.org, p.name, p.phone, p.note].some((v) => v?.trim())

/** A typed count as the blob stores it — «», «3 », «-1» and «abc» all mean «nichts eingetragen». */
const numOrU = (s: string): number | undefined => {
  const n = Number(s)
  return s.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined
}

// --- Rapportangaben that BOTH sides write ----------------------------------------------------
//
// The Rapport is not a dialog: it is opened early in an Einsatz and left open for hours, while
// the workspace syncs every few seconds and the Einsatzleiter fills in the same sheet on the
// iPad next to it. Every field below used to be seeded from `reportMeta` ONCE, at mount, and
// then ignored the prop for the rest of the Einsatz — so the form showed the state it opened
// on, and (the real damage) wrote all fifteen of those stale values back into the blob on the
// next keystroke in any one of them. A Kurzbericht typed on the iPad was gone the moment
// somebody touched the Bemerkung on the laptop. «Der Einsatzrapport synchronisiert nicht.»
//
// `useSyncedField` is the three-way merge that replaces the seeding. Two rules, and they are
// the same rule seen from both ends:
//   • what this operator did NOT touch follows the blob (adoption), and
//   • what this operator DID touch is all this device is allowed to write back (`dirty`).
//
/** Which synced field the caret is in, by the `data-sync` marker on its wrapper — `null` when
 *  the focus is anywhere else on the sheet. One attribute per field beats an onFocus/onBlur pair
 *  on every input, half of which are custom components that forward neither. */
const focusedSyncField = (): string | null => {
  const el = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)
  return el?.closest?.('[data-sync]')?.getAttribute('data-sync') ?? null
}

/** Canonical forms. A round trip through the LOCAL shape must not read as a change — a
 *  Kurzbericht is trimmed on the way to the blob, `dtLocalValue` drops the seconds off an ISO
 *  stamp, a Stepper writes «3» where the blob holds 3 — and a field that looks edited because
 *  of one of those would clobber the blob exactly as before. */
const normText = (v: string) => v.trim()
const normDtLocal = (v: string) => dtLocalToIso(v) ?? ''
const normCount = (v: string) => String(numOrU(v) ?? '')
const normList = (v: unknown[]) => JSON.stringify(v)
/** blank partner rows live on screen and never reach the blob, so they are not a change either */
const normPartners = (v: PartnerContact[]) => JSON.stringify(v.filter(partnerFilled))

/**
 * One Rapportangabe, merged with whatever the other devices have made of it.
 *
 * @param name    the field's `data-sync` marker — how «is the caret in here right now» is asked
 * @param remote  what the blob says, already in this field's LOCAL shape (dtLocal string, list,
 *                «» for absent), so the two sides are comparable at all
 * @param norm    the field's canonical form (see above)
 * @param tick    bumped on every focus move inside the sheet, so an adoption that was held back
 *                for the caret is retried the moment the field is left
 *
 * ⚠️ Nothing is ever yanked out from under a typing operator: while the field has the caret the
 * remote value waits, and the field stays CLEAN while it waits — so what this device saves is
 * the blob's value, not the stale text still on screen. `dirty` is exactly what the save may
 * carry (see dirtyMeta), and it clears itself the moment the write lands back in `reportMeta`.
 */
function useSyncedField<T>(
  name: string, remote: T, norm: (v: T) => string, tick: number,
): readonly [T, (next: T) => void, boolean] {
  const [value, setValue] = useState(remote)
  const [dirty, setDirty] = useState(false)
  const rn = norm(remote)
  const ln = norm(value)
  useEffect(() => {
    // In sync — which is also how a local edit stops being dirty: every field here persists on
    // change and the workspace echoes the write straight back, so one render later the blob
    // says what the operator typed and this device has nothing left of its own to defend.
    if (rn === ln) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the write landed; nothing to defend
      if (dirty) setDirty(false)
      return
    }
    if (dirty) return                        // this operator's edit is the newer one — it stands
    if (focusedSyncField() === name) return  // …or is being typed right now: adopt on blur (tick)
    setValue(remote)                         // adoption: the blob moved, an untouched field follows
    // `remote` itself is deliberately not a dep — it is compared through `norm`, so a new array
    // identity that says the same thing must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rn, ln, dirty, tick, name])
  const set = (next: T) => { setDirty(true); setValue(next) }
  return [value, set, dirty] as const
}

/** HH:MM display value for the compact time inputs of the Zeiten grid. */
function clockOf(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return hhmm(d)
}

function CheckRow({ done, label, sub, onGo, anchor, tab, children }: {
  done: boolean
  label: string
  sub: string
  onGo?: () => void
  /** the Abschluss step this row answers — the «noch offen» chips scroll to it (see jumpToStep) */
  anchor?: string
  /** which phone tab this row belongs to — inert above 600px (see PhoneTab) */
  tab?: PhoneTab
  children?: ReactNode
}) {
  return (
    <div className="rp-check" data-step={anchor} data-tab={tab}>
      <button type="button" className="rp-check-main" onClick={onGo} disabled={!onGo}>
        <span className={`rp-check-dot${done ? ' done' : ''}`}>
          <Icon id={done ? 'check' : 'minus'} />
        </span>
        <span className="rp-check-label">{label}</span>
        <span className="rp-check-sub">{sub}</span>
        {onGo && <Icon id="chevron" className="rp-check-go" />}
      </button>
      {children}
    </div>
  )
}


/**
 * PHONE ONLY (≤600px, the width at which the rail becomes a bottom bar and every other surface
 * switches too). Stacked, this page is four form sections, a five-part round-up and the Kroki —
 * about five phone screens, and the Anwesenheits-Liste read out at the Appell sits at the far
 * end of them. Three tabs put each of those within one screen.
 *
 * ⚠️ It decides what is SHOWN, never the order: the DOM stays in the printed rapport's order
 * (report_pdf.py / admin/capturePdf.ts), and from 601px up the bar is `display: none` and every
 * section is on screen exactly as it is today — the two-column layout at 1080 is untouched.
 */
type PhoneTab = 'bericht' | 'werwas' | 'beilagen'
const PHONE_TABS: PhoneTab[] = ['bericht', 'werwas', 'beilagen']
/** Which tab a still-open Mindestangabe lives in — the head's «noch offen» chips switch to it
 *  before they scroll, and the tab itself carries a dot while one of its steps is open. */
const STEP_TAB: Record<AbschlussStep, PhoneTab> = {
  zeiten: 'bericht',
  einsatzleiter: 'bericht',
  kontaktperson: 'bericht',
  kurzbericht: 'bericht',
  rueckmeldung: 'bericht',
  anwesenheit: 'werwas',
  mittel: 'werwas',
  // an Anwesenheits-Abweichung is about who was there — it rides with the Anwesenheit it is about
  abweichungen: 'werwas',
}

// The preflight UNMOUNTS while the operator hops to Anwesenheit / Mittel / Verlauf («Zurück
// zum Einsatzrapport» remounts it) — remember the body's scroll position per incident so the
// return lands where they left off, not back at the top. A deliberate close (X / overlay /
// Abbrechen / Abschliessen) resets it, so a later fresh open starts at the top again.
// ⚠️ The phone TAB rides in the same box and for the same reason: the Appell is «Rapport →
// Personal & Mittel → hop to Anwesenheit to correct → back», and a return that landed on «Bericht»
// would cost a tap on every single round trip. A genuinely fresh open — another Einsatz, or
// after Abschliessen — still starts on «Bericht».
// ⚠️ …and so does WHAT WILL PRINT: the print-section toggles (incl. the Kroki's Quer/Hoch and
// its framing) plus the chosen Kroki-Stand. Switching «Einsatzjournal» off, hopping to
// Anwesenheit to fix a name and coming back put every section silently back on — on the one
// surface that decides what leaves the building, and with the choice buried in the ▾ menu where
// nobody would notice it had been undone.
// Only the operator's OWN changes are kept (`optionOverrides`, a patch — see patchOpt), never
// the whole options object: the seeds `kroki` / `annotatedPlans` / `atemschutz` follow the LIVE
// data, and a remembered `kroki: false` from a Rapport opened before anything was drawn would
// have dropped the Lageskizze from the sheet for the rest of the Einsatz.
// (a mutated `.current` box, not a reassigned binding — the react-compiler lint forbids
// reassigning module variables inside the component)
const savedScroll: {
  current: { incidentId: string; top: number; tab: PhoneTab; optionOverrides: Partial<ReportOptions>; krokiAt: number | null } | null
} = { current: null }

/** What the box holds for THIS Einsatz, or null — another incident always starts fresh. */
const keptFor = (incidentId: string) => (savedScroll.current?.incidentId === incidentId ? savedScroll.current : null)

// «Später» on the Abschluss-Band, per incident. Same kind of box as savedScroll and for the same
// reason — the surface unmounts on every hop to Anwesenheit/Mittel/Verlauf, and a dismissal that
// did not survive that would put the band back on screen two taps later. Deliberately NOT in the
// workspace blob and NOT on disk: it is one operator postponing one decision on one device, and a
// «Später» that outlived a reload would turn the only surface that says «dieser Einsatz ist noch
// offen» permanently silent — which is the failure this whole band exists to fix.
const bandDismissed: { current: Set<string> } = { current: new Set() }

export function ReportPreflight({
  incident, reportMeta, personnel = [], presentIds = NO_IDS, onRolePicked, onAddGuest, events, annotatedPlanCount, truppCount, attendanceCount, mittelCount, mittel = [], mapContentCount = 1, pendingMediaCount = 0, attendance = {}, trupps = [], contactIntervalMin, contactGraceSec, plans = [], scene, board, twinAnnos, building, captureUsage, canEdit = true, attachments = [], onAddAttachments, onCaptionAttachment, onRemoveAttachment, onSaveMeta, onEditDispatch, onOpenAnwesenheit, onOpenMittel, onResolveConflict, onComplete, onFixTranscripts,
}: {
  incident: IncidentMeta
  reportMeta: ReportMeta
  /** Mannschaft roster + who is present — the Einsatzleiter picker offers present crew first */
  personnel?: Person[]
  presentIds?: Set<string>
  /** Naming somebody here puts them on the Anwesenheit list and, for the Einsatzleiter, writes
   *  the function into their Bemerkung. A rapport that names an Einsatzleiter the attendance
   *  sheet has never heard of contradicts itself on paper. Undefined = nothing to link, which
   *  by now only happens for a name typed on a session that may not write. */
  onRolePicked?: (personId: string | undefined, role: AssignableRole, note?: string) => void
  /** …and the id a hand-typed name is filed under: the roster's, or a fresh Gast's. Carries the
   *  job, because a Gast's row is CREATED by this call — there is nothing yet for a following
   *  `onRolePicked` to write a Bemerkung onto. Absent = the session may not write. */
  onAddGuest?: (name: string, role: AssignableRole, note?: string) => string | undefined
  events: TimelineEvent[]
  annotatedPlanCount: number
  truppCount: number
  attendanceCount: number
  /** count of distinct visible Mittel lines — drives the section toggle + its label */
  mittelCount: number
  /** append-only Mittel entries — the quick-check list derives current lines from them */
  mittel?: MittelEntry[]
  /** entities+drawings on the Lage map — 0 seeds the Kroki page OFF (rapport-only incident) */
  mapContentCount?: number
  /** captures (photo/audio) still in the offline upload queue — warns they aren't on the
   *  server yet, so a report printed now won't include them from another device */
  pendingMediaCount?: number
  /** full attendance record — drives the collapsible Stunden (von–bis) editor */
  attendance?: AttendanceState
  trupps?: Trupp[]
  /** the Funkkontakt-Intervall this Einsatz ran on + the grace on top — what «überfällig»
   *  meant here. It is a per-incident setting, so nobody can look it up on the paper later. */
  contactIntervalMin?: number
  contactGraceSec?: number
  plans?: PlanDocument[]
  /** the Lage scene for the server-rendered Kroki (entities/drawings/layers/view) */
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
  /** plan whiteboard annotations — server-rendered annotated Objektplan pages */
  board?: BoardDoc
  /** mirrored Karte content per linked plan (workspace · printTwinAnnos) — printed with the
   *  sheet's own annos, and enough on its own for a plan to count as annotated */
  twinAnnos?: Record<string, BoardAnno[]>
  /** the picked Gebäude (floor stack) — exports as blank-base plan pages when present */
  building?: BuildingDoc | null
  /** QR self-reporting in use — «QR: N Einträge · zuletzt HH:MM» chip (informational) */
  captureUsage?: CaptureUsage | null
  /** Beilagen: photos that belong to the REPORT (an ID document, a damage close-up), printed
   *  large enough to read at the end. Separate from Verlauf photos on purpose — see
   *  types · ReportAttachment. Omit the handlers on a read-only surface and the block reads. */
  attachments?: ReportAttachment[]
  onAddAttachments?: (files: File[]) => void
  onCaptionAttachment?: (id: string, caption: string) => void
  onRemoveAttachment?: (id: string) => void
  /** persist the inline Rapportangaben edits (after-arrival fields) into the workspace */
  onSaveMeta: (next: ReportMeta) => void
  /** may this session write the Rapportangaben? False for a viewer and for an ARCHIVED Einsatz
   *  (which is «nur ansehen – zum Bearbeiten reaktivieren»): the fields render, filled in and
   *  readable, but nothing in them can be changed. */
  canEdit?: boolean
  /** Stunden editor: correct one person's von–bis; omit to render the table read-only */
  /** open the Einsatzdaten panel to correct the dispatch facts; omit to hide the link
   *  (e.g. viewers / read-only) */
  onEditDispatch?: () => void
  /** checklist navigation into the REAL views (the practice rationale): these close the
   *  sheet and reveal the surface — same tools on every incident size */
  onOpenAnwesenheit?: () => void
  onOpenMittel?: () => void
  /** Settle one Anwesenheits-Abweichung: write the chosen value into the record (or leave the
   *  merge alone for «beide stimmen so») AND append the row that says so. ONE call, because the
   *  two halves must not drift apart — a record change with no line, or a line about a change
   *  that never landed, are both worse than the warning it replaces. */
  onResolveConflict?: (open: OpenConflict, choice: 0 | 1 | 'both') => void
  /** «Einsatz abschliessen» — runs the confirm (the shared one, see IncidentWorkspace ·
   *  confirmAndComplete), stamps report_done_at and closes. Resolves TRUE only when the Einsatz
   *  was actually handed over, so a cancelled confirm changes nothing here either. Omit for
   *  viewers / read-only. */
  onComplete?: () => Promise<boolean>
  /** jump to the Verlauf to fill the still-missing audio transcripts */
  onFixTranscripts?: () => void
}) {
  // Defaults follow the data: a rapport-only incident (nothing drawn) prints without the
  // map/plan pages, no configuration needed; every toggle stays available as an override.
  // Personal + Material stay ON even with zero records: the rapport is a pre-filled
  // FORM (2026-07-17) — empty sections print as tick-off roster rows / amount stubs.
  // ⚠️ Derived HERE rather than passed in like the other counts: it comes out of the journal the
  // sheet already has, and the number is also the diagnostic — «Aufträge / Pendenzen (0)» says the
  // Einsatz raised none, which is a different answer from a section that failed to reach paper.
  // ⚠️ And the OPTION is not seeded from it (`defaultReportOptions.pendenzen` is simply true).
  // Seeding «on if there are any» reads the count ONCE, at mount, from whatever the sheet happened
  // to know then — every item raised afterwards found the section already switched off, silently
  // and for the rest of the Einsatz. The payload carries an empty list when there are none, so
  // «always on» costs nothing: the section prints if and only if there is something to print.
  const pendenzCount = useMemo(() => pendenzRows(events).length, [events])
  const [options, setOptions] = useState<ReportOptions>(() => ({
    ...defaultReportOptions,
    kroki: mapContentCount > 0,
    annotatedPlans: annotatedPlanCount > 0,
    atemschutz: truppCount > 0,
    // The framing chosen for the LAST print of this Einsatz — the Kroki panel opens on it and
    // reports every settled pan back into this same field, so what the surface would print is
    // always what the crop on screen shows. Auto on first use: the operational extent decides
    // the shape, so a Lage that runs north–south opens upright without anyone asking for it.
    krokiView: reportMeta.krokiPrint?.view ?? null,
    // ⚠️ HOCH by default. The rapport is a portrait document and every other page of it is
    // portrait, so a landscape Kroki turns the one sheet people actually look at sideways in the
    // middle of the stack. It used to be derived from the scene's bounding box, which meant the
    // orientation changed between two prints of the SAME Einsatz as symbols were added. A
    // remembered choice still wins — this is only what an unframed rapport starts from.
    krokiLandscape: reportMeta.krokiPrint?.landscape ?? false,
    // …and LAST, so the operator's own picks beat every seed above them: what was chosen before
    // the hop to Anwesenheit/Mittel is what this Einsatz still prints (see savedScroll).
    ...(keptFor(incident.id)?.optionOverrides ?? {}),
  }))
  // The deviations from those seeds — the patch, not the result. Kept across the unmount so a
  // remount re-reads the live data (a Lage drawn in the meantime turns `kroki` back on) and then
  // re-applies what the operator actually decided.
  const optionOverrides = useRef<Partial<ReportOptions>>(keptFor(incident.id)?.optionOverrides ?? {})

  // Every focus move inside the sheet, counted. An adoption held back because the caret was in
  // the field (see useSyncedField) has to be retried when the operator leaves it, and «the field
  // was left» is not a prop change — nothing else would re-run the effect. Both halves of the
  // move are counted because `focusout` fires BEFORE the next element has the focus, so the
  // reading taken on the way out can still name the field being left.
  const [blurTick, setBlurTick] = useState(0)
  useEffect(() => {
    const moved = (e: FocusEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('[data-sync]')) setBlurTick((t) => t + 1)
    }
    document.addEventListener('focusin', moved)
    document.addEventListener('focusout', moved)
    return () => {
      document.removeEventListener('focusin', moved)
      document.removeEventListener('focusout', moved)
    }
  }, [])

  // What the BLOB says, field by field, in the shape each field holds it in on screen. This
  // block is the mapping the old seeding did once at mount and never again; it is read on every
  // render now, and `useSyncedField` decides per field whether the screen follows it.
  const remoteSummary = reportMeta.summary ?? ''
  const remoteKontaktperson = reportMeta.kontaktperson ?? ''
  const remoteKontaktTel = reportMeta.kontaktpersonTelefon ?? ''
  // ⚠️ The Kroki fallback belongs in here, not beside it: it is what an EMPTY blob shows, so a
  // field sitting on the seeded name is in agreement with the blob and must not count as an edit
  // this device has to defend (that is what `seededEinsatzleiter` below persists, once).
  const remoteEinsatzleiter = reportMeta.einsatzleiter ?? einsatzleiterFromScene(scene?.entities) ?? ''
  const remoteEndedAt = dtLocalValue(reportMeta.endedAt ?? incident.closed_at ?? undefined)
  const remoteAusgerueckt = dtLocalValue(reportMeta.ausgeruecktAt)
  const remoteRemarks = reportMeta.remarks ?? ''
  const remoteLehren = reportMeta.lehren ?? ''
  const remoteGruppen = reportMeta.gruppen ?? []
  const remoteFahrzeuge = reportMeta.fahrzeuge ?? []
  const remoteGeretteteP = reportMeta.gerettete?.personen?.toString() ?? ''
  const remoteGeretteteT = reportMeta.gerettete?.tiere?.toString() ?? ''
  const remoteRueckName = reportMeta.rueckmeldungElz?.name ?? ''
  const remoteRueckAt = reportMeta.rueckmeldungElz?.at ?? ''
  const remotePartners = reportMeta.partnerContacts ?? []

  // Partnerorganisationen. The field existed in the model and PRINTED for months, but nothing
  // ever wrote it — so every rapport fell back to the config's tick-off row and «Polizei war da»
  // was all the paper ever said. The remark is the point of the block: which patrol, whose
  // number, what they took over.
  const [partners, setPartners, partnersDirty] = useSyncedField('partners', remotePartners, normPartners, blurTick)
  const savePartners = (next: PartnerContact[]) => {
    // Bail BEFORE the local state: `persist` already refuses to write while read-only, so
    // accepting the edit on screen would show a viewer (or a closed Einsatz) a partner that
    // was never saved and vanishes on close — the silent-drop failure the read-only fieldset
    // exists to prevent. This block sits outside that fieldset, so it guards itself.
    if (!canEdit) return
    setPartners(next)
    // an all-empty row is nothing to record — dropped on the way to the blob, kept on screen
    const clean = next.filter(partnerFilled)
    persist({ partnerContacts: clean.length ? clean : undefined })
  }
  const patchPartner = (i: number, over: Partial<PartnerContact>) =>
    savePartners(partners.map((p, j) => (j === i ? { ...p, ...over } : p)))
  // WHEN the printed Kroki shows. The live picture is the default and the common case; a past
  // instant is what makes a rapport able to show the Rettung that has since left, or the moment
  // the Lage was at its worst. Reconstructed locally from the event journal (lib/replay), the
  // same fold the Wiedergabe uses — so the paper and the replay can never disagree.
  // …and it survives the round trip to Anwesenheit/Mittel with the print options (savedScroll):
  // a Stand picked by hand is a choice about the sheet, exactly like the sections are.
  const [krokiAt, setKrokiAt] = useState<number | null>(() => {
    const kept = keptFor(incident.id)
    if (kept) return kept.krokiAt
    return reportMeta.krokiPrint?.at ? Date.parse(reportMeta.krokiPrint.at) || null : null
  })
  const [pastScene, setPastScene] = useState<{ entities: Entity[]; drawings: Drawing[] } | null>(null)
  const [krokiAtBusy, setKrokiAtBusy] = useState(false)
  // WHEN anything happened, for the Stand slider's tick marks. Derived from the SAME source the
  // replay bar uses, so the two surfaces cannot disagree about where the Einsatz has substance:
  // the recorded actions plus the Verlauf rows that carry an absolute time.
  const [auditMoments, setAuditMoments] = useState<number[]>([])
  const bundleRef = useRef<ReplayBundle | null>(null)
  useEffect(() => {
    if (krokiAt == null) { setPastScene(null); return }
    let alive = true
    setKrokiAtBusy(true)
    void (async () => {
      try {
        const startMs = Date.parse(meta.startedAt ?? incident.started_at)
        bundleRef.current ??= await loadReplay(incident.id, startMs, Date.now())
        const ws = await stateAt(bundleRef.current, krokiAt)
        if (!alive) return
        // vehicles come from the recorded GPS samples, like the Wiedergabe draws them
        const vehicles: Entity[] = vehiclesAt(bundleRef.current.samples, krokiAt).map((v) => ({
          id: `replay-veh-${v.deviceId}`, kind: 'vehicle', layer: appConfig.gps.layerId,
          coord: v.coord, symbolSvg: vehicleSymbolSvg(String(v.deviceId), autoRotation(v.course), v.course != null),
          label: `Fahrzeug ${v.deviceId}`, live: true, directed: v.course != null,
        }))
        setPastScene({ entities: [...(ws?.entities ?? []), ...vehicles], drawings: ws?.drawings ?? [] })
      } catch {
        if (alive) { setPastScene(null); toast(P.krokiAtFailed, { icon: 'warn', tone: 'warn' }) }
      } finally {
        if (alive) setKrokiAtBusy(false)
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- incident/meta are stable per sheet
  }, [krokiAt])

  /** the Lage the printed Kroki is built from: the reconstructed one when a moment is chosen */
  const effScene = pastScene && scene ? { ...scene, entities: pastScene.entities, drawings: pastScene.drawings } : scene

  const presetOrgs = getDeploymentConfig().report?.partnerOrgs ?? []
  /** One row per organisation: the station's list (ticked or not), then any recorded org that is
   *  not on it. Matching is case-insensitive on the name, so a list entry and a typed one are
   *  the same organisation and can never appear twice. */
  const partnerRows = useMemo(() => {
    const key = (o?: string) => (o ?? '').trim().toLowerCase()
    const rows: { org: string; i: number; custom: boolean }[] =
      presetOrgs.map((org) => ({ org, i: partners.findIndex((p) => key(p.org) === key(org)), custom: false }))
    partners.forEach((p, i) => {
      if (!presetOrgs.some((o) => key(o) === key(p.org))) rows.push({ org: p.org ?? '', i, custom: true })
    })
    return rows
  }, [presetOrgs, partners])
  const [proof, setProof] = useState<AuditProof>({ intact: null, checkedAt: new Date().toISOString(), offline: true })
  const [checking, setChecking] = useState(true)
  // the alarm text auto-fills from the incident's dispatch text when none was typed in the
  // Einsatzdaten panel — display + print fallback only, never persisted into the report blob.
  const [alarmFallback, setAlarmFallback] = useState('')

  // Rapportangaben = the after-arrival fields, edited inline here. Every change is persisted
  // live (see persist) so nothing is lost if the sheet is closed — and every field follows the
  // blob while this operator is not editing it (see useSyncedField), because the same sheet is
  // open on the Einsatzleiter's iPad.
  const [summary, setSummary, summaryDirty] = useSyncedField('summary', remoteSummary, normText, blurTick)
  const [kontaktperson, setKontaktperson, kontaktpersonDirty] = useSyncedField('kontaktperson', remoteKontaktperson, normText, blurTick)
  const [kontaktTel, setKontaktTel, kontaktTelDirty] = useSyncedField('kontaktTel', remoteKontaktTel, normText, blurTick)
  // Seeded from the Kroki when the Rapport has none of its own: the EL was already named on the
  // map (Einsatzleiter glyph / KP Front), so typing it a second time is pure duplication. A
  // pre-fill only — the picker stays editable and the typed value wins from then on.
  const [einsatzleiter, setEinsatzleiter, einsatzleiterDirty] = useSyncedField('einsatzleiter', remoteEinsatzleiter, normText, blurTick)
  const [endedAt, setEndedAt, endedAtDirty] = useSyncedField('endedAt', remoteEndedAt, normDtLocal, blurTick)
  const [ausgerueckt, setAusgerueckt, ausgeruecktDirty] = useSyncedField('ausgerueckt', remoteAusgerueckt, normDtLocal, blurTick)
  const [remarks, setRemarks, remarksDirty] = useSyncedField('remarks', remoteRemarks, normText, blurTick)
  const [lehren, setLehren, lehrenDirty] = useSyncedField('lehren', remoteLehren, normText, blurTick)
  // Alarmierungs-/Ausrückzeiten grid (G1/G2) + the paper-form Details fields (G4).
  // Grid rows come from deployment config (empty config = grid hidden); values are
  // prefilled by the milestone webhook, edits here stamp `manual` (human beats machine).
  const [gruppen, setGruppen, gruppenDirty] = useSyncedField<GruppeZeit[]>('gruppen', remoteGruppen, normList, blurTick)
  const [fahrzeuge, setFahrzeuge, fahrzeugeDirty] = useSyncedField<FahrzeugZeit[]>('fahrzeuge', remoteFahrzeuge, normList, blurTick)
  const [geretteteP, setGeretteteP, gerettetePDirty] = useSyncedField('geretteteP', remoteGeretteteP, normCount, blurTick)
  const [geretteteT, setGeretteteT, geretteteTDirty] = useSyncedField('geretteteT', remoteGeretteteT, normCount, blurTick)
  // ── «Auf der Lage» — the Gerettete already standing on the map, offered into the fields ──
  // Same shape as the Material surface's «Gesetzt, aber nicht erfasst» strip: it states what it
  // read and where, one tap fills both fields, and nothing is ever written on its own. The
  // Rettungs-Symbol carries «Anzahl Personen» in its count and «Anzahl Tiere» in its own field,
  // so the number the Rapport asks for has been on the Kroki the whole time (lib/gerettete).
  const geretteteLage = useMemo(
    () => geretteteFromLage([...(scene?.entities ?? []), ...Object.values(board ?? {}).flat()]),
    [scene?.entities, board],
  )
  const geretteteHint = canEdit
    ? geretteteOffer(geretteteLage, { personen: numOrU(geretteteP), tiere: numOrU(geretteteT) })
    : null
  const [rueckName, setRueckName, rueckNameDirty] = useSyncedField('rueckName', remoteRueckName, normText, blurTick)
  // ⚠️ The full ISO, not an HH:MM. The Rückmeldung an die ELZ is regularly given after
  // midnight, or the morning after on a long Einsatz, and a bare clock had to guess which
  // day it meant (applyTimeToIso rolled it forward past the start). The Einsatzende beside
  // it has always asked for a date; this is the same question and now asks it the same way.
  const [rueckAt, setRueckAt, rueckAtDirty] = useSyncedField('rueckAt', remoteRueckAt, normText, blurTick)

  useEffect(() => {
    let alive = true
    verifyChain(incident.id)
      .then((r) => {
        if (!alive) return
        setProof({ intact: r.intact, brokenAtSeq: r.broken_at_seq, count: r.count, head: r.head, checkedAt: new Date().toISOString() })
      })
      .catch(() => {
        if (!alive) return
        setProof({ intact: null, checkedAt: new Date().toISOString(), offline: true })
      })
      .finally(() => { if (alive) setChecking(false) })
    return () => { alive = false }
  }, [incident.id])

  useEffect(() => {
    if (reportMeta.alarmText) return
    let alive = true
    getIncident(incident.id)
      .then((full) => { if (alive && full.text) setAlarmFallback(full.text) })
      .catch(() => {})
    return () => { alive = false }
  }, [incident.id, reportMeta.alarmText])

  // Header «Ausgerückt» is DERIVED (first physical departure) once any per-vehicle time
  // exists; the manual field stays authoritative only while there is no vehicle data.
  const derivedAus = deriveAusgerueckt(fahrzeuge)

  const rueckIso = rueckAt || undefined
  const geretteteOver = (p: string, t: string): Partial<ReportMeta> => ({
    gerettete: numOrU(p) !== undefined || numOrU(t) !== undefined
      ? { personen: numOrU(p), tiere: numOrU(t) } : undefined,
  })
  // The Rückmeldung is often given LATER than it happened — «ah, die ELZ hab ich gestern um
  // 23:40 informiert» — so it carries a DATE, like the Einsatzende above it. It used to be a
  // bare clock with an optional day chip, which could only offer the incident's own days and
  // defaulted to rolling the time forward past the start; a Rückmeldung given the next morning
  // was filed on the night of the fire, on the one field that records when the ELZ was told.
  const rueckOver = (name: string, iso: string): Partial<ReportMeta> => {
    const at = iso || undefined
    return { rueckmeldungElz: name.trim() || at ? { name: name.trim() || undefined, at } : undefined }
  }
  /** The form AS IT STANDS ON SCREEN, for everything that reads the rapport rather than writes
   *  it: the head's «noch offen», the Abschluss-Checkliste, the printed draft. It is not what
   *  gets SAVED (that is `dirtyMeta` — this device may only write what it changed): an
   *  Einsatzende typed a second ago has to count here without a round trip, and a field still
   *  holding a value the blob has moved on from prints what the operator is looking at. */
  const editedMeta = (): Partial<ReportMeta> => ({
    summary: summary.trim() || undefined,
    kontaktperson: kontaktperson.trim() || undefined,
    kontaktpersonTelefon: kontaktTel.trim() || undefined,
    einsatzleiter: einsatzleiter.trim() || undefined,
    endedAt: dtLocalToIso(endedAt),
    ausgeruecktAt: derivedAus ?? dtLocalToIso(ausgerueckt),
    remarks: remarks.trim() || undefined,
    lehren: lehren.trim() || undefined,
    gruppen: gruppen.length ? gruppen : undefined,
    fahrzeuge: fahrzeuge.length ? fahrzeuge : undefined,
    gerettete: numOrU(geretteteP) !== undefined || numOrU(geretteteT) !== undefined
      ? { personen: numOrU(geretteteP), tiere: numOrU(geretteteT) } : undefined,
    rueckmeldungElz: rueckName.trim() || rueckIso ? { name: rueckName.trim() || undefined, at: rueckIso } : undefined,
  })

  /**
   * What THIS device is entitled to write: the fields its operator actually changed and whose
   * change has not landed in the blob yet. Everything else is left to pass through from the
   * latest `reportMeta`.
   *
   * ⚠️ This used to be `editedMeta()` — all fifteen fields, every time, out of state that was
   * seeded at mount and never refreshed. So a device that had the Rapport open wrote its own
   * half-hour-old idea of every field back on the next keystroke in any one of them, and the
   * Kurzbericht the Einsatzleiter had just typed on the iPad was gone. A field is in here only
   * while `useSyncedField` says the operator moved it, which also means a field they are
   * currently TYPING in but have not changed (the caret holds off its adoption) is deliberately
   * absent: what leaves this device is the blob's value, not the stale text still on screen.
   */
  const dirtyMeta = (): Partial<ReportMeta> => {
    const out: Partial<ReportMeta> = {}
    if (summaryDirty) out.summary = summary.trim() || undefined
    if (kontaktpersonDirty) out.kontaktperson = kontaktperson.trim() || undefined
    if (kontaktTelDirty) out.kontaktpersonTelefon = kontaktTel.trim() || undefined
    if (einsatzleiterDirty) out.einsatzleiter = einsatzleiter.trim() || undefined
    if (endedAtDirty) out.endedAt = dtLocalToIso(endedAt)
    // The header «Ausgerückt» is derived from the vehicle grid the moment it holds anything, so
    // a change to either side is a change to this one stamp (see derivedAus).
    if (ausgeruecktDirty || fahrzeugeDirty) out.ausgeruecktAt = derivedAus ?? dtLocalToIso(ausgerueckt)
    if (remarksDirty) out.remarks = remarks.trim() || undefined
    if (lehrenDirty) out.lehren = lehren.trim() || undefined
    if (gruppenDirty) out.gruppen = gruppen.length ? gruppen : undefined
    if (fahrzeugeDirty) out.fahrzeuge = fahrzeuge.length ? fahrzeuge : undefined
    // ⚠️ Two fields, ONE blob key — so an untouched half is taken from the blob rather than from
    // this device's copy of it: writing `gerettete` because the Tiere moved must not put back
    // the Personen count another device corrected in the meantime.
    if (gerettetePDirty || geretteteTDirty) {
      const p = numOrU(gerettetePDirty ? geretteteP : remoteGeretteteP)
      const t = numOrU(geretteteTDirty ? geretteteT : remoteGeretteteT)
      out.gerettete = p !== undefined || t !== undefined ? { personen: p, tiere: t } : undefined
    }
    // …and the same for the Rückmeldung's name + time
    if (rueckNameDirty || rueckAtDirty) {
      const name = (rueckNameDirty ? rueckName : remoteRueckName).trim()
      const at = (rueckAtDirty ? rueckAt : remoteRueckAt) || undefined
      out.rueckmeldungElz = name || at ? { name: name || undefined, at } : undefined
    }
    if (partnersDirty) {
      const clean = partners.filter(partnerFilled)
      out.partnerContacts = clean.length ? clean : undefined
    }
    return out
  }

  // The freshest blob this surface has seen, for the writes that do NOT happen inside the event
  // that triggered them (see persist, stampReportMade). Updated in an effect rather than during
  // render — a ref written while rendering is the pattern the immutability lint objects to.
  const metaRef = useRef(reportMeta)
  useEffect(() => { metaRef.current = reportMeta })

  // Write the after-arrival fields back to the blob, preserving everything else (the dispatch
  // facts alarmText/alarmiertAt stay sourced from the incident — never persisted here). `over`
  // carries the just-changed field so we don't read stale state mid-event.
  // ⚠️ The base is `metaRef`, the freshest blob this surface has seen, not the `reportMeta` of
  // the render this closure was built in: `startOutput` persists the Kroki framing AFTER an
  // awaited confirm dialog, by which time a sync may have moved the blob on underneath it.
  const persist = (over: Partial<ReportMeta>) => canEdit && onSaveMeta({
    ...metaRef.current,
    ...dirtyMeta(),
    ...over,
  })

  // Commit the Kroki-seeded Einsatzleiter to the blob once, so the Abschluss-Checkliste and a
  // rapport printed from another device see the same name this field shows — a value that only
  // lives in local state would leave the checklist nagging about an Einsatzleiter that is on
  // screen. Fills a BLANK field only, never overwrites, and only while the sheet is mounted.
  const seededEinsatzleiter = useRef(false)
  useEffect(() => {
    if (seededEinsatzleiter.current || reportMeta.einsatzleiter?.trim() || !einsatzleiter.trim()) return
    seededEinsatzleiter.current = true
    persist({ einsatzleiter: einsatzleiter.trim() })
    // `persist` is re-created every render (it closes over the live field state); depending on it
    // would re-run this on every keystroke — the ref guard is what makes it once-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportMeta.einsatzleiter, einsatzleiter])

  // …and put that Einsatzleiter on the ANWESENHEIT, once.
  //
  // ⚠️ The EL is the one person a rapport names on its front page — and until 10.08. that name
  // was only ever a string on `reportMeta` (or on the Kroki symbol it was seeded from). Nothing
  // guaranteed a matching Anwesenheits-Zeile, so an Einsatz could be led by somebody who
  // appeared on NO list: not on the Anwesenheit, not in the Trupp picker's «schon: Einsatzleiter»
  // hint, and not on the printed Personalblatt — which is also the Soldblatt. The interactive
  // pick already writes it (onRolePicked · lib/roleAssignment); this covers every other route a
  // name arrives by (seeded data, a sync from another device, the symbol).
  //
  // Only when the name RESOLVES to a roster row. A name that arrives this way was NOT typed
  // here — it comes from seeded data, another device's sync or the Kroki symbol — and minting a
  // Gast for one would put people on the Soldblatt that nobody recorded on this screen. Typing a
  // name into the picker itself is the deliberate act, and that path files a Gast (onAddGuest).
  /** person id → the job they already hold, off their Anwesenheits-Bemerkung — shown on every
   *  option of the two person pickers below (lib/roleAssignment writes these notes). Same shape
   *  the Atemschutz board's pickers use; a roster that reads differently depending on which
   *  screen it is opened from is a roster nobody trusts. */
  const rolesById = useMemo(
    () => new Map(
      Object.entries(attendance)
        .map(([id, a]) => [id, (a.note ?? '').trim()] as const)
        .filter(([, note]) => note.length > 0),
    ),
    [attendance],
  )
  const linkedEinsatzleiter = useRef(false)
  useEffect(() => {
    if (linkedEinsatzleiter.current || !onRolePicked) return
    const name = (reportMeta.einsatzleiter ?? einsatzleiter).trim()
    if (!name) return
    const p = personnel.find((x) => x.displayName.trim().toLowerCase() === name.toLowerCase())
    if (!p || attendance[p.id]) return
    linkedEinsatzleiter.current = true
    onRolePicked(p.id, 'el', appConfig.copy.anwesenheit.roleEinsatzleiter)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount, guarded by the ref
  }, [reportMeta.einsatzleiter, einsatzleiter, personnel, attendance])

  const meta: ReportMeta = {
    ...reportMeta,
    ...editedMeta(),
    alarmText: reportMeta.alarmText ?? (alarmFallback || undefined),
    // Alarmierung = the incident's start (= when we were alarmed); editable in Einsatzdaten
    alarmiertAt: reportMeta.alarmiertAt ?? incident.started_at,
  }
  const alarm = parseAlarmText(meta.alarmText)
  const alarmiert = meta.alarmiertAt
  // Plausibility of the three clocks, as a HINT under the field that is wrong. Never a block:
  // printing must not depend on what somebody typed, and an Einsatz over midnight is normal.
  //
  // ⚠️ `Date.now()`, NOT the `nowRef` captured when this surface mounted. The Rapport is a
  // surface, not a dialog — it is opened early in an Einsatz and left open for hours — so a
  // mount-time «now» goes stale while it sits there, and «liegt in der Zukunft» then fired on
  // exactly the stamp that cannot possibly be in the future: the one «Jetzt» had just written.
  // Any Einsatz longer than the 5-minute slack showed it, which is most of them. (It failed the
  // other way too: a genuinely future time typed later was measured against the same stale
  // mark and stayed unflagged.)
  //
  // This is a read during render, not a ticking clock — nothing schedules a re-render, so the
  // battery footgun the frozen `nowRef` exists for is not reintroduced. The hint is re-evaluated
  // whenever anything on the form moves, which is precisely when it can change.
  const issues = zeitIssues(
    {
      alarmiertAt: alarmiert,
      ausgeruecktAt: derivedAus ?? dtLocalToIso(ausgerueckt),
      endedAt: dtLocalToIso(endedAt),
      rueckmeldungAt: rueckIso,
    },
    Date.now(),
  )
  const issueFor = (kind: ZeitKind) => {
    const i = issues.find((x) => x.kind === kind)
    if (!i) return null
    const t = i.ref ? formatDateTime(i.ref) : ''
    if (i.code === 'future') return P.zeitFuture
    return fillTemplate(i.code === 'beforeAusgerueckt' ? P.zeitBeforeAusgerueckt : P.zeitBeforeAlarm, { t })
  }
  // a plain call, not a component: one declared in the render body is re-created every pass
  const zeitWarn = (kind: ZeitKind) => {
    const text = issueFor(kind)
    return text ? <span className="rz-warn"><Icon id="warn" />{text}</span> : null
  }
  const missTx = missingTranscriptCount(events)
  // No krokiView argument any more: the panel reports each settled crop into `options` while the
  // rapport is being filled in, so by the time a button is pressed the state IS the framing on
  // screen. It used to be threaded through the modal's onConfirm because that value and the
  // setState landed in the same tick.
  const buildDraft = (): ReportDraft => {
    const generatedAt = new Date().toISOString()
    return {
      meta, generatedAt,
      proof: { ...proof, checkedAt: proof.checkedAt || generatedAt },
      // krokiAt travels with the draft so the printed caption dates the PICTURE, not the print
      // Stamp the chosen instant ONLY when the reconstruction for it is actually what prints.
      // `effScene` falls back to the LIVE Lage while the reconstruction is in flight and after
      // one fails, and a caption saying «Stand 21:14» over a picture of 23:00 is a false
      // statement on a document that is a legal record. No caption is the honest fallback.
      options: { ...options, krokiAt: krokiAt != null && pastScene ? new Date(krokiAt).toISOString() : null },
    }
  }
  const [pdfBusy, setPdfBusy] = useState(false)
  /** A rapport has just been produced (PDF in hand, or a print job on its way to the station
   *  printer). The blob remembers WHEN, so the Rapport can tell whoever opens it next that the
   *  paper already exists — on this device or on any other.
   *  ⚠️ NOT through `persist`: this write lands SECONDS after the press that started it (a
   *  server-rendered PDF takes a moment), and `persist` merges the form state of the render it
   *  was created in — a Kurzbericht typed while the PDF was rendering would be overwritten with
   *  the text it had when the button was hit. `metaRef` is the freshest blob instead, and every
   *  field on this surface already persists itself on change, so there is nothing else to carry
   *  — except `also`, the framing written by the same click (see startOutput). */
  const stampReportMade = (also: Partial<ReportMeta>) =>
    canEdit && onSaveMeta({ ...metaRef.current, ...also, reportMadeAt: new Date().toISOString() })
  /** A job has been handed to the station relay and is not printed yet. Recorded on the blob,
   *  not just in the toast: «in der Warteschlange» is a STATE and a toast is an event, and the
   *  poll behind the toast gives up after 90 s. Whoever opens the Rapport next — after a reload,
   *  on another device — has to see that a print is still outstanding. */
  const holdPrintJob = (id: string, also: Partial<ReportMeta>) =>
    canEdit && onSaveMeta({ ...metaRef.current, ...also, printJob: { id, at: new Date().toISOString() } })
  /** Jobs already settled on THIS surface — the double-settle guard. The toast's `onSettled`
   *  and this surface's own 15 s poll can both answer for the same job within one render, and
   *  `metaRef` only catches up on the NEXT render — so without this, the second settler saw the
   *  job still on the blob and wrote again, re-stamping `reportMadeAt` seconds later. A plain
   *  synchronous Set: the first settle claims the id before any side effect, the second no-ops. */
  const settledJobsRef = useRef(new Set<string>())
  /** The job left the queue. `done` is the ONLY status that earns the «Rapport erstellt» stamp —
   *  a failed or a cancelled job simply stops being outstanding, and `gone` (the relay no longer
   *  knows the job — swept after 7 days) clears WITHOUT stamping: the outcome is unknown, and a
   *  stamp would claim paper that may never have existed.
   *  ⚠️ ONE write for both halves: `metaRef` only catches up on the next render, so stamping and
   *  then clearing would merge the clear onto the blob as it was BEFORE the stamp.
   *  ⚠️ Settles the NAMED job only: a settle that arrives late (the toast poll of a previous
   *  job) must not clear a newer job that has since been queued. */
  const settlePrintJob = (jobId: string, status: PrintJobStatus | 'gone') => {
    if (!canEdit || metaRef.current.printJob?.id !== jobId || settledJobsRef.current.has(jobId)) return
    settledJobsRef.current.add(jobId)
    onSaveMeta({
      ...metaRef.current,
      ...(status === 'done' ? { reportMadeAt: new Date().toISOString() } : {}),
      printJob: undefined,
    })
  }
  /** The one step left after the paper exists, offered beside the fact rather than demanded:
   *  the Einsatz is still open, and nobody archives one unless they know they have to.
   *  ⚠️ `undefined` while ANY Mindestangabe is missing — printing a half-filled sheet to finish
   *  by hand, or a Zwischenausdruck taken mid-Einsatz, must never suggest closing the Einsatz.
   *  Same condition the Band under the head uses, so the two can't disagree. */
  const completeOffer = (): ToastAction | undefined =>
    onComplete && !missing.length ? { label: A.complete, onClick: () => void complete() } : undefined
  // ONE button (decided 2026-07-18): the server composes the complete rapport — map
  // render included (app/kroki.py) — from pure data. No Druckansicht detour anymore.
  const downloadPdf = async (framing: Partial<ReportMeta> = {}) => {
    const draft = buildDraft()
    setPdfBusy(true)
    try {
      await downloadDirectReportPdf({
        incident, draft, trupps, contactIntervalMin, contactGraceSec, attendance, events, plans, mittel, attachments, scene: effScene, board, twinAnnos, building,
        // the printed journal marks the same terms the app marks (lib/journalLinks) — the Trupps
        // included, or the paper would mark every name in a row except the crew it is about
        vocab: journalVocabulary(personnel, attendance, undefined, trupps),
        roster: personnel.filter((p) => p.active).map((p) => ({ id: p.id, name: p.displayName })),
      })
      // The PDF itself used to be the only feedback, and it still is the proof — but it is also
      // the moment everything except the bookkeeping is done, and nothing ever said so.
      stampReportMade(framing)
      const offer = completeOffer()
      if (offer) toast(P.madeToast, { icon: 'check', action: offer })
    } catch {
      toast(appConfig.copy.report.pdfFailed, { icon: 'warn', tone: 'warn' })
    } finally {
      setPdfBusy(false)
    }
  }
  // Station print relay: hidden unless the deployment runs one (fail-closed backend);
  // the dot mirrors the agent heartbeat, undo cancels while the job is still queued.
  const [printStatus, setPrintStatus] = useState<PrintRelayStatus | null>(null)
  const [printBusy, setPrintBusy] = useState(false)
  useEffect(() => {
    let alive = true
    void fetchPrintStatus(editorPrintTransport()).then((s) => { if (alive) setPrintStatus(s) })
    return () => { alive = false }
  }, [])
  // Opening this surface is a strong «about to print» signal: once we know the relay is
  // available and the report carries a Kroki, warm the server's map-tile cache so the real
  // enqueue render is near-instant. Fire once, best-effort — reframes reuse overlapping tiles.
  const warmedRef = useRef(false)
  useEffect(() => {
    if (warmedRef.current || !printStatus?.available || !options.kroki || mapContentCount === 0 || !scene) return
    warmedRef.current = true
    const payload = buildDirectReportPayload({
      incident, draft: buildDraft(), trupps, contactIntervalMin, contactGraceSec, attendance, events, plans, mittel, attachments, scene: effScene, board, twinAnnos, building,
      roster: personnel.filter((p) => p.active).map((p) => ({ id: p.id, name: p.displayName })),
    })
    void prewarmPrint(editorPrintTransport(), incident.id, payload)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printStatus?.available, options.kroki, mapContentCount])
  const R = appConfig.copy.printRelay
  const sendToPrinter = async (framing: Partial<ReportMeta> = {}) => {
    // ALWAYS confirm — «Ausdrucken» must never produce accidental paper; when the relay is
    // offline the modal doubles as the store-and-forward warning. That one is now the TITLE and
    // nothing else: «Stationsdrucker offline» is the whole statement, and the paragraph under it
    // explaining that the job would be printed later was the sentence that made queuing sound
    // like printing.
    const ok = printStatus?.online
      ? await confirmDialog({ title: R.confirmTitle, message: R.confirmMsg, confirmLabel: R.confirmBtn })
      : await confirmDialog({ title: R.offlineConfirmTitle, message: '', confirmLabel: R.offlineConfirmBtn })
    if (!ok) return
    setPrintBusy(true)
    try {
      const t = editorPrintTransport()
      const payload = buildDirectReportPayload({
        incident, draft: buildDraft(), trupps, contactIntervalMin, contactGraceSec, attendance, events, plans, mittel, attachments, scene: effScene, board, twinAnnos, building,
        roster: personnel.filter((p) => p.active).map((p) => ({ id: p.id, name: p.displayName })),
      })
      const jobId = await enqueuePrint(t, incident.id, payload)
      // ⚠️ NOT `stampReportMade`. EINGEREIHT IST NICHT GEDRUCKT: the stamp is the sole condition
      // for the band «Rapport erstellt. Der Einsatz ist noch offen – abschliessen?», and until
      // 22.08. it was set the instant the job left this device — including straight after the
      // dialog that had just said the printer was offline. So the app offered to close an Einsatz
      // whose rapport existed on no sheet of paper anywhere. What is recorded here is the OPEN
      // JOB; the stamp waits for the relay to say `done` (settlePrintJob).
      holdPrintJob(jobId, framing)
      // …and the Abschluss offer rides the END of the job's own status chain, not a second toast
      // beside it: the Einsatz is worth closing once the paper is out of the printer.
      trackPrintJob(t, jobId, completeOffer(), {
        relayOffline: !printStatus?.online,
        onSettled: (status) => settlePrintJob(jobId, status),
      })
    } catch {
      toast(R.failed, { icon: 'warn', tone: 'warn' })
    } finally {
      setPrintBusy(false)
    }
  }

  // --- The print job that has NOT come out yet ------------------------------------------------
  //
  // `pollJobUntilDone` gives up after 90 s and its toast is gone from the screen long before
  // that, and nothing ever read the job again — so a Rapport could sit for an hour claiming to
  // have been printed while the relay had never come back. An unresolved job is a STATE: it
  // lives on the blob, it shows under the head, and it is re-read for as long as this surface is
  // open, across a reload and a change of device.
  const pendingJob = reportMeta.printJob
  const [jobBusy, setJobBusy] = useState(false)
  // «Seit X min» must move. Computed from a bare Date.now() at render it froze at whatever
  // minute the band appeared in (and read the clock during render, which the purity lint
  // rightly flags) — a minute tick while a job is outstanding keeps the line honest. The
  // interval only exists while the band does; an Einsatz without an open job pays nothing.
  // No synchronous re-read when a job appears (the lint objects to setState in an effect
  // body, and it is not needed): a just-queued job's negative span is clamped to «Seit 0 min»
  // where the band renders it, which is the right sentence until the first tick.
  const [jobNowMs, setJobNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!pendingJob) return
    const iv = setInterval(() => setJobNowMs(Date.now()), 60_000)
    return () => clearInterval(iv)
  }, [pendingJob])
  useEffect(() => {
    const job = pendingJob
    if (!job || !canEdit) return
    let alive = true
    const t = editorPrintTransport()
    const read = async () => {
      const s = await fetchJobStatus(t, job.id)
      if (!alive) return
      // 'gone' = the relay no longer knows the job (swept after 7 days — the relay-was-down-a-
      // week case). Waiting longer can never resolve it, so stop showing it as open and say so
      // honestly: the outcome is unknown, no «Rapport erstellt» stamp.
      if (s === 'gone') { settlePrintJob(job.id, 'gone'); toast(R.jobGone, { icon: 'warn', tone: 'warn' }); return }
      // null = the relay is unreachable right now, which says nothing about the job — keep it.
      if (!s || s.status === 'queued' || s.status === 'printing') return
      settlePrintJob(job.id, s.status)
    }
    void read()
    const iv = setInterval(() => void read(), 15_000)
    return () => { alive = false; clearInterval(iv) }
    // keyed on the JOB, not on the writer — `settlePrintJob` is re-created every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingJob?.id, canEdit])
  /** «Prüfen»: ask the relay once, now, and say what came back — including «nothing», which is
   *  its own answer and used to be indistinguishable from «still queued». */
  const checkPrintJob = async () => {
    const job = metaRef.current.printJob
    if (!job) return
    setJobBusy(true)
    const s = await fetchJobStatus(editorPrintTransport(), job.id)
    setJobBusy(false)
    // «nicht mehr auffindbar» and «nicht erreichbar» are different answers: the first is about
    // the JOB (it stopped existing — clear it, outcome unknown), the second about the network.
    if (s === 'gone') { settlePrintJob(job.id, 'gone'); toast(R.jobGone, { icon: 'warn', tone: 'warn' }); return }
    if (!s) { toast(R.jobUnreachable, { icon: 'warn', tone: 'warn' }); return }
    if (s.status === 'done') { settlePrintJob(job.id, 'done'); toast(R.printed, { icon: 'check', tone: 'success' }); return }
    if (s.status === 'failed') { settlePrintJob(job.id, 'failed'); toast(R.printFailed, { icon: 'warn', tone: 'warn' }); return }
    if (s.status === 'cancelled') { settlePrintJob(job.id, 'cancelled'); toast(R.cancelled); return }
    toast(s.status === 'printing' ? R.printing : R.queued, { icon: 'printer', tone: 'warn' })
  }
  /** Give up on a job that is still in the queue. Refused once the agent has claimed it — the
   *  paper may already be moving, and the button says so rather than pretending. */
  const dropPrintJob = async () => {
    const job = metaRef.current.printJob
    if (!job) return
    setJobBusy(true)
    const res = await cancelPrint(editorPrintTransport(), job.id)
    setJobBusy(false)
    if (res === 'cancelled') { settlePrintJob(job.id, 'cancelled'); toast(R.cancelled); return }
    // The three refusals mean three different things (see printRelay · CancelOutcome):
    // «zu spät» only when the relay actually SAID the job is past cancelling — a network
    // failure used to wear the same words, claiming knowledge nobody had.
    if (res === 'gone') { settlePrintJob(job.id, 'gone'); toast(R.jobGone, { icon: 'warn', tone: 'warn' }); return }
    if (res === 'unreachable') { toast(R.jobUnreachable, { icon: 'warn', tone: 'warn' }); return }
    toast(R.undoTooLate, { icon: 'warn', tone: 'warn' })
  }

  /** The ONE way an option changes — it also records the deviation, which is what outlives the
   *  hop to Anwesenheit/Mittel (see savedScroll). Set an option any other way and it is back to
   *  its seed the moment the operator steps off this surface. */
  const patchOpt = (patch: Partial<ReportOptions>) => {
    optionOverrides.current = { ...optionOverrides.current, ...patch }
    setOptions((o) => ({ ...o, ...patch }))
  }
  /** Is there anything to frame? A rapport-only Einsatz (nothing drawn, nothing placed) seeds
   *  the Kroki section OFF and must not show an empty map pretending to be a picture — and
   *  switching the section off by hand means the same thing: nothing is going on the paper. */
  const krokiPanel = options.kroki && mapContentCount > 0 && !!effScene
  // is there anything on the SERVER to archive? Journal photos/recordings and Rapport-Beilagen
  // are all Media rows; blob: URLs are uploads still in flight and not fetchable as a ZIP yet
  const hasStoredMedia = useMemo(() => (
    attachments.some((a) => a.url.startsWith('/'))
    || events.some((e) => (e.audioUrl ?? '').startsWith('/') || rowPhotos(e).some((u) => u.startsWith('/')))
  ), [attachments, events])
  // The panel is a fold: on a wide screen it is open, because seeing the crop while the form is
  // typed is the whole reason it stopped being a modal; below the two-column breakpoint a map
  // crop is a postcard sitting between the operator and the fields, so it starts closed and
  // Loaded when the crop becomes visible, not on the first drag: the ticks exist to aim that
  // drag, so arriving after it would be arriving too late. Best-effort — a replay bundle that
  // will not load costs the marks, never the slider.
  const krokiShown = krokiPanel
  useEffect(() => {
    if (!krokiShown) return
    let alive = true
    void (async () => {
      try {
        const startMs = Date.parse(meta.startedAt ?? incident.started_at)
        bundleRef.current ??= await loadReplay(incident.id, startMs, Date.now())
        if (alive) setAuditMoments(activityMoments(bundleRef.current.events))
      } catch { /* no marks from the audit side; the slider still works */ }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the panel becoming visible
  }, [krokiShown, incident.id])
  // ⚠️ The journal moments come from the LIVE timeline (the same rows the Verlauf's own strip
  // ticks) and are derived REACTIVELY: the effect above runs once when the panel becomes
  // visible, and the rows routinely arrive after that (the journal store loads async since the
  // Verlauf moved out of the blob) — a one-shot read latched an empty barcode (19.08.).
  const krokiMoments = useMemo(
    () => [...auditMoments, ...activityMoments([], events)],
    [auditMoments, events],
  )
  const startOutput = async (action: 'pdf' | 'print') => {
    // ⚠️ A rapport that is still missing Mindestangaben may ALWAYS be produced — printing is
    // never blocked by what somebody has not typed yet, and a half-filled sheet taken to the
    // Magazin to be finished by hand is a real way of working. But a PDF that leaves the
    // building is the version that gets filed, so the gap is said out loud once, by name,
    // before it goes. Same words the Abschluss confirm uses; the only difference is that this
    // one is a warning and that one is a decision.
    if (missing.length) {
      const ok = await confirmDialog({
        title: P.exportIncompleteTitle,
        message: P.exportIncompleteLead,
        items: missing.map((st2) => A.steps[st2]),
        note: P.exportIncompleteMsg,
        confirmLabel: action === 'print' ? R.send : P.pdfFull,
        cancelLabel: appConfig.copy.cancel,
      })
      if (!ok) return
    }
    // No framing step in front of the action any more — the crop has been on screen the whole
    // time. What is left of the old onConfirm is the REMEMBERING: the framing rides the workspace
    // blob so the second print comes out of the same window as the first, from any device. Written
    // here rather than on every pan, because «the last print's framing» is what it claims to be —
    // and a persist per map frame would be a workspace write per frame. Cleared for a read-only
    // surface by `persist` itself.
    const framing: Partial<ReportMeta> = krokiPanel && options.krokiView
      ? {
        krokiPrint: {
          view: options.krokiView,
          at: krokiAt != null && pastScene ? new Date(krokiAt).toISOString() : undefined,
          landscape: options.krokiLandscape,
        },
      }
      : {}
    if (framing.krokiPrint) persist(framing)
    // …and it rides along to the stamp that follows a successful export: that write lands after
    // this one, merges onto its own snapshot of the blob, and would otherwise drop the framing
    // that was just saved.
    if (action === 'pdf') void downloadPdf(framing)
    else void sendToPrinter(framing)
  }
  const P = appConfig.copy.preflight
  const A = appConfig.copy.abschluss
  // the Verlauf's own namespace — the divergence rows are written there, so the card that
  // settles them speaks in the same words the row does
  const C = appConfig.copy.journal

  // «Formulare & Links» — the station's OWN paperwork (config `report.links`, see
  // lib/reportLinks). No config, no section: a Wehr that has no such forms never sees an empty
  // card explaining a feature it does not use.
  const stationLinks = reportLinks()
  const linksDone = meta.linksDone ?? {}
  const linksDoneCount = stationLinks.filter((l) => linksDone[l.id]).length
  /** ⚠️ Through `metaRef`, not `persist` — the tick is offered again when the operator returns
   *  from the form, which is a moment later than the render the offer was built in. `persist`
   *  would merge THAT render's form state and undo whatever was typed since (same reason as
   *  stampReportMade). Every field on this surface persists itself already. */
  const setLinkDone = (id: string, done: boolean) => {
    if (!canEdit) return
    const next = { ...(metaRef.current.linksDone ?? {}) }
    if (done) next[id] = new Date().toISOString()
    else delete next[id]
    onSaveMeta({ ...metaRef.current, linksDone: Object.keys(next).length ? next : undefined })
  }
  /** The link whose form was opened and not yet ticked off — the offer waits here until the
   *  operator comes back (see the effect below). */
  const returnOffer = useRef<ReportLink | null>(null)
  const openLink = (link: ReportLink) => {
    // Resolved at the moment of the press, not at render: the Kurzbericht and the Einsatzende
    // are typed while the Rapport is open, and the form should carry what stands there NOW.
    const url = resolveLinkUrl(link.url, linkTokenValues({
      stichwort: incident.title,
      ort: incident.address,
      alarmiertAt: meta.alarmiertAt,
      endedAt: meta.endedAt,
      einsatzleiter: meta.einsatzleiter,
      kontaktperson: meta.kontaktperson,
      kurzbericht: meta.summary,
      wehr: deploymentName(),
    }))
    // ⚠️ A blocked popup returns null, and saying «geöffnet» then offering to tick it off would
    // let the checklist record a form that never came up. Say what actually happened instead.
    if (!window.open(url, '_blank', 'noopener,noreferrer')) {
      toast(fillTemplate(P.linksOpenFailed, { title: link.title }), { icon: 'warn', tone: 'warn' })
      return
    }
    // The app cannot see whether the form was submitted, so it asks — but only once the
    // operator is BACK. A toast raised now would sit on a tab that just lost focus and expire
    // (6 s) long before anyone finished filling anything in.
    // Skipped where the row is already ticked, and where this session may not write anyway.
    if (!canEdit || linksDone[link.id]) return
    returnOffer.current = link
  }
  // …and here is the coming back. Scoped to the mounted Rapport on purpose: leave the surface
  // and the offer dies with it, which also keeps `metaRef` (read by `setLinkDone`) fresh for as
  // long as the offer can be taken.
  useEffect(() => {
    const onVisible = () => {
      const link = returnOffer.current
      if (document.visibilityState !== 'visible' || !link) return
      returnOffer.current = null
      toast(fillTemplate(P.linksOpened, { title: link.title }), {
        icon: 'external',
        action: { label: P.linksOpenedAction, onClick: () => setLinkDone(link.id, true) },
      })
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
    // `setLinkDone` reads the live blob off `metaRef`, so a listener bound once is not stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Derived closing checklist (lib/abschluss): the sheet is the ONE closing surface — the
  // status is recomputed from the data on every render, never stored as visited-state.
  // What the fold has to say without being opened: the sections that will actually print.
  // Personal and Material are always in it and that is deliberate — the Rapport is a pre-filled
  // FORM (field feedback 2026-07-17), so an incident with no records still wants the tick-off
  // roster and the amount stubs on paper. Everything else follows its content.

  /* Anwesenheits-Abweichungen the record still owes an answer for — derived from the Verlauf
     itself (append-only: settling one APPENDS a row, it never rewrites the one that warned).
     Rows raised before 04.09. carry no structured payload and are deliberately not returned;
     an item nobody can close would leave the step open for ever on every past Einsatz. */
  const conflicts = useMemo(() => openConflicts(events), [events])
  const facts: AbschlussFacts = { reportMeta: meta, attendanceCount, mittelCount, openConflicts: conflicts.length }
  const rows = hoursRows(attendance, { alarmedAt: alarmiert ?? null, endedAt: meta.endedAt ?? null })
  // People whose presence blocks cannot be turned into a duration — almost always a still-open
  // block borrowing an Einsatzende that lies BEFORE it. They fall out of BOTH Einsatzstunden
  // totals. It used to print on the paper as «N Person(en) ohne verwertbare Zeiten», a count of
  // an abstraction that named neither who nor why and that nobody could act on from a sheet.
  // It belongs here instead: beside the button that makes the paper, while it can still be fixed.
  // ⚠️ Filtered, not raw: while the Einsatz is RUNNING everybody still on scene totals to
  // nothing, and naming all of them under «Zeiten laufen rückwärts oder fehlen» is a warning
  // about the ordinary state of every open Einsatz (lib/attendanceHours · unresolvedHoursRows).
  const unresolvedNames = unresolvedHoursRows(rows, { endedAt: meta.endedAt ?? null }).map((r) => r.name)

  // «bereit» is a claim, so it is made only when nothing is outstanding — a fold that says all
  // is well while hiding a broken hash chain would be worse than no summary at all.
  const controlOk = !checking && proof.intact !== false && missTx === 0 && pendingMediaCount === 0
    && unresolvedNames.length === 0
  /** how many things are actually wrong — the chip counts them rather than saying «Kontrolle» */
  const warnCount = (missTx > 0 ? 1 : 0) + (pendingMediaCount > 0 ? 1 : 0) + (proof.intact === false ? 1 : 0)
    + (unresolvedNames.length > 0 ? 1 : 0)
  const [controlOpen, setControlOpen] = useState(false)

  // ⚠️ Used ONLY to decide whether the Kroki panel is mounted (see the section itself) — the
  // tabs themselves are pure CSS, because a layout that depends on a JS breakpoint and one that
  // depends on a media query drift apart on exactly the widths nobody tests.
  const isPhone = useIsPhone()
  // The phone's three tabs (see PhoneTab). Seeded from the box that also carries the scroll
  // position, so a hop to Anwesenheit and back returns to the tab it left from; a fresh Einsatz
  // opens on «Bericht», which is the first section of the printed rapport.
  const [phoneTab, setPhoneTab] = useState<PhoneTab>(() => keptFor(incident.id)?.tab ?? 'bericht')
  /** Picked by hand — each tab starts at ITS top, never at the scroll offset of the one before
   *  (which is a different page of different length). The «noch offen» chips do NOT go through
   *  here: they scroll to their own field instead. */
  const pickTab = (t: PhoneTab) => {
    setPhoneTab(t)
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }

  // The head's one line, in the voice the other surfaces use («12 anwesend · 3 gegangen · 28
  // Mannschaft»): what is recorded, then the verdict. «Alle Angaben erfasst» is a claim, so it is
  // made only when the same Mindestangaben the Abschluss-Confirm checks are all in — and when
  // they are not, the line NAMES the missing ones instead of saying that something, somewhere, is
  // still open. It deliberately says nothing about the Prüfnachweis or the pending uploads: those
  // are warnings, they live beside the buttons they must be read before, and a header that also
  // mentioned them would be the second place to look for the same thing.
  const missing = missingSteps(facts)
  /* «noch offen» as chips or as one dropdown. Measured with four open steps: the strip wraps onto a
   * second row below 834px and fits on one line from there up — so below that it becomes a single
   * control that rides with the other head buttons, and above it the chips stay exactly as they
   * were. 860 rather than 834 because it is a threshold this codebase already uses, and because
   * the wrap point moves with the number of open steps anyway (five would wrap wider).
   *
   * Raising the chips to var(--tap) was tried first and reverted: four 44px pills take over the
   * head, and the ::after-pad trick cannot help once the strip wraps — the pads of two rows
   * overlap and a tap between «Zeiten» and «Kurzbericht» becomes a coin flip. One control can be
   * 44px; four in a wrapped strip cannot. */
  const narrowHead = useMediaQuery('(max-width: 860px)')
  const headCounts = fillTemplate(P.headCounts, { n: attendanceCount, m: mittelCount })

  // «Einsatz abschliessen» is bookkeeping, not the artefact: it stamps report_done_at and
  // archives. The PDF is its own (primary) action — decoupled by decision 2026-07-08 after
  // auto-download-on-complete felt wrong in the field.
  // ⚠️ The CONFIRM does not live here any more. Both doors into the Abschluss — this one and the
  // row in the Einsatz-Menü — run the one in IncidentWorkspace (`confirmAndComplete`), which
  // names the same open points and stamps the same `report_done_at`. The menu row used to archive
  // plainly, so an Einsatz put away there stood in the Historie as «offen» for ever.
  // What stays here is what only this surface knows: a completed rapport should re-open at the
  // top and from its seeds, so the whole kept box — scroll position, tab, print sections, Kroki
  // Stand — is forgotten. But only if the Abschluss actually happened.
  const complete = async () => {
    if (await onComplete?.()) savedScroll.current = null
  }

  // The Abschluss-Band under the head (see the JSX): shown once a rapport has been produced and
  // nothing is left open — the two facts that together mean «only the bookkeeping is missing».
  // Both come off `meta`/`missing`, i.e. the LIVE form state: an Einsatzende typed a second ago
  // makes the band appear without a round trip, exactly as it clears the head's «noch offen».
  // Seeded once per mount, which is once per Einsatz — the workspace is keyed by incident id.
  const [bandHidden, setBandHidden] = useState(() => bandDismissed.current.has(incident.id))
  const hideBand = () => {
    bandDismissed.current.add(incident.id)
    setBandHidden(true)
  }
  const showCloseBand = !!onComplete && !!meta.reportMadeAt && missing.length === 0 && !bandHidden

  // Scroll keep-alive across the Anwesenheit/Mittel/Verlauf round trip (see savedScroll):
  // Restore before paint on mount, capture on unmount. There is no «close» any more: leaving is
  // choosing another surface in the rail, which unmounts this one and captures the scroll — and
  // «Einsatz abschliessen» clears the saved position itself, because coming back to a completed
  // rapport should start at the top.
  /**
   * Jump to the section a «noch offen» chip names, and flash it.
   *
   * The chips list what is still missing and were pure text: you read «Zeiten», then hunted for
   * the Zeiten yourself down a page that is four sections long. Naming a problem and not
   * pointing at it is the same failure the überfällig badge had on the Atemschutz board.
   *
   * Anchored on `data-step` rather than on refs: the six steps live in four different shapes
   * (a CheckRow, a labelled field, a grid, a person picker), and one attribute is the only thing
   * they can all carry without being restructured around it.
   */
  const jumpToStep = (step: AbschlussStep) => {
    // On a phone the field may be in a tab that is not on screen, and a hidden element measures
    // as nothing — so switch first and measure a frame later. Above 600px no tab is ever hidden
    // and this is the same jump it always was, one frame later.
    setPhoneTab(STEP_TAB[step])
    requestAnimationFrame(() => requestAnimationFrame(() => flashStep(step)))
  }
  const flashStep = (step: AbschlussStep) => {
    const body = bodyRef.current
    const el = body?.querySelector<HTMLElement>(`[data-step="${step}"]`)
    if (!body || !el) return
    // ⚠️ Scroll the SHEET, not `scrollIntoView`. Three of the six targets are whole `<section>`s
    // taller than the viewport, and `block: 'center'` centres their MIDDLE — which puts the
    // heading the chip just named off the top of the screen, so the jump lands somewhere
    // plausible and unrecognisable. Putting the target's top just under the sheet's top edge is
    // the same thing a reader would do with their thumb.
    const top = el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 12
    body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
    // …and the same two-beat ink ring the Atemschutz board uses when a locked Anwesenheits-Zeile
    // sends you to a card (Atemschutz.module.css · truppFlash). One surface, one way of saying
    // «this one» — a soft 1.2 s background wash read as a rendering artefact rather than a point.
    el.classList.remove('rp-flash')
    void el.offsetWidth // restart the animation when the same chip is tapped twice
    el.classList.add('rp-flash')
    window.setTimeout(() => el.classList.remove('rp-flash'), 2000)
    // the field the step is ABOUT, focused where there is one — a chip that scrolls to a text
    // box the operator then has to tap is one tap short of finishing the job
    el.querySelector<HTMLElement>('textarea, input, button')?.focus({ preventScroll: true })
  }

  const bodyRef = useRef<HTMLDivElement>(null)
  // …and the tab + the Kroki-Stand ride with it (see savedScroll). Read through refs in the
  // cleanup because the effect below is mount-only and would otherwise capture the values this
  // surface OPENED on. (`optionOverrides` is already a ref, so it needs no mirror.)
  const phoneTabRef = useRef(phoneTab)
  const krokiAtRef = useRef(krokiAt)
  useEffect(() => { phoneTabRef.current = phoneTab; krokiAtRef.current = krokiAt })
  useLayoutEffect(() => {
    const el = bodyRef.current
    const kept = keptFor(incident.id)
    if (el && kept) el.scrollTop = kept.top
    return () => {
      if (el) {
        savedScroll.current = {
          incidentId: incident.id, top: el.scrollTop, tab: phoneTabRef.current,
          optionOverrides: optionOverrides.current, krokiAt: krokiAtRef.current,
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    /* A SURFACE, not a dialog. The Rapport is filled in across a whole Einsatz — a sentence
       here, a time there, jump to Anwesenheit because somebody arrived — and it wants the width
       its Zeiten grid and its two-up roster ask for. It is also the last screen here with no
       dialog left over it at all: the Kroki framing used to open on top of this, which put the
       operator two windows deep on the one screen that has to stay legible at 3am, and it is a
       panel in the page now. The head carries NO close button: a page is left by choosing
       another surface in the rail, and a ✕ on one of six surfaces asks «closed into what?». */
    <>
      {/* Opaque backdrop, exactly as Mittel and Atemschutz do it: the Lage showing through the
          gap around an inset card makes a form look like something floating over the map, and
          this surface is where somebody sits and writes. */}
      <div className="rp-backdrop" aria-hidden />
      <div className={cx('report-preflight report-preflight-surface', surface.shell)}>
        {/* The same head every other surface wears (Anwesenheit, Mittel): a title, and under it
            one line of what is actually recorded. It carried a bare title and an ✕ — dialog
            chrome, which is what a page inherits when it used to be a sheet. No ✕ either: a
            page is left by choosing another surface in the rail, exactly like Anwesenheit and
            Mittel, and a close button on one of six surfaces asks «closed into what?». */}
        <header className="rp-head">
          <div className="rp-head-titles">
            <h2>{P.title}</h2>
            {/* ⚠️ NOT one sentence. As «5 Personen · 2 Positionen · noch offen: Kurzberi…» the
                line truncated away the only part of itself worth reading — what is still
                missing was the first thing to go, because it sits at the end. The counts are a
                read-out and stay one line; what is OPEN is a set, so it is a set of chips that
                wrap onto a second row and are named in full however many there are. */}
            <p className="rp-head-sum">
              <span className="rp-head-counts">{headCounts}</span>
              {missing.length > 0 && !narrowHead ? (
                <span className="rp-head-open">
                  <span className="rp-head-open-k">{P.headStillOpen}</span>
                  {/* each chip JUMPS to the thing it names — see jumpToStep */}
                  {missing.map((s) => (
                    <button
                      key={s} type="button" className="rp-head-open-go"
                      title={fillTemplate(P.headOpenGo, { step: A.steps[s] })}
                      aria-label={fillTemplate(P.headOpenGo, { step: A.steps[s] })}
                      onClick={() => jumpToStep(s)}
                    >{A.steps[s]}</button>
                  ))}
                </span>
              ) : missing.length === 0 ? (
                <span className="rp-head-done"><Icon id="check" />{P.headAllRecorded}</span>
              ) : null}
            </p>
          </div>
          {/* The controls sit HERE, with the other surfaces' controls, and the readiness state
              rides with them — that pairing is not decoration. A warning about the record (a
              broken hash chain, an audio entry with no transcript, a photo still queued) has to
              be read before the paper exists, so it has to be in the same glance as the button
              that makes the paper. Putting the buttons up here and leaving the warnings at the
              bottom of a scrolling form would be exactly the failure the never-behind-a-fold rule
              prevents; they move together or not at all. */}
          <div className="rp-head-actions">
            {/* Same row as the archive and print buttons — the head has one line of controls and
                this belongs on it, not above it. Only rendered where the chips would wrap. */}
            {narrowHead && missing.length > 0 && (
              <Menu
                trigger={
                  <button type="button" className="rp-head-open-menu"
                    aria-label={`${missing.length} ${P.headStillOpen}`} title={`${missing.length} ${P.headStillOpen}`}>
                    <Icon id="warn" />
                    <span>{missing.length} {P.headStillOpen}</span>
                    <Icon id="chevron-down" />
                  </button>
                }
                popupClassName="rp-print-menu"
                itemClassName={() => 'rp-print-menu-item'}
                items={missing.map((s) => ({
                  label: A.steps[s],
                  // the same jump the chip made — one control, same destinations
                  onClick: () => jumpToStep(s),
                }))}
              />
            )}
            {/* The chip appears ONLY when something is wrong. A green «Alles bereit» spent a
                control on the most contested row of the surface to announce that nothing had
                happened — and the line under the title already says whether the Angaben are
                complete, so it was also the second place to look for the same answer. Worse, a
                badge that is present and green on every ordinary Einsatz teaches the eye to skip
                exactly the spot the warning will appear in.
                Nothing actionable is lost: every state that needs a person is a warning, and a
                warning still lands here, amber, counted, in the same glance as the button that
                makes the paper. The Prüfnachweis read-out goes with it while it is intact —
                the signed paper is the record (report_pdf · decision E), and «intact» is not
                news. A BROKEN chain is, and that raises the chip.
                Not rendered while checking either: a spinner that resolves to nothing a moment
                later is a flicker on the row, and the check is the app's business, not the
                operator's. */}
            {/* The Kontrolle detail is a POPOVER on the chip that opens it, not a band across the
                page: it is a handful of lines about the record, and a full-width slab pushed the form
                down every time anything was amiss. Anchored to the chip, so «what is wrong» and «the
                thing that told me» are the same object. A warning still reaches the operator without
                it — the chip itself is amber and counts them.
                Through overlays · Popover, like the print menu beside it — NOT hand-rolled absolute
                positioning. The hand-rolled version anchored to the chip's own edge, and on a phone
                the wrapped action row pushes that chip far enough right that a 358px panel opening
                leftwards from it started at roughly x=−130: the names in the Einsatzstunden warning
                were cut off the left of the screen, hard-clipped by the surface's `overflow: hidden`.
                Portalled + collision-aware, the panel is clamped to the viewport instead of to the
                chip, so no breakpoint has to guess which way it should open. */}
            {!checking && !controlOk && (
              <Popover
                open={controlOpen}
                onOpenChange={setControlOpen}
                popupClassName="rp-control"
                ariaLabel={P.controlHead}
                trigger={(
                  <button type="button" className={cx('rp-state', 'warn')} title={P.controlHead}>
                    <Icon id="warn" />
                    <span>{fillTemplate(P.controlOpen, { n: warnCount })}</span>
                  </button>
                )}
              >
                {missTx > 0 && (
                  <p className="report-pre-warn">
                    <Icon id="warn" /> <span>{fillTemplate(P.missingTranscripts, { n: missTx })}</span>
                    {onFixTranscripts && <button type="button" className="report-pre-fix" onClick={onFixTranscripts}>{P.fixTranscripts}</button>}
                  </p>
                )}
                {pendingMediaCount > 0 && (
                  <p className="report-pre-warn">
                    <Icon id="warn" /> <span>{fillTemplate(P.pendingMedia, { n: pendingMediaCount })}</span>
                  </p>
                )}
                {/* names them and says WHY — a count of «ohne verwertbare Zeiten» was the version
                    that got printed and that nobody could do anything with. The fix is one tap
                    away, on the Anwesenheit these names come from. */}
                {unresolvedNames.length > 0 && (
                  <p className="report-pre-warn">
                    {/* joined on «·», not on a comma: the names read «Müller Hans», so every
                        name already contains a space, and a comma between them is a weaker
                        break than the one inside each pair — the run scanned as one long
                        smear of words. A middot outranks the space and the list falls apart
                        into people again. */}
                    <Icon id="warn" /> <span>{fillTemplate(P.unresolvedHours, { names: unresolvedNames.join(' · ') })}</span>
                    {onOpenAnwesenheit && <button type="button" className="report-pre-fix" onClick={onOpenAnwesenheit}>{A.steps.anwesenheit}</button>}
                  </p>
                )}
                <div className="report-fold-body">
                  <p><Icon id={proof.intact ? 'check' : 'warn'} /> {proofLabel(proof)}</p>
                  <p><Icon id="doc" /> {fillTemplate(P.annotatedDefault, { n: annotatedPlanCount })}</p>
                  <p><Icon id="snapshot" /> {fillTemplate(P.stateNote, { at: formatDateTime(new Date().toISOString()) })}</p>
                </div>
              </Popover>
            )}
            {/* ⚠️ Every label in this row is wrapped in `.rp-btn-label`, not left as a bare text
                node: on a phone the row goes icon-only (see app.css) and a bare text node cannot
                be hidden. The label survives as `aria-label` + `title`, so what is dropped is the
                pixels, never the naming. */}
            {onComplete && (
              <button className="ip-btn" onClick={() => void complete()} aria-label={A.complete} title={A.complete}>
                <Icon id="archive" /><span className="rp-btn-label">{A.complete}</span>
              </button>
            )}
            {printStatus?.available && (
              <button className={`ip-btn print-send${printStatus.online ? '' : ' offline'}`} disabled={printBusy}
                onClick={() => void startOutput('print')} aria-label={printBusy ? R.sending : R.send}
                title={printStatus.online ? R.online : R.offline}>
                <span className="print-send-main">
                  <Icon id="printer" />
                  <span className={`dot print-relay-dot${printStatus.online ? ' online' : ''}`} aria-hidden />
                  <span className="rp-btn-label">{printBusy ? R.sending : R.send}</span>
                </span>
                {/* the offline reason is the whole point of the taller button — it stays when the
                    label goes, because «it will print later» is not guessable from a printer icon */}
                {!printStatus.online && <span className="print-send-off">{R.offline}</span>}
              </button>
            )}
            {/* Press it and it prints, with whatever is set. The ▾ is the second door: the same
                print again (so the menu is never a dead end for the one who opened it looking
                for «drucken»), and the way into the section picker. Split rather than two
                buttons: the arrow belongs TO the PDF button — it modifies it — and a separate
                ⋮ beside it would have read as the surface's menu. The pair never wraps apart
                (it is one flex item), so at ≤720px it drops onto its own line intact. */}
            <span className="rp-split">
              <button className="ip-btn primary rp-split-main" disabled={pdfBusy} onClick={() => void startOutput('pdf')}
                aria-label={pdfBusy ? P.pdfBusy : P.pdfFull} title={pdfBusy ? P.pdfBusy : P.pdfFull}>
                <Icon id={pdfBusy ? 'rotate' : 'doc'} className={pdfBusy ? 'spin' : undefined} />
                <span className="rp-btn-label">{pdfBusy ? P.pdfBusy : P.pdfFull}</span>
              </button>
              <Menu
                trigger={
                  <button type="button" className="ip-btn primary rp-split-more" aria-label={P.printMenu} title={P.printMenu}>
                    <Icon id="chevron-down" />
                  </button>
                }
                popupClassName="rp-print-menu"
                itemClassName={() => 'rp-print-menu-item'}
                // «Abschnitte» used to be a fold ON the page — a section of the rapport that is
                // not part of the rapport: it is neither recorded nor printed, it is how the
                // printing is done, and it was scrolled past on every Einsatz whose defaults were
                // already right, which is nearly all of them (the seed follows the data).
                // The sections are IN this menu now, not behind it: «was kommt aufs Papier» is
                // several decisions in a row, and a dialog to open, tick and close for each one is
                // the long way round something done while looking at the button that prints. Base
                // UI keeps the menu open on a checkbox, so the row just flipped is still there.
                items={[
                  // No «Einsatzrapport (PDF)» row in here. It was meant as a second door for
                  // whoever opened the ▾ looking for «drucken», but the door it repeats is the
                  // button the ▾ is physically attached to — one press to the left, already
                  // pressed to get here. A menu whose first line is the control that opened it
                  // teaches that the two do different things, and they do not.
                  // The ticks need a name. Nine of them under «Einsatzrapport (PDF)» with nothing
                  // saying what they are is a menu that has to be experimented with.
                  { kind: 'head' as const, label: P.sectionsHead },
                  { kind: 'check' as const, label: P.toggleKroki, checked: options.kroki && mapContentCount > 0, disabled: mapContentCount === 0, onChange: (v: boolean) => patchOpt({ kroki: v }) },
                  // Pläne is three-way (mit Anmerkungen / alle / keine) and does not fit a
                  // checkbox, so the menu offers the two that are actually chosen between: the
                  // annotated ones, or all of them. Off is «neither ticked».
                  { kind: 'check' as const, label: fillTemplate(P.plansAnnotated, { n: annotatedPlanCount }), checked: options.annotatedPlans && !options.allPlans, onChange: (v: boolean) => patchOpt({ annotatedPlans: v, allPlans: false }) },
                  { kind: 'check' as const, label: P.plansAll, checked: options.allPlans, onChange: (v: boolean) => patchOpt({ allPlans: v, annotatedPlans: v ? false : options.annotatedPlans }) },
                  { kind: 'sep' as const },
                  { kind: 'check' as const, label: fillTemplate(P.toggleAtemschutz, { n: truppCount }), checked: options.atemschutz, onChange: (v: boolean) => patchOpt({ atemschutz: v }) },
                  { kind: 'check' as const, label: fillTemplate(P.toggleAttendance, { n: attendanceCount }), checked: options.attendance, onChange: (v: boolean) => patchOpt({ attendance: v }) },
                  { kind: 'check' as const, label: fillTemplate(P.toggleMittel, { n: mittelCount }), checked: options.mittel, onChange: (v: boolean) => patchOpt({ mittel: v }) },
                  { kind: 'check' as const, label: P.toggleJournal, checked: options.journal, onChange: (v: boolean) => patchOpt({ journal: v }) },
                  // ⚠️ Its own row, with its own count. Folded into «Einsatzjournal» it was invisible:
                  // switching the long log off silently dropped the outstanding items too, and nothing
                  // on the sheet said so. The count is also the diagnostic — «(0)» means the Einsatz
                  // raised none, not that the section is broken.
                  { kind: 'check' as const, label: fillTemplate(P.togglePendenzen, { n: pendenzCount }), checked: options.pendenzen && pendenzCount > 0, disabled: pendenzCount === 0, onChange: (v: boolean) => patchOpt({ pendenzen: v }) },
                  { kind: 'check' as const, label: fillTemplate(P.toggleAttachments, { n: attachments.length }), checked: options.attachments && attachments.length > 0, disabled: attachments.length === 0, onChange: (v: boolean) => patchOpt({ attachments: v }) },
                  { kind: 'sep' as const },
                  { kind: 'check' as const, label: P.toggleDetailedAudit, checked: options.detailedAudit, onChange: (v: boolean) => patchOpt({ detailedAudit: v }) },
                  { kind: 'sep' as const },
                  // the Beilagen in ORIGINAL quality — one ZIP with manifest + SHA-256 per file,
                  // for the digital Ablage. An ACTION among the section ticks, so it sits last;
                  // plain navigation, the session cookie does the auth. Absent (404) when the
                  // Einsatz has no stored media — the disabled state mirrors that.
                  {
                    label: P.archiveZip,
                    disabled: !hasStoredMedia,
                    onClick: () => { window.location.assign(`/api/incidents/${incident.id}/media.zip`) },
                  },
                ]}
              />
            </span>
          </div>
        </header>
        {/* The Einsatz is done in every way except the bookkeeping: the paper exists, nothing is
            missing, and it is still sitting on the open list. Archiving is a deliberate act that
            nobody performs unless they know it exists, so this is the app saying it once, at the
            one moment it is true — a line under the head, never a dialog. It blocks nothing:
            «Später» takes it off the screen and the two buttons above are untouched. */}
        {showCloseBand && (
          <div className="rp-band">
            <Icon id="check" className="rp-band-ok" />
            <span className="rp-band-txt"><b>{P.bandDone}</b> {P.bandAsk}</span>
            <button type="button" className="ip-btn" onClick={hideBand}>{P.bandLater}</button>
            <button type="button" className="ip-btn primary" onClick={() => void complete()}>
              <Icon id="archive" />{A.complete}
            </button>
          </div>
        )}
        {/* …and its counterpart: a print that has been handed over and has not come back. It is
            NOT dismissible — «Später» on the green band hides an offer, this one is an open
            question about whether the rapport exists at all — and it stays until the relay says
            done, failed or cancelled. Amber, because nothing is finished and nothing is wrong. */}
        {pendingJob && (
          <div className="rp-band rp-band-open">
            <Icon id="printer" className="rp-band-wait" />
            <span className="rp-band-txt">
              <b>{R.jobOpen}</b>{' '}
              {fillTemplate(R.jobOpenSince, { t: fmtSpanShort(Math.max(0, jobNowMs - Date.parse(pendingJob.at))) })}
              {printStatus && !printStatus.online && ` · ${R.offline}`}
            </span>
            {/* The band stays VISIBLE for a viewer — an outstanding print is true information —
                but the actions sit behind the same canEdit gate as every other control on this
                surface (the disabled fieldsets above). A viewer's «Abbrechen» used to really
                cancel the job at the relay while their own settlePrintJob no-oped: toast said
                abgebrochen, the band stayed, and the editor's print was gone. */}
            <fieldset className="report-fieldset" disabled={!canEdit}>
              <button type="button" className="ip-btn" disabled={jobBusy} onClick={() => void checkPrintJob()}>{R.jobCheck}</button>
              <button type="button" className="ip-btn ip-btn-danger" disabled={jobBusy} onClick={() => void dropPrintJob()}>{R.jobCancel}</button>
            </fieldset>
          </div>
        )}
        {/* PHONE ONLY — `display: none` from 601px up, so tablet and desktop are byte-identical
            to what they were. Outside the scrolling body on purpose: it is a flex item of the
            surface, like the head, so it cannot scroll away from under the thumb. The dot marks
            a tab holding a Mindestangabe that is still open — the same amber the head's chips
            use, so «noch offen» means one thing on this page. */}
        <div className="rp-tabs">
          <Segmented<PhoneTab>
            ariaLabel={P.tabsLabel}
            value={phoneTab}
            onChange={pickTab}
            options={PHONE_TABS.map((t) => {
              const open = missing.some((s) => STEP_TAB[s] === t)
              return {
                value: t,
                title: open ? `${P.tabs[t]} – ${P.headStillOpen}` : P.tabs[t],
                label: <>{P.tabs[t]}{open && <span className="rp-tab-dot" aria-hidden />}</>,
              }
            })}
          />
        </div>
        <div className="ip-body report-preflight-body" data-phone-tab={phoneTab} ref={bodyRef}>
          {/* TWO columns on a wide screen (one below 1080px, see app.css), because the rapport is
              worked in two different ways and they interleave: the FORM is typed straight through
              — dispatch readout, Zusammenfassung, the Zeiten, Bemerkungen — while the ROUND-UP
              beside it (wer und was war da: Anwesenheit · Mittel · Partner · Beilagen, then what
              will print) is checked off after the fact and jumps to other surfaces. Stacked they
              made one column two screens tall on a page half of which was margin; side by side
              the Zeiten grid gets the width it was always asking for and the checklist stays
              visible while the form is being typed. The DOM order is untouched — it is the order
              of the printed rapport and of the paper Erfassungsblatt (report_pdf.py,
              admin/capturePdf.ts, both tested) — the columns only decide WHERE, never in which
              order things are read. */}
          <div className="rp-col rp-col-form">
          {/* ONE disabled fieldset rather than a `readOnly` on twenty controls: a viewer, and an
              archived Einsatz («nur ansehen – zum Bearbeiten reaktivieren»), can read every
              recorded value here and change none of it. `persist` refuses too, so a stray
              handler can't slip past the markup. */}
          <fieldset className="report-fieldset" disabled={!canEdit}>
          <section className="report-pre-section report-pre-meta" data-tab="bericht">
            {/* No <h3> here: the dispatch block carries its own «Aus den Einsatzdaten» heading and
                the edit link that belongs to it, so a section title above it was the same words
                twice. The other three sections have one because they have nothing else to say
                what they are. */}
            {/* ⚠️ The card is CLICKABLE, not a <button>. Wrapping the whole thing in a button
                made the dispatch facts part of its label: a screen reader then gets one stop
                announcing «Aus den Einsatzdaten – Bearbeiten», and the Alarmmeldung, the
                Einsatzplan and the Alarmierung — the things this block exists to state —
                collapse into it. So the <dl> stays readable content, the click on the card is
                pure pointer convenience, and «Bearbeiten» remains a real button: the keyboard
                and AT target, and the visible cue that the card does something. */}
            <div
              className={`report-meta-dispatch${onEditDispatch ? ' report-meta-dispatch-click' : ''}`}
              onClick={onEditDispatch}
            >
              <div className="report-meta-dispatch-head">
                <span>{P.fromDispatch}</span>
                {onEditDispatch && (
                  // stopPropagation: without it the card's own handler fires too and the
                  // Einsatzdaten panel is asked to open twice from one tap
                  <button type="button" className="report-meta-editlink"
                    onClick={(e) => { e.stopPropagation(); onEditDispatch() }}>
                    <Icon id="pen" /> {P.edit}
                  </button>
                )}
              </div>
              <dl className="report-meta-readout">
                {/* The gateway hands us one field holding four different things (see
                    lib/alarmText). Shown verbatim it is mostly machinery — a marching order,
                    an object's notes, and a 300-character link this app minted itself — under
                    a heading that promises a MESSAGE. Split, each part lands where it belongs
                    and «Alarmmeldung» says «nicht erfasst» when nobody wrote one, which is the
                    honest answer and the common one. */}
                <div>
                  <dt>{P.alarmMessage}</dt>
                  <dd>{alarm.message || <span className="report-meta-empty">{P.notRecorded}</span>}</dd>
                </div>
                {alarm.vehicleOrder && (
                  <div><dt>{P.vehicleOrder}</dt><dd>{alarm.vehicleOrder}</dd></div>
                )}
                {alarm.plan && (
                  <div>
                    <dt>{P.einsatzplan}</dt>
                    <dd>
                      {alarm.plan.header}
                      {/* Sofortmassnahmen are the safety-relevant half — they stay. The
                          Bemerkungen belong to the Einsatzobjekt and are one tap away there. */}
                      {alarm.plan.measures.length > 0 && (
                        <ul className="report-meta-list">
                          {alarm.plan.measures.map((m, i) => <li key={i}>{m}</li>)}
                        </ul>
                      )}
                    </dd>
                  </div>
                )}
                <div><dt>{P.alarmierung}</dt><dd>{alarmiert ? formatDateTime(alarmiert) : <span className="report-meta-empty">{P.notRecorded}</span>}</dd></div>
              </dl>
            </div>
          </section>

          {/* «Rapportangaben» was ONE heading over everything after the dispatch facts — a blob a
              screen and a half long in which nothing could be found by looking. It is four
              sections now, each named after the question it answers, in exactly the order they
              were already in (that order is the printed rapport's). */}
          <section className="report-pre-section report-pre-meta" data-tab="bericht">
            <h3>{P.sectionBericht}</h3>
            {/* after-arrival — editable inline (replaces the old Bearbeiten modal).
                ⚠️ `data-sync` marks which Rapportangabe the caret is in, so a value arriving
                from another device is never yanked out from under somebody typing here — it is
                adopted the moment the field is left (see useSyncedField). One marker per field. */}
            <label className="ip-field" data-step="kurzbericht" data-sync="summary">
              <span>{P.summaryLabel}</span>
              <textarea className="ip-textarea" value={summary} rows={5} placeholder={P.summaryPlaceholder}
                onChange={(e) => { const v = stripUnprintable(e.target.value); setSummary(v); persist({ summary: v.trim() || undefined }) }} />
            </label>
            <div className="report-meta-grid">
              {/* ⚠️ Each field carries its OWN anchor. The grid used to carry one for
                  «einsatzleiter», so the chip highlighted the Einsatzleiter AND the Kontaktperson
                  — two different people answering two different questions. The grid is a single
                  column, so a wrapper here is a plain block box and changes no layout. */}
              <div data-step="einsatzleiter" data-sync="einsatzleiter">
              <PersonField
                label={P.einsatzleiterLabel} placeholder={P.einsatzleiterPlaceholder}
                value={{ name: einsatzleiter }} onChange={(slot) => {
                  setEinsatzleiter(slot.name)
                  persist({ einsatzleiter: slot.name.trim() || undefined })
                  // the slot's personId was thrown away here — which is why the EL named on the
                  // Rapport never reached the Anwesenheit list
                  onRolePicked?.(slot.personId, 'el', appConfig.copy.anwesenheit.roleEinsatzleiter)
                }}
                personnel={personnel} legacyRoster={[]} presentIds={presentIds}
                assignedIds={NO_IDS} usedIds={NO_IDS} usedNames={NO_IDS}
                // ⚠️ The job each candidate already holds. This picker of all of them was the
                // silent one: it is where somebody is MADE Einsatzleiter, and it said nothing
                // about the fact that the name under the cursor is already the Fahrer of the TLF.
                rolesById={rolesById}
                onAddGuest={onAddGuest && ((name) => onAddGuest(name, 'el', appConfig.copy.anwesenheit.roleEinsatzleiter))}
                rankFirst officerFilter
              />
              </div>
              {/* ⚠️ A <div>, not a <label>: the row carries a BUTTON now, and a button inside a
                  label steals its own tap for the input's focus. Same shape the Rückmeldung-Zeit
                  row next to it already uses; the input keeps its name through `aria-label`. */}
              <div className="ip-field" data-step="kontaktperson" data-sync="kontaktperson">
                <span>{P.kontaktpersonLabel}</span>
                {/* «Entfällt» — the third answer. A Fehlalarm in an empty Altersheim has nobody
                    to name, and «leer» and «gibt es nicht» are two different statements: without
                    this the step stayed open for ever and the «Angaben fehlen noch» dialog stood
                    in front of every print until it was being tapped away unread. It is a
                    trailing affordance on the input line, not a checkbox somewhere else — the
                    two answers are the same distance away. */}
                {meta.kontaktpersonNone ? (
                  <div className="rz-none">
                    {/* dashed, never a tick: erledigt, but ANSWERED «nicht vorhanden» rather than
                        filled in — one glance tells the two apart */}
                    <span className="rz-none-val">{P.entfaellt}</span>
                    <button type="button" className="ip-btn" onClick={() => persist({ kontaktpersonNone: undefined })}>{P.entfaelltUndo}</button>
                  </div>
                ) : (
                  <div className="rz-none rz-kontakt">
                    {/* ✕: the Rapport is filled in after the fact and corrected as the picture
                        settles — a name written down from a first guess is normal here. */}
                    <ClearableInput value={kontaktperson} placeholder={P.kontaktpersonPlaceholder}
                      aria-label={P.kontaktpersonLabel}
                      clearLabel={P.kontaktpersonClear}
                      onChange={(raw) => { const v = stripUnprintable(raw); setKontaktperson(v); persist({ kontaktperson: v.trim() || undefined }) }} />
                    {/* The number beside the name, because it is ONE fact — and the reason it is
                        recorded at all: the callback in the Nachbearbeitung. Its own data-sync
                        marker, or a value arriving from the iPad would overwrite mid-typing. */}
                    <div className="rz-kontakt-tel" data-sync="kontaktTel">
                      <ClearableInput value={kontaktTel} placeholder={P.kontaktpersonTelefonPlaceholder}
                        aria-label={P.kontaktpersonTelefon}
                        clearLabel={P.kontaktpersonTelefonClear}
                        inputMode="tel" autoComplete="off"
                        onChange={(raw) => { const v = stripUnprintable(raw); setKontaktTel(v); persist({ kontaktpersonTelefon: v.trim() || undefined }) }} />
                      {telHref(kontaktTel) && (
                        <a className="ip-btn rz-call" href={telHref(kontaktTel)}
                          aria-label={P.kontaktpersonCall} title={P.kontaktpersonCall}>
                          <Icon id="phone" />
                        </a>
                      )}
                    </div>
                    {/* only while BOTH halves are empty (30.08.): «Entfällt» beside a typed
                        name contradicted it — the tap would silently wipe real content. Once
                        something is typed, the ✕ is the way back to the empty state. */}
                    {!kontaktperson.trim() && !kontaktTel.trim() && (
                      <button type="button" className="ip-btn"
                        onClick={() => { persist({ kontaktperson: undefined, kontaktpersonTelefon: undefined, kontaktpersonNone: true }) }}>
                        {P.entfaellt}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
            {/* one Kontaktperson carries all contact/ownership details (2026-07-18 —
                the kantonale Eigentümer/Ursache/Verursacher trio was retired: cause is
                not the Feuerwehr's to judge, one contact suffices) */}
            <div className="report-meta-grid">
              <div className="ip-field">
                <span>{P.geretteteLabel}</span>
                {/* two labelled ±steppers (shared Stepper) — tap −/+ or the value to type; matches the
                    details-modal count control. over-object carries the fresh values (state set in the
                    same tick is stale). Empty = null (shows «0» placeholder, − disabled). */}
                <div className="rz-counts">
                  <div className="rz-count" data-sync="geretteteP">
                    <span>{P.gerettetePersonen}</span>
                    <Stepper value={numOrU(geretteteP) ?? null} min={0} max={999} seed={1} placeholder="0" ariaLabel={P.gerettetePersonen}
                      onChange={(v) => { setGeretteteP(String(v)); persist(geretteteOver(String(v), geretteteT)) }}
                      onClear={() => { setGeretteteP(''); persist(geretteteOver('', geretteteT)) }} canClear={geretteteP !== ''} />
                  </div>
                  <div className="rz-count" data-sync="geretteteT">
                    <span>{P.geretteteTiere}</span>
                    <Stepper value={numOrU(geretteteT) ?? null} min={0} max={999} seed={1} placeholder="0" ariaLabel={P.geretteteTiere}
                      onChange={(v) => { setGeretteteT(String(v)); persist(geretteteOver(geretteteP, String(v))) }}
                      onClear={() => { setGeretteteT(''); persist(geretteteOver(geretteteP, '')) }} canClear={geretteteT !== ''} />
                  </div>
                </div>
                {/* ⚠️ «Keine» — the answer an empty pair of steppers could not give (04.09.,
                    Rapport-Review). Empty meant «niemand gerettet» AND «nicht abgeklärt» AND
                    «nicht erfasst» at once on the 03.09. Rapport; with this it means only the
                    last of them.
                    Offered only while BOTH steppers are empty — the rule «Entfällt» follows one
                    field up (30.08.): a «Keine» beside a 3 would contradict itself, and once a
                    number is typed the stepper's ✕ is the way back to empty. Answered, it wears
                    the same dashed `.rz-none-val` the Kontaktperson does: filled in, but by an
                    answer rather than a value — a tick would claim something was counted. */}
                {meta.geretteteNone ? (
                  <div className="rz-none rz-none-trail">
                    <span className="rz-none-val">{P.geretteteNoneHint}</span>
                    {canEdit && (
                      <button type="button" className="ip-btn"
                        onClick={() => persist({ geretteteNone: undefined })}>{P.entfaelltUndo}</button>
                    )}
                  </div>
                ) : canEdit && numOrU(geretteteP) === undefined && numOrU(geretteteT) === undefined ? (
                  <div className="rz-none rz-none-trail">
                    <button type="button" className="ip-btn"
                      onClick={() => persist({ gerettete: undefined, geretteteNone: true })}>
                      {P.geretteteNone}
                    </button>
                  </div>
                ) : null}
                {/* No ✕ here, unlike the Material strip: this one disappears by itself the moment
                    the fields agree with the Lage, so «weg damit» and «stimmt» are the same tap. */}
                {geretteteHint && (
                  <div className="rz-lage-strip" role="status">
                    <span className="rz-lage-text">
                      {fillTemplate(P.geretteteLageStrip, {
                        list: [
                          geretteteHint.personen ? fillTemplate(P.geretteteLagePersonen, { n: geretteteHint.personen }) : '',
                          geretteteHint.tiere ? fillTemplate(P.geretteteLageTiere, { n: geretteteHint.tiere }) : '',
                        ].filter(Boolean).join(' · '),
                      })}
                    </span>
                    <button type="button" className="rz-lage-take"
                      onClick={() => {
                        const p = String(geretteteHint.personen)
                        const t = String(geretteteHint.tiere)
                        setGeretteteP(p); setGeretteteT(t); persist(geretteteOver(p, t))
                      }}>
                      {P.geretteteLageTake}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="report-pre-section report-pre-meta" data-tab="bericht">
            <h3>{P.sectionZeiten}</h3>
            {/* Ausgerückt: derived from the vehicle grid when it exists; the manual field
                only appears on deployments WITHOUT configured vehicles (nothing else to
                derive from). With vehicles configured but no times yet, the grid below is
                the entry point — a duplicate manual field would just contradict it. */}
            {derivedAus ? (
              <label className="ip-field">
                <span>{A.ausgerueckt}</span>
                <div className="report-meta-end rz-derived">
                  <b>{clockOf(derivedAus)}</b>
                  <span className="rz-sub">{P.ausgeruecktDerived}</span>
                </div>
              </label>
            ) : (getDeploymentConfig().fleet?.vehicles ?? []).length === 0 ? (
              <label className="ip-field" data-sync="ausgerueckt">
                <span>{A.ausgerueckt}</span>
                <div className="report-meta-end dtrow">
                  <DateTimeField ariaLabel={A.ausgerueckt} value={dtLocalToIso(ausgerueckt)}
                    onCommit={(iso) => { setAusgerueckt(dtLocalValue(iso ?? undefined)); persist({ ausgeruecktAt: iso ?? undefined }) }} />
                </div>
                {zeitWarn('ausgerueckt')}
              </label>
            ) : null}
            {/* Alarmierungs-/Ausrückzeiten grid — rows from deployment config (empty config
                hides it); webhook-prefilled values, edits stamp `manual` (human wins). */}
            {(() => {
              const gRows = gruppenRows(getDeploymentConfig().alarms?.groups ?? [], gruppen)
              const vRows = fahrzeugRows(getDeploymentConfig().fleet?.vehicles ?? [], fahrzeuge)
              // The grid shows a bare clock, so the calendar day is resolved against the alarm —
              // an Ausrückzeit of 00:15 after an Alarmierung um 23:50 is the NEXT day, and used
              // to land 23h35 before the alarm. Same rule and same day wheel as the Rückmeldung
              // ELZ field below; `day` arrives only on an incident that spans more than one.
              // ⚠️ A LIVE clock, for the same reason the plausibility check above uses one: this
              // list runs from the Alarmierung to «now», and a «now» frozen when the surface
              // mounted stops growing while the surface sits open. An Einsatz that started at
              // 23:50 and is still being written at 00:30 — the ordinary night Einsatz — then
              // offered only the day before, so a clock typed after midnight could not be put on
              // the day it actually happened.
              const zeitDays = incidentDays(meta.startedAt ?? incident.started_at, Date.now())
              const onGruppe = (id: string, hhmm: string, day?: Date) => {
                const iso = zeitFromClock(incident.started_at, hhmm, day)
                const next = setGruppeZeit(gruppen, id, iso)
                setGruppen(next)
                persist({ gruppen: next.length ? next : undefined })
              }
              const onFahrzeug = (id: string, hhmm: string, day?: Date) => {
                const iso = zeitFromClock(incident.started_at, hhmm, day)
                const next = setFahrzeugZeit(fahrzeuge, id, 'ausgerueckt', iso)
                setFahrzeuge(next)
                persist({ fahrzeuge: next.length ? next : undefined, ausgeruecktAt: deriveAusgerueckt(next) ?? dtLocalToIso(ausgerueckt) })
              }
              return (
                <>
                  {gRows.length > 0 && (
                    <div className="ip-field" data-sync="gruppen">
                      <span>{P.gruppenLabel}</span>
                      <div className="rz-grid">
                        {gRows.map(({ config: c, value: v }) => (
                          <label key={c.id} className="rz-row">
                            <span className="rz-name">{c.label}{c.color ? ` (${c.color})` : ''}</span>
                            {/* ⚠️ `valueDay` is not optional here: the day wheel hands a day back
                                on EVERY commit once the incident spans more than one, and without
                                it the picker opens on TODAY — so correcting a Monday Ausrückzeit
                                on Wednesday filed it as Wednesday, on the sheet that becomes the
                                printed Rapport (see TimeField · valueDay). */}
                            <TimeField ariaLabel={c.label} value={clockOf(v?.alarmedAt)} days={zeitDays}
                              valueDay={v?.alarmedAt ? new Date(v.alarmedAt) : undefined}
                              onCommit={(hhmm, day) => onGruppe(c.id, hhmm ?? '', day)} />
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                  {vRows.length > 0 && (
                    <div className="ip-field" data-sync="fahrzeuge">
                      <span>{P.fahrzeugeLabel}</span>
                      <div className="rz-grid">
                        {vRows.map(({ config: c, value: v }) => (
                          <label key={c.id} className="rz-row">
                            <span className="rz-name">
                              {c.label}
                              {(v?.vorOrt || v?.zurueck) && (
                                <span className="rz-sub">
                                  {v?.vorOrt ? ` ${P.vorOrtShort} ${clockOf(v.vorOrt)}` : ''}
                                  {v?.zurueck ? ` · ${P.zurueckShort} ${clockOf(v.zurueck)}` : ''}
                                </span>
                              )}
                            </span>
                            {/* …and the same day for the Ausrückzeit — see the Gruppen row above */}
                            <TimeField ariaLabel={c.label} value={clockOf(v?.ausgerueckt)} days={zeitDays}
                              valueDay={v?.ausgerueckt ? new Date(v.ausgerueckt) : undefined}
                              onCommit={(hhmm, day) => onFahrzeug(c.id, hhmm ?? '', day)} />
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )
            })()}
            {/* (Einsatzende moved down to the Rückmeldung ELZ block — 2026-08-14. The two are
                set in the same breath: you note the end time as you phone the Einsatzleitzentrale.
                Everything left here is the Alarmierung, which is filled in from the other end of
                the Einsatz.) */}
          </section>

          <section className="report-pre-section report-pre-meta" data-tab="bericht">
            <h3>{P.sectionNachbearbeitung}</h3>
            <label className="ip-field" data-sync="remarks">
              <span>{P.remarksLabel}</span>
              <textarea className="ip-textarea" value={remarks} rows={3} placeholder={P.remarksPlaceholder}
                onChange={(e) => { const v = stripUnprintable(e.target.value); setRemarks(v); persist({ remarks: v.trim() || undefined }) }} />
            </label>
            <label className="ip-field" data-sync="lehren">
              <span>{P.lehrenLabel}</span>
              <textarea className="ip-textarea" value={lehren} rows={3} placeholder={P.lehrenPlaceholder}
                onChange={(e) => { const v = stripUnprintable(e.target.value); setLehren(v); persist({ lehren: v.trim() || undefined }) }} />
            </label>
            <div className="report-meta-grid">
              {/* Einsatzende leads the block. ⚠️ It carries `data-step="zeiten"` because it IS
                  the Zeiten step (lib/abschluss · stepDone) — the «Zeiten» chip has to land on
                  the field that makes it go away, not on the Alarmierung grid it used to sit in. */}
              <label className="ip-field" data-step="zeiten" data-sync="endedAt">
                <span>{P.incidentEndLabel}</span>
                <div className="report-meta-end dtrow">
                  <DateTimeField ariaLabel={P.incidentEndLabel} value={dtLocalToIso(endedAt)}
                    onCommit={(iso) => { setEndedAt(dtLocalValue(iso ?? undefined)); persist({ endedAt: iso ?? undefined }) }} />
                  <button type="button" className="ip-btn" onClick={() => { const v = dtLocalValue(new Date().toISOString()); setEndedAt(v); persist({ endedAt: dtLocalToIso(v) }) }}>{P.now}</button>
                </div>
                {zeitWarn('ende')}
              </label>
              {/* ⚠️ `data-step` on the two Rückmeldung fields TOGETHER, never on the grid around
                  them: the grid also holds the Einsatzende, so the chip flashed that too and
                  pointed at a field it has nothing to say about. This is the same mistake
                  `kontaktperson` was split out of `einsatzleiter` for on 11.08. — a step has to
                  name the fields that make it go away and no others. Both halves are inside,
                  because `stepDone` wants the name AND the time (lib/abschluss). */}
              {/* ⚠️ `data-sync` on the BLOCK stands for the name field, which has no wrapper of
                  its own (PersonField takes no class); the Zeit row below carries its own marker
                  and wins for the caret, because `closest` stops at the nearest one. */}
              <div className="rz-rueck" data-step="rueckmeldung" data-sync="rueckName">
                {/* …and the same «Entfällt» the Kontaktperson has, for the Einsatz the ELZ was
                    never told about because there was nothing to tell (an Ölspur, a Fehlalarm).
                    It replaces BOTH halves, because the step wants the name AND the time and
                    neither of them exists. */}
                {meta.rueckmeldungNone ? (
                  <>
                  <div className="ip-field">
                    <span>{P.rueckmeldungLabel}</span>
                    <div className="rz-none">
                      <span className="rz-none-val">{P.entfaellt}</span>
                      <button type="button" className="ip-btn" onClick={() => persist({ rueckmeldungNone: undefined })}>{P.entfaelltUndo}</button>
                    </div>
                  </div>
                  {/* ⚠️ The Zeit row STAYS. «Entfällt» used to collapse three rows into one, and
                      everything below the Rückmeldung jumped up half a card the moment it was
                      pressed — on the screen where the operator is working DOWN a form. The row
                      keeps its place and its label (damped), and its value is the same dash that
                      goes on the paper. The word is not repeated: it was answered once, one line
                      up, and saying it twice reads as two separate answers. */}
                  <div className="ip-field rz-dim">
                    <span>{P.rueckmeldungZeit}</span>
                    {/* punctuation, not language — the accessible name carries the answer */}
                    <span className="rz-none-val rz-none-dash" aria-label={P.entfaellt}>–</span>
                  </div>
                  </>
                ) : (
                  <>
                  {/* who reported back to the ELZ — a roster pick like Einsatzleiter, free text allowed */}
                  <PersonField
                    label={P.rueckmeldungLabel} placeholder={P.rueckmeldungName}
                    value={{ name: rueckName }} onChange={(slot) => {
                      setRueckName(slot.name)
                      persist(rueckOver(slot.name, rueckAt))
                      // ⚠️ `presence`, NOT `el`. Whoever reported back to the ELZ was on scene to
                      // have something to report — that is all this field says. Filed as `el` it
                      // inherited the Einsatzleiter conflict check and warned «X ist Einsatzleiter
                      // und zugleich im Trupp 2» about somebody who had just made a phone call.
                      onRolePicked?.(slot.personId, 'presence')
                    }}
                    personnel={personnel} legacyRoster={[]} presentIds={presentIds}
                    assignedIds={NO_IDS} usedIds={NO_IDS} usedNames={NO_IDS}
                    rolesById={rolesById}
                    // `presence` here too (see onRolePicked above): whoever phoned the ELZ was on
                    // scene, which is all this field says — it does not make them Einsatzleiter.
                    onAddGuest={onAddGuest && ((name) => onAddGuest(name, 'presence'))}
                    rankFirst
                    // «Entfällt» at the END of the name line — the same place the Kontaktperson
                    // carries it, so the two fields that can be answered this way answer it in
                    // one gesture instead of two shapes. It replaces BOTH halves (the step wants
                    // the name AND the time, lib/abschluss), and it is only offered while the
                    // pair is still EMPTY: once something is written down, «entfällt» would
                    // contradict the line right above it.
                    trailing={!rueckName.trim() && !rueckAt ? (
                      <button type="button" className="ip-btn"
                        onClick={() => persist({ rueckmeldungElz: undefined, rueckmeldungNone: true })}>
                        {P.entfaellt}
                      </button>
                    ) : undefined}
                  />
                  <div className="ip-field" data-sync="rueckAt">
                    <span>{P.rueckmeldungZeit}</span>
                    {/* Datum + Zeit, the same control the Einsatzende uses — with «Jetzt» beside it,
                        because the ordinary case is that the call has just been made. */}
                    <div className="report-meta-end dtrow">
                      <DateTimeField ariaLabel={P.rueckmeldungZeit} value={rueckAt}
                        onCommit={(iso) => { setRueckAt(iso ?? ''); persist(rueckOver(rueckName, iso ?? '')) }} />
                      <button type="button" className="ip-btn"
                        onClick={() => { const iso = new Date().toISOString(); setRueckAt(iso); persist(rueckOver(rueckName, iso)) }}>{P.now}</button>
                    </div>
                    {/* the same plausibility hint the Einsatzende carries — this field has a DATE
                        wheel and is usually filled in from memory, so it is the likeliest of the
                        four to land on the wrong day */}
                    {zeitWarn('rueckmeldung')}
                  </div>
                  </>
                )}
              </div>
            </div>
            {/* Partnerorganisationen: WHO was there, from whom, reachable how — and the remark,
                which is the whole reason to write a partner down at all («Wm. Keller, übernimmt
                Verkehr ab Kreisel»). The organisation is offered from the station's list and
                stays free text, because the one that turns up is never the one on the list. */}
          </section>


          </fieldset>
          </div>

          <div className="rp-col rp-col-side">
          {/* Four SECTIONS, not four cards inside a fifth. They used to sit in an unnamed
              `.report-pre-section` wrapper — a box round a box, headed by nothing, while the
              column opposite carried named cards at the top level. Each of these already says
              what it is and how much of it there is, so the wrapper was pure nesting: a border
              weight, a padding, and a rhythm that did not match the form beside it.
              They still belong together and still read in this order (it is the printed one):
              all four answer «wer und was war da», and all four are filled in after the fact. */}
          <div className="rp-checks">
            {/* Rides with «Personal & Mittel» on a phone — it reports on what the poster wrote, which is
                Anwesenheit and Mittel. Hidden by CSS rather than by a wrapper element: the chip
                renders nothing until the first QR write, and an empty wrapper would still cost
                this flex column one gap on every Einsatz that never used the poster. */}
            <CaptureUsageChip usage={captureUsage} />
            <CheckRow
              anchor="anwesenheit" tab="werwas"
              done={stepDone('anwesenheit', facts)}
              label={A.steps.anwesenheit}
              sub={fillTemplate(A.personen, { n: attendanceCount })}
              onGo={onOpenAnwesenheit}
            >
              {/* quick double-check, not an editor: everyone recorded, early leavers
                  flagged inline — corrections go through the row's arrow (Anwesenheit) */}
              {attendanceCount > 0 && (
                <div className="rp-check-extra">
                  <div className="rp-people">
                    {rows.map((r) => (
                      <span key={r.personId} className="rp-person">
                        {r.name}
                        {/* the job they had — «Einsatzleiter», «Fahrer TLF» — read straight off
                            their Bemerkung, the same string the printed Personal-/Anwesenheits-
                            blatt puts under the name. At the end of an Einsatz this list IS the
                            check «wer war da, und als was», so the function belongs on it. */}
                        {(attendance[r.personId]?.note ?? '').trim()
                          && <i>{` · ${(attendance[r.personId]!.note ?? '').trim()}`}</i>}
                        {/* only somebody who actually LEFT gets a time. hoursRows fills an open
                            block with the Einsatzende, which put «· bis 09:00» behind every name
                            on the list — the exception it exists to flag then read as the rule. */}
                        {r.leftEarly && <em>{fillTemplate(A.leftEarly, { t: dtLocalValue(r.to!).slice(11) })}</em>}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </CheckRow>
            <CheckRow anchor="mittel" tab="werwas" done={stepDone('mittel', facts)} label={A.steps.mittel} sub={fillTemplate(A.mittelCount, { n: mittelCount })} onGo={onOpenMittel}>
              {mittelCount > 0 && (
                <div className="rp-check-extra">
                  <div className="rp-people">
                    {/* one line, three weights, same shape as the Anwesenheit list beside it:
                        the amount is the value (bold), the unit and the material are the thing,
                        and where it came from is the dim qualifier — «3 Sack Bindemittel · TLF».
                        It used to set amount AND unit bold and print the Quelle in full ink, so
                        four items read as one wall of equally loud text. */}
                    {visibleMittel(mittel).map((l) => (
                      <span key={l.key} className="rp-person">
                        <b>{l.menge}</b> {l.unit} {l.label}
                        {l.sourceLabel && <i>{` · ${l.sourceLabel}`}</i>}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {mittelCount === 0 && onComplete && (
                <div className="rp-check-extra">
                  <button
                    type="button"
                    className={`ip-btn${meta.mittelConfirmedNone ? ' primary' : ''}`}
                    onClick={() => persist({ mittelConfirmedNone: !meta.mittelConfirmedNone })}
                  >
                    {meta.mittelConfirmedNone ? A.mittelNoneOn : A.mittelNone}
                  </button>
                </div>
              )}
            </CheckRow>
            {/* ⚠️ ABWEICHUNGEN (04.09., Rapport-Review). Until now a divergence between the
                QR-Bogen and a tablet was a «bitte prüfen» line in the Verlauf and nothing else —
                so the 03.09. Rapport was closed at 11:41 with three of them standing, and the
                record could not say whether anybody had looked. It is a step like the seven
                beside it, and like them it blocks nothing.
                The row does not merely ACKNOWLEDGE: it shows both values and asks which one
                holds, so the Rapport ends up with the right answer rather than only with proof
                that somebody read the warning. The card renders only while there is something to
                settle — on the ordinary Einsatz, which never produces a divergence at all, this
                whole block is absent rather than a permanently green row nobody needs. */}
            {conflicts.length > 0 && (
              <CheckRow
                anchor="abweichungen" tab="werwas"
                done={false}
                label={A.steps.abweichungen}
                sub={fillTemplate(C.attendanceConflictOpenCount, { n: conflicts.length })}
              >
                <div className="rp-check-extra rp-conf">
                  {conflicts.map((c) => (
                    <div key={c.sig} className="rp-conf-item">
                      <div className="rp-conf-head">
                        <b>{c.name}</b>
                        <span>{c.what}</span>
                      </div>
                      <div className="rp-conf-sides">
                        {c.sides.map((side, i) => (
                          <div key={i} className="rp-conf-side">
                            <h6>{sideLabel(side)}</h6>
                            {/* the value under the named source: whichever way the label came
                                out, the reader has to see WHAT they are choosing */}
                            <div className="rp-conf-val">{sideValue(side.entry)}</div>
                          </div>
                        ))}
                      </div>
                      {canEdit && onResolveConflict && (
                        <div className="rp-conf-acts">
                          {c.sides.map((side, i) => (
                            <button key={i} type="button" className="ip-btn"
                              onClick={() => onResolveConflict(c, i === 0 ? 0 : 1)}>
                              {fillTemplate(C.attendanceConflictTake, { side: sideLabel(side) })}
                            </button>
                          ))}
                          {/* the third answer, and not a lesser one: the merge may well have
                              landed right, and «geprüft, beide stimmen» is a real finding */}
                          <button type="button" className="ip-btn"
                            onClick={() => onResolveConflict(c, 'both')}>
                            {C.attendanceConflictKeep}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </CheckRow>
            )}
            {/* Partnerorganisationen sit with Anwesenheit and Mittel: all three answer «who and
                what was here», and all three are the parts of the rapport that get filled in
                after the fact. The station's own list is the choice (free text stays possible —
                the one that turns up is not always on it), and one free line beside it carries
                whatever is worth saying: «Wm. Keller, übernimmt Verkehr ab Kreisel». */}
            <CheckRow
              tab="werwas"
              /* ⚠️ the FILLED rows, not `partners.length` — the block always carries two blank
                 free rows, and counting those ticked the step off before anything was recorded */
              done={partners.some(partnerFilled)}
              label={P.partnersLabel}
              sub={partners.some(partnerFilled)
                ? partners.map((p) => p.org).filter(Boolean).join(' · ')
                : P.partnersNone}
            >
              <div className="rp-check-extra">
                {/* own gate: the sheet's main fieldset ends above the checklist, so a viewer or
                    a closed Einsatz would otherwise get fully live controls here.
                    ⚠️ `data-sync` sits on the WHOLE block, «+ Organisation» included: the button
                    adds a blank row that lives on screen and never reaches the blob, so a partner
                    list arriving from another device while the operator is still standing in that
                    row would adopt the row away under them (see useSyncedField). */}
                <fieldset className="report-fieldset rp-check-gate" disabled={!canEdit} data-sync="partners">
                  {/* A CHECKLIST, not a picker: every organisation the station works with is
                      already on the list, so the question is «war die da?» — one tap per row,
                      nothing to search, and an unticked row still proves it was considered.
                      Ticking reveals the one free line («Wm. Keller, Verkehr ab Kreisel»). */}
                  <div className="report-partners">
                    {partnerRows.map((r) => {
                      const on = r.i >= 0
                      return (
                        <div className={cx('report-partner', on && 'on', r.custom && 'free')} key={r.custom ? `c${r.i}` : r.org}>
                          {/* ⚠️ NO tick on a free row. A tick answers «war die da?» about an
                              organisation the list already names — a row somebody added by hand
                              is there BECAUSE it was there, so the box had nothing to ask and
                              unticking it silently deleted the row, a bin disguised as a
                              checkbox right next to the actual bin. It was also unlabelled, so
                              at the narrow breakpoint (where the tick claims the full row width)
                              a free row opened with an empty checkmark on a line of its own and
                              the two fields squeezed underneath — «man kann keine Organisation
                              richtig hinzufügen». Now: the field IS the row. */}
                          {!r.custom && (
                            <button
                              type="button" className="report-partner-tick"
                              role="checkbox" aria-checked={on} aria-label={r.org || P.partnerOrgShort}
                              onClick={() => (on
                                ? savePartners(partners.filter((_, j) => j !== r.i))
                                : savePartners([...partners, { org: r.org }]))}
                            >
                              <span className="report-partner-box">{on && <Icon id="check" />}</span>
                              <span className="report-partner-org">{r.org}</span>
                            </button>
                          )}
                          {/* a free-typed organisation names itself; a listed one is already named */}
                          {on && r.custom && (
                            <ClearableInput
                              className="ip-input" wrapClassName="report-partner-name" value={partners[r.i].org ?? ''}
                              placeholder={P.partnerOrgShort} aria-label={P.partnerOrgShort}
                              clearLabel={P.partnerOrgShort}
                              onChange={(v) => patchPartner(r.i, { org: stripUnprintable(v) })} maxLength={80}
                            />
                          )}
                          {on && (
                            <ClearableInput
                              /* a FREE row shares its line with the Organisation field and the
                                 bin, so the example in the long placeholder gets cut mid-word
                                 («Bemerkung (z. B. ü»). A listed row has the width for it. */
                              className="ip-input" value={partners[r.i].note ?? ''}
                              placeholder={r.custom ? P.partnerNoteShort : P.partnerNote}
                              aria-label={`${r.org || P.partnerOrgShort} – ${P.partnerNoteShort}`}
                              clearLabel={P.partnerNoteShort}
                              onChange={(v) => patchPartner(r.i, { note: stripUnprintable(v) })} maxLength={240}
                            />
                          )}
                          {on && r.custom && (
                            <button
                              type="button" className="report-att-x" aria-label={appConfig.copy.delete}
                              title={appConfig.copy.delete}
                              onClick={() => savePartners(partners.filter((_, j) => j !== r.i))}
                            ><Icon id="trash" /></button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                  {/* the list covers the usual partners; the one that turns up anyway still has
                      to be recordable, so a free row stays available underneath it */}
                  <button type="button" className="report-row-add" onClick={() => savePartners([...partners, { org: '' }])}>
                    <Icon id="plus" /><span>{P.partnerAdd}</span>
                  </button>
                </fieldset>
              </div>
            </CheckRow>
            {/* Beilagen sit right under Partnerorganisationen: same family, same question —
                what else belongs to this rapport. Tapping a thumbnail opens the picture full-size
                (lib/ui · openPhoto), because a 52px square is not something you can check. */}
            <CheckRow
              tab="beilagen"
              done={attachments.length > 0}
              label={P.attachmentsHead}
              sub={attachments.length ? fillTemplate(P.attachmentsCount, { n: attachments.length }) : P.attachmentsNone}
            >
              {/* No explainer paragraph. «Fotos» with «Foto hinzufügen» under it is not a card
                  anybody needs a sentence for, and four lines of prose at the top of a row
                  pushed the pictures themselves below the fold. Same for the links row. */}
              <div className="rp-check-extra">
                {attachments.length > 0 && (
                  <ul className="report-att-list">
                    {attachments.map((a) => (
                      <li key={a.id} className="report-att">
                        <button
                          type="button" className="report-att-thumb" title={P.attachmentsOpen}
                          aria-label={P.attachmentsOpen}
                          onClick={() => openPhoto(a.url, { caption: a.caption, filename: `beilage-${a.id}.jpg` })}
                        >
                          {/* the small copy — a Rapport with twenty Beilagen used to decode
                              twenty full pictures (lib/mediaUrl · thumbUrl) */}
                          <img src={thumbUrl(a.url)} alt="" loading="lazy" decoding="async" />
                        </button>
                        <div className="report-att-body">
                          <input
                            className="ip-input" value={a.caption ?? ''} placeholder={P.attachmentsCaption}
                            aria-label={P.attachmentsCaption} disabled={!onCaptionAttachment}
                            // typed value goes in untouched (trimming on change eats the space
                            // you just pressed); the tidy-up happens once, on leaving the field
                            onChange={(e) => onCaptionAttachment?.(a.id, stripUnprintable(e.target.value))}
                            onBlur={(e) => {
                              const v = e.target.value.trim()
                              if (v !== e.target.value) onCaptionAttachment?.(a.id, v)
                            }}
                          />
                          {a.url.startsWith('blob:') && <span className="report-att-pending">{P.attachmentsPending}</span>}
                        </div>
                        {onRemoveAttachment && (
                          <button type="button" className="report-att-x" aria-label={appConfig.copy.delete}
                            title={appConfig.copy.delete} onClick={() => onRemoveAttachment(a.id)}><Icon id="trash" /></button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {onAddAttachments && (
                  <label className="report-row-add report-att-add">
                    <Icon id="photo" /><span>{P.attachmentsAdd}</span>
                    <input type="file" accept="image/*" multiple
                      onChange={(e) => {
                        const files = [...(e.target.files ?? [])]
                        if (files.length) onAddAttachments(files)
                        e.target.value = ''
                      }} />
                  </label>
                )}
              </div>
            </CheckRow>
            {/* …and under the Beilagen, the station's own paperwork: the Getränkeabrechnung, a
                Schadenmeldung, whatever this Wehr still has to fill in elsewhere. It belongs in
                THIS column because the column's question is «was ist noch offen» — and a form
                that has not been sent is exactly that. It never reaches the paper (the printed
                rapport is the record, not the to-do list), and where a station has configured
                none the whole card is absent rather than empty. */}
            {stationLinks.length > 0 && (
              <CheckRow
                tab="beilagen"
                done={linksDoneCount === stationLinks.length}
                label={P.linksHead}
                sub={fillTemplate(P.linksCount, { done: linksDoneCount, n: stationLinks.length })}
              >
                <div className="rp-check-extra">
                  <div className="rp-links">
                    {stationLinks.map((link) => {
                      const at = linksDone[link.id]
                      return (
                        <div key={link.id} className={cx('rp-link', at && 'on')}>
                          {/* tick + title are ONE target, as on the Partnerorganisationen rows —
                              a 40px checkbox beside a label is a miss waiting to happen */}
                          <button
                            type="button" className="rp-link-tick" disabled={!canEdit}
                            role="checkbox" aria-checked={!!at}
                            aria-label={fillTemplate(at ? P.linksMarkOpen : P.linksMarkDone, { title: link.title })}
                            onClick={() => setLinkDone(link.id, !at)}
                          >
                            <span className="rp-link-box"><Icon id={at ? 'check' : 'minus'} /></span>
                            <span className="rp-link-txt">
                              <span className="rp-link-title">{link.title}</span>
                              {/* the note says WHEN this has to be filled in; once it is done the
                                  row answers the more useful question instead — when it was */}
                              {at
                                ? <span className="rp-link-note">{fillTemplate(P.linksDoneAt, { at: formatDateTime(at) })}</span>
                                : link.note?.trim() && <span className="rp-link-note">{link.note.trim()}</span>}
                            </span>
                          </button>
                          <button type="button" className="rp-link-open" onClick={() => openLink(link)}>
                            <Icon id="external" />{P.linksOpen}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </CheckRow>
            )}
          </div>

          {/* The Kroki, on the page. It was a modal that opened on the press of PDF / Ausdrucken,
              so the crop was chosen blind for the whole time the rapport was being written and
              then decided in a hurry, on top of a surface that had itself just stopped being a
              dialog. It sits at the END of the checklist column, below the rows worked most
              (Anwesenheit, Mittel), which it would otherwise push down by the height of a map.
              Whether a Kroki prints at all is a section, and sections live on the print action
              now — switching it off takes this panel away with it (see krokiPanel).
              No confirm step: whatever the crop shows when PDF or Ausdrucken is pressed is what
              prints, and `startOutput` remembers it as this Einsatz's framing. */}
          {/* No fold. The panel is the only thing on this page that shows what the picture will
              be, and a section that is open every time it is looked at is a section with a
              chevron in front of it for nothing. */}
          {/* ⚠️ On a phone it is MOUNTED only while its own tab is on screen — hiding it with CSS
              is not enough for this one. A MapLibre canvas created inside a `display: none` box
              is created at 0×0: the mount-time `fitBounds` runs against nothing, and when the tab
              is finally opened the map resizes without re-fitting (it is still «following», so
              nothing changed its deps) and reports that over-zoomed crop back as the Einsatz'
              framing. This panel decides what the printed Kroki shows, so a crop nobody chose is
              not a cosmetic bug. Above 600px `isPhone` is false and this is the same always-on
              panel it was. */}
          {krokiPanel && (!isPhone || phoneTab === 'beilagen') && (
            <section className="report-pre-section rp-kroki" data-tab="beilagen">
              <h3>{P.krokiHead}</h3>
              <KrokiFramingPanel
                  scene={effScene}
                  initial={options.krokiView}
                  // WHEN the picture shows. One picture is one Lage at one time; naming the
                  // moment is the honest answer to «die Rettung ist weg», and the map redraws
                  // under the crop as it is reconstructed.
                  atMs={krokiAt}
                  atBusy={krokiAtBusy}
                  onAtChange={setKrokiAt}
                  moments={krokiMoments}
                  startedAtMs={Date.parse(meta.startedAt ?? incident.started_at) || null}
                  landscape={options.krokiLandscape}
                  onLandscapeChange={(v) => patchOpt({ krokiLandscape: v })}
                  // the preview has to show what the sheet will show: the Trupp in a hose's end
                  // tag and the same Beschriftungen setting the export resolves captions under
                  trupps={trupps}
                  captionMode={scene?.captionMode ?? 'auto'}
                  onViewChange={(v) => patchOpt({ krokiView: v })}
                />
            </section>
          )}

          {/* ── Weitergeben ─────────────────────────────────────────────────────────────
              A section of its own (01.09.), and since 04.09. the LAST one on the page. Never on
              paper: the printed Rapport is the record, and «wer darf das hier lesen» is not part
              of it. Absent for a viewer — handing the Einsatzakte out of the station is an
              editor's decision.
              ⚠️ It used to sit between «Formulare & Links» and the Kroki, in the middle of the
              column, where a QR the size of a hand cut the checklist in two and read as a step in
              it. It is not one: handing the Einsatzakte out is what one does AFTER the rapport is
              written, so it closes the page instead of interrupting it. Nothing about the section
              itself changed — same `data-tab`, same surface, same «Teilen» sheet inline. */}
          {canEdit && (
            <section className="report-pre-section rp-share" data-tab="beilagen">
              <h3>{P.shareHead}</h3>
              {/* `archived` because the Rapport is most often opened AFTER the Abschluss, and
                  the Atemschutz link is dead by then — a tab leading to a 404 belongs to nobody. */}
              <ShareIncident incidentId={incident.id} archived={incident.is_archived} />
            </section>
          )}

          </div>
        </div>

        {/* Pinned to the bottom of the surface instead of scrolling away at the end of the form.
            As a sheet the buttons WERE the end of a thing you filled in top to bottom; a page is
            not read that way — the rapport is opened mid-Einsatz to correct one time and print,
            and «PDF» sitting two screens below was the reason for every scroll to the bottom.
            Kontrolle comes with it (it is the row directly above the actions in the print order
            anyway): a warning must be read BEFORE paper is made, and pinning the button without
            pinning the warning would have made it possible to print past one without ever having
            seen it — the same failure the «never behind a fold» rule exists to prevent. */}
      </div>
    </>
  )
}
