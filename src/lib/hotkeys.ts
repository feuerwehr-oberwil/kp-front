// Keyboard shortcuts for working the app at a keyboard (tablet stays touch-first; this is the
// power-user layer). ONE place maps a KeyboardEvent → a semantic command; App.tsx dispatches it
// per surface (Lage map vs Plan whiteboard) so the same key does the parallel thing on both —
// Lage↔Plan parity is a review criterion. Escape (bail-out) and Delete/Backspace (delete
// selection) are handled by their own long-standing listeners in App.tsx / Whiteboard.tsx and are
// deliberately NOT re-mapped here.
//
// Numbers jump straight to a surface (recognition over recall — matches the NavRail order):
//   1 Karte · 2 Pläne · 3 Checkliste · 4 Atemschutz · 5 Anwesenheit · 6 Mittel · 0 Einpassen
// Bare letters are tools/panels/view; Cmd/Ctrl is reserved for the doc-level ops (undo/redo/
// duplicate) and the OS-conventional Einstellungen (Cmd+,). The cheatsheet lives in
// appConfig.copy.help ("Tastaturkürzel") — keep the two in sync when a binding changes.

export type ToolCmd =
  | 'select' | 'lasso' | 'symbol' | 'line' | 'area' | 'circle' | 'note' | 'team' | 'measure'
export type PanelCmd = 'journal' | 'composer' | 'layers' | 'picker' | 'settings' | 'help'
export type ViewCmd = 'zoomIn' | 'zoomOut' | 'locate' | 'coord' | 'north'

export type HotkeyCommand =
  | { type: 'surface'; n: number }        // 1..6 → jump to that surface
  | { type: 'fit' }                        // 0 → einpassen / center
  | { type: 'nav'; dir: -1 | 1 }           // Cmd+[ / Cmd+] → step surfaces
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'duplicate' }
  | { type: 'tool'; tool: ToolCmd }
  | { type: 'panel'; panel: PanelCmd }
  | { type: 'view'; view: ViewCmd }

/** true while a text field owns focus — bare-letter shortcuts must stay inert so typing works. */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false
  const tag = (el as HTMLElement).tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable === true
}

const TOOL_KEYS: Record<string, ToolCmd> = {
  v: 'select', m: 'lasso', s: 'symbol', l: 'line', f: 'area', k: 'circle', n: 'note', t: 'team', d: 'measure',
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
    const n = Number(key)
    return n >= 1 && n <= 6 ? { type: 'surface', n } : null
  }
  if (key.length !== 1) return null
  const lower = key.toLowerCase()
  if (lower in TOOL_KEYS) return { type: 'tool', tool: TOOL_KEYS[lower] }
  if (lower in PANEL_KEYS) return { type: 'panel', panel: PANEL_KEYS[lower] }
  if (lower in VIEW_KEYS) return { type: 'view', view: VIEW_KEYS[lower] }
  return null
}
