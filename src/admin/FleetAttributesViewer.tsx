import { useMemo, useState, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { useSymbols } from '../lib/useSymbols'
import { symbolConfigurableFields, symbolControls } from '../lib/symbols'
import { formatSymbolName } from '../lib/format'
import { appConfig } from '../config/appConfig'
import { Table } from './ui'
import type { FleetAttributeList } from '../lib/deploymentConfig'

// Read-only config viewer for the fleet/symbol attribute lists, as a TABLE: one row per symbol
// FIELD, with the symbol + its doctrine (controls) spanning that symbol's field rows. Each field
// shows its source — a configured deployment list (Konfiguriert), a roster field (Aus Mannschaft),
// or a bare free-text field (Freitext) — plus the effective option values as chips. There are NO
// code-baked default lists. Editing happens via the `admin_config` CLI, NOT here — this surface
// only renders, never mutates.

const ROSTER_FIELDS = new Set<string>(appConfig.symbols.rosterFields)

// A chip strip of the effective option values (read-only).
function Chips({ options }: { options: string[] }) {
  return (
    <span className="adm-view-chips">
      {options.map((o) => <span className="adm-view-chip" key={o}>{o}</span>)}
    </span>
  )
}

// One field's (source badge, options) cells — shared by preset fields and custom rows.
function fieldCells(C: typeof appConfig.copy.admin.fleet, opts: { roster: boolean; configured: boolean; options: string[] }): {
  source: ReactNode
  values: ReactNode
} {
  if (opts.roster) {
    return {
      source: <span className="adm-fleet-rosterpill"><Icon id="people" />{C.rosterField}</span>,
      values: <span className="adm-fleet-freeval">—</span>,
    }
  }
  if (opts.configured) {
    return {
      source: <span className="adm-fleet-badge adm-fleet-badge-cfg" title={C.configuredBadgeHint}>{C.configuredBadge}</span>,
      values: opts.options.length > 0 ? <Chips options={opts.options} /> : <span className="adm-fleet-freeval">{C.freitextValue}</span>,
    }
  }
  return {
    source: <span className="adm-fleet-badge adm-fleet-badge-free" title={C.freitextBadgeHint}>{C.freitextBadge}</span>,
    values: <span className="adm-fleet-freeval">{C.freitextValue}</span>,
  }
}

export function FleetAttributesViewer({ lists }: { lists: FleetAttributeList[] }) {
  const sym = useSymbols()
  const C = appConfig.copy.admin.fleet
  const [filter, setFilter] = useState('')

  // every library symbol grouped by category, in the curated order; narrowed by the search box.
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const out: { cat: string; symbols: { name: string; cat: string }[] }[] = []
    const at: Record<string, number> = {}
    for (const s of sym.symbols) {
      if (q && !formatSymbolName(s.name).toLowerCase().includes(q) && !s.name.toLowerCase().includes(q)) continue
      if (!(s.cat in at)) { at[s.cat] = out.length; out.push({ cat: s.cat, symbols: [] }) }
      out[at[s.cat]].symbols.push({ name: s.name, cat: s.cat })
    }
    return out
  }, [sym.symbols, filter])

  const overrideOf = (symbol: string, field: string) =>
    lists.find((r) => r.symbol === symbol && r.field === field)?.options

  const columns = [
    { key: 'cat', label: C.colCategory },
    { key: 'sym', label: C.colSymbol },
    { key: 'props', label: C.propsLabel },
    { key: 'field', label: C.colField },
    { key: 'source', label: C.colSource },
    { key: 'options', label: C.colOptions },
  ]

  // Per-field rows for one symbol (preset fields, then custom rows; a muted placeholder if none).
  type Row = { key: string; label: string; muted?: boolean; cells: { source: ReactNode; values: ReactNode } }
  const rowsFor = (name: string, cat: string): Row[] => {
    const fields = symbolConfigurableFields(name, cat)
    const presetKeys = new Set(fields.map((f) => f.key))
    const customRows = lists.filter((r) => r.symbol === name && !presetKeys.has(r.field))
    const rows: Row[] = []
    for (const f of fields) {
      const label = f.key === 'title' ? C.fieldTitle : f.key
      if (f.roster) {
        rows.push({ key: f.key, label, cells: fieldCells(C, { roster: true, configured: false, options: [] }) })
      } else {
        const override = overrideOf(name, f.key)
        rows.push({ key: f.key, label, cells: fieldCells(C, { roster: false, configured: override !== undefined, options: override ?? [] }) })
      }
    }
    for (const r of customRows) {
      const isRoster = ROSTER_FIELDS.has(r.field.trim())
      rows.push({ key: `c:${r.field}`, label: r.field, cells: fieldCells(C, { roster: isRoster, configured: true, options: r.options }) })
    }
    if (rows.length === 0) {
      rows.push({ key: '∅', label: C.noAttributes, muted: true, cells: { source: null, values: null } })
    }
    return rows
  }

  return (
    <div className="adm-view">
      <details className="adm-fleet-guide">
        <summary>{C.guideTitle}</summary>
        <div className="adm-fleet-guide-grid">
          <section className="adm-fleet-glossary">
            <strong>{C.fieldMeaningTitle}</strong>
            <dl>{Object.entries(C.fieldGlossary).map(([field, meaning]) => (
              <div key={field}><dt>{field}</dt><dd>{meaning}</dd></div>
            ))}</dl>
          </section>
          <section className="adm-fleet-glossary">
            <strong>{C.propertiesMeaningTitle}</strong>
            <dl>{Object.entries(C.controlGlossary).map(([control, meaning]) => (
              <div key={control}><dt>{C.controls[control as keyof typeof C.controls]}</dt><dd>{meaning}</dd></div>
            ))}</dl>
          </section>
          <section className="adm-fleet-glossary">
            <strong>{C.listsMeaningTitle}</strong>
            <dl>
              <div><dt>{C.configuredBadge}</dt><dd>{C.configuredBadgeHint}</dd></div>
              <div><dt>{C.freitextBadge}</dt><dd>{C.freitextBadgeHint}</dd></div>
              <div><dt>{C.rosterField}</dt><dd>{C.rosterBadgeHint}</dd></div>
              <div className="adm-fleet-guide-wide"><dt>{C.colOptions}</dt><dd>{lists.length === 0 ? C.noConfiguredLists : C.configuredLists}</dd></div>
            </dl>
          </section>
        </div>
      </details>
      <input
        className="adm-input adm-view-filter"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={C.filterPlaceholder}
        aria-label={C.filterPlaceholder}
      />

      {groups.length === 0 && <p className="adm-view-empty">{sym.ready ? C.noMatches : C.loading}</p>}

      {/* ONE table across every category; the category is a spanning first column (not a
          per-category section heading), so all groups share identical columns. */}
      {groups.length > 0 && (
        <Table columns={columns} className="adm-vtable">
          {groups.map((g, gi) => {
            const symRows = g.symbols.map((s) => ({ s, rows: rowsFor(s.name, s.cat) }))
            const catRowTotal = symRows.reduce((n, x) => n + x.rows.length, 0)
            return symRows.map(({ s, rows }, si) => {
              const glyph = sym.byName[s.name]
              const controls = [...symbolControls(s.name, s.cat)]
              const span = rows.length
              return rows.map((row, i) => {
                const catBoundary = si === 0 && i === 0 && gi > 0 // strong divider between categories
                const symBoundary = i === 0 && si > 0             // hairline between symbols in a category
                return (
                  <tr
                    key={`${s.name}/${row.key}`}
                    className={catBoundary ? 'adm-vsep-cat' : symBoundary ? 'adm-vsep' : undefined}
                  >
                    {si === 0 && i === 0 && (
                      <td rowSpan={catRowTotal} className="adm-symcat">
                        <span className="adm-view-catname">{g.cat}</span>
                      </td>
                    )}
                    {i === 0 && (
                      <td rowSpan={span}>
                        <span className="adm-vname">
                          <span className="adm-view-glyph" aria-hidden>
                            {glyph ? <span dangerouslySetInnerHTML={{ __html: glyph }} /> : <Icon id="hex" />}
                          </span>
                          <span className="adm-view-id">
                            <span className="adm-view-name">{formatSymbolName(s.name) || s.name}</span>
                            <span className="adm-view-key">{s.name}</span>
                          </span>
                        </span>
                      </td>
                    )}
                    {i === 0 && (
                      <td rowSpan={span}>
                        {controls.length > 0
                          ? <span className="adm-fleet-props">{controls.map((c) => <span className="adm-fleet-prop" key={c}>{C.controls[c]}</span>)}</span>
                          : <span className="adm-fleet-freeval">—</span>}
                      </td>
                    )}
                    <td className={row.muted ? undefined : 'adm-vfield'}>
                      {row.muted ? <span className="adm-fleet-freeval">{row.label}</span> : row.label}
                    </td>
                    <td>{row.cells.source}</td>
                    <td>{row.cells.values}</td>
                  </tr>
                )
              })
            })
          })}
        </Table>
      )}
    </div>
  )
}
