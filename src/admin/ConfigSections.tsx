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
        {numField(C.mindestBar, C.mindestBarTip, ['doctrine', 'mindestBar'])}
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
