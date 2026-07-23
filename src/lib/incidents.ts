// Data layer for the kp-front backend. The implementation is split by domain under ./api/*;
// this module is the stable entry point — every call site imports from `../lib/incidents`, so
// the surface can be reorganised without touching them. Re-exports are explicit (not `export *`)
// so a symbol's origin stays greppable.
//
//   ./api/incidents     — incident CRUD + offline-resilient list + legacy migration
//   ./api/workspace     — the per-incident workspace blob (get/put/beacon/poll)
//   ./api/workspaceSync — WorkspaceSync: offline cache + debounced merge-on-save engine
//   ./api/events        — audit event ingest + hash-chain verify
//   ./api/media         — photo/audio upload
//   ./api/divera        — Divera alarm pool (take/attach)
//   ./api/personnel     — Mannschaft roster + Divera sync
//   ./api/geo           — intake address geocoder
//   ./api/objects       — Feuerwehrpläne objects + their plan datasets
//   ./api/reference     — reference datasets + per-station reference-layer config

export {
  listIncidents, cacheIncidentList, readCachedIncidentList, listIncidentsResilient,
  getIncident, createIncident, patchIncident, archiveIncident, reactivateIncident,
  deleteIncident, migrateLegacyWorkspace,
} from './api/incidents'
export type { IncidentMeta, IncidentFull, IncidentCreate } from './api/incidents'

export { getWorkspace, putWorkspace, putWorkspaceBeacon, pollWorkspaceSince } from './api/workspace'
export type { Workspace } from './api/workspace'

export { WorkspaceSync } from './api/workspaceSync'
export type { SyncStatus, WorkspaceSyncOptions } from './api/workspaceSync'

export { ingestEvents, ingestEventsBeacon, verifyChain } from './api/events'
export type { ClientEvent } from './api/events'

export { uploadMedia } from './api/media'

export { getDiveraPool, refreshDiveraPool, takeDiveraAlarm, attachDiveraAlarm } from './api/divera'
export type { DiveraAlarm, DiveraTakeOverrides } from './api/divera'

export { listPersonnel, personnelSyncPreview, personnelSyncExecute } from './api/personnel'
export type { PersonnelSyncPreview, PersonnelSyncResult } from './api/personnel'

export { geocodeSearch, geocodeReverse } from './api/geo'
export type { GeoHit } from './api/geo'

export {
  listObjects, objectsNearIncident, getObject, objectsNearIncidentResilient, getObjectResilient,
} from './api/objects'
export type { ObjectWithPlans } from './api/objects'

export {
  listReference, referenceUrl, uploadReference, upsertReferenceLayer, inspectGeojson,
} from './api/reference'
export type { ReferenceDataset, ReferenceLayerInput } from './api/reference'
