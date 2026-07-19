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

/** Install is offered on MOBILE platforms only (decided 2026-07-14): the app-ness matters
 *  on the tablet/phone in the field; on desktop the browser tab is the right form and the
 *  install nudge (banner AND menu entry) is just noise. */
export function installOffered(platform: InstallPlatform): boolean {
  return platform === 'ios' || platform === 'android'
}

/** The proactive banner shows only where it can lead somewhere: in a plain browser tab, on a
 *  mobile platform (installOffered), and never again once dismissed (per device — the menu
 *  entry stays the permanent path, no re-nagging). */
export function shouldShowInstallBanner(opts: {
  standalone: boolean
  dismissed: boolean
  platform: InstallPlatform
}): boolean {
  return !opts.standalone && !opts.dismissed && installOffered(opts.platform)
}
