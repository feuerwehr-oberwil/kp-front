// Per-device "seen the demo welcome" flag. A tiny preference (not operational state), so
// localStorage is the right home — mirrors kp.divera.dismissed. The welcome modal shows once
// per browser; clearing this key (or a fresh browser) shows it again.
const KEY = 'kp.demo.welcomed'

export function hasSeenDemoWelcome(): boolean {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

export function markDemoWelcomeSeen(): void {
  try { localStorage.setItem(KEY, '1') } catch { /* private mode / storage disabled → just re-show */ }
}
