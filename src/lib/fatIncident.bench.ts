/**
 * How the pure hot paths scale with the size of an Einsatz — `pnpm bench`.
 *
 * Each row is something a tablet does over and over in the field, run against the fat incident
 * presets (lib/fatIncident: `real` = the busiest incident on record, then longer / larger /
 * extreme). Read the table ACROSS presets: a row that grows much faster than the blob does
 * (compare the sizes printed first) is the thing that will hurt first in a long Einsatz.
 *
 *   hydrate        JSON.parse + load gate — every time ANOTHER device saves, this device re-reads
 *   derive         blob → the state the surfaces render (runs with every hydrate)
 *   serialise      the full-blob PUT body and the IndexedDB copy — every local save
 *   merge (409)    three-way merge when two devices saved against the same revision
 *   reminders      open Pendenzen, re-derived from the whole Verlauf on every journal change
 *   verlauf search the Verlauf's search box, per keystroke
 *   replay scrub   one step of the Replay slider (nearest snapshot + fold)
 */
import { bench, describe } from 'vitest'
import { FAT_PRESETS, fatIncident, type FatPreset } from './fatIncident'
import { deriveInitial, sanitizeWorkspace, type Saved } from './workspace'
import { mergeWorkspace } from './mergeWorkspace'
import { deriveReminders } from './reminders'
import { filterJournal } from './journalSearch'
import { stateAt, type ReplayBundle } from './replay'

// node has no localStorage; deriveInitial only asks it for this device's Ebenen
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} } as unknown as Storage

const PRESETS = (process.env.FAT_PRESETS?.split(',') ?? Object.keys(FAT_PRESETS)) as FatPreset[]

for (const preset of PRESETS) {
  const fat = fatIncident(FAT_PRESETS[preset])
  const ws = fat.workspace
  const text = JSON.stringify(ws)
  // two devices diverging from the revision both last saw: one moves a symbol, the other logs Mittel
  const base = JSON.parse(text) as Saved
  const mine = JSON.parse(text) as Saved
  mine.entities[0] = { ...mine.entities[0], coord: [mine.entities[0].coord[0] + 1e-4, mine.entities[0].coord[1]] }
  mine.objects = mine.objects!.map((o) => (o.id === mine.entities[0].id ? { ...o, entity: mine.entities[0] } : o))
  const theirs = JSON.parse(text) as Saved
  theirs.mittel = [...(theirs.mittel ?? []), { id: 'm-new', label: 'Schaummittel', unit: 'l', menge: 20, at: fat.endedAt }]
  // replay: a snapshot per save means the nearest one is always seconds before the cursor
  const endMs = Date.parse(fat.endedAt)
  const snapshotWs = fat.stateAt(0.5)
  const bundle: ReplayBundle = {
    incidentId: 'fat', events: fat.events, samples: [], startMs: Date.parse(fat.startedAt), endMs,
    snapshotCache: new Map(),
    loadSnapshotAt: async () => ({ workspace: snapshotWs, occurredMs: (Date.parse(fat.startedAt) + endMs) / 2 - 10_000 }),
  }
  const mid = (Date.parse(fat.startedAt) + endMs) / 2

  // eslint-disable-next-line no-console
  console.log(`${preset}: blob ${Math.round(text.length / 1024)} KB · ${ws.entities.length} Karte · ${Object.values(ws.board ?? {}).flat().length} Plan · ${ws.trupps?.length} Trupps · ${fat.journal.length} Verlauf · ${fat.events.length} events`)

  describe(`${preset} (${Math.round(text.length / 1024)} KB)`, () => {
    bench('hydrate', () => { sanitizeWorkspace(JSON.parse(text)) })
    bench('derive', () => { deriveInitial(ws, 'fat', {}, 'Brand') })
    bench('serialise', () => { JSON.stringify(ws) })
    bench('merge (409)', () => { mergeWorkspace(base as never, mine as never, theirs as never) })
    bench('reminders', () => { deriveReminders(fat.journal) })
    bench('verlauf search', () => { filterJournal(fat.journal, 'trupp dach') })
    bench('replay scrub', async () => { await stateAt(bundle, mid) })
  })
}
