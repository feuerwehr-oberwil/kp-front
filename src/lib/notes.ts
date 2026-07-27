import type { NoteSize } from '../types'

/**
 * One place for everything a free-text note needs to agree on across the four renderers that
 * draw it: the Lage map (MapMarkers), the Plan whiteboard (Whiteboard), the client-side PDF
 * (reportPdfDirect) and the server-side sheet (backend/app/kroki.py). The Python side mirrors
 * these numbers — see `NOTE_SIZE_SCALE` / `_note_lines` there; a change here needs a change
 * there, or paper stops matching the screen.
 *
 * A note is a one-line pill until it has a WIDTH, at which point it wraps and grows downwards.
 * Width is per-surface because the surfaces scale differently: `BoardAnno.wN` is a fraction of
 * the plan width (so it survives zoom and prints 1:1), `Entity.noteW` is screen px (map notes
 * are pinned to a constant screen size). Everything else lives on the shared `SymbolProps`.
 */

/** Multiplier on each surface's base text size. 'm' is the default when `noteSize` is absent. */
export const NOTE_SIZE_SCALE: Record<NoteSize, number> = { s: 0.8, m: 1, l: 1.45 }

/** Text size multiplier for a note, tolerating an absent / unknown value. */
export const noteScale = (size?: NoteSize) => NOTE_SIZE_SCALE[size ?? 'm'] ?? 1

/** Plan text-box width, as a fraction of the plan width. `def` is what "Zu Textfeld" seeds. */
export const NOTE_WN = { min: 0.06, max: 0.6, def: 0.2 } as const
/** Map text-box width, in screen px. */
export const NOTE_W_PX = { min: 90, max: 420, def: 220 } as const

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

/** Clamp a dragged plan width into [min,max] so a shaky drag can't make a sliver or a band. */
export const clampNoteWN = (w: number) => clamp(w, NOTE_WN.min, NOTE_WN.max)
/** Clamp a dragged map width (screen px) into [min,max]. */
export const clampNoteWPx = (w: number) => Math.round(clamp(w, NOTE_W_PX.min, NOTE_W_PX.max))

/**
 * Is this note a wrapping text box (rather than the legacy one-line pill)? The width is the
 * ONLY discriminator — a note with no width renders exactly as it did before this existed,
 * which is what keeps stored incidents and report fixtures valid without a migration.
 */
export const isNoteBox = (width?: number) => typeof width === 'number' && width > 0
