import { useState } from 'react'
import { appConfig } from '../config/appConfig'
import { Icon } from '../lib/icons'
import { categoryId, categoryLabel, INK, isCategoryColor, writableRules, type ObjectCategoryRule, type ObjectKind } from '../lib/karte/categories'
import { getPath, useConfig } from './ConfigContext'
import { TEXT_MAX_LENGTH, tooLongNote } from './configGuards'
import { useStoredRows } from './useStoredRows'
import { ConfirmButton, RecordRows, RecordTable, SettingRow, SettingsNote } from './ui'

// «Objektfarben» — the station's colours for its objects on «Karte & Objekte»
// (`map.objectCategories`, lib/karte/categories; backend schemas.py · ObjectCategoryConfig).
// Ordered rules, first match wins; a rule names the object kinds and/or plan modules (globs) it
// takes. A colour is a #rrggbb or «Tinte» (`ink`: the default look, near-black by day, near-white
// at night — owner, 25.10.2026). A row the server would refuse — no name, neither colour — stays on
// screen with its reason and is not written, like every list editor in the Verwaltung; a stored
// rule past a bound stays in the save as stored (useStoredRows).

const HEX = /^#[0-9a-fA-F]{6}$/
const KINDS: ObjectKind[] = ['einsatzobjekt', 'objekt'] // «depot» is retired (lib/karte/categories)
const NEW_COLOR = '#64748b'
/** what an `ink` category looks like here: the token the Karte draws it with */
const INK_SWATCH = 'var(--obj-plans)'
const MODULE_MAX = TEXT_MAX_LENGTH['map.objectCategories.0.match.modules.0']
const chars = (s: string | undefined) => [...(s ?? '')].length
/** The globs of the modules box. A glob typed past the schema's length is cut to it, the way
 *  `maxLength` holds a box – by code point, as pydantic counts, so «🚒» is never split into half a
 *  character the API refuses. While the rule still holds a stored glob past it (`before`), the box
 *  cuts nothing: the row's warning names the glob until the admin shortens it, and the save keeps
 *  the stored rule (useStoredRows). A glob the admin did not touch keeps its string from `before`:
 *  the box shows it without line breaks, so a token is matched against it as shown. */
const parseModules = (text: string, before: readonly string[]) => {
  const cut = before.every((m) => chars(m) <= MODULE_MAX)
  const shown = (m: string) => m.replace(/[\r\n]/g, '')
  return text.split(',').map((raw, k) => {
    // the box shows `before` joined by «, », so a token after the first starts with that space
    const token = k > 0 && raw.startsWith(' ') ? raw.slice(1) : raw
    const m = raw.trim()
    return before.find((b) => shown(b) === token) ?? (cut ? [...m].slice(0, MODULE_MAX).join('') : m)
  }).filter(Boolean)
}

export function ObjectCategoriesCard() {
  const { draft, set } = useConfig()
  const C = appConfig.copy.admin.map
  const K = appConfig.copy.karte.kind
  const raw = getPath(draft, ['map', 'objectCategories'])
  const stored = Array.isArray(raw) ? raw : []
  const [editing, setEditing] = useState<ObjectCategoryRule[] | null>(null)
  // A row's key is its index, and a rule has no stable id (it follows the name). So a move, a
  // delete or an add gives every row a new key: an armed «Löschen?» is dropped instead of staying
  // at its index and deleting the rule that moved there.
  const [layout, setLayout] = useState(0)
  const rows = editing ?? stored
  const { edited, saved, keptOriginals } = useStoredRows(stored, writableRules, (r) => chars(r.id) > TEXT_MAX_LENGTH['map.objectCategories.0.id']
    || (r.match?.modules ?? []).some((m) => chars(m) > MODULE_MAX))

  const write = (next: ObjectCategoryRule[]) => {
    setEditing(next)
    set(['map', 'objectCategories'], saved(next))
  }
  const reshape = (next: ObjectCategoryRule[]) => { setLayout((n) => n + 1); write(next) }
  const patch = (i: number, over: Partial<ObjectCategoryRule>) => write(rows.map((r, j) => (j === i ? edited(r, { ...r, ...over }) : r)))
  /** a German name edits the German entry of a per-language label, and leaves the others */
  const setName = (i: number, name: string) => {
    const r = rows[i]
    const label = typeof r.label === 'object' && r.label ? { ...r.label, de: name } : name
    const others = rows.filter((_, j) => j !== i).map((x) => x.id)
    // the id follows the name while it is still the one derived from it (a rule being named);
    // a rule whose id was set otherwise (the CLI, an import) keeps it
    const auto = !r.id || r.id === categoryId(categoryLabel(r.label, 'de', ''), others)
    patch(i, { label, id: auto ? categoryId(name, others) : r.id })
  }
  const move = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= rows.length) return
    const next = [...rows]
    ;[next[i], next[j]] = [next[j], next[i]]
    reshape(next)
  }

  /** …and the bounds `writableRules` holds a rule to: the name derives a short id and the box cuts
   *  each glob, so only a stored rule (the CLI, an import) can be past one. `stored`: the wording
   *  for a stored original (useStoredRows · keptOriginals). */
  const lengthNote = (r: ObjectCategoryRule, stored = false) => tooLongNote([
    ['map.objectCategories.0.id', C.catId, r.id],
    ...(r.match?.modules ?? []).map((m) => ['map.objectCategories.0.match.modules.0', C.catModules, m] as const),
  ], stored)
  const kept = keptOriginals(rows)
  return (
    <RecordTable title={C.groupCategories} tip={C.categoriesTip} recordLabel={C.colCategory}>
      {rows.length === 0 && <SettingsNote>{C.categoriesEmpty}</SettingsNote>}
      {rows.map((row, i) => {
        const name = categoryLabel(row.label, 'de', '')
        const kinds = row.match?.kinds ?? []
        const modules = row.match?.modules ?? []
        const ink = row.color === INK
        const other = !name.trim() ? C.catNoName : !isCategoryColor(row.color) ? C.catBadColor : null
        // a rule the save replaces by its stored original blocks every save until it is fixed: the
        // field still too long in the edit, else the original's, beside any other reason
        const original = kept.get(row)
        const problems = (original ? [other, lengthNote(row, true) ?? lengthNote(original, true)] : [other ?? lengthNote(row)])
          .filter((p) => p !== null)
        return (
          <RecordRows
            key={`${layout}:${i}`}
            name={name || appConfig.copy.admin.common.newEntry}
            swatch={ink ? INK_SWATCH : HEX.test(row.color) ? row.color : null}
            meta={row.id ? <code>{row.id}</code> : undefined}
            action={(
              <span className="adm-cat-actions">
                <button type="button" className="adm-formlink-x mv" title={C.catUp} aria-label={C.catUp} disabled={i === 0} onClick={() => move(i, -1)}><Icon id="chevron-up" /></button>
                <button type="button" className="adm-formlink-x mv" title={C.catDown} aria-label={C.catDown} disabled={i === rows.length - 1} onClick={() => move(i, 1)}><Icon id="chevron-down" /></button>
                <ConfirmButton
                  className="adm-formlink-x" ariaLabel={C.catRemove} label={<Icon id="trash" />}
                  question={C.catRemoveConfirm} danger
                  onConfirm={() => reshape(rows.filter((_, j) => j !== i))}
                />
              </span>
            )}
          >
            <SettingRow label={C.catName}>
              <input className="adm-input" type="text" value={name} placeholder={C.catNamePlaceholder} onChange={(e) => setName(i, e.target.value)} />
            </SettingRow>
            <SettingRow label={C.catColor} tip={C.catColorTip}>
              <div className="adm-color-row">
                {/* «Tinte» is chosen here; a picked or typed hex leaves it */}
                <button type="button" className="adm-token adm-cat-ink" aria-pressed={ink} title={C.catInkTip}
                  onClick={() => patch(i, { color: INK })}>
                  <span className="adm-rec-swatch" style={{ background: INK_SWATCH }} aria-hidden />{C.catInk}
                </button>
                <input className="adm-color-swatch" type="color" value={HEX.test(row.color) ? row.color.toLowerCase() : NEW_COLOR}
                  onChange={(e) => patch(i, { color: e.target.value })} aria-label={C.catColor} />
                <input className="adm-input adm-input-mono" type="text" value={ink ? '' : row.color} placeholder={ink ? C.catInk : NEW_COLOR}
                  aria-label={C.catColorHex} onChange={(e) => patch(i, { color: e.target.value.trim() })} />
              </div>
            </SettingRow>
            <SettingRow label={C.catKinds} tip={C.catKindsTip}>
              <span className="adm-cat-kinds" role="group" aria-label={C.catKinds}>
                {KINDS.map((k) => {
                  const on = kinds.includes(k)
                  return (
                    <button key={k} type="button" className="adm-token" aria-pressed={on}
                      onClick={() => patch(i, { match: { ...row.match, kinds: on ? kinds.filter((x) => x !== k) : [...kinds, k] } })}>
                      {on && <Icon id="check" />}{K[k]}
                    </button>
                  )
                })}
              </span>
            </SettingRow>
            <SettingRow label={C.catModules} tip={C.catModulesTip}>
              <input className="adm-input adm-input-mono" type="text" value={modules.join(', ')} placeholder={C.catModulesPlaceholder}
                onChange={(e) => patch(i, { match: { ...row.match, modules: parseModules(e.target.value, modules) } })} />
            </SettingRow>
            {problems.map((p) => <SettingsNote key={p}><span className="adm-state adm-state-err">{p}</span></SettingsNote>)}
          </RecordRows>
        )
      })}
      <SettingsNote>
        <button type="button" className="adm-formlink-add"
          onClick={() => reshape([...rows, { id: '', label: '', color: NEW_COLOR, match: {} }])}>
          <Icon id="plus" />{C.catAdd}
        </button>
      </SettingsNote>
    </RecordTable>
  )
}
