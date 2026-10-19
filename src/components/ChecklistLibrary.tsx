import { appConfig } from '../config/appConfig'
import { EmptyState } from './EmptyState'

// The station's checklists and Anleitungen to READ without an Einsatz – the «Checkliste» surface
// of Karte & Objekte (KarteApp). Read-only: nothing is ticked, nothing is stored on the server.
// `query` is the search typed into the Karte's top bar while this surface is shown.
//
// Contract between the Karte (which hosts it) and the library (which owns everything inside):
// the Karte passes the query and nothing else; the library keeps its own selection.
// (Placeholder on the base branch – the LIB builder replaces the body.)
export function ChecklistLibrary({ query }: { query: string }) {
  void query
  return <EmptyState className="empty-fill" icon="check" title={appConfig.copy.checklists.none} />
}
