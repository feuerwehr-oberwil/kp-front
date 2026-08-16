import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { apiGet, apiPut, ApiError } from '../lib/api'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import {
  loadDeploymentConfig,
  applyDeploymentBranding,
  type DeploymentConfig,
} from '../lib/deploymentConfig'

// Shared editing state for the whole Konfiguration ("Station") area. The config is one
// document that the five Station pages each edit a facet of. Edits AUTOSAVE: a change is
// debounced and PUT automatically — there is no manual "Speichern". Dirty-tracking is
// against the last successfully-persisted snapshot, so a server projection that differs
// cosmetically can never wedge the indicator or trigger a save loop.

// ─── nested path helpers ──────────────────────────────────────────────────────

// Immutably set a nested path on the draft, creating intermediate containers as needed.
// Unedited siblings/branches are preserved verbatim (the PUT is a full-document replace).
//
// ⚠️ What a MISSING branch is created as is decided by the next key: a numeric key addresses an
// array element, so the container has to be an array. Creating `{}` for it and then writing key
// `0` produced an object keyed by index — `map.defaultView.center` left this file as
// `{"0": 8.1148}`, where the API requires a list (schemas.py · MapDefaultView), and because the
// PUT replaces the WHOLE document that one 422 also refused every other section's edits.
function setPath(obj: DeploymentConfig, path: (string | number)[], val: unknown): DeploymentConfig {
  const next: any = Array.isArray(obj) ? [...obj] : { ...obj }
  let cur = next
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]
    const child = cur[k]
    cur[k] = child == null
      ? (typeof path[i + 1] === 'number' ? [] : {})
      : Array.isArray(child) ? [...child] : { ...child }
    cur = cur[k]
  }
  cur[path[path.length - 1]] = val
  return next
}

/** Read a nested path (undefined-safe). */
export function getPath<T = unknown>(obj: unknown, path: (string | number)[]): T | undefined {
  let cur: any = obj
  for (const k of path) {
    if (cur == null) return undefined
    cur = cur[k]
  }
  return cur as T | undefined
}

// ─── what the server refused, in the operator's language ──────────────────────

/** Config-document path → the field's own name and the Station page that edits it. Resolved
 *  at call time (never at module level), so a locale switch applies. Only the paths Verwaltung
 *  can actually write are listed; anything else falls back to the dotted path, which still
 *  answers «which field» — unlike an English Pydantic sentence. */
export function rejectedFieldLabel(path: string): string {
  const A = appConfig.copy.admin
  const P = A.nav
  const known: Record<string, { field: string; page: string }> = {
    'identity.appName': { field: A.identity.appName, page: P.identitaet.title },
    'identity.accentColor': { field: A.identity.accentColor, page: P.identitaet.title },
    'identity.locale': { field: A.identity.language, page: P.identitaet.title },
    'identity.kommandant': { field: A.identity.kommandant, page: P.identitaet.title },
    'map.defaultView.zoom': { field: A.map.zoom, page: P.karte.title },
    // the pair AND the block: a bad coordinate reports on `…center`, the "one CRS only" rule
    // on `…defaultView` itself
    'map.defaultView.center': { field: A.map.centerField, page: P.karte.title },
    'map.defaultView': { field: A.map.centerField, page: P.karte.title },
    'journal.quickPhrases': { field: A.journal.quickPhrases, page: P.journal.title },
    'report.hoursRounding': { field: A.report.groupRounding, page: P.rapport.title },
    'report.attendanceMergeGapMin': { field: A.report.mergeGapMin, page: P.rapport.title },
    'report.partnerOrgs': { field: A.report.groupPartners, page: P.rapport.title },
    'report.links': { field: A.report.groupLinks, page: P.rapport.title },
    'fleet.vehicles': { field: A.fleet.groupVehicles, page: P.fahrzeuge.title },
    'alarms.groups': { field: A.alarms.groupGroups, page: P.alarme.title },
    'alarms.webhooks': { field: A.alarms.groupWebhooks, page: P.alarme.title },
    'doctrine': { field: P.doktrin.title, page: P.doktrin.title },
    // No Station page edits these — the Mittel-Katalog is exactly what Sicherung → Import
    // exists for, which makes them the paths MOST likely to be refused and the ones that had
    // no German name at all. Listed with no page, so they read as a plain name.
    'mittel.catalogue': { field: A.backup.fieldMittelCatalogue, page: A.backup.fieldMittelCatalogue },
    'mittel.sources': { field: A.backup.fieldMittelSources, page: A.backup.fieldMittelSources },
    'mittel.units': { field: A.backup.fieldMittelUnits, page: A.backup.fieldMittelUnits },
    // …and the whole SECTIONS, as the last resort before a raw path. A config import is refused
    // (and a config import EMPTIES things) one whole section at a time far more often than one
    // field, and «fleet» is not a word anybody at this station chose.
    'identity': { field: P.identitaet.title, page: P.identitaet.title },
    'map': { field: P.karte.title, page: P.karte.title },
    'fleet': { field: P.fahrzeuge.title, page: P.fahrzeuge.title },
    'roster': { field: P.mannschaft.title, page: P.mannschaft.title },
    'report': { field: P.rapport.title, page: P.rapport.title },
    'journal': { field: P.journal.title, page: P.journal.title },
    // ⚠️ «Alarme & Einsätze», NOT «Alarmierung»: the `alarms` SECTION of the config document is
    // edited on the Station page of that name (Alarmgruppen, the archive clocks, the capture
    // window, the webhooks). `nav.divera` is the Divera intake status page and edits none of it —
    // naming it here sent a reader with a refused import to a page with nothing to fix on it.
    'alarms': { field: P.alarme.title, page: P.alarme.title },
    'referenceLayers': { field: P.ebenen.title, page: P.ebenen.title },
    'modules': { field: P.objektplaene.title, page: P.objektplaene.title },
    'mittel': { field: appConfig.copy.mittel.title, page: appConfig.copy.mittel.title },
  }
  // Longest matching prefix wins, so a row path (`report.links.0.title`) resolves to the
  // editor that owns the row instead of falling through to the raw path.
  const segs = path.split('.')
  for (let n = segs.length; n > 0; n--) {
    const hit = known[segs.slice(0, n).join('.')]
    if (hit) return hit.field === hit.page ? hit.field : `${hit.field} (${hit.page})`
  }
  return path
}

/** Pydantic's error `type` as the one thing a hand-edited file needs to know: what shape was
 *  expected there. Anything unlisted contributes nothing rather than a guess — the field name,
 *  the position and the value that WAS found already carry the answer on their own. */
function expectedShape(kind: string | undefined): string | null {
  const C = appConfig.copy.admin.backup
  if (!kind) return null
  if (kind === 'missing') return C.expectMissing
  if (kind === 'extra_forbidden') return C.expectUnknown
  if (kind.startsWith('string')) return C.expectText
  if (kind.startsWith('list') || kind.startsWith('tuple') || kind.startsWith('set')) return C.expectList
  if (kind.startsWith('dict') || kind.startsWith('model')) return C.expectObject
  if (kind.startsWith('int')) return C.expectInteger
  if (kind.startsWith('float') || kind.startsWith('decimal')) return C.expectNumber
  if (kind.startsWith('bool')) return C.expectBool
  return null
}

/** The value the server actually found there, short enough to read in one line. */
function foundValue(input: unknown): string | null {
  if (input === undefined) return null
  let text: string
  try { text = typeof input === 'string' ? `«${input}»` : JSON.stringify(input) ?? String(input) }
  catch { return null }
  return text.length > 60 ? `${text.slice(0, 57)}…` : text
}

/**
 * A 422 from the config endpoint, one readable German line per refused field.
 *
 * ⚠️ The server already says exactly what is wrong — `loc: ["body","mittel","sources",0]`,
 * `input: "TLF 31"` — and «Konfiguration ungültig (422) – Datei passt nicht zum Schema» threw
 * all of it away. A volunteer importing a Mittel-Katalog (the documented route to the one thing
 * the UI cannot edit) then has nothing to go on but guessing, and guessed three times before
 * finding that `units` are strings and `sources` are objects.
 *
 * So each line names WHICH field, WHICH entry of it, what was expected and what was found —
 * and never the raw Pydantic sentence, which is English.
 */
export function describeRejectedFields(e: ApiError): string[] {
  const C = appConfig.copy.admin.backup
  const lines = (e.fields ?? []).map(({ path, kind, input }) => {
    const segs = path.split('.')
    const isIndex = (s: string) => /^\d+$/.test(s)
    // The LAST index in the path — `report.links.2.title` is «entry 3 of Formulare», and a
    // deeper nesting still points at the row the operator has to find. 1-based, because the
    // file is read by a person: `sources.0` is the FIRST entry.
    const indexes = segs.filter(isIndex)
    const index: string | undefined = indexes[indexes.length - 1]
    const name = rejectedFieldLabel(segs.filter((s) => !isIndex(s)).join('.'))
    const where = index != null ? `${name}, ${fillTemplate(C.invalidEntry, { n: Number(index) + 1 })}` : name
    const what = [expectedShape(kind), foundValue(input) && fillTemplate(C.invalidFound, { value: foundValue(input)! })]
      .filter(Boolean).join(' · ')
    return what ? `${where}: ${what}` : where
  })
  return [...new Set(lines)]
}

/** The 422 the config endpoint answers an invalid document with, as a sentence naming the
 *  field(s). Null for every other failure, which keeps the server's own (German) message —
 *  `ApiError.detail` is only English where FastAPI's validator wrote it (lib/api · fields). */
function describeRejection(e: ApiError): { message: string; hint: string } | null {
  if (!e.fields?.length) return null
  const C = appConfig.copy.admin.autosave
  const names = [...new Set(e.fields.map((f) => rejectedFieldLabel(f.path)))]
  return { message: fillTemplate(C.rejected, { fields: names.join(' · ') }), hint: C.rejectedHint }
}

// ─── context ───────────────────────────────────────────────────────────────────

const AUTOSAVE_DELAY_MS = 700
/** consecutive failures after which the autosave stops trying by itself (see SaveState.halted) */
const MAX_AUTOSAVE_FAILURES = 2

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'ok' }
  /** ⚠️ Somebody else changed the config since this tab loaded it. NOT an error: nothing failed
   *  and nothing is lost — this tab's edits are still in the draft. It is a state that must
   *  STOP the autosave, because the whole point is that a full-document write no longer wins by
   *  default. «Übernehmen» re-sends on top of the newer document; reloading the page takes it. */
  | { kind: 'conflict' }
  /** `halted` = the autosave has GIVEN UP on THIS document and will not re-fire on its own.
   *  Without it the effect below re-ran on every `error → saving → error` cycle: one PUT every
   *  700 ms, for as long as the draft stayed invalid, with the chip flickering so fast the
   *  message could not be read — and «Erneut versuchen» was decorative, because it was already
   *  retrying. The draft is safe in memory either way; halting only stops the hammering.
   *  ⚠️ On THIS document: an edit lifts it (see the effect). Halting on the STATE instead meant
   *  a station that typed one bad coordinate could not save anything again — not the correction,
   *  not the fields on the other pages — without finding the «Erneut versuchen» link first. */
  | { kind: 'error'; message: string; reauth?: boolean; halted?: boolean; hint?: string }

interface ConfigCtx {
  draft: DeploymentConfig | null
  loadError: string | null
  dirty: boolean
  save: SaveState
  /** Set a nested path on the draft (autosaves shortly after). */
  set: (path: (string | number)[], val: unknown) => void
  /** Re-try the last failed autosave now. */
  retry: () => void
  /** REPLACE the draft with a fresh server projection — config import / history restore only.
   *  ⚠️ Discards unsaved edits, so it belongs behind the confirm those two flows already ask
   *  (ConfigBackup · replaceTitle, ConfigHistory · histRestoreConfirm). Anything the server
   *  changed on its own goes through `applyServerAssets`. */
  applyServerConfig: (cfg: DeploymentConfig) => void
  /** Fold the branding slots of a fresh server projection into the draft (logo upload/remove).
   *  ⚠️ NOT a re-seed: see the implementation. */
  applyServerAssets: (cfg: DeploymentConfig) => void
  /** Fold `roster.ranks` of a fresh server projection into the draft — a CSV import that
   *  adopted a new Dienstgrad wrote it server-side. ⚠️ NOT a re-seed either: see below. */
  applyServerRanks: (cfg: DeploymentConfig) => void
}

const Ctx = createContext<ConfigCtx | null>(null)

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<DeploymentConfig | null>(null)
  // Last snapshot we know the server holds — the baseline for dirty + autosave.
  const [saved, setSaved] = useState<DeploymentConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const savingRef = useRef(false)
  //
  // Consecutive failed saves. Two is enough to tell a blip (a dropped connection, a redeploy
  // mid-PUT) from a document the server will keep refusing — and one retry is worth having,
  // because the first class is the common one.
  const failuresRef = useRef(0)
  /** The version of the document the SERVER holds, as last seen. Sent as `If-Match` on every
   *  save (backend · api/config · put_config) so a stale tab is refused rather than obeyed. */
  const versionRef = useRef<string | null>(null)
  /** The document of the last attempt, serialised. Re-sending it unchanged after a refusal is
   *  the hammering `halted` exists to stop; sending it once it has CHANGED is the whole point
   *  of an autosave (see the effect below). */
  const attemptedRef = useRef<string | null>(null)

  useEffect(() => {
    let alive = true
    apiGet<DeploymentConfig>('/api/config')
      .then((cfg) => {
        if (!alive) return
        const safe = cfg && typeof cfg === 'object' ? cfg : {}
        versionRef.current = safe.version ?? null
        setDraft(safe)
        setSaved(safe)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setLoadError(e instanceof ApiError ? e.detail : appConfig.copy.admin.autosave.loadFailed)
      })
    return () => { alive = false }
  }, [])

  const dirty = useMemo(() => {
    if (!saved || !draft) return false
    return JSON.stringify(saved) !== JSON.stringify(draft)
  }, [saved, draft])

  // Persist a specific draft snapshot. Dirty/baseline is tracked against `sent` itself
  // (not the server echo), so the indicator settles even if the projection normalises.
  const persist = useCallback(async (sent: DeploymentConfig) => {
    savingRef.current = true
    // An edited document earns a fresh pair of attempts: the previous failures were a verdict
    // on the old one, and the field the server refused may be exactly the one just corrected.
    const json = JSON.stringify(sent)
    if (json !== attemptedRef.current) failuresRef.current = 0
    attemptedRef.current = json
    setSave({ kind: 'saving' })
    // integrations is env-derived / read-only; symbols (quickPick) was dropped from the
    // app. Strip both before the full-document PUT so neither is ever re-sent.
    const { integrations: _ignore, symbols: _dropSymbols, ...payload } =
      sent as DeploymentConfig & { symbols?: unknown }
    let echo: DeploymentConfig | undefined
    try {
      echo = await apiPut<DeploymentConfig>(
        '/api/config', payload,
        // omitted only on a document this tab has never read a version for — a fresh, unwritten
        // station, where there is nothing to conflict with
        versionRef.current ? { 'If-Match': versionRef.current } : undefined,
      )
    } catch (e: unknown) {
      savingRef.current = false
      if (e instanceof ApiError) {
        // ⚠️ 409 = the stored document moved on. Stop autosaving and SAY so — the old behaviour
        // (a full-document PUT that always won) is exactly how a tab left open all morning
        // reverted a station's Dienstgrade, Partnerorganisationen and Atemschutz-Doktrin in one
        // write. The draft is kept; re-reading the version lets «Übernehmen» land on top.
        // 428 = this PAGE predates the guard and sent no version at all (api/config · put_config).
        // Same treatment: stop autosaving and say so. «Übernehmen» works because the fresh read
        // below gives this tab the token it was missing — which is also why the message says
        // «neu laden» rather than «nochmals versuchen».
        if (e.status === 409 || e.status === 428) {
          setSave({ kind: 'conflict' })
          try {
            const fresh = await apiGet<DeploymentConfig>('/api/config')
            versionRef.current = fresh.version ?? null
          } catch { /* offline → «Übernehmen» will fail loudly, which is honest */ }
          return
        }
        const reauth = e.status === 401 || e.status === 403
        // A 4xx is a verdict on the DOCUMENT, not a blip: re-sending the identical body cannot
        // produce a different answer, so it gives up at once rather than burning a second
        // attempt on it. (429 excepted — waiting is exactly what that one asks for.)
        const refused = e.status >= 400 && e.status < 500 && e.status !== 429
        // German for the field the server named, where it named one — `detail` is FastAPI's
        // own English prose («Input should be a valid list»), which is what a volunteer setting
        // up a station was shown.
        const rejection = describeRejection(e)
        failuresRef.current += 1
        setSave({
          kind: 'error',
          message: reauth
            ? appConfig.copy.admin.autosave.sessionExpired
            : rejection?.message ?? e.detail,
          reauth,
          // a dead session cannot be retried into life, so that one gives up at once
          halted: reauth || refused || failuresRef.current >= MAX_AUTOSAVE_FAILURES,
          // the instruction, not just the diagnosis — at 3am the instruction is the point
          hint: rejection?.hint ?? e.hint,
        })
      } else {
        failuresRef.current += 1
        setSave({
          kind: 'error',
          message: appConfig.copy.admin.autosave.saveFailed,
          halted: failuresRef.current >= MAX_AUTOSAVE_FAILURES,
        })
      }
      return
    }
    // Release the lock BEFORE the state updates, so the autosave effect re-runs (on the
    // new `saved`) and picks up any edits made while this save was in flight.
    savingRef.current = false
    versionRef.current = echo?.version ?? versionRef.current
    // ⚠️ The branding slots come back from the SERVER, which owns them (api/config · _keep_assets):
    // they are written by the upload endpoints and by `admin_branding push`, never typed here, so
    // a draft loaded before a logo was installed carries stale nulls. Folding the echo's assets
    // into both sides keeps this tab showing the logo that actually exists — and keeps `saved`
    // equal to `draft`, so the dirty check still settles instead of re-saving forever.
    const assets = echo?.identity?.assets
    const merged = assets ? { ...sent, identity: { ...(sent.identity ?? {}), assets } } : sent
    setSaved(merged)
    if (merged !== sent) setDraft((d) => (d ? { ...d, identity: { ...(d.identity ?? {}), assets } } : d))
    failuresRef.current = 0
    setSave({ kind: 'ok' })
    // Best-effort: re-resolve the singleton + re-apply branding so title/accent update
    // live. A failure here must not flip the (already successful) save to an error.
    try {
      applyDeploymentBranding(await loadDeploymentConfig())
    } catch { /* branding refresh is non-critical */ }
  }, [])

  // Debounced autosave: fire AUTOSAVE_DELAY_MS after the last edit. A save already in
  // flight defers — its completion bumps `saved`, re-running this with any trailing edits.
  useEffect(() => {
    if (loadError || !draft || !saved) return
    // a refused save must not re-fire on its own — that would be the silent overwrite again,
    // one debounce later. It waits for «Übernehmen» (retry).
    if (save.kind === 'conflict') return
    const json = JSON.stringify(draft)
    if (json === JSON.stringify(saved)) return
    // ⚠️ A refused document must not be re-sent UNCHANGED — that is the 700 ms hammering the
    // halt exists for. An EDIT, though, is new information: freezing on `halted` alone meant
    // that after a rejected map centre, everything typed afterwards — including the second
    // coordinate the operator could SEE on screen — never reached the server at all, and only
    // «Erneut versuchen» ever sent it. So the halt lasts exactly as long as the document does.
    if (save.kind === 'error' && save.halted && json === attemptedRef.current) return
    if (savingRef.current) return
    const t = setTimeout(() => { void persist(draft) }, AUTOSAVE_DELAY_MS)
    return () => clearTimeout(t)
  }, [draft, saved, loadError, persist, save])

  const set = (path: (string | number)[], val: unknown) => {
    setDraft((d) => setPath(d ?? {}, path, val))
  }

  const retry = () => {
    if (!draft || savingRef.current) return
    failuresRef.current = 0 // a deliberate press earns the same two attempts again
    void persist(draft)
  }

  const applyServerConfig = (cfg: DeploymentConfig) => {
    const safe = cfg && typeof cfg === 'object' ? cfg : {}
    versionRef.current = safe.version ?? versionRef.current
    setDraft(safe)
    setSaved(safe)
    setSave({ kind: 'idle' })
    applyDeploymentBranding(safe)
  }

  /**
   * A logo upload changed ONE thing on the server: the branding slots. It answers with the whole
   * document anyway, and taking that answer as the new draft is how a setup session lost its
   * work — App-Name, Markenfarbe and Kommandant were typed but not yet saved, the upload
   * re-seeded the editor from the server's nulls, `saved` was re-seeded with the same nulls, and
   * the badge therefore went GREEN over three fields the server had never been told about. The
   * values even stayed legible on screen for a moment, because `identity` was re-rendered from a
   * document that no longer had them.
   *
   * So only what the server owns is folded in — `identity.assets` (api/config · _keep_assets) —
   * into BOTH sides: the draft keeps every local edit, `saved` keeps the stored assets, and the
   * autosave carries on with a draft that is still honestly dirty.
   */
  const applyServerAssets = (cfg: DeploymentConfig) => {
    const assets = cfg?.identity?.assets ?? null
    versionRef.current = cfg?.version ?? versionRef.current
    const fold = (c: DeploymentConfig | null) =>
      c ? { ...c, identity: { ...(c.identity ?? {}), assets } } : c
    setDraft(fold)
    setSaved(fold)
    // branding is re-applied from the DRAFT (the accent colour on screen), not from the server
    // document — which would flash the old colour back until the pending save lands
    applyDeploymentBranding(fold(draft) ?? cfg)
  }

  /**
   * The same problem as `applyServerAssets`, for the other section this app writes behind the
   * editor's back: a CSV import that adopts a Dienstgrad writes `roster.ranks` on the server
   * (backend · personnel.adopt_ranks), because on a station that has no list of its own that
   * import is the only place a rank list can come into existence at all.
   *
   * ⚠️ Leaving the draft alone would arm the clobber this whole guard exists for. The tab now
   * holds a document without those ranks AND an outdated version token: the next unrelated edit
   * on this page is refused with 409, and «Übernehmen» — which re-sends on top of the newer
   * document — would put the empty rank list back. So the ranks and the version are folded into
   * BOTH sides (draft keeps every local edit, `saved` stays the honest baseline).
   */
  const applyServerRanks = (cfg: DeploymentConfig) => {
    const ranks = cfg?.roster?.ranks
    if (!ranks) return
    versionRef.current = cfg?.version ?? versionRef.current
    const fold = (c: DeploymentConfig | null) =>
      c ? { ...c, roster: { ...(c.roster ?? {}), ranks } } : c
    setDraft(fold)
    setSaved(fold)
  }

  const value: ConfigCtx = {
    draft, loadError, dirty, save, set, retry, applyServerConfig, applyServerAssets, applyServerRanks,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useConfig(): ConfigCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useConfig must be used within ConfigProvider')
  return v
}

/** Gate that shows a load/error state until the config draft is ready. */
export function ConfigGate({ children }: { children: ReactNode }) {
  const { draft, loadError } = useConfig()
  if (loadError) return <div className="adm-state adm-state-err">{loadError}</div>
  if (!draft) return <div className="adm-state">{appConfig.copy.admin.common.configLoading}</div>
  return <>{children}</>
}

/** Compact autosave indicator — replaces the manual save bar across the Station pages. */
export function ConfigAutosaveStatus() {
  const { save, dirty, draft, retry } = useConfig()
  const C = appConfig.copy.admin.autosave
  if (!draft) return null
  // ⚠️ Its own state, ahead of `error`: nothing failed, and this page's edits are still here.
  // What it must do is STOP looking like a page that saves by itself, because the one thing
  // that must not happen next is this tab writing its hour-old document over the newer one.
  if (save.kind === 'conflict') {
    return (
      // ⚠️ The hint is RENDERED, not a `title=`. «Übernehmen schreibt die Änderungen dieser Seite
      // darüber» is the only warning that the button beside it is a clobber, and a tooltip needs a
      // pointer to hover with — on the tablet this app is built for there is none, so the one
      // sentence that makes the choice an informed one was unreachable exactly where the guard
      // matters most. Same shape as the error branch below, which already renders its hint.
      <span className="adm-autosave warn">
        <span className="adm-autosave-dot" aria-hidden />
        <span className="adm-autosave-msg">
          {C.conflict}
          <em className="adm-autosave-hint">{C.conflictHint}</em>
        </span>
        <button type="button" className="adm-autosave-retry" onClick={retry}>{C.conflictApply}</button>
      </span>
    )
  }
  // ⚠️ `dirty`, not just the kind: a refused edit that has been TAKEN BACK (the operator
  // cleared the value or typed the old one back) leaves the draft equal to the stored
  // document again. There is nothing left to fail on, and nothing left to retry — so the
  // banner has to stop saying otherwise, or the page reads as broken until it is reloaded.
  if (save.kind === 'error' && dirty) {
    return (
      <span className="adm-autosave err" title={save.hint ?? undefined}>
        <span className="adm-autosave-dot" aria-hidden />
        <span className="adm-autosave-msg">
          {save.message}
          {/* the INSTRUCTION, where the API sent one (lib/api · ApiError.hint). The message says
              what went wrong; the hint says what to do about it, and it was being thrown away. */}
          {save.hint && <em className="adm-autosave-hint">{save.hint}</em>}
        </span>
        {/* Only offered once the autosave has actually stopped. While it is still retrying by
            itself the button did nothing a wait would not, which is how it came to read as
            broken. A dead session halts at once and cannot be retried into life — say so
            instead of offering an action that must fail. */}
        {save.halted && !save.reauth && (
          <button type="button" className="adm-autosave-retry" onClick={retry}>{C.retry}</button>
        )}
      </span>
    )
  }
  if (save.kind === 'saving') {
    return <span className="adm-autosave busy"><span className="adm-autosave-dot" aria-hidden />{C.saving}</span>
  }
  if (dirty) {
    return <span className="adm-autosave busy"><span className="adm-autosave-dot" aria-hidden />{C.pending}</span>
  }
  return <span className="adm-autosave ok"><span className="adm-autosave-dot" aria-hidden />{C.saved}</span>
}
