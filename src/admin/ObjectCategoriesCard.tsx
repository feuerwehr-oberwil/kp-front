import { useState } from 'react'
import { appConfig } from '../config/appConfig'
import { Icon } from '../lib/icons'
import { categoryId, categoryLabel, writableRules, type ObjectCategoryRule, type ObjectKind } from '../lib/karte/categories'
import { getPath, useConfig } from './ConfigContext'
import { ConfirmButton, RecordRows, RecordTable, SettingRow, SettingsNote } from './ui'

// «Objektfarben» — the station's colours for its objects on «Karte & Objekte»
// (`map.objectCategories`, lib/karte/categories; backend schemas.py · ObjectCategoryConfig).
// Ordered rules, first match wins; a rule names the object kinds and/or plan modules (globs) it
// takes. A row the server would refuse — no name, no #rrggbb colour — stays on screen with its
// reason and is not written, the ExternalLinksCard's rule.

const HEX = /^#[0-9a-fA-F]{6}$/
const KINDS: ObjectKind[] = ['einsatzobjekt', 'objekt'] // «depot» is retired (lib/karte/categories)
const NEW_COLOR = '#64748b'

export function ObjectCategoriesCard() {
  const { draft, set } = useConfig()
  const C = appConfig.copy.admin.map
  const K = appConfig.copy.karte.kind
  const raw = getPath<ObjectCategoryRule[]>(draft, ['map', 'objectCategories'])
  const stored = Array.isArray(raw) ? raw : []
  const [editing, setEditing] = useState<ObjectCategoryRule[] | null>(null)
  const rows = editing ?? stored

  const write = (next: ObjectCategoryRule[]) => {
    setEditing(next)
    set(['map', 'objectCategories'], writableRules(next))
  }
  const patch = (i: number, over: Partial<ObjectCategoryRule>) => write(rows.map((r, j) => (j === i ? { ...r, ...over } : r)))
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
    write(next)
  }

  return (
    <RecordTable title={C.groupCategories} tip={C.categoriesTip} recordLabel={C.colCategory}>
      {rows.length === 0 && <SettingsNote>{C.categoriesEmpty}</SettingsNote>}
      {rows.map((row, i) => {
        const name = categoryLabel(row.label, 'de', '')
        const kinds = row.match?.kinds ?? []
        const modules = row.match?.modules ?? []
        const problem = !name.trim() ? C.catNoName : !HEX.test(row.color) ? C.catBadColor : null
        return (
          <RecordRows
            key={i}
            name={name || appConfig.copy.admin.common.newEntry}
            swatch={HEX.test(row.color) ? row.color : null}
            meta={row.id ? <code>{row.id}</code> : undefined}
            action={(
              <span className="adm-cat-actions">
                <button type="button" className="adm-formlink-x" title={C.catUp} aria-label={C.catUp} disabled={i === 0} onClick={() => move(i, -1)}><Icon id="chevron-up" /></button>
                <button type="button" className="adm-formlink-x" title={C.catDown} aria-label={C.catDown} disabled={i === rows.length - 1} onClick={() => move(i, 1)}><Icon id="chevron-down" /></button>
                <ConfirmButton
                  className="adm-formlink-x" ariaLabel={C.catRemove} label={<Icon id="trash" />}
                  question={C.catRemoveConfirm} danger
                  onConfirm={() => write(rows.filter((_, j) => j !== i))}
                />
              </span>
            )}
          >
            <SettingRow label={C.catName}>
              <input className="adm-input" type="text" value={name} placeholder={C.catNamePlaceholder} onChange={(e) => setName(i, e.target.value)} />
            </SettingRow>
            <SettingRow label={C.catColor}>
              <div className="adm-color-row">
                <input className="adm-color-swatch" type="color" value={HEX.test(row.color) ? row.color.toLowerCase() : NEW_COLOR}
                  onChange={(e) => patch(i, { color: e.target.value })} aria-label={C.catColor} />
                <input className="adm-input adm-input-mono" type="text" value={row.color} placeholder={NEW_COLOR}
                  onChange={(e) => patch(i, { color: e.target.value.trim() })} />
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
              <input className="adm-input adm-input-mono" type="text" value={modules.join(', ')} placeholder="modul5-pv*, modul5-wasser*"
                onChange={(e) => patch(i, { match: { ...row.match, modules: e.target.value.split(',').map((m) => m.trim()).filter(Boolean) } })} />
            </SettingRow>
            {problem && <SettingsNote><span className="adm-state adm-state-err">{problem}</span></SettingsNote>}
          </RecordRows>
        )
      })}
      <SettingsNote>
        <button type="button" className="adm-formlink-add"
          onClick={() => write([...rows, { id: '', label: '', color: NEW_COLOR, match: {} }])}>
          <Icon id="plus" />{C.catAdd}
        </button>
      </SettingsNote>
    </RecordTable>
  )
}
