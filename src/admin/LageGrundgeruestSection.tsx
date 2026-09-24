import { useState } from 'react'
import { useConfig, getPath } from './ConfigContext'
import { ConfirmButton, RecordRows, RecordTable, Select, SettingRow, SettingsNote, SettingsSheet, standardNote } from './ui'
import { Segmented, OnOff } from '../components/Segmented'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { Icon } from '../lib/icons'
import { useSymbols } from '../lib/useSymbols'
import { sanitizeSvg } from '../lib/sanitizeSvg'
import {
  CATEGORY_LABELS, DEFAULT_PRESET, presetSlots,
  type LageGrundgeruestConfig, type LageGrundgeruestPresets, type LageSlot,
} from '../lib/lageGrundgeruest'

/**
 * /admin › Lage-Grundgerüst — the station's `lageGrundgeruest` block (backend
 * schemas.LageGrundgeruestConfig, docs/CONFIGURATION.md §1e).
 *
 * Station doctrine, so it is edited HERE and nowhere in the Einsatz (AGENTS.md · «a setting lives
 * in one of three places»). The page is the shipped preset plus the Einsatzarten the station
 * replaced: a tab per Einsatzart, and the list of that tab is either the preset's (shown as it is,
 * editable — the first edit copies it into the station's own list) or the station's own, with
 * «Auf Preset zurücksetzen» to drop it again. The same save and version guard as every other
 * Station page: the shared draft, the full-document autosave with `If-Match` (ConfigContext).
 *
 * ⚠️ Rows that are not finished (no label, no symbol/line, metres out of range) stay on screen
 * with a warning and are NOT written: the backend refuses them, and the PUT carries the whole
 * document — one half-typed row would 422 every other page's edits in the autosave retry loop.
 * The same rule AlarmGroupsEditor follows.
 */

type Kind = 'none' | 'hydrant' | 'wind'

/** The row as it is being edited — a slot, possibly not yet valid. */
type Draft = LageSlot

const TAB_FIRST = ['brandbekaempfung', 'bma_unechte_alarme', 'strassenrettung', 'chemiewehr', 'oelwehr', 'elementarereignis']

const WIND_MIN = 5
const WIND_MAX = 2000
const DEFAULT_WIND_M = 40

function kindOf(s: Draft): Kind {
  if (s.vorschlag?.naechster === 'hydrant') return 'hydrant'
  if (s.vorschlag?.wind === 'auf') return 'wind'
  return 'none'
}

/** why a row is not stored, or null when it is fine to write */
function problem(s: Draft): string | null {
  const C = appConfig.copy.admin.lageGrundgeruest
  if (!s.label?.trim() || (!s.symbol && !s.linie)) return C.incomplete
  if (kindOf(s) === 'wind') {
    const m = s.vorschlag?.m
    if (m == null || !Number.isInteger(m) || m < WIND_MIN || m > WIND_MAX) return fillTemplate(C.metresInvalid, { min: WIND_MIN, max: WIND_MAX })
  }
  return null
}

/** the shape the document stores — no nulls, no `optional: false`, no suggestion on a line */
function clean(s: Draft): LageSlot {
  const out: LageSlot = { id: s.id, label: s.label.trim() }
  if (s.symbol) out.symbol = s.symbol
  else if (s.linie) out.linie = s.linie
  const k = kindOf(s)
  if (s.symbol && k === 'hydrant') out.vorschlag = { naechster: 'hydrant' }
  if (s.symbol && k === 'wind') out.vorschlag = { wind: 'auf', m: s.vorschlag!.m! }
  if (s.optional) out.optional = true
  return out
}

/** A list compared as the backend reads it, so a spelled-out copy of the preset is not «angepasst». */
const sameList = (a: readonly LageSlot[] | undefined, b: readonly LageSlot[] | undefined) =>
  JSON.stringify((a ?? []).map(clean)) === JSON.stringify((b ?? []).map(clean))

/** a slot id from a label — ASCII, lower case, unique in its list */
function slotId(label: string, taken: Set<string>): string {
  const base = label.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'element'
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return id
}

export function LageGrundgeruestSection() {
  const { draft, set } = useConfig()
  const C = appConfig.copy.admin.lageGrundgeruest
  const sym = useSymbols()

  const block = getPath<LageGrundgeruestConfig>(draft, ['lageGrundgeruest']) ?? {}
  const presets = (getPath<LageGrundgeruestPresets>(draft, ['lageGrundgeruestPresets']) ?? {}) as LageGrundgeruestPresets
  const preset = block.preset || DEFAULT_PRESET
  // ⚠️ a plain object check, not `?? {}`: a hand-edited `kategorien: []` must not white-screen
  // the one page somebody would come to in order to fix it
  const own: Record<string, LageSlot[]> = block.kategorien && typeof block.kategorien === 'object' && !Array.isArray(block.kategorien)
    ? block.kategorien : {}
  const shipped = presets[preset]?.kategorien ?? presets[DEFAULT_PRESET]?.kategorien ?? {}
  // the design's order — the Einsatzarten a Grundgerüst matters most for first — then the rest
  const order = [...TAB_FIRST, ...Object.keys(CATEGORY_LABELS).filter((k) => !TAB_FIRST.includes(k))]
  const cats = order.filter((k) => k in shipped || k in own)
  const customized = Object.keys(own).filter((k) => !sameList(own[k], shipped[k]))

  const [cat, setCat] = useState<string>(cats[0] ?? 'brandbekaempfung')
  const shown = cats.includes(cat) ? cat : (cats[0] ?? 'brandbekaempfung')
  const isOwn = Object.prototype.hasOwnProperty.call(own, shown) && Array.isArray(own[shown])
  const stored: LageSlot[] = isOwn ? own[shown] : (presetSlots(presets, preset, shown) ?? [])

  // the rows as they are being EDITED — null until the first edit, so a config arriving from
  // elsewhere (another tab, a CLI push) still shows through. Keyed by Einsatzart.
  const [editing, setEditing] = useState<{ cat: string; rows: Draft[] } | null>(null)
  const rows: Draft[] = editing?.cat === shown ? editing.rows : stored
  const [open, setOpen] = useState<number | null>(null)

  const writeKategorien = (next: Record<string, LageSlot[]>) => set(['lageGrundgeruest', 'kategorien'], next)

  const write = (next: Draft[]) => {
    const taken = new Set<string>()
    const withIds = next.map((r) => {
      const id = r.id && !taken.has(r.id) ? r.id : slotId(r.label || '', taken)
      taken.add(id)
      return { ...r, id }
    })
    setEditing({ cat: shown, rows: withIds })
    writeKategorien({ ...own, [shown]: withIds.filter((r) => problem(r) === null).map(clean) })
  }
  const patch = (i: number, over: Partial<Draft>) => write(rows.map((r, j) => (j === i ? { ...r, ...over } : r)))
  const move = (i: number, by: -1 | 1) => {
    const j = i + by
    if (j < 0 || j >= rows.length) return
    const next = [...rows]
    ;[next[i], next[j]] = [next[j], next[i]]
    write(next)
    setOpen((o) => (o === i ? j : o === j ? i : o))
  }
  const resetToPreset = () => {
    const { [shown]: _gone, ...rest } = own
    setEditing(null); setOpen(null)
    writeKategorien(rest)
  }
  const addCategory = (k: string) => {
    if (!k) return
    writeKategorien({ ...own, [k]: [] })
    setEditing(null); setOpen(null); setCat(k)
  }

  // the picker: the line presets first (a Zufahrt is a line, not a symbol), then the pack
  const targetOptions = [
    { value: '', label: C.targetPick },
    ...appConfig.drawing.linePresets.slice(1).map((p) => ({ value: `linie:${p.label}`, label: fillTemplate(C.targetLine, { linie: p.label }) })),
    ...sym.symbols.map((s) => ({ value: `symbol:${s.name}`, label: `${s.cat} · ${s.name}` })),
  ]
  const targetValue = (r: Draft) => (r.linie ? `linie:${r.linie}` : r.symbol ? `symbol:${r.symbol}` : '')
  const setTarget = (i: number, v: string) => {
    if (v.startsWith('linie:')) patch(i, { linie: v.slice(6), symbol: undefined, vorschlag: undefined })
    else if (v.startsWith('symbol:')) patch(i, { symbol: v.slice(7), linie: undefined })
  }
  const setKind = (i: number, k: Kind) => patch(i, {
    vorschlag: k === 'hydrant' ? { naechster: 'hydrant' } : k === 'wind' ? { wind: 'auf', m: rows[i].vorschlag?.m ?? DEFAULT_WIND_M } : undefined,
  })

  const summary = (r: Draft): string => {
    const parts: string[] = [r.linie ? fillTemplate(C.metaLine, { linie: r.linie }) : (r.symbol ?? '')]
    const k = kindOf(r)
    if (r.symbol && k === 'hydrant') parts.push(C.metaHydrant)
    if (r.symbol && k === 'wind') parts.push(fillTemplate(C.metaWind, { m: r.vorschlag?.m ?? '' }))
    if (r.optional) parts.push(C.metaOptional)
    return parts.filter(Boolean).join(' · ')
  }

  const status = fillTemplate(C.status, {
    preset,
    n: customized.length === 0 ? C.customizedNone : customized.length === 1 ? C.customizedOne : fillTemplate(C.customizedMany, { n: customized.length }),
  })
  const missing = order.filter((k) => !cats.includes(k))

  return (
    <>
      <SettingsSheet title={C.presetTitle} tip={C.presetTip}>
        <SettingRow label={C.presetLabel} tip={C.presetLabelTip} standard={standardNote(preset, DEFAULT_PRESET)}>
          <Select
            value={preset}
            onChange={(v) => set(['lageGrundgeruest', 'preset'], v)}
            ariaLabel={C.presetLabel}
            options={Object.entries(presets).map(([name, p]) => ({ value: name, label: p.beschreibung ? `${name} — ${p.beschreibung}` : name }))}
          />
        </SettingRow>
      </SettingsSheet>

      <RecordTable
        title={fillTemplate(C.listTitle, { kategorie: CATEGORY_LABELS[shown] ?? shown })}
        tip={C.listTip}
        caption={status}
        recordLabel={C.recordLabel}
      >
        <div className="agg-tabs">
          <Segmented<string>
            value={shown}
            onChange={(k) => { setCat(k); setEditing(null); setOpen(null) }}
            ariaLabel={C.categoriesAria}
            options={cats.map((k) => ({
              value: k,
              title: CATEGORY_LABELS[k],
              label: <>{C.tabShort[k] ?? CATEGORY_LABELS[k]}{customized.includes(k) && <span className="agg-dot" aria-label={C.customizedMark} />}</>,
            }))}
          />
          {missing.length > 0 && (
            <span className="agg-addcat">
              <Select
                value=""
                onChange={addCategory}
                ariaLabel={C.addCategory}
                options={[{ value: '', label: C.addCategory }, ...missing.map((k) => ({ value: k, label: CATEGORY_LABELS[k] }))]}
              />
            </span>
          )}
        </div>

        <SettingsNote>
          <span className="agg-origin">
            {isOwn ? C.customized : fillTemplate(C.fromPreset, { preset })}
            {isOwn && shown in shipped && (
              <ConfirmButton label={C.reset} question={C.resetConfirm} onConfirm={resetToPreset} />
            )}
          </span>
        </SettingsNote>

        {rows.length === 0 && <SettingsNote>{C.emptyList}</SettingsNote>}
        {rows.map((r, i) => {
          const warn = problem(r)
          const glyph = r.symbol ? sym.byName[r.symbol] : undefined
          const editingRow = open === i
          return (
            // index key: a row's identity is its place in the list, and every value in it is
            // controlled from `rows` anyway (AlarmGroupsEditor · the same reasoning)
            <RecordRows
              key={i}
              name={r.label?.trim() || C.newLabel}
              meta={(
                <span className="agg-meta">
                  <span className="adm-view-glyph agg-glyph" aria-hidden>
                    {glyph
                      ? <span dangerouslySetInnerHTML={{ __html: sanitizeSvg(glyph) }} />
                      : <Icon id={r.linie ? 'pen' : 'hex'} />}
                  </span>
                  <span>{summary(r) || C.targetPick}</span>
                </span>
              )}
              action={(
                <>
                  <button type="button" className="agg-btn" aria-label={C.up} title={C.up} disabled={i === 0} onClick={() => move(i, -1)}>
                    <Icon id="chevron-down" className="agg-up" />
                  </button>
                  <button type="button" className="agg-btn" aria-label={C.down} title={C.down} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
                    <Icon id="chevron-down" />
                  </button>
                  <button type="button" className={`agg-btn${editingRow ? ' on' : ''}`} aria-pressed={editingRow}
                    aria-label={editingRow ? C.done : C.edit} title={editingRow ? C.done : C.edit}
                    onClick={() => setOpen(editingRow ? null : i)}>
                    <Icon id={editingRow ? 'check' : 'pen'} />
                  </button>
                  <ConfirmButton
                    className="adm-formlink-x" ariaLabel={C.remove} label={<Icon id="trash" />}
                    question={C.removeConfirm} danger
                    onConfirm={() => { setOpen(null); write(rows.filter((_, j) => j !== i)) }}
                  />
                </>
              )}
            >
              {editingRow && (
                <>
                  <SettingRow label={C.fieldLabel} tip={C.fieldLabelTip}>
                    <input className="adm-input" type="text" value={r.label ?? ''} placeholder={C.fieldLabelPlaceholder}
                      onChange={(e) => patch(i, { label: e.target.value })} />
                  </SettingRow>
                  <SettingRow label={C.fieldTarget} tip={C.fieldTargetTip}>
                    <Select value={targetValue(r)} onChange={(v) => setTarget(i, v)} ariaLabel={C.fieldTarget} options={targetOptions} />
                  </SettingRow>
                  {r.symbol && (
                    <SettingRow label={C.fieldVorschlag} tip={C.fieldVorschlagTip}>
                      <Segmented<Kind> value={kindOf(r)} onChange={(k) => setKind(i, k)} ariaLabel={C.fieldVorschlag}
                        options={[
                          { value: 'none', label: C.vorschlagNone },
                          { value: 'hydrant', label: C.vorschlagHydrant },
                          { value: 'wind', label: C.vorschlagWind },
                        ]} />
                    </SettingRow>
                  )}
                  {r.symbol && kindOf(r) === 'wind' && (
                    <SettingRow label={C.fieldMetres} tip={C.fieldMetresTip}>
                      <input className="adm-input agg-metres" type="text" inputMode="numeric"
                        value={r.vorschlag?.m == null ? '' : String(r.vorschlag.m)}
                        onChange={(e) => {
                          const raw = e.target.value.trim()
                          const m = raw === '' ? null : Number(raw)
                          patch(i, { vorschlag: { wind: 'auf', m: m != null && Number.isFinite(m) ? m : null } })
                        }} />
                    </SettingRow>
                  )}
                  <SettingRow label={C.fieldOptional} tip={C.fieldOptionalTip}>
                    <OnOff value={!!r.optional} onChange={(v) => patch(i, { optional: v || undefined })} ariaLabel={C.fieldOptional} />
                  </SettingRow>
                </>
              )}
              {warn && <SettingsNote tone="warn">{warn}</SettingsNote>}
            </RecordRows>
          )
        })}
        <button
          type="button" className="adm-formlink-add"
          onClick={() => { write([...rows, { id: '', label: '' }]); setOpen(rows.length) }}
        >
          <Icon id="plus" />{C.add}
        </button>
      </RecordTable>
    </>
  )
}
