// Server answers for the Objektbesuche tests: each factory fills every field the server always
// sends (types.ts reads them off the generated schema), so a test names only what it is about.
import type { CatalogueObject, Delivery, VisitList, VisitSummary } from './types'

export const summaryRow = (over: Partial<VisitSummary> & Pick<VisitSummary, 'id'>): VisitSummary => ({
  objectId: null, objectName: null, workRef: null, lifecycle: 'completed', revision: 1, ready: true,
  visitedAt: '2026-10-01T08:00:00+02:00', updatedAt: null, by: { id: null, name: null }, findings: 0,
  ...over,
})

export const catalogueObject = (over: Partial<CatalogueObject> & Pick<CatalogueObject, 'id' | 'name'>): CatalogueObject => ({
  address: null, lat: null, lng: null, folder: over.name, refs: [], hasPlans: false, lastVisit: null,
  ...over,
})

export const visitList = (over: Partial<VisitList> & Pick<VisitList, 'ref'>): VisitList => ({
  title: over.ref, note: null, closesAt: null, objectIds: [], unresolved: [],
  ...over,
})

export const delivery = (over: Partial<Delivery> & Pick<Delivery, 'state' | 'revision'>): Delivery => ({
  destination: 'sp', at: null,
  ...over,
})
