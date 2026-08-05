// Pure decision rules for the "Als App installieren" (PWA) nudge — kept free of
// window/navigator so they stay unit-testable (installPrompt.ts wires them up).

/** How the install guide must be presented on this device — each platform installs a PWA
 *  differently, and the guide shows ONLY the steps for the one it's on (recognition over
 *  recall, the 3am rule). */
export type InstallPlatform =
  | 'ios'              // iPhone/iPad — Safari share-sheet steps (iOS has no install API)
  | 'android'          // Android — Chromium native prompt or ⋮ menu; other browsers via note
  | 'desktop-chromium' // Chrome/Edge desktop — native prompt or address-bar install icon
  | 'mac-safari'       // macOS Safari 17+ — Ablage → Zum Dock hinzufügen
  | 'unsupported'      // e.g. desktop Firefox — recommend a Chromium browser / Safari

export function detectInstallPlatform(ua: string, maxTouchPoints = 0): InstallPlatform {
  // iPadOS Safari masquerades as macOS ('Macintosh' UA) — the touch points give it away.
  // Checked FIRST: iOS browsers all carry the iPhone/iPad token (Chrome is 'CriOS', Firefox
  // 'FxiOS'), and they all install the same way — via the Safari-engine share sheet.
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  if (/Firefox\//.test(ua)) return 'unsupported' // desktop Firefox dropped PWA install
  if (/Edg\/|Chrome\//.test(ua)) return 'desktop-chromium'
  if (/Macintosh/.test(ua) && /Safari\//.test(ua)) return 'mac-safari'
  return 'unsupported'
}

/** Can this device install at all — i.e. does InstallGuide have real steps for it? Every
 *  platform above except 'unsupported' does, so this is simply "not unsupported".
 *
 *  Was mobile-only until 2026-08-05. That paired two different questions: whether to NAG
 *  (noise on a desktop, still true — see shouldShowInstallBanner) and whether the capability
 *  exists at all. Desktop Chromium and Safari 17+ install perfectly well, the guide has
 *  carried their steps the whole time, and suppressing this made the Offline-Bereitschaft
 *  sheet tell a desktop KP that its device "offers no installation" while the guide sat one
 *  menu entry away with instructions. Offering ≠ pushing. */
export function installOffered(platform: InstallPlatform): boolean {
  return platform !== 'unsupported'
}

/** The proactive banner is a different question from the menu entry: it interrupts. It shows
 *  only in a plain browser tab, on a MOBILE platform (where app-ness earns the interruption —
 *  fullscreen and offline in the field), and never again once dismissed (per device — the menu
 *  entry stays the permanent, unpushy path). The desktop half of the 2026-07-14 decision. */
export function shouldShowInstallBanner(opts: {
  standalone: boolean
  dismissed: boolean
  platform: InstallPlatform
}): boolean {
  return !opts.standalone && !opts.dismissed && (opts.platform === 'ios' || opts.platform === 'android')
}
