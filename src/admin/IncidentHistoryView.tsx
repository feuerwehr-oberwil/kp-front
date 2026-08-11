import { useEffect, useMemo, useState } from 'react'
import { deleteIncident, listIncidents, type IncidentMeta } from '../lib/incidents'
import { appConfig } from '../config/appConfig'
import { Card, ConfirmButton, EmptyState, StatusBadge, Table } from './ui'
import { fillTemplate } from '../lib/format'

type State = { kind: 'loading' } | { kind: 'error' } | { kind: 'ok'; data: IncidentMeta[] }

const dateTime = (value: string | null) => value
  ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : '—'

export function IncidentHistoryView() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [query, setQuery] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const C = appConfig.copy.admin.incidentHistory

  useEffect(() => {
    let alive = true
    // 500 is the backend's hard page cap — enough history for years of station operation.
    void listIncidents(undefined, 500).then((data) => { if (alive) setState({ kind: 'ok', data }) })
      .catch(() => { if (alive) setState({ kind: 'error' }) })
    return () => { alive = false }
  }, [])

  /** Drop it from the list on success rather than refetching: the row is gone, and a reload
   *  would put a spinner over a table the admin is reading. A failure says so and keeps the row. */
  const remove = async (id: string) => {
    try {
      await deleteIncident(id)
      setState((cur) => (cur.kind === 'ok' ? { kind: 'ok', data: cur.data.filter((i) => i.id !== id) } : cur))
    } catch {
      setErr(C.deleteFailed)
    }
  }

  const rows = useMemo(() => {
    if (state.kind !== 'ok') return []
    const q = query.trim().toLocaleLowerCase()
    return q ? state.data.filter((i) => `${i.title} ${i.address ?? ''} ${i.type ?? ''} ${i.source}`.toLocaleLowerCase().includes(q)) : state.data
  }, [query, state])

  return (
    <Card>
      {state.kind === 'loading' && <EmptyState message={C.loading} />}
      {state.kind === 'error' && <EmptyState tone="err" message={C.error} />}
      {err && <EmptyState tone="err" message={err} />}
      {state.kind === 'ok' && (
        <>
          <input className="adm-input adm-view-filter" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={C.search} aria-label={C.search} />
          {rows.length === 0 ? <EmptyState message={query ? C.noMatches : C.none} /> : (
            <Table columns={[
              { key: 'date', label: C.started }, { key: 'incident', label: C.incident },
              { key: 'status', label: C.status }, { key: 'source', label: C.source },
              { key: 'report', label: C.report }, { key: 'updated', label: C.updated },
              { key: 'actions', label: C.actions },
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
                  {/* ⚠️ Only once the Einsatz is CLOSED. Archiving is the operator saying it is
                      over, and it is the only moment at which «löschen» is a decision rather than
                      an accident — the backend refuses a running one either way (409). */}
                  <td>
                    {closed ? (
                      <ConfirmButton
                        danger
                        label={C.delete}
                        question={fillTemplate(C.deleteQuestion, { title: incident.title })}
                        onConfirm={() => void remove(incident.id)}
                      />
                    ) : <span className="adm-ref-note">{C.deleteOpenHint}</span>}
                  </td>
                </tr>
              })}
            </Table>
          )}
        </>
      )}
    </Card>
  )
}
