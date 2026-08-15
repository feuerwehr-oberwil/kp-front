import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DeploymentConfig, DeploymentFleet } from '../lib/deploymentConfig'
import { legacyFleetToAttributeLists, DEFAULT_MODULES } from '../lib/deploymentConfig'
import { listReference, listObjects, type ReferenceDataset, type ObjectWithPlans } from '../lib/incidents'
import { useConfig, getPath } from './ConfigContext'
import { Card, Field, Select } from './ui'
import { AVAILABLE_LOCALES } from '../config/copy'
import { ReferenceLayersViewer } from './ReferenceLayersViewer'
import { FleetAttributesViewer } from './FleetAttributesViewer'
import { ModulesViewer } from './ModulesViewer'
import { ObjectsView, GeodataView } from './DataView'
import { BrandingFields } from './BrandingFields'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { DEFAULT_HOURS_ROUNDING, fmtHours, roundedMinutes } from '../lib/attendanceHours'
import { DEFAULT_ATTENDANCE_MERGE_GAP_MIN } from '../lib/attendanceIntervals'
import {
  isOpenableUrl, linkTokenValues, resolveLinkUrl, REPORT_LINK_TOKENS,
  type ReportLink, type ReportLinkFacts,
} from '../lib/reportLinks'
import { Icon } from '../lib/icons'
import { StringList } from './StringList'

// The five "Station" pages. Each edits one facet of the single config document via the
// shared ConfigContext (draft + Save live in the provider, not here). Section-level help
// that merely repeated the caption was dropped; field-level tips stay where they teach.

// Number-field value → store. Empty input becomes `null` (NOT 0), so clearing a field
// never silently writes a zero doctrine value.
function numOrNull(raw: string): number | null {
  if (raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}
function numStr(v: number | null | undefined): string {
  return v == null ? '' : String(v)
}

export function IdentitySection() {
  const { draft, set, applyServerConfig } = useConfig()
  const C = appConfig.copy.admin.identity
  return (
    <>
    <Card>
      <div className="adm-row-2">
        <Field label={C.appName} tip={C.appNameTip}>
          <input
            className="adm-input"
            type="text"
            value={getPath<string>(draft, ['identity', 'appName']) ?? ''}
            onChange={(e) => set(['identity', 'appName'], e.target.value || null)}
            placeholder="KP Front"
          />
        </Field>
        <Field
          label={C.accentColor}
          hint={C.accentColorHint}
          tip={C.accentColorTip}
        >
          <div className="adm-color-row">
            <input
              className="adm-color-swatch"
              type="color"
              value={getPath<string>(draft, ['identity', 'accentColor']) ?? '#e8392b'}
              onChange={(e) => set(['identity', 'accentColor'], e.target.value)}
              aria-label={C.pickAccentColor}
            />
            <input
              className="adm-input adm-input-mono"
              type="text"
              value={getPath<string>(draft, ['identity', 'accentColor']) ?? ''}
              onChange={(e) => set(['identity', 'accentColor'], e.target.value || null)}
              placeholder="#e8392b"
            />
          </div>
        </Field>
      </div>
      <div className="adm-row-2">
        <Field
          label={C.language}
          hint={C.languageHint}
          tip={C.languageTip}
        >
          <Select
            value={getPath<string>(draft, ['identity', 'locale']) ?? 'de-CH'}
            onChange={(v) => set(['identity', 'locale'], v)}
            options={AVAILABLE_LOCALES.map((l) => ({ value: l.id, label: l.label }))}
            ariaLabel={C.pickLanguage}
          />
        </Field>
        <Field label={C.kommandant} tip={C.kommandantTip}>
          <input
            className="adm-input"
            type="text"
            value={getPath<string>(draft, ['identity', 'kommandant']) ?? ''}
            onChange={(e) => set(['identity', 'kommandant'], e.target.value || null)}
          />
        </Field>
      </div>
      <BrandingFields
        assets={getPath<DeploymentConfig['identity']>(draft ?? {}, ['identity'])?.assets}
        onApplied={applyServerConfig}
      />
    </Card>
    <MapSection />
    </>
  )
}

export function MapSection() {
  const { draft, set } = useConfig()
  const C = appConfig.copy.admin.map
  return (
    <Card title={appConfig.copy.admin.nav.karte.title}>
      <div className="adm-row-2">
        <Field label={C.centerLon} tip={C.centerLonTip}>
          <input
            className="adm-input adm-input-mono"
            type="number"
            step="any"
            value={numStr(getPath<number>(draft, ['map', 'defaultView', 'center', 0]))}
            onChange={(e) => set(['map', 'defaultView', 'center', 0], numOrNull(e.target.value))}
          />
        </Field>
        <Field label={C.centerLat} tip={C.centerLatTip}>
          <input
            className="adm-input adm-input-mono"
            type="number"
            step="any"
            value={numStr(getPath<number>(draft, ['map', 'defaultView', 'center', 1]))}
            onChange={(e) => set(['map', 'defaultView', 'center', 1], numOrNull(e.target.value))}
          />
        </Field>
      </div>
      <Field label={C.zoom} tip={C.zoomTip}>
        <input
          className="adm-input adm-input-mono"
          type="number"
          step="any"
          value={numStr(getPath<number>(draft, ['map', 'defaultView', 'zoom']))}
          onChange={(e) => set(['map', 'defaultView', 'zoom'], numOrNull(e.target.value))}
        />
      </Field>
    </Card>
  )
}

export function JournalSection() {
  const { draft, set } = useConfig()
  const C = appConfig.copy.admin.journal
  // Empty deployment config means the national defaults are effective. Seed the textarea
  // with those actual values (not placeholder text), so editing one line preserves the rest.
  const [raw, setRaw] = useState<string>(
    () => {
      const configured = getPath<string[]>(draft, ['journal', 'quickPhrases']) ?? []
      return (configured.length > 0 ? configured : appConfig.journal.quickPhrases).join('\n')
    },
  )
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.72))}px`
  }, [raw])
  return (
    <Card title={C.quickPhrases} caption={C.quickPhrasesTip}>
      <Field label={C.quickPhrases} tip={C.quickPhrasesTip}>
        <textarea
          ref={textareaRef}
          className="adm-input adm-textarea adm-textarea-tall"
          rows={16}
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value)
            const lines = e.target.value.split('\n').map((l) => l.trim()).filter(Boolean)
            set(['journal', 'quickPhrases'], lines)
          }}
        />
      </Field>
    </Card>
  )
}

export function DoctrineSection() {
  const { draft, set } = useConfig()
  const C = appConfig.copy.admin.doctrine
  type DoctrineKey = keyof DeploymentConfig['doctrine'] & keyof typeof appConfig.atemschutz
  const doctrineValue = (key: DoctrineKey) =>
    getPath<number>(draft, ['doctrine', key]) ?? appConfig.atemschutz[key]
  // A doctrine number field, wired to its config path. A plain JSX helper (NOT a nested
  // component) so the inputs reconcile in place and never remount/lose focus mid-typing.
  // Grouped by type below so related knobs (Funk / Druck / Kontakt) sit together.
  const numField = (label: string, tip: string, path: (string | number)[]) => (
    <Field label={label} tip={tip}>
      <input
        className="adm-input adm-input-mono"
        type="number"
        step="any"
        value={numStr(path[0] === 'doctrine' ? doctrineValue(path[1] as DoctrineKey) : getPath<number>(draft, path))}
        onChange={(e) => set(path, numOrNull(e.target.value))}
      />
    </Field>
  )
  return (
    <Card>
      <h3 className="adm-fieldgroup">{C.groupFunk}</h3>
      <div className="adm-row-3">
        {numField(C.defaultFunkkanal, C.defaultFunkkanalTip, ['doctrine', 'defaultFunkkanal'])}
        {numField(C.funkkanalMin, C.funkkanalMinTip, ['doctrine', 'funkkanalMin'])}
        {numField(C.funkkanalMax, C.funkkanalMaxTip, ['doctrine', 'funkkanalMax'])}
      </div>

      <h3 className="adm-fieldgroup">{C.groupPressure}</h3>
      <div className="adm-row-2">
        {numField(C.defaultPressure, C.defaultPressureTip, ['doctrine', 'defaultPressureBar'])}
        {numField(C.alarmBar, C.alarmBarTip, ['doctrine', 'alarmBar'])}
      </div>
      <div className="adm-row-2">
        {numField(C.pressureStep, C.pressureStepTip, ['doctrine', 'pressureStep'])}
        {numField(C.pressureMax, C.pressureMaxTip, ['doctrine', 'pressureMax'])}
      </div>

      <h3 className="adm-fieldgroup">{C.groupContact}</h3>
      <div className="adm-row-2">
        {numField(C.contactInterval, C.contactIntervalTip, ['doctrine', 'contactIntervalMin'])}
        {numField(C.contactGrace, C.contactGraceTip, ['doctrine', 'contactGraceSec'])}
      </div>

      {/* The air estimate's two inputs. The app has read them from the config all along and the
          card says «geschätzt mit 7 L Flasche und 50 L/min», which reads like a station setting —
          it wasn't one, because the backend dropped both fields on save and there was nowhere to
          type them. A 9-litre cylinder is an ordinary thing for a Wehr to own. */}
      <h3 className="adm-fieldgroup">{C.groupAir}</h3>
      <p className="adm-hint">{C.airTip}</p>
      <div className="adm-row-2">
        {numField(C.cylinderLiters, C.cylinderLitersTip, ['doctrine', 'cylinderLiters'])}
        {numField(C.estConsumption, C.estConsumptionTip, ['doctrine', 'estConsumptionLPerMin'])}
      </div>

      {/* Optional station colour per Auftrag. Empty = the default behaviour, where a Trupp's
          colour means IDENTITY (every Trupp a different one from the palette). Filling a row in
          says «read this Lage by role» — every Löschtrupp red — and the EL can still override any
          single Trupp. Left as swatches, not a free colour input: these have to be the SAME ten
          colours the Trupp form and the plan chip offer, or the picture stops agreeing with
          itself. */}
      <h3 className="adm-fieldgroup">{C.groupAuftragColors}</h3>
      <p className="adm-hint">{C.auftragColorsTip}</p>
      {appConfig.atemschutz.auftrag.map((a) => {
        const value = getPath<string>(draft, ['doctrine', 'auftragColors', a.id])
        return (
          <Field key={a.id} label={appConfig.copy.atemschutz.auftragLabels[a.id] ?? a.label}>
            <div className="adm-colorrow">
              <button
                type="button" className={`adm-swatch-auto${value ? '' : ' on'}`} aria-pressed={!value}
                onClick={() => set(['doctrine', 'auftragColors', a.id], null)}
              >{appConfig.copy.atemschutz.colorAuto}</button>
              {appConfig.drawing.teamColors.map((c) => (
                <button
                  key={c} type="button" className={`dh-color${value === c ? ' on' : ''}`} style={{ background: c }}
                  aria-pressed={value === c} aria-label={c}
                  onClick={() => set(['doctrine', 'auftragColors', a.id], value === c ? null : c)}
                />
              ))}
            </div>
          </Field>
        )
      })}
    </Card>
  )
}

export function FleetSection() {
  const { draft } = useConfig()
  const fleet = getPath<DeploymentFleet>(draft, ['fleet'])
  // Read-only viewer. The effective attribute lists are the configured `attributeLists`, with a
  // pre-migration config (the old fixed fields) shown as its migrated equivalent. Editing happens
  // in the station configuration via the `admin_config` CLI, not here.
  const lists = fleet?.attributeLists ?? legacyFleetToAttributeLists(fleet)
  return (
    <Card>
      <FleetAttributesViewer lists={lists} />
    </Card>
  )
}

export function LayersSection() {
  const { draft } = useConfig()
  const C = appConfig.copy.admin.layers
  // Read-only. The loaded reference datasets (geo:*, via `admin_geodata load`) give each configured
  // layer a load-status AND are listed in full below (the merged Geodaten view). Editing the layers
  // happens via the `admin_geodata` CLI, not here. Optional fetch — silent on failure.
  const [datasets, setDatasets] = useState<ReferenceDataset[]>([])
  useEffect(() => {
    let alive = true
    void listReference().then((rows) => { if (alive) setDatasets(rows) }).catch(() => { /* status is a nicety */ })
    return () => { alive = false }
  }, [])
  return (
    <>
      <Card>
        <ReferenceLayersViewer layers={draft?.referenceLayers ?? []} datasets={datasets} />
      </Card>
      <h3 className="adm-view-subhead">{C.datasetsTitle}</h3>
      <GeodataView />
    </>
  )
}

export function ModulesSection() {
  const { draft } = useConfig()
  const C = appConfig.copy.admin.modules
  // Read-only. The imported objects drive both the per-module coverage stats (in ModulesViewer)
  // and the object map below. Editing the module catalogue happens via the `admin_config` CLI.
  const [objects, setObjects] = useState<ObjectWithPlans[]>([])
  useEffect(() => {
    let alive = true
    void listObjects().then((rows) => { if (alive) setObjects(rows) }).catch(() => { /* coverage is a nicety */ })
    return () => { alive = false }
  }, [])
  // A deployment that doesn't override `modules` runs on the national defaults — show those as the
  // in-force catalogue (with a note), not an empty state.
  const configured = draft?.modules ?? []
  const usingDefaults = configured.length === 0
  const modules = usingDefaults ? DEFAULT_MODULES : configured
  return (
    <>
      <Card>
        <ModulesViewer modules={modules} objects={objects} usingDefaults={usingDefaults} />
      </Card>
      <h3 className="adm-view-subhead">{C.objectsTitle}</h3>
      <ObjectsView />
    </>
  )
}

/**
 * Rapport → Rundung. The one setting on this page changes what the Gemeinde is billed, and it
 * lived in a JSON blob reachable only through the CLI. It is shown with a worked example rather
 * than a description: the printed rapport deliberately does NOT carry the rule (it is identical
 * on every sheet a station produces — see docs/CONFIGURATION.md §1b), so this page is the one
 * place somebody can see what the two numbers actually do before changing them.
 */
export function ReportSection() {
  const { draft, set } = useConfig()
  const C = appConfig.copy.admin.report
  const stepMin = getPath<number>(draft, ['report', 'hoursRounding', 'stepMin']) ?? DEFAULT_HOURS_ROUNDING.stepMin
  const graceMin = getPath<number>(draft, ['report', 'hoursRounding', 'graceMin']) ?? DEFAULT_HOURS_ROUNDING.graceMin
  // the three durations from the docs' own worked example, run through the LIVE rule
  const sample = [67, 23, 178]
  const rule = { stepMin, graceMin }
  const raw = sample.map((m) => fmtHours(m)).join(' · ')
  const rounded = fmtHours(sample.reduce((n, m) => n + roundedMinutes(m, rule), 0))
  return (
    <Card>
      <h3 className="adm-fieldgroup">{C.groupRounding}</h3>
      <p className="adm-hint">{C.roundingTip}</p>
      <div className="adm-row-2">
        <Field label={C.stepMin} tip={C.stepMinTip}>
          <input
            className="adm-input adm-input-mono" type="number" min={1} max={480} step={1}
            value={numStr(getPath<number>(draft, ['report', 'hoursRounding', 'stepMin']))}
            placeholder={String(DEFAULT_HOURS_ROUNDING.stepMin)}
            onChange={(e) => set(['report', 'hoursRounding', 'stepMin'], numOrNull(e.target.value))}
          />
        </Field>
        <Field label={C.graceMin} tip={C.graceMinTip}>
          <input
            className="adm-input adm-input-mono" type="number" min={0} max={479} step={1}
            value={numStr(getPath<number>(draft, ['report', 'hoursRounding', 'graceMin']))}
            placeholder={String(DEFAULT_HOURS_ROUNDING.graceMin)}
            onChange={(e) => set(['report', 'hoursRounding', 'graceMin'], numOrNull(e.target.value))}
          />
        </Field>
      </div>
      <Field label={C.example}>
        <p className="adm-hint">{fillTemplate(C.exampleHint, { raw, rounded })}</p>
      </Field>

      {/* The other number that decides what the Personalblatt says about a person's time. It
          belongs beside the rounding rather than in its own card: both are the station's
          convention for turning a recorded presence into a printed figure. */}
      <h3 className="adm-fieldgroup">{C.groupMerge}</h3>
      <p className="adm-hint">{C.mergeTip}</p>
      <div className="adm-row-2">
        <Field label={C.mergeGapMin} tip={C.mergeGapMinTip}>
          <input
            className="adm-input adm-input-mono" type="number" min={0} max={240} step={1}
            value={numStr(getPath<number>(draft, ['report', 'attendanceMergeGapMin']))}
            placeholder={String(DEFAULT_ATTENDANCE_MERGE_GAP_MIN)}
            onChange={(e) => set(['report', 'attendanceMergeGapMin'], numOrNull(e.target.value))}
          />
        </Field>
      </div>

      {/* Partnerorganisationen — printed as an Ankreuz-Zeile on the Rapport AND on the paper
          Erfassungsblatt (admin/capturePdf). It sat in the config document with no editor, so a
          Wehr could not add one without a JSON file and a terminal. */}
      <h3 className="adm-fieldgroup">{C.groupPartners}</h3>
      <p className="adm-hint">{C.partnersTip}</p>
      <StringList
        ariaLabel={C.groupPartners}
        value={getPath<string[]>(draft, ['report', 'partnerOrgs']) ?? []}
        onChange={(next) => set(['report', 'partnerOrgs'], next)}
        placeholder={C.partnerAddPlaceholder}
      />

      <h3 className="adm-fieldgroup">{C.groupLinks}</h3>
      <p className="adm-hint">{C.linksTip}</p>
      <ReportLinksEditor />
    </Card>
  )
}

/** The Einsatz the link PREVIEW is resolved against — a plausible one, so an admin can read
 *  what a placeholder will turn into without having to open a real incident. */
const SAMPLE_LINK_FACTS: ReportLinkFacts = {
  stichwort: 'Brand Gebäude',
  ort: 'Musterstrasse 3',
  alarmiertAt: '2026-08-14T19:42:00Z',
  endedAt: '2026-08-14T21:05:00Z',
  einsatzleiter: 'Hans Muster',
  kontaktperson: 'Anna Meier',
  kurzbericht: 'Küchenbrand, durch Kleinlöschgerät gelöscht.',
  wehr: 'Feuerwehr Musterdorf',
}

/**
 * «Formulare & Links» — the station's own paperwork as rows on the Rapport (lib/reportLinks).
 *
 * The workflow this is shaped around: in Google Forms press «Link zum Vorausfüllen abrufen»,
 * type sample values, paste the link here — then swap the sample values for placeholders. The
 * chips insert a placeholder AT THE CURSOR, so nobody has to remember their names, and the
 * preview underneath resolves the whole URL against a sample Einsatz: a typo shows up as a
 * `{platzhalter}` still standing in the preview, which is the only way to catch one before an
 * Einsatz does.
 */
function ReportLinksEditor() {
  const { draft, set } = useConfig()
  const C = appConfig.copy.admin.report
  // Array.isArray, not `?? []`: the document can also be written by the `admin_config` CLI
  // straight into the DB, and a hand-edited `links: {}` would otherwise white-screen this page
  // on `.map` — the one config surface somebody would go to in order to FIX that.
  const raw = getPath<ReportLink[]>(draft, ['report', 'links'])
  const stored = Array.isArray(raw) ? raw : []
  // The rows as they are being EDITED — the stored ones plus any that are not finished yet.
  // Null until the first edit, so a config arriving from elsewhere still shows through.
  const [editing, setEditing] = useState<ReportLink[] | null>(null)
  const rows = editing ?? stored
  // the URL field a chip inserts into: the one that was focused last. Held as an element ref
  // rather than an index, because the insert needs its live selection anyway.
  const urlRef = useRef<HTMLTextAreaElement | null>(null)
  // ⚠️ The empty list is written as `[]`, NOT as `null`. `report.links` is a plain
  // `list[ReportLinkConfig]` on the backend (schemas.py), so a `null` fails validation — and
  // because Verwaltung PUTs the WHOLE document, that 422 does not just refuse the deletion:
  // the null stays in the draft and every later edit on every Station page 422s with it, in a
  // 700 ms autosave retry loop, until the tab is reloaded (which throws the edit away). The
  // «a cleared section should look untouched» idea was void anyway — `model_dump` fills the
  // default, so every saved document carries `"links": []` whatever we send.
  const write = (next: ReportLink[]) => {
    setEditing(next)
    // ⚠️ Only COMPLETE rows reach the config document. «Link hinzufügen» necessarily creates an
    // empty row, and the backend refuses a blank title or a non-http URL (schemas.py) — so
    // writing the half-typed row straight into the draft made the whole document invalid. Not
    // just this page: Verwaltung PUTs the WHOLE config, so one empty row 422'd every other
    // Station page too, and the autosave re-sent it every 700 ms until the tab was reloaded.
    // The row stays on screen and keeps its warning («erscheint nicht auf dem Rapport») until
    // it is worth saving; the same predicate `reportLinks()` uses decides that, so what the
    // preview promises and what gets stored cannot drift apart.
    set(['report', 'links'], next.filter((l) => !!l.title?.trim() && isOpenableUrl(l.url ?? '')))
  }
  const patch = (i: number, over: Partial<ReportLink>) =>
    write(rows.map((r, j) => (j === i ? { ...r, ...over } : r)))

  const insertToken = (i: number, token: string) => {
    const row = rows[i]
    const el = urlRef.current
    const url = row?.url ?? ''
    // ⚠️ Matched by link ID, never by row index. The ref is deliberately not cleared on blur
    // (pressing a chip blurs the field, which is the whole point of holding it), so after a row
    // above this one is deleted it still points at a DETACHED textarea — one that, matched by
    // index, would answer to the row that moved up into its place. The token then went in at
    // the caret of a different URL, usually mid-host, and the focus/caret restore silently did
    // nothing because the node was no longer in the document.
    const live = el && el.dataset.id === row?.id && el.isConnected ? el : null
    // nothing focused → append, which is what a chip pressed straight after pasting asks for
    const at = live ? (live.selectionStart ?? url.length) : url.length
    patch(i, { url: `${url.slice(0, at)}{${token}}${url.slice(at)}` })
    if (live) {
      const caret = at + token.length + 2
      requestAnimationFrame(() => { live.focus(); live.setSelectionRange(caret, caret) })
    }
  }

  return (
    <>
      {rows.map((row, i) => {
        const preview = resolveLinkUrl(row.url ?? '', linkTokenValues(SAMPLE_LINK_FACTS))
        return (
          <div className="adm-formlink" key={row.id}>
            <div className="adm-formlink-head">
              <Field label={C.linkTitle}>
                <input
                  className="adm-input" type="text" value={row.title ?? ''}
                  placeholder={C.linkTitlePlaceholder}
                  onChange={(e) => patch(i, { title: e.target.value })}
                />
              </Field>
              <button
                type="button" className="adm-formlink-x" title={C.linkRemove} aria-label={C.linkRemove}
                onClick={() => write(rows.filter((_, j) => j !== i))}
              >
                <Icon id="trash" />
              </button>
            </div>
            <Field label={C.linkNote}>
              <input
                className="adm-input" type="text" value={row.note ?? ''}
                placeholder={C.linkNotePlaceholder}
                onChange={(e) => patch(i, { note: e.target.value || null })}
              />
            </Field>
            <Field label={C.linkUrl} tip={C.linkUrlTip}>
              <textarea
                className="adm-input adm-input-mono adm-formlink-url" rows={3} value={row.url ?? ''}
                placeholder={C.linkUrlPlaceholder} data-id={row.id}
                onFocus={(e) => { urlRef.current = e.currentTarget }}
                onChange={(e) => patch(i, { url: e.target.value })}
              />
            </Field>
            <div className="adm-formlink-tokens" role="group" aria-label={C.linkTokens}>
              {REPORT_LINK_TOKENS.map((t) => (
                <button type="button" key={t} className="adm-token" onClick={() => insertToken(i, t)}>
                  {`{${t}}`}
                </button>
              ))}
            </div>
            {/* What the Rapport will actually open — and, where it would not, WHY.
                ⚠️ This warns on exactly the conditions `reportLinks()` drops a row on, title
                included. Checking only the URL let an admin paste a link, see a correct green
                preview, save without a title, and get a row that never appears on any Rapport
                while Verwaltung said it was fine. */}
            <Field label={C.linkPreview}>
              {isOpenableUrl(preview) && !!row.title?.trim()
                ? <p className="adm-formlink-preview">{preview}</p>
                : (
                  <p className="adm-hint adm-formlink-warn">
                    {row.title?.trim() ? C.linkPreviewNone : C.linkPreviewNoTitle}
                  </p>
                )}
            </Field>
          </div>
        )
      })}
      <button
        type="button" className="adm-formlink-add"
        onClick={() => write([...rows, { id: `lnk${Date.now()}-${rows.length}`, title: '', url: '' }])}
      >
        <Icon id="plus" />{C.linkAdd}
      </button>
    </>
  )
}
