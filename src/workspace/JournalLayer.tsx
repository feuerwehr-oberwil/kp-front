// The Verlauf layer, app-level so it opens over every surface: the drawer (with its delivery
// notice), the Durchhören player and the «Eintrag» composer. Split out of IncidentWorkspace (E1,
// 09.10.2026) verbatim; the rows themselves are written by the workspace (addJournal,
// addPlayerEntry, the reminders), which hands its writers in as props.

import { lazy, Suspense, type Dispatch, type ReactElement, type ReactNode, type SetStateAction } from 'react'
import { AudioPlayerSheet } from '../components/AudioPlayerSheet'
import { Journal } from '../components/Journal'
import { type JournalDraft, JournalComposer } from '../components/JournalComposer'
import { JournalDeliveryNotice } from '../components/JournalDeliveryNotice'
import type { LageSend } from '../components/LagemeldungSheet'
import { appConfig } from '../config/appConfig'
import type { lageRhythm } from '../lib/lageRhythm'
import type { LageInput } from '../lib/lagemeldung'
import { combinedSyncStatus } from '../lib/combinedSyncStatus'
import { type IncidentMeta, uploadMedia } from '../lib/incidents'
import type { JournalLink } from '../lib/journalLinks'
import type { PhotoPlacement } from '../lib/photoGeo'
import { toast } from '../lib/ui'
import type { useAuditEvents } from '../lib/useAuditEvents'
import type { useJournal } from '../lib/useJournal'
import type { useMediaQueue } from '../lib/useMediaQueue'
import type { useReminders } from '../lib/useReminders'
import type { TimelineEvent, PlanDocument } from '../types'

/** The Lagemeldung composer (F3) and its engine — loaded on the first tap on «Lage» (or when a
 *  booking comes due and the Meldeleiste row wants the engine's count), never at boot. */
const loadLagemeldung = () => import('../components/LagemeldungSheet')
const LagemeldungSheet = lazy(() => loadLagemeldung().then((m) => ({ default: m.LagemeldungSheet })))

export interface JournalLayerProps {
  journalOpen: boolean
  guarded: (surface: string, node: ReactNode, toMap?: boolean) => ReactElement
  journal: ReturnType<typeof useJournal>
  auditDelivery: ReturnType<typeof useAuditEvents>
  closedRefusedTotal: number
  exportEntries: () => void
  journalVocab: JournalLink[]
  timeline: TimelineEvent[]
  incidentMeta: IncidentMeta
  planDocs: PlanDocument[]
  focusEvent: (e: TimelineEvent) => void
  replayActive: boolean
  replayAtMs: number | null
  seekToEvent: (e: TimelineEvent) => void
  journalLandOn: { id: string; nonce: number } | null
  setJournalOpen: Dispatch<SetStateAction<boolean>>
  setJournalLandOn: Dispatch<SetStateAction<{ id: string; nonce: number } | null>>
  journalFromRapport: boolean
  setJournalFromRapport: Dispatch<SetStateAction<boolean>>
  openRapport: () => void
  readOnly: boolean
  enterReplay: () => void
  reminders: ReturnType<typeof useReminders>
  setNoteOn: Dispatch<SetStateAction<{ id: string; text: string } | null>>
  setComposerOpen: Dispatch<SetStateAction<boolean>>
  reRaisePendenz: (reminderId: string, mins: number) => void
  media: ReturnType<typeof useMediaQueue>
  setPlayer: Dispatch<SetStateAction<{ row: TimelineEvent; seekSec?: number } | null>>
  photoOnMap: (row: Pick<TimelineEvent, 'photoUrl' | 'photoUrls' | 'id' | 'photoGeo'>, i: number) => PhotoPlacement | null
  tacticalLocked: boolean
  placePhotos: (row: Pick<TimelineEvent, 'photoUrl' | 'photoUrls' | 'id' | 'photoGeo'>, only?: number) => void
  showPhotoOnMap: (entityId: string) => void
  player: { row: TimelineEvent; seekSec?: number } | null
  isEditor: boolean
  addPlayerEntry: (text: string, atIso: string, quiet?: boolean) => string
  composerOpen: boolean
  addJournal: (d: JournalDraft, geoSettled?: boolean) => void
  noteOn: { id: string; text: string } | null
  lageOpen: boolean
  canLagemeldung: boolean
  lageInput: () => LageInput
  lage: ReturnType<typeof lageRhythm>
  setLageOpen: Dispatch<SetStateAction<boolean>>
  sendLagemeldung: (r: LageSend) => void
  lageRhythmOff: () => void
}

export function JournalLayer({
  journalOpen, guarded, journal, auditDelivery, closedRefusedTotal, exportEntries, journalVocab,
  timeline, incidentMeta, planDocs, focusEvent, replayActive, replayAtMs, seekToEvent, journalLandOn,
  setJournalOpen, setJournalLandOn, journalFromRapport, setJournalFromRapport, openRapport, readOnly,
  enterReplay, reminders, setNoteOn, setComposerOpen, reRaisePendenz, media, setPlayer, photoOnMap,
  tacticalLocked, placePhotos, showPhotoOnMap, player, isEditor, addPlayerEntry, composerOpen,
  addJournal, noteOn, lageOpen, canLagemeldung, lageInput, lage, setLageOpen, sendLagemeldung, lageRhythmOff,
}: JournalLayerProps) {
  return (
    <>
      {/* unified Verlauf + quick-add — rendered app-level so both open over either surface,
          and AFTER the Rapport sheet so its checklist row can stack the Verlauf on top */}
      {journalOpen && guarded('journal', (
        <Journal
          deliveryNotice={<JournalDeliveryNotice
            status={combinedSyncStatus(journal.syncStatus, auditDelivery.status)}
            count={journal.pendingCount + journal.rejectedCount + auditDelivery.pendingCount + auditDelivery.rejectedCount}
            refused={auditDelivery.refusedCount}
            closedRefused={closedRefusedTotal}
            onRetry={async () => { await Promise.all([journal.retry(), auditDelivery.retry()]) }}
            onExport={exportEntries}
          />}
          vocab={journalVocab}
          events={timeline}
          closedAt={incidentMeta.closed_at}
          plans={planDocs}
          onSelect={focusEvent}
          replayAtMs={replayActive ? replayAtMs : null}
          onSeekTo={replayActive ? seekToEvent : undefined}
          landOn={journalLandOn}
          // ⚠️ The landing is CONSUMED on close. The drawer remounts every time it opens, so the
          // «already landed» guard inside it resets — and a stale `landOn` left lying around
          // meant the next ordinary open (TopBar, checklist, Rapport) silently jumped to
          // whatever row the Wiedergabe caption had pointed at, possibly hours ago.
          onClose={() => { setJournalOpen(false); setJournalLandOn(null); if (journalFromRapport) { setJournalFromRapport(false); openRapport() } }}
          onTranscript={!readOnly ? (id, transcript) => journal.appendPatch(id, { transcript: transcript.trim() }) : undefined}
          onReplay={!replayActive ? () => { setJournalOpen(false); enterReplay() } : undefined}
          openReminders={reminders.open}
          onReminderDone={!readOnly ? reminders.markDone : undefined}
          // tap a Pendenz → write a Meldung on it. The Verlauf steps aside so the composer is
          // not stacked on a drawer the operator can no longer see behind it.
          // ⚠️ The Verlauf STAYS OPEN behind it. Closing it meant that finishing a Meldung — or
          // thinking better of it — dropped you back onto the map, away from the list you were
          // working through; and at a Lagerapport you write several in a row. The composer is a
          // modal above the drawer (z 81 over 61), so nothing is lost behind it.
          onReminderNote={!readOnly ? (r) => {
            setNoteOn({ id: r.id, text: r.text })
            setComposerOpen(true)
          } : undefined}
          onReminderAgain={!readOnly && !replayActive ? reRaisePendenz : undefined}
          mediaStatusOf={media.statusOf}
          onOpenPlayer={(e, seekSec) => setPlayer({ row: e, seekSec })}
          onEditText={!readOnly ? (id, text) => journal.appendPatch(id, { textEdit: text }) : undefined}
          photoPlacement={photoOnMap}
          onPhotoPlace={!tacticalLocked && !replayActive ? (e) => placePhotos(e) : undefined}
          onPhotoShow={!replayActive ? showPhotoOnMap : undefined}
        />
      ))}
      {player && (
        <AudioPlayerSheet
          row={player.row}
          events={timeline}
          readOnly={readOnly}
          // transcribing and deciding its segments is editor-only on the server (api/media)
          canTranscribe={isEditor}
          initialSeekSec={player.seekSec}
          // the same vocabulary the composer gets — «Eintrag an dieser Stelle» writes into the
          // same Verlauf, so it completes and marks names identically
          vocab={journalVocab}
          onAddEntry={!readOnly ? addPlayerEntry : undefined}
          // a voice memo's words land on the memo itself, as a transcript section at the
          // playhead — appended like every enrichment, never edited in place
          onAddSection={!readOnly ? (atSec, text) => {
            journal.appendPatch(player.row.id, { transcriptSection: { at: atSec, text } })
            toast(appConfig.copy.journal.saved, { icon: 'type', tone: 'success' })
          } : undefined}
          // fixing a section replaces its words in place ('' removes it) — the recording is
          // the original, so no «korrigiert» mark and no new Verlauf line
          onEditSection={!readOnly ? (sectionId, text) => journal.appendPatch(player.row.id, { transcriptSectionEdit: { id: sectionId, text } }) : undefined}
          onPatchEntry={!readOnly ? (rowId, text) => journal.appendPatch(rowId, { textEdit: text }) : undefined}
          onRetractEntry={!readOnly ? (rowId) => {
            journal.appendPatch(rowId, { retracted: true })
            toast(appConfig.copy.journal.entryRemoved, {
              icon: 'trash', tone: 'default',
              action: { label: appConfig.copy.undo, onClick: () => journal.appendPatch(rowId, { retracted: false }) },
            })
          } : undefined}
          onClose={() => setPlayer(null)}
        />
      )}
      {lageOpen && canLagemeldung && (
        <Suspense fallback={null}>
          <LagemeldungSheet
            getInput={lageInput}
            anchor={lage.anchor}
            intervalMin={lage.off ? 0 : lage.intervalMin}
            onClose={() => setLageOpen(false)}
            onSend={sendLagemeldung}
            onRhythmOff={!lage.off && (lage.dueAt != null || lage.derived) ? () => { lageRhythmOff(); setLageOpen(false) } : undefined}
          />
        </Suspense>
      )}
      {composerOpen && (
        <JournalComposer
          // everything this Einsatz has words for — Mannschaft, Mittel, Partnerorganisationen,
          // Fahrzeuge, Alarmgruppen. Typing three letters of any of them completes it.
          vocab={journalVocab}
          // …and this Einsatz's own rows, so the chips offered on an empty field are the phrases
          // that are actually being used tonight (lib/startChips)
          timeline={timeline}
          onSubmit={addJournal}
          onClose={() => { setComposerOpen(false); setNoteOn(null) }}
          noteOn={noteOn ?? undefined}
          onClearNote={() => setNoteOn(null)}
          // …and the same list the Verlauf pins, so an entry being written can be attached to an
          // open item without going through the Verlauf at all — the sheet offers the ones the
          // sentence already names, and holds a picker for the rest.
          openPendenzen={reminders.open.map((r) => ({ id: r.id, text: r.text, urgent: !!r.urgent, createdAt: r.createdAt }))}
          onLinkPendenz={(pdz) => setNoteOn(pdz)}
          // «Lagemeldung an Einsatzzentrale» typed → offer the composer (F3)
          onLagemeldung={canLagemeldung ? () => { setComposerOpen(false); setNoteOn(null); setLageOpen(true) } : undefined}
          incidentStartAt={incidentMeta.started_at}
          uploadAudio={(blob, filename) => uploadMedia(incidentMeta.id, blob, 'audio', filename)}
          // generic Beilagen (PDF & Co.) ride the same endpoint under kind 'file' — the server
          // hands those back as a download, never inline (backend/app/api/media.py)
          uploadFile={(blob, filename) => uploadMedia(incidentMeta.id, blob, 'file', filename)}
        />
      )}
    </>
  )
}
