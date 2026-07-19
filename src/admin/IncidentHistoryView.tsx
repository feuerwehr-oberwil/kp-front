import { useEffect, useMemo, useState } from 'react'
import { listIncidents, type IncidentMeta } from '../lib/incidents'
import { appConfig } from '../config/appConfig'
import { Card, EmptyState, StatusBadge, Table } from './ui'

type State = { kind: 'loading' } | { kind: 'error' } | { kind: 'ok'; data: IncidentMeta[] }

const dateTime = (value: string | null) => value
  ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : '—'

export function IncidentHistoryView() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [query, setQuery] = useState('')
  const C = appConfig.copy.admin.incidentHistory

  useEffect(() => {
    let alive = true
    // 500 is the backend's hard page cap — enough history for years of station operation.
    void listIncidents(undefined, 500).then((data) => { if (alive) setState({ kind: 'ok', data }) })
      .catch(() => { if (alive) setState({ kind: 'error' }) })
    return () => { alive = false }
  }, [])

  const rows = useMemo(() => {
    if (state.kind !== 'ok') return []
    const q = query.trim().toLocaleLowerCase()
    return q ? state.data.filter((i) => `${i.title} ${i.address ?? ''} ${i.type ?? ''} ${i.source}`.toLocaleLowerCase().includes(q)) : state.data
  }, [query, state])

  return (
    <Card>
      {state.kind === 'loading' && <EmptyState message={C.loading} />}
      {state.kind === 'error' && <EmptyState tone="err" message={C.error} />}
      {state.kind === 'ok' && (
        <>
          <input className="adm-input adm-view-filter" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={C.search} aria-label={C.search} />
          {rows.length === 0 ? <EmptyState message={query ? C.noMatches : C.none} /> : (
            <Table columns={[
              { key: 'date', label: C.started }, { key: 'incident', label: C.incident },
              { key: 'status', label: C.status }, { key: 'source', label: C.source },
              { key: 'report', label: C.report }, { key: 'updated', label: C.updated },
            ]} className="adm-history-table">
              {rows.map((incident) => {
                const closed = incident.is_archived || !!incident.closed_at
                return <tr key={incident.id}>
                  <td className="adm-mono">{dateTime(incident.started_at)}</td>
                  <td><span className="adm-ref-title">{incident.title}</span>{incident.address && <span className="adm-ref-note">{incident.address}</span>}</td>
                  <td><StatusBadge tone={closed ? 'off' : 'on'} label={C.status} state={closed ? C.closed : C.open} /></td>
                  <td><span className="adm-view-badge adm-view-badge-muted">{incident.source}</span></td>
                  <td>{incident.report_done_at ? C.complete : C.incomplete}</td>
                  <td className="adm-mono">{dateTime(incident.updated_at)}</td>
                </tr>
              })}
            </Table>
          )}
        </>
      )}
    </Card>
  )
}
