import type { HotkeyCommand, SurfaceCmd, ToolCmd } from './hotkeys'
import { isMapReadOnlyTool } from './readOnlyTools'

/**
 * WHERE a decoded shortcut goes, given the workspace's state — the routing half of the keyboard
 * layer (23.09.2026). `lib/hotkeys · resolveHotkey` turns a keydown into a command; this turns a
 * command into ONE action and whether the key is claimed, and IncidentWorkspace's one
 * latest-ref window listener executes it. Pure, so the table can be tested without a workspace.
 *
 * ⚠️ `prevent` is not «did we act». Several keys are claimed only where they mean something
 * (⌘D off a drawing surface, a tool key on a locked sheet, B away from the Karte) and pass
 * through otherwise; others are claimed even when they end in nothing (a digit with no such
 * module, 0 on a surface with nothing to fit), because a bare letter the app has reserved must
 * not leak to the browser half the time. The table below is the one statement of which is which.
 */
export interface HotkeyState {
  /** a modal sheet owns the screen — its own focus trap / Esc handle keys */
  modalOpen: boolean
  mode: string
  /** an alignment session is running, on this plan (georefMode · planId) */
  georefPlanId: string | null
  /** the plan a module number opens (the first carrying it), for the alignment session's own pair */
  moduleTargetId: (n: number) => string | undefined
  tacticalLocked: boolean
  replayActive: boolean
  readOnly: boolean
  linkScoped: boolean
}

export type HotkeyAction =
  | { type: 'none' }
  | { type: 'georef'; go: 'goPlan' | 'goMap' }
  | { type: 'module'; n: number }
  | { type: 'surface'; surface: SurfaceCmd; clear: boolean }
  | { type: 'nav'; dir: -1 | 1 }
  | { type: 'fitPlan' } | { type: 'centerMap' }
  | { type: 'undo' } | { type: 'redo' }
  | { type: 'duplicateMap' } | { type: 'duplicatePlan' }
  | { type: 'toolMap'; tool: ToolCmd } | { type: 'toolPlan'; tool: ToolCmd }
  | { type: 'journal' } | { type: 'composer' } | { type: 'layers' } | { type: 'settings' } | { type: 'help' }
  | { type: 'zoomPlan'; factor: number } | { type: 'zoomMap'; dir: 'in' | 'out' }
  | { type: 'locate' } | { type: 'coord' }

export interface HotkeyRoute { action: HotkeyAction; prevent: boolean }

const NONE: HotkeyRoute = { action: { type: 'none' }, prevent: false }
const claim = (action: HotkeyAction): HotkeyRoute => ({ action, prevent: true })
/** claimed and acted on only where `when` holds — passed through untouched otherwise */
const where = (when: boolean, action: HotkeyAction): HotkeyRoute => (when ? claim(action) : NONE)

export function routeHotkey(cmd: HotkeyCommand | null, s: HotkeyState): HotkeyRoute {
  if (s.modalOpen || !cmd) return NONE
  // An alignment session owns navigation on every form factor. The hidden NavRail must not
  // have a keyboard back door to another module or surface; only its own Karte/Modul pair
  // remains reachable until the operator deliberately finishes or cancels the task.
  if (s.georefPlanId) {
    if (cmd.type === 'module') return claim(s.moduleTargetId(cmd.n) === s.georefPlanId ? { type: 'georef', go: 'goPlan' } : { type: 'none' })
    if (cmd.type === 'nav') return claim({ type: 'none' })
    if (cmd.type === 'surface') return claim(cmd.surface === 'map' ? { type: 'georef', go: 'goMap' } : { type: 'none' })
  }
  const onMap = s.mode === 'map', onPlan = s.mode === 'plans', drawing = onMap || onPlan
  switch (cmd.type) {
    case 'module': return claim({ type: 'module', n: cmd.n })
    case 'surface': return claim({ type: 'surface', surface: cmd.surface, clear: cmd.surface !== s.mode })
    case 'nav': return claim({ type: 'nav', dir: cmd.dir })
    case 'fit': return claim(onPlan ? { type: 'fitPlan' } : onMap ? { type: 'centerMap' } : { type: 'none' })
    // ⚠️ The keyboard reaches the SAME one timeline the header pair does, and no longer routes
    // by surface: Cmd-Z means «take back the last thing that happened», wherever it happened.
    case 'undo': return claim({ type: 'undo' })
    case 'redo': return claim({ type: 'redo' })
    // both drawing surfaces duplicate their own single selection; every other surface has
    // nothing Cmd+D could mean (A22 — the key used to resolve and then do nothing on the Plan)
    case 'duplicate': return onMap ? claim({ type: 'duplicateMap' }) : onPlan ? claim({ type: 'duplicatePlan' }) : NONE
    case 'tool':
      // a locked surface keeps the keys for the tools it still shows (D = Messen, V = Auswahl)
      if (!drawing || (s.tacticalLocked && !isMapReadOnlyTool(cmd.tool)) || s.replayActive) return NONE
      return claim(onMap ? { type: 'toolMap', tool: cmd.tool } : { type: 'toolPlan', tool: cmd.tool })
    case 'panel':
      switch (cmd.panel) {
        case 'journal': return claim({ type: 'journal' })
        case 'composer': return where(!s.readOnly && !s.linkScoped, { type: 'composer' })
        case 'layers': return where(onMap, { type: 'layers' })
        case 'settings': return where(!s.linkScoped, { type: 'settings' })
        case 'help': return claim({ type: 'help' })
      }
      return NONE
    case 'view':
      switch (cmd.view) {
        case 'zoomIn': return claim(onPlan ? { type: 'zoomPlan', factor: 1.3 } : { type: 'zoomMap', dir: 'in' })
        case 'zoomOut': return claim(onPlan ? { type: 'zoomPlan', factor: 1 / 1.3 } : { type: 'zoomMap', dir: 'out' })
        case 'locate': return where(onMap, { type: 'locate' })
        case 'coord': return where(onMap, { type: 'coord' })
        // «Nach Norden» has no key — the compass button carries it on every form factor and
        // R went to the Rapport surface (see lib/hotkeys)
      }
      return NONE
  }
}
