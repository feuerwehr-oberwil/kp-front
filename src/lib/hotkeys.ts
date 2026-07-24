// Keyboard shortcuts for working the app at a keyboard (tablet stays touch-first; this is the
// power-user layer). ONE place maps a KeyboardEvent → a semantic command; IncidentWorkspace
// dispatches it per surface (Lage map vs Plan whiteboard) so the same key does the parallel thing
// on both — Lage↔Plan parity is a review criterion. Escape (bail-out / close chrome) and
// Delete/Backspace (delete selection) are handled by their own listeners and are NOT re-mapped here.
//
// Numbers address the plan MODULES by their own number (the rail already shows "1" / "2/3" as the
// module glyph — that badge IS the key): 1 → Modul 1, 2 or 3 → Modul 2/3, 4 → Modul 4, …
// The non-module surfaces carry their own letter, shown as a rail badge (SURFACE_KEY):
//   K Karte · H Checkliste · A Atemschutz · W Anwesenheit · I Mittel
// Bare letters are also the tools/panels/view; Cmd/Ctrl is reserved for the doc-level ops
// (undo/redo/duplicate) and the OS-conventional Einstellungen (Cmd+,). The cheatsheet lives in
// appConfig.copy.help ("Tastaturkürzel") — keep the three (here, SURFACE_KEY, help) in sync.

export type ToolCmd =
  | 'select' | 'lasso' | 'symbol' | 'line' | 'area' | 'circle' | 'note' | 'team' | 'measure'
export type SurfaceCmd = 'map' | 'checklists' | 'atemschutz' | 'anwesenheit' | 'mittel'
export type PanelCmd = 'journal' | 'composer' | 'layers' | 'picker' | 'settings' | 'help'
export type ViewCmd = 'zoomIn' | 'zoomOut' | 'locate' | 'coord' | 'north'

export type HotkeyCommand =
  | { type: 'module'; n: number }          // 1..9 → the plan module with that number
  | { type: 'surface'; surface: SurfaceCmd } // K/H/A/W/I → a non-module surface
  | { type: 'fit' }                          // 0 → einpassen / center
  | { type: 'nav'; dir: -1 | 1 }             // Cmd+[ / Cmd+] → step through the whole nav list
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'duplicate' }
  | { type: 'tool'; tool: ToolCmd }
  | { type: 'panel'; panel: PanelCmd }
  | { type: 'view'; view: ViewCmd }

/** the letter badge shown on each non-module surface in the NavRail — the single source the rail
 *  and SURFACE_KEYS below both read, so the badge always matches what the key does. */
export const SURFACE_KEY: Record<SurfaceCmd, string> = {
  map: 'K', checklists: 'H', atemschutz: 'A', anwesenheit: 'W', mittel: 'I',
}

/** true while a text field owns focus — bare-letter shortcuts must stay inert so typing works. */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false
  const tag = (el as HTMLElement).tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable === true
}

// derive the lowercase-key → surface map from SURFACE_KEY so there's one source of truth
const SURFACE_KEYS: Record<string, SurfaceCmd> = Object.fromEntries(
  (Object.entries(SURFACE_KEY) as [SurfaceCmd, string][]).map(([s, k]) => [k.toLowerCase(), s]),
) as Record<string, SurfaceCmd>

const TOOL_KEYS: Record<string, ToolCmd> = {
  v: 'select', m: 'lasso', s: 'symbol', l: 'line', f: 'area', p: 'circle', n: 'note', t: 'team', d: 'measure',
}
const PANEL_KEYS: Record<string, PanelCmd> = {
  j: 'journal', e: 'composer', b: 'layers', o: 'picker',
}
const VIEW_KEYS: Record<string, ViewCmd> = {
  g: 'locate', c: 'coord', r: 'north',
}

/**
 * Map a keydown to its command, or null if it isn't a shortcut. Pure — no DOM/state. The caller
 * owns the typing/overlay/read-only guards and preventDefault; this only decodes the key.
 */
export function resolveHotkey(e: KeyboardEvent): HotkeyCommand | null {
  const mod = e.metaKey || e.ctrlKey
  const key = e.key

  // Cmd/Ctrl combos — doc-level ops + OS conventions. Alt never participates.
  if (mod && !e.altKey) {
    const k = key.length === 1 ? key.toLowerCase() : key
    switch (k) {
      case 'z': return e.shiftKey ? { type: 'redo' } : { type: 'undo' }
      case 'y': return { type: 'redo' }
      case 'd': return { type: 'duplicate' }
      case '[': return { type: 'nav', dir: -1 }
      case ']': return { type: 'nav', dir: 1 }
      case ',': return { type: 'panel', panel: 'settings' }
      default: return null
    }
  }
  if (mod || e.altKey) return null // any other modifier combo isn't ours

  // Bare keys.
  if (key === '?') return { type: 'panel', panel: 'help' } // Shift+/ on most layouts
  if (key === '+' || key === '=') return { type: 'view', view: 'zoomIn' }
  if (key === '-' || key === '_') return { type: 'view', view: 'zoomOut' }
  if (/^[0-9]$/.test(key)) {
    if (key === '0') return { type: 'fit' }
    return { type: 'module', n: Number(key) } // 1..9 → the plan module with that number
  }
  if (key.length !== 1) return null
  const lower = key.toLowerCase()
  if (lower in SURFACE_KEYS) return { type: 'surface', surface: SURFACE_KEYS[lower] }
  if (lower in TOOL_KEYS) return { type: 'tool', tool: TOOL_KEYS[lower] }
  if (lower in PANEL_KEYS) return { type: 'panel', panel: PANEL_KEYS[lower] }
  if (lower in VIEW_KEYS) return { type: 'view', view: VIEW_KEYS[lower] }
  return null
}
