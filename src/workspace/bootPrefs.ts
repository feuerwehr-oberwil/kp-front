// The device prefs as they stood when the workspace module loaded — the boot snapshot
// `deriveInitial` seeds a workspace from (IncidentWorkspace, useWorkspaceBlob). Read fresh with
// `loadPrefs()` wherever the CURRENT value matters (an in-session switch, a write).

import { loadPrefs } from '../lib/prefs'

export const prefs = loadPrefs()
